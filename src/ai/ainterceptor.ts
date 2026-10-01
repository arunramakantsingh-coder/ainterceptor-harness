/**
 * The AI backend seam.
 *
 * Phase 1 has exactly ONE implementation: AInterceptor. There is deliberately
 * no OpenAI/Anthropic/DeepSeek SDK anywhere in this package, because provider
 * choice is AInterceptor's concern, not the harness's. The harness sends a
 * model/alias and AInterceptor decides which provider actually serves it.
 *
 * Transport used:
 *   GET  /health              - liveness
 *   GET  /admin/providers     - the provider catalogue (selection UI)
 *   POST /v1/chat/completions - OpenAI-compatible chat, streaming or not
 */
import type { HarnessConfig } from "../config.ts";
import { resolveSecret } from "../security/credentials.ts";
import { redactString } from "../security/redact.ts";
import type { EventSink } from "../events.ts";
import { sessionEmitter } from "../events.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Provider alias or capability; "auto" lets AInterceptor route. */
  model?: string;
  stream?: boolean;
  /** Caller-supplied correlation id, propagated into events. */
  requestId?: string;
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  detail?: string;
  /** Provider names reported active by AInterceptor, when known. */
  activeProviders?: string[];
}

export interface ProviderInfo {
  name: string;
  status?: string;
  phase?: string;
  session?: string;
}

/**
 * Raised for any backend failure. The message is already redacted, so it is
 * safe to surface in the UI and the event log.
 */
export class AiBackendError extends Error {
  readonly status?: number;
  readonly kind: "network" | "auth" | "unavailable" | "bad-response";

  constructor(
    message: string,
    status?: number,
    kind: "network" | "auth" | "unavailable" | "bad-response" = "network",
  ) {
    super(message);
    this.name = "AiBackendError";
    this.status = status;
    this.kind = kind;
  }
}

export interface AiBackend {
  readonly name: string;
  probe(): Promise<ProbeResult>;
  providers(): Promise<ProviderInfo[]>;
  chat(req: ChatRequest): Promise<string>;
  streamChat(req: ChatRequest, onDelta: (delta: string) => void): Promise<string>;
}

export class AInterceptorBackend implements AiBackend {
  readonly name = "ainterceptor";
  private readonly cfg: HarnessConfig;
  private readonly events: EventSink;

  constructor(cfg: HarnessConfig, events: EventSink) {
    this.cfg = cfg;
    this.events = events;
  }

  private log() {
    return sessionEmitter(this.events, "ainterceptor", {
      provider: this.cfg.ainterceptor.baseUrl,
    });
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const key = await resolveSecret(this.cfg.ainterceptor.apiKeyRef);
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  /** Never include the body of a failed response - it may echo a credential. */
  private safeDetail(text: string, limit = 240): string {
    return redactString(text.slice(0, limit)).text;
  }

  async probe(): Promise<ProbeResult> {
    const url = new URL("/health", this.cfg.ainterceptor.baseUrl).toString();
    try {
      const res = await fetch(url, {
        headers: await this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return { ok: false, status: res.status, detail: `GET /health -> ${res.status}` };
      }
      const body = (await res.json()) as Record<string, unknown>;
      const active = Array.isArray(body.providers_active)
        ? (body.providers_active as string[])
        : undefined;
      return { ok: true, status: res.status, activeProviders: active };
    } catch (err) {
      return { ok: false, detail: this.safeDetail(err instanceof Error ? err.message : String(err)) };
    }
  }

  /**
   * The provider catalogue.
   *
   * Discovered behaviour: `/admin/providers` exists on the running build but
   * rejects the same `sk-aint-…` key that `/v1/chat/completions` accepts
   * (401 with auth, 422 without). So we try the admin route first and fall
   * back to `/health`, which reports `providers_active` / `providers_inactive`
   * and needs no admin scope. The harness must not break just because an
   * admin surface is locked down.
   */
  async providers(): Promise<ProviderInfo[]> {
    try {
      const viaAdmin = await this.providersViaAdmin();
      if (viaAdmin.length > 0) return viaAdmin;
    } catch {
      // fall through to /health
    }
    return this.providersViaHealth();
  }

  private async providersViaAdmin(): Promise<ProviderInfo[]> {
    const url = new URL("/admin/providers", this.cfg.ainterceptor.baseUrl).toString();
    const res = await fetch(url, {
      headers: await this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new AiBackendError(`GET /admin/providers -> ${res.status}`, res.status, "unavailable");
    }
    const body = (await res.json()) as unknown;
    const list = Array.isArray(body)
      ? body
      : Array.isArray((body as { providers?: unknown[] }).providers)
        ? (body as { providers: unknown[] }).providers
        : [];
    return list.map((p) => {
      const o = p as Record<string, unknown>;
      return {
        name: String(o.name ?? "unknown"),
        status: o.status === undefined ? undefined : String(o.status),
        phase: o.phase === undefined ? undefined : String(o.phase),
        session: o.session === undefined ? undefined : String(o.session),
      };
    });
  }

  /** Fallback that works with a plain API key. */
  private async providersViaHealth(): Promise<ProviderInfo[]> {
    const url = new URL("/health", this.cfg.ainterceptor.baseUrl).toString();
    try {
      const res = await fetch(url, {
        headers: await this.headers(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new AiBackendError(`GET /health -> ${res.status}`, res.status, "unavailable");
      const body = (await res.json()) as Record<string, unknown>;
      const active = Array.isArray(body.providers_active) ? (body.providers_active as string[]) : [];
      const inactive = Array.isArray(body.providers_inactive) ? (body.providers_inactive as string[]) : [];
      return [
        ...active.map((name) => ({ name, status: "active" })),
        ...inactive.map((name) => ({ name, status: "inactive" })),
      ];
    } catch (err) {
      if (err instanceof AiBackendError) throw err;
      throw new AiBackendError(
        this.safeDetail(err instanceof Error ? err.message : String(err)),
        undefined,
        "network",
      );
    }
  }

  async chat(req: ChatRequest): Promise<string> {
    let out = "";
    await this.streamChat(req, (d) => {
      out += d;
    });
    return out;
  }

  /**
   * Streaming chat. Parses OpenAI-style SSE: lines beginning `data:`, a
   * `[DONE]` sentinel, and `choices[0].delta.content`. Errors reported by
   * AInterceptor inside the stream are surfaced as AiBackendError.
   */
  async streamChat(req: ChatRequest, onDelta: (delta: string) => void): Promise<string> {
    const log = this.log();
    const model = req.model ?? this.cfg.ainterceptor.defaultModel;
    const requestId = req.requestId ?? `req-${Date.now().toString(36)}`;

    log.emit("ainterceptor.request.started", {
      requestId,
      provider: model,
      data: { model, messageCount: req.messages.length, stream: true },
    });

    const url = new URL("/v1/chat/completions", this.cfg.ainterceptor.baseUrl).toString();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...(await this.headers()), Accept: "text/event-stream" },
        body: JSON.stringify({ model, stream: true, messages: req.messages }),
        signal: AbortSignal.timeout(this.cfg.ainterceptor.timeoutMs),
      });
    } catch (err) {
      const detail = this.safeDetail(err instanceof Error ? err.message : String(err));
      log.emit("ainterceptor.request.failed", { requestId, provider: model, data: { detail } });
      throw new AiBackendError(detail, undefined, "network");
    }

    if (res.status === 401 || res.status === 403) {
      const detail = `AInterceptor rejected the API key (${res.status}). Check the key reference.`;
      log.emit("provider.auth.failed", { requestId, provider: model, severity: "error", data: { detail } });
      throw new AiBackendError(detail, res.status, "auth");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail = `AInterceptor ${res.status}: ${this.safeDetail(text)}`;
      if (res.status === 429) {
        log.emit("provider.rate_limited", { requestId, provider: model, severity: "warn", data: { detail } });
      } else {
        log.emit("ainterceptor.request.failed", { requestId, provider: model, data: { detail } });
      }
      throw new AiBackendError(detail, res.status, "unavailable");
    }

    if (!res.body) {
      throw new AiBackendError("AInterceptor returned no response body", res.status, "bad-response");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assembled = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        for (const rawLine of frame.split("\n")) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue; // tolerate partial frames
          }

          // AInterceptor reports in-stream failures as {error:{message,type}}
          const errField = parsed.error as { message?: string; type?: string } | undefined;
          if (errField) {
            const detail = this.safeDetail(
              `${errField.type ?? "error"}: ${errField.message ?? "unknown"}`,
            );
            log.emit("ainterceptor.request.failed", {
              requestId,
              provider: model,
              severity: "error",
              data: { detail },
            });
            throw new AiBackendError(detail, undefined, "unavailable");
          }

          const choices = parsed.choices as
            | Array<{ delta?: { content?: string }; message?: { content?: string } }>
            | undefined;
          const delta = choices?.[0]?.delta?.content ?? choices?.[0]?.message?.content ?? "";
          if (typeof delta === "string" && delta.length > 0) {
            assembled += delta;
            onDelta(delta);
          }
        }
      }
    }

    log.emit("ainterceptor.request.completed", {
      requestId,
      provider: model,
      data: { chars: assembled.length },
    });
    return assembled;
  }
}
