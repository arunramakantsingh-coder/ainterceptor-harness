/**
 * Redaction - the single choke point for every log line and every event.
 *
 * Design rules (from the discovery report, section 10.3):
 *   - ONE stage, applied at the write boundary. Not per call site.
 *   - FAIL CLOSED: if the redactor itself throws, we emit a placeholder
 *     rather than the raw text.
 *   - Secrets may be DETECTED and their metadata reported, never their value.
 *
 * This is deliberately dependency-free. The pattern corpus below is modelled
 * on well-known secret shapes (gitleaks-class rules) but is our own code.
 */

/** A named credential shape. `name` is safe to log; the match is not. */
export interface SecretRule {
  name: string;
  pattern: RegExp;
  /**
   * Replacement. Either a string (may use $1 backreferences) or undefined to
   * use the default `<redacted:NAME>` marker.
   */
  mask?: string;
  /**
   * When true the LAST capture group holds the secret and everything before it
   * is preserved via $1. Avoids having to restate the whole pattern.
   */
  maskLastGroup?: boolean;
  /** The regex has exactly one capture group = the secret. */
  oneGroup?: boolean;
}

/**
 * Ordered most-specific first. Every rule MUST use the global flag so we can
 * replace all occurrences.
 */
export const SECRET_RULES: SecretRule[] = [
  // --- cloud / provider keys -------------------------------------------------
  { name: "github-fine-grained-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "openai-style-key", pattern: /\bsk-(?:aint-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "tailscale-authkey", pattern: /\btskey-[a-z]+-[A-Za-z0-9]{6,}\b/g },
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },

  // --- private key material --------------------------------------------------
  { name: "openssh-private-key", pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g },
  {
    name: "pem-private-key",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },

  // --- headers and assignments ----------------------------------------------
  {
    name: "authorization-header",
    // keep the scheme so logs stay diagnosable, drop the credential
    pattern: /\b(Authorization\s*:\s*(?:Bearer|Basic|token|Token)\s+)[A-Za-z0-9._~+/=-]{8,}/g,
    maskLastGroup: true,
  },
  {
    name: "assigned-secret",
    // keep the key name, mask the value.
    // Covers:  API_KEY=…   MASTER_KEY="…"   "password": "…"   tailscale_authkey: …
    pattern:
      /(\b(?:access_token|refresh_token|id_token|api[_-]?key|apikey|token|password|passwd|secret|authkey|master[_-]?key|jwt[_-]?secret|client[_-]?secret)["']?\s*[=:]\s*["']?)([^&\s"',]{6,})/gi,
    maskLastGroup: true,
  },
];

/**
 * Keys whose VALUES must always be masked when they appear in structured
 * data (a JSON log record, a settings object, an env dump).
 */
export const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /pass(word|wd|phrase)?$/i,
  /secret$/i,
  /token$/i,
  /api[_-]?key$/i,
  /private[_-]?key$/i,
  /master[_-]?key$/i,
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /credential/i,
  /authkey/i,
  /^jwt/i,
  /session[_-]?secret/i,
];

export const MASK = "<redacted>";

/** True when a property NAME suggests its value is sensitive. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

export interface RedactionReport {
  text: string;
  /** Rule name -> number of hits. Names only; never the matched values. */
  counts: Record<string, number>;
  total: number;
}

/**
 * Redact a string. Returns the safe text plus a count of what was removed
 * (so we can prove redaction happened without leaking anything).
 */
export function redactString(input: unknown): RedactionReport {
  let text: string;
  try {
    text = typeof input === "string" ? input : String(input);
  } catch {
    return { text: "<redacted:unstringifiable>", counts: {}, total: 0 };
  }

  const counts: Record<string, number> = {};
  let total = 0;

  try {
    for (const rule of SECRET_RULES) {
      // reset lastIndex: the regexes are module-level and stateful
      rule.pattern.lastIndex = 0;
      const matches = text.match(rule.pattern);
      if (!matches || matches.length === 0) continue;
      counts[rule.name] = (counts[rule.name] ?? 0) + matches.length;
      total += matches.length;

      if (rule.maskLastGroup) {
        // keep everything before the final capture group, mask the secret
        text = text.replace(rule.pattern, (_full: string, ...groups: unknown[]) => {
          const head = String(groups[0] ?? "");
          return `${head}${MASK}`;
        });
      } else if (rule.mask) {
        text = text.replace(rule.pattern, rule.mask);
      } else {
        text = text.replace(rule.pattern, `<redacted:${rule.name}>`);
      }
      rule.pattern.lastIndex = 0;
    }
  } catch {
    // FAIL CLOSED: never return text we could not fully process.
    return { text: "<redacted:redactor-error>", counts, total };
  }

  return { text, counts, total };
}

/**
 * Deep-redact structured data. Sensitive KEYS are masked wholesale; string
 * values are run through redactString. Depth-limited and cycle-safe, and it
 * fails closed on any error.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  try {
    if (depth > 12) return "<redacted:depth-limit>";
    if (value === null || value === undefined) return value;

    const t = typeof value;
    if (t === "string") return redactString(value).text;
    if (t === "number" || t === "boolean" || t === "bigint") return value;
    if (t === "function") return "<function>";
    if (t === "symbol") return "<symbol>";

    const obj = value as object;
    if (seen.has(obj)) return "<cycle>";
    seen.add(obj);

    if (Array.isArray(value)) {
      return value.map((v) => redactValue(v, depth + 1, seen));
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message).text,
        // stack frames can embed URLs with tokens
        stack: value.stack ? redactString(value.stack).text : undefined,
      };
    }
    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value.entries()) {
        const key = String(k);
        out[key] = isSensitiveKey(key) ? MASK : redactValue(v, depth + 1, seen);
      }
      return out;
    }
    if (value instanceof Set) {
      return [...value].map((v) => redactValue(v, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? MASK : redactValue(v, depth + 1, seen);
    }
    return out;
  } catch {
    return "<redacted:redactor-error>";
  }
}

/** Convenience: redact then JSON-stringify (safe for any log sink). */
export function redactJson(value: unknown): string {
  try {
    return JSON.stringify(redactValue(value));
  } catch {
    return JSON.stringify("<redacted:unserialisable>");
  }
}
