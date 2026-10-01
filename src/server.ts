/**
 * Harness HTTP server.
 *
 * Zero dependencies - node:http only - so there is no build step and nothing
 * to audit beyond this repository. Loopback-only by default.
 *
 * Routes are thin: they validate input and delegate to the seams (AI backend,
 * executor, inventory, workspace store). No route reaches a model directly;
 * every model call goes through the AInterceptor backend.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, redactedConfigView, type HarnessConfig } from "./config.ts";
import { JsonlEventSink, MemoryEventSink, MultiEventSink, sessionEmitter } from "./events.ts";
import { AInterceptorBackend } from "./ai/ainterceptor.ts";
import { Executor } from "./exec/executor.ts";
import { HostInventory, overallVerdict, type DiagnosticCheck } from "./hosts/inventory.ts";
import { WorkspaceStore } from "./workspace/store.ts";
import { describeSecret } from "./security/credentials.ts";
import { redactString } from "./security/redact.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface Harness {
  cfg: HarnessConfig;
  events: MultiEventSink;
  memoryEvents: MemoryEventSink;
  ai: AInterceptorBackend;
  executor: Executor;
  inventory: HostInventory;
  workspaces: WorkspaceStore;
}

export function buildHarness(cfg: HarnessConfig): Harness {
  const memoryEvents = new MemoryEventSink(400);
  const fileEvents = new JsonlEventSink(cfg.dataDir, cfg.logLevel, cfg.logToStdout);
  const events = new MultiEventSink([memoryEvents, fileEvents]);

  const executor = new Executor(cfg, events);
  const inventory = new HostInventory(cfg, executor, events);
  const workspaces = new WorkspaceStore(cfg.dataDir, executor, events);
  const ai = new AInterceptorBackend(cfg, events);

  return { cfg, events, memoryEvents, ai, executor, inventory, workspaces };
}

// ── tiny helpers ─────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limitBytes) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

/** Only these targets may be executed against. */
function assertKnownTarget(h: Harness, target: unknown): string {
  const id = String(target ?? "");
  if (!h.cfg.hosts.some((x) => x.id === id)) {
    throw new Error(`unknown target '${id}'`);
  }
  return id;
}

// ── diagnostics ──────────────────────────────────────────────────────

async function buildDiagnostics(h: Harness, refresh: boolean) {
  const checks: DiagnosticCheck[] = [];

  const cfgKey = await describeSecret(h.cfg.ainterceptor.apiKeyRef);
  const probe = await h.ai.probe();

  checks.push({
    name: "AI backend reachable",
    verdict: probe.ok ? "PASS" : "FAIL",
    detail: probe.ok
      ? `${h.cfg.ainterceptor.baseUrl} answered /health${probe.activeProviders ? ` (active: ${probe.activeProviders.join(", ")})` : ""}`
      : `${h.cfg.ainterceptor.baseUrl} -> ${probe.detail ?? "unreachable"}`,
  });

  checks.push({
    name: "AI backend credential",
    verdict: cfgKey.present ? "PASS" : "WARN",
    detail: cfgKey.present
      ? `reference ${cfgKey.ref} resolved from ${cfgKey.source} (${cfgKey.length} chars)`
      : `reference ${cfgKey.ref || "(none)"} did not resolve; calls will be unauthenticated`,
  });

  const hosts = await h.inventory.all(refresh);
  for (const host of hosts) {
    const missing = host.capabilities.filter((c) => !c.present).map((c) => c.name);
    if (!host.reachable) {
      checks.push({
        name: `host ${host.id}`,
        verdict: "FAIL",
        detail: host.error ?? "unreachable",
      });
      continue;
    }
    const memNote = host.notes.find((n) => n.startsWith("memory pressure"));
    const core = ["git", "python3", "node"].filter((n) =>
      host.capabilities.find((c) => c.name === n)?.present,
    );
    checks.push({
      name: `host ${host.id}`,
      verdict: memNote ? "WARN" : "PASS",
      detail: [
        `${host.identity.hostname ?? "?"} ${host.identity.os ?? ""}`.trim(),
        `${host.resources.cpuCores ?? "?"} cores`,
        host.resources.memAvailableMb !== undefined && host.resources.memTotalMb !== undefined
          ? `${host.resources.memAvailableMb}/${host.resources.memTotalMb} MB free`
          : undefined,
        host.resources.diskFree ? `disk ${host.resources.diskFree}` : undefined,
        `toolchain: ${core.join(", ") || "none"}`,
        memNote,
        missing.length ? `absent: ${missing.join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join(" | "),
    });
  }

  const wsList = await h.workspaces.list();
  checks.push({
    name: "workspaces",
    verdict: "PASS",
    detail: wsList.length === 0 ? "none registered yet" : `${wsList.length} registered`,
  });

  const redactions = h.events.sinks.find((s) => s instanceof JsonlEventSink);
  const stats = redactions && "redactionStats" in redactions
    ? (redactions as JsonlEventSink).redactionStats()
    : {};

  return {
    generatedAt: new Date().toISOString(),
    overall: overallVerdict(checks),
    checks,
    hosts,
    aiBackend: {
      baseUrl: h.cfg.ainterceptor.baseUrl,
      apiKeyRef: h.cfg.ainterceptor.apiKeyRef,
      keyPresent: cfgKey.present,
      reachable: probe.ok,
      detail: probe.detail ?? (probe.ok ? "ok" : "unreachable"),
      activeProviders: probe.activeProviders,
    },
    redactionStats: stats,
  };
}

// ── server ───────────────────────────────────────────────────────────

export function createHarnessServer(h: Harness) {
  const log = sessionEmitter(h.events, "harness");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const p = url.pathname;

    // loopback guard: this process is not a public service
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!isLoopback && h.cfg.listen.host !== "0.0.0.0") {
      json(res, 403, { error: "harness accepts loopback connections only" });
      return;
    }

    try {
      // ---- UI -------------------------------------------------------
      if (p === "/" || p === "/index.html") {
        const html = await readFile(path.join(HERE, "web", "index.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
        return;
      }
      if (p === "/app.js") {
        const js = await readFile(path.join(HERE, "web", "app.js"), "utf8");
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
        res.end(js);
        return;
      }

      // ---- health / config -----------------------------------------
      if (p === "/api/health") {
        json(res, 200, { ok: true, name: "ainterceptor-harness", version: "0.1.0" });
        return;
      }
      if (p === "/api/config") {
        json(res, 200, redactedConfigView(h.cfg));
        return;
      }

      // ---- diagnostics ---------------------------------------------
      if (p === "/api/diagnostics") {
        const refresh = url.searchParams.get("refresh") === "1";
        const report = await buildDiagnostics(h, refresh);
        log.emit("diagnostics.run", { data: { overall: report.overall, checks: report.checks.length } });
        json(res, 200, report);
        return;
      }

      // ---- hosts ---------------------------------------------------
      if (p === "/api/hosts") {
        const refresh = url.searchParams.get("refresh") === "1";
        json(res, 200, await h.inventory.all(refresh));
        return;
      }

      // ---- providers (through AInterceptor only) -------------------
      if (p === "/api/providers") {
        try {
          json(res, 200, { backend: h.ai.name, providers: await h.ai.providers() });
        } catch (err) {
          json(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // ---- workspaces ----------------------------------------------
      if (p === "/api/workspaces" && req.method === "GET") {
        json(res, 200, await h.workspaces.list());
        return;
      }
      if (p === "/api/workspaces" && req.method === "POST") {
        const body = (await readBody(req)) as { path?: string; host?: string };
        if (!body.path) {
          json(res, 400, { error: "path is required" });
          return;
        }
        const target = assertKnownTarget(h, body.host ?? "local");
        const ws = await h.workspaces.open(body.path, target);
        json(res, 201, ws);
        return;
      }
      const wsDetail = /^\/api\/workspaces\/([^/]+)$/.exec(p);
      if (wsDetail && req.method === "GET") {
        const detail = await h.workspaces.detail(decodeURIComponent(wsDetail[1]));
        if (!detail) {
          json(res, 404, { error: "workspace not found" });
          return;
        }
        json(res, 200, detail);
        return;
      }
      if (wsDetail && req.method === "DELETE") {
        const ok = await h.workspaces.remove(decodeURIComponent(wsDetail[1]));
        json(res, ok ? 200 : 404, { removed: ok });
        return;
      }

      // ---- execution ------------------------------------------------
      if (p === "/api/exec" && req.method === "POST") {
        const body = (await readBody(req)) as {
          target?: string;
          command?: string;
          cwd?: string;
          timeoutMs?: number;
        };
        const target = assertKnownTarget(h, body.target);
        if (!body.command || typeof body.command !== "string") {
          json(res, 400, { error: "command is required" });
          return;
        }
        const result = await h.executor.run({
          target,
          command: body.command,
          cwd: body.cwd,
          timeoutMs: Math.min(body.timeoutMs ?? 60_000, 600_000),
          permission: "execute",
        });
        json(res, 200, result);
        return;
      }

      // ---- chat (always via AInterceptor) --------------------------
      if (p === "/api/chat" && req.method === "POST") {
        const body = (await readBody(req)) as {
          messages?: Array<{ role: string; content: string }>;
          model?: string;
        };
        const messages = (body.messages ?? []).map((m) => ({
          role: (["system", "user", "assistant"].includes(m.role) ? m.role : "user") as
            | "system"
            | "user"
            | "assistant",
          content: String(m.content ?? ""),
        }));
        if (messages.length === 0) {
          json(res, 400, { error: "messages is required" });
          return;
        }
        try {
          const text = await h.ai.chat({ messages, model: body.model });
          json(res, 200, { backend: h.ai.name, model: body.model ?? h.cfg.ainterceptor.defaultModel, text });
        } catch (err) {
          json(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // ---- events ---------------------------------------------------
      if (p === "/api/events") {
        json(res, 200, h.memoryEvents.events.slice(-200));
        return;
      }

      json(res, 404, { error: `no route for ${req.method} ${p}` });
    } catch (err) {
      const detail = redactString(err instanceof Error ? err.message : String(err)).text;
      log.emit("harness.error", { severity: "error", data: { detail, path: p } });
      json(res, 400, { error: detail });
    }
  });
}

export async function startServer(cfg = loadConfig()): Promise<void> {
  const h = buildHarness(cfg);
  const server = createHarnessServer(h);

  await new Promise<void>((resolve) => server.listen(cfg.listen.port, cfg.listen.host, resolve));

  const log = sessionEmitter(h.events, "harness");
  log.emit("harness.started", {
    data: { listen: `${cfg.listen.host}:${cfg.listen.port}`, backend: h.ai.name, url: cfg.ainterceptor.baseUrl },
  });

  const url = `http://${cfg.listen.host}:${cfg.listen.port}/`;
  process.stdout.write(`\n  AInterceptor Harness\n`);
  process.stdout.write(`  UI     ${url}\n`);
  process.stdout.write(`  AI     ${cfg.ainterceptor.baseUrl}  (backend: ${h.ai.name})\n`);
  process.stdout.write(`  events ${path.join(cfg.dataDir, "events-*.jsonl")}\n\n`);

  const shutdown = async () => {
    await h.events.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  startServer().catch((err) => {
    process.stderr.write(`failed to start: ${redactString(String(err)).text}\n`);
    process.exit(1);
  });
}
