/**
 * Credentials seam.
 *
 * Rule from the discovery report (section 11.2): the credentials store holds
 * VALUES; settings hold only REFERENCES. A reference is a string like
 * `env:NAME` or `file:~/path`. Nothing that renders settings or config may
 * ever print a value.
 *
 * Providers own their own values, so AInterceptor's API key lives here rather
 * than being copied into harness settings.
 */
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A pointer to a secret. Safe to log, safe to persist, safe to show in a UI. */
export type SecretRef = string;

export interface SecretMetadata {
  /** The reference itself (safe). */
  ref: SecretRef;
  /** Where the value resolved from. */
  source: "env" | "file" | "unset";
  /** True when a value was actually found. */
  present: boolean;
  /** Character length of the value - never the value. */
  length: number;
}

const ENV_PREFIX = "env:";
const FILE_PREFIX = "file:";

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Validate a reference shape without resolving it. */
export function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "string" &&
    (value.startsWith(ENV_PREFIX) || value.startsWith(FILE_PREFIX)) &&
    value.length > ENV_PREFIX.length
  );
}

/**
 * Metadata about a secret WITHOUT reading or exposing its value.
 * The UI uses this to show "configured / missing" honestly.
 */
export async function describeSecret(ref: SecretRef | undefined): Promise<SecretMetadata> {
  if (!ref || !isSecretRef(ref)) {
    return { ref: ref ?? "", source: "unset", present: false, length: 0 };
  }
  if (ref.startsWith(ENV_PREFIX)) {
    const name = ref.slice(ENV_PREFIX.length);
    const v = process.env[name];
    return {
      ref,
      source: "env",
      present: typeof v === "string" && v.length > 0,
      length: typeof v === "string" ? v.length : 0,
    };
  }
  const p = expandHome(ref.slice(FILE_PREFIX.length));
  try {
    const st = await stat(p);
    if (!st.isFile()) return { ref, source: "file", present: false, length: 0 };
    const content = await readFile(p, "utf8");
    const trimmed = content.trim();
    return { ref, source: "file", present: trimmed.length > 0, length: trimmed.length };
  } catch {
    return { ref, source: "file", present: false, length: 0 };
  }
}

/**
 * Resolve a reference to its value.
 *
 * Deliberately NOT exported through any HTTP route. Callers that need the
 * value are limited to credentialed clients (e.g. the AInterceptor client);
 * everything else must use describeSecret().
 */
export async function resolveSecret(ref: SecretRef | undefined): Promise<string | undefined> {
  if (!ref || !isSecretRef(ref)) return undefined;
  if (ref.startsWith(ENV_PREFIX)) {
    const v = process.env[ref.slice(ENV_PREFIX.length)];
    return v && v.length > 0 ? v : undefined;
  }
  const p = expandHome(ref.slice(FILE_PREFIX.length));
  try {
    const content = await readFile(p, "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** Build a reference. Convenience so callers do not hand-write prefixes. */
export const refFromEnv = (name: string): SecretRef => `${ENV_PREFIX}${name}`;
export const refFromFile = (p: string): SecretRef => `${FILE_PREFIX}${p}`;
