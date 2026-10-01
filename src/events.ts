/**
 * Structured event log.
 *
 * Design (discovery report section 10): every significant action emits a
 * structured event, correlated across session kinds, and the SINGLE redaction
 * stage sits at the write boundary - not at each call site. If redaction
 * fails we write a placeholder rather than the raw payload.
 *
 * Format: append-only JSON Lines, one event per line, so the log is trivially
 * inspectable with `tail`/`jq` and never needs a database.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { redactValue } from "./security/redact.ts";

/** The event vocabulary from the discovery report, section 10.2. */
export type EventKind =
  // workspace lifecycle
  | "workspace.created"
  | "workspace.opened"
  | "workspace.removed"
  // agent
  | "agent.started"
  | "agent.message"
  | "agent.stopped"
  // execution
  | "execution.started"
  | "execution.completed"
  | "execution.failed"
  // remote shell
  | "ssh.connected"
  | "ssh.failed"
  // github
  | "github.authenticated"
  | "github.push"
  | "github.pull_request.created"
  // AInterceptor / providers
  | "ainterceptor.session.started"
  | "ainterceptor.request.started"
  | "ainterceptor.request.completed"
  | "ainterceptor.request.failed"
  | "provider.auth.failed"
  | "provider.rate_limited"
  // diagnostics
  | "diagnostics.run"
  // harness self
  | "harness.started"
  | "harness.error";

/** Which session kinds an event can belong to (kept distinct, never merged). */
export type SessionKind = "harness" | "workspace" | "agent" | "ainterceptor" | "execution" | "ssh";

export interface HarnessEvent {
  /** ISO-8601 UTC. */
  ts: string;
  kind: EventKind;
  /** Which session this belongs to. */
  session: SessionKind;
  /** Free-form session identifier, so one turn can be traced end to end. */
  sessionId?: string;
  /** Correlation id: set once and carried through every downstream event. */
  requestId?: string;
  workspace?: string;
  host?: string;
  provider?: string;
  severity?: "debug" | "info" | "warn" | "error";
  /** Arbitrary structured payload. Redacted before it is written. */
  data?: unknown;
}

export interface EventSink {
  emit(event: HarnessEvent): void;
  flush(): Promise<void>;
}

const SEVERITY_ORDER = ["debug", "info", "warn", "error"] as const;

function severityAtLeast(
  value: HarnessEvent["severity"],
  floor: HarnessEvent["severity"],
): boolean {
  const v = SEVERITY_ORDER.indexOf(value ?? "info");
  const f = SEVERITY_ORDER.indexOf(floor ?? "info");
  return v >= f;
}

/**
 * Writes JSONL to `<dir>/events-<YYYY-MM-DD>.jsonl`.
 *
 * Buffers writes in-process and appends in order, so concurrent emitters
 * cannot interleave partial lines. Never throws into the caller.
 */
export class JsonlEventSink implements EventSink {
  private queue: Promise<void> = Promise.resolve();
  private readonly redactionCounts: Record<string, number> = {};
  private readonly dir: string;
  private readonly minSeverity: HarnessEvent["severity"];
  private readonly alsoPrint: boolean;

  constructor(
    dir: string,
    minSeverity: HarnessEvent["severity"] = "info",
    alsoPrint = false,
  ) {
    this.dir = dir;
    this.minSeverity = minSeverity;
    this.alsoPrint = alsoPrint;
  }

  /** Cumulative count of redactions by rule name - proof the stage is active. */
  redactionStats(): Record<string, number> {
    return { ...this.redactionCounts };
  }

  emit(event: HarnessEvent): void {
    if (!severityAtLeast(event.severity, this.minSeverity)) return;

    let line: string;
    try {
      // THE redaction boundary. Everything written passes through here.
      const safe = redactValue({ ...event, ts: event.ts ?? new Date().toISOString() });

      // tally what we removed, using the redacted structure only
      const asText = JSON.stringify(safe);
      for (const marker of asText.matchAll(/<redacted:([a-z0-9-]+)>/g)) {
        const rule = marker[1];
        this.redactionCounts[rule] = (this.redactionCounts[rule] ?? 0) + 1;
      }

      line = asText;
    } catch {
      // FAIL CLOSED: never write the original payload if redaction broke.
      line = JSON.stringify({
        ts: new Date().toISOString(),
        kind: "harness.error",
        session: "harness",
        severity: "error",
        data: "<redacted:event-redaction-failed>",
      });
    }

    if (this.alsoPrint) {
      process.stdout.write(line + "\n");
    }

    const file = path.join(this.dir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    this.queue = this.queue
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(file, line + "\n", "utf8");
      })
      .catch(() => {
        /* logging must never break the caller */
      });
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}

/** In-memory sink for tests and for the UI's recent-events list. */
export class MemoryEventSink implements EventSink {
  readonly events: HarnessEvent[] = [];
  private readonly limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  emit(event: HarnessEvent): void {
    if (!severityAtLeast(event.severity, "debug")) return;
    this.events.push(redactValue(event) as HarnessEvent);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }

  async flush(): Promise<void> {
    /* nothing buffered */
  }
}

/** Fans an event out to several sinks; one failing sink cannot break another. */
export class MultiEventSink implements EventSink {
  private readonly sinks: EventSink[];

  constructor(sinks: EventSink[]) {
    this.sinks = sinks;
  }

  emit(event: HarnessEvent): void {
    for (const s of this.sinks) {
      try {
        s.emit(event);
      } catch {
        /* isolate */
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.flush()));
  }
}

/**
 * Create an event emitter bounded to one session. This is the ergonomic entry
 * point: pick the session kind once, then emit correlated events.
 */
export function sessionEmitter(
  sink: EventSink,
  session: SessionKind,
  context: Omit<HarnessEvent, "ts" | "kind" | "session"> = {},
) {
  return {
    emit(kind: EventKind, extra: Partial<HarnessEvent> = {}): void {
      sink.emit({
        ts: new Date().toISOString(),
        kind,
        session,
        ...context,
        ...extra,
      });
    },
  };
}
