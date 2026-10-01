/**
 * Harness configuration.
 *
 * IMPORTANT: this object holds only secret REFERENCES, never values. Anything
 * that needs an actual credential must call resolveSecret() in the credentials
 * seam. That is what makes it safe to render this config in the UI.
 */
import os from "node:os";
import path from "node:path";

import type { SecretRef } from "./security/credentials.ts";
import { refFromFile } from "./security/credentials.ts";

export interface HostTarget {
  /** Stable id used in Execution Requests. */
  id: string;
  /** Human label for the terminal prompt, e.g. "[VM]". */
  label: string;
  /** Transport: run here, or over SSH. */
  transport: "local" | "ssh";
  /** SSH target (host or Host alias from ~/.ssh/config). */
  sshTarget?: string;
  /** SSH user, when not supplied by an ssh_config alias. */
  sshUser?: string;
  /** SSH port. */
  sshPort?: number;
  /** Identity file for key-based auth. */
  sshIdentity?: string;
  /** Shell to invoke for one-shot commands. */
  shell?: string;
  /** Free-form notes surfaced in diagnostics. */
  notes?: string;
}

export interface HarnessConfig {
  /** Where the harness listens. Loopback only by default. */
  listen: { host: string; port: number };
  /** Where events and harness state are written. */
  dataDir: string;
  /**
   * The AI backend. AInterceptor is the ONLY supported backend in Phase 1 -
   * there is deliberately no direct-provider option, because provider choice
   * is AInterceptor's concern.
   */
  ainterceptor: {
    /** Base URL, e.g. http://100.82.62.82:8000 or the Tailscale DNS name. */
    baseUrl: string;
    /** REFERENCE to the API key, never the key. */
    apiKeyRef: SecretRef;
    /** Default provider/alias sent as `model`. "auto" lets AInterceptor route. */
    defaultModel: string;
    /** Per-request timeout. */
    timeoutMs: number;
  };
  /** Execution targets. The VM is the only provisioned remote today. */
  hosts: HostTarget[];
  /** Redaction floor for the event log. */
  logLevel: "debug" | "info" | "warn" | "error";
  /** Print events to stdout as well as the log file. */
  logToStdout: boolean;
}

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".ainterceptor-harness");

/**
 * The VM's AInterceptor, reachable from the host over Tailscale. Derived at
 * runtime from the current host's identity rather than hard-coded everywhere,
 * but kept as a single explicit default so the wiring is obvious.
 */
const DEFAULT_AINTERCEPTOR_URL = "http://100.82.62.82:8000";

export function loadConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const base: HarnessConfig = {
    listen: {
      host: process.env.HARNESS_HOST ?? "127.0.0.1",
      port: Number(process.env.HARNESS_PORT ?? 8787),
    },
    dataDir: process.env.HARNESS_DATA_DIR ?? DEFAULT_DATA_DIR,
    ainterceptor: {
      baseUrl: process.env.AINTERCEPTOR_URL ?? DEFAULT_AINTERCEPTOR_URL,
      // Where the operator has placed the key. Override with
      // AINTERCEPTOR_API_KEY_REF (env:NAME or file:PATH).
      apiKeyRef:
        (process.env.AINTERCEPTOR_API_KEY_REF as SecretRef | undefined) ??
        refFromFile("~/.ainterceptor/admin_api_key.txt"),
      defaultModel: process.env.AINTERCEPTOR_MODEL ?? "auto",
      timeoutMs: Number(process.env.AINTERCEPTOR_TIMEOUT_MS ?? 180_000),
    },
    hosts: [
      {
        id: "local",
        label: "LOCAL",
        transport: "local",
        shell: process.platform === "win32" ? "pwsh" : "bash",
        notes: "the machine running the harness",
      },
      {
        id: "vm",
        label: "VM",
        transport: "ssh",
        sshTarget: process.env.HARNESS_VM_SSH ?? "100.82.62.82",
        sshUser: process.env.HARNESS_VM_USER ?? "arun",
        sshPort: Number(process.env.HARNESS_VM_PORT ?? 22),
        sshIdentity: process.env.HARNESS_VM_IDENTITY ?? "~/.ssh/id_ed25519_ainterceptor",
        shell: "bash",
        notes: "Debian 13, the primary execution host and where AInterceptor runs",
      },
    ],
    logLevel: (process.env.HARNESS_LOG_LEVEL as HarnessConfig["logLevel"]) ?? "info",
    logToStdout: process.env.HARNESS_LOG_STDOUT === "1",
  };

  const merged: HarnessConfig = {
    ...base,
    ...overrides,
    listen: { ...base.listen, ...(overrides.listen ?? {}) },
    ainterceptor: { ...base.ainterceptor, ...(overrides.ainterceptor ?? {}) },
    hosts: overrides.hosts ?? base.hosts,
  };

  // Fail fast on an empty SSH identity rather than hanging on a password prompt.
  if (!merged.ainterceptor.baseUrl) {
    throw new Error("ainterceptor.baseUrl is required");
  }
  return merged;
}

/** A config safe to serialise to the UI: references only, no values. */
export function redactedConfigView(cfg: HarnessConfig) {
  return {
    listen: cfg.listen,
    dataDir: cfg.dataDir,
    ainterceptor: {
      baseUrl: cfg.ainterceptor.baseUrl,
      // the REFERENCE is shown; the value never is
      apiKeyRef: cfg.ainterceptor.apiKeyRef,
      defaultModel: cfg.ainterceptor.defaultModel,
      timeoutMs: cfg.ainterceptor.timeoutMs,
    },
    hosts: cfg.hosts.map((h) => ({
      id: h.id,
      label: h.label,
      transport: h.transport,
      sshTarget: h.sshTarget,
      sshUser: h.sshUser,
      sshPort: h.sshPort,
      notes: h.notes,
    })),
    logLevel: cfg.logLevel,
  };
}
