/**
 * In-process test runner.
 *
 * `node --test` spawns a child process per file, which the DSH file sandbox
 * blocks with `spawn EPERM`. This runner exercises the same assertions in a
 * single process so the suite is runnable in a confined shell.
 *
 * Usage:  node test/run-tests.ts
 * Exit:   0 all passed, 1 one or more failed.
 */
import assert from "node:assert/strict";

import {
  redactString,
  redactValue,
  redactJson,
  isSensitiveKey,
  MASK,
} from "../src/security/redact.ts";

let passed = 0;
const failures: Array<{ name: string; error: unknown }> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}`);
  }
}

console.log("redaction\n");

test("redacts an OpenAI-style API key", () => {
  const secret = "sk-aint-0LcsVpp9ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  const { text, counts, total } = redactString(`key is ${secret} ok`);
  assert.equal(text.includes(secret), false);
  assert.match(text, /<redacted:openai-style-key>/);
  assert.equal(total > 0, true);
  assert.equal(counts["openai-style-key"] >= 1, true);
  assert.match(text, /^key is /);
  assert.match(text, / ok$/);
});

test("redacts a GitHub fine-grained PAT and a classic gh token", () => {
  const { text } = redactString(
    "t=github_pat_11ABCDEFG0123456789_abcdefghijklmnop and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  );
  assert.equal(text.includes("github_pat_"), false);
  assert.equal(text.includes("ghp_"), false);
});

test("redacts a Tailscale auth key", () => {
  const { text } = redactString("up --auth-key=tskey-auth-kAbC123EXAMPLEKEYvalue --hostname=x");
  assert.equal(text.includes("tskey-auth-"), false);
  assert.match(text, /--auth-key=<redacted:tailscale-authkey>/);
});

test("redacts an Authorization header but keeps the scheme", () => {
  const { text } = redactString("Authorization: Bearer abcDEF123456.ghiJKL");
  assert.equal(text.includes("abcDEF123456"), false);
  assert.match(text, /Authorization: Bearer <redacted>/);
});

test("redacts an assigned secret but keeps the key name", () => {
  const { text } = redactString('MASTER_KEY="c3VwZXJzZWNyZXR2YWx1ZTEyMzQ1Njc4OTA="');
  assert.equal(text.includes("c3VwZXJzZWNyZXR2YWx1ZTEyMzQ1Njc4OTA"), false);
  assert.match(text, /MASTER_KEY=.*<redacted>/);
});

test("redacts a PEM private key block", () => {
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const { text } = redactString(`here:\n${pem}\ndone`);
  assert.equal(text.includes("MIIEowIBAAKCAQEA"), false);
  assert.match(text, /<redacted:pem-private-key>/);
  assert.match(text, /^here:/);
  assert.match(text, /done$/);
});

test("redacts an SSH private key block", () => {
  const pem =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
  const { text } = redactString(pem);
  assert.equal(text.includes("b3BlbnNzaC1rZXktdjEAAAAA"), false);
});

test("leaves ordinary text completely untouched", () => {
  const plain =
    "The workspace tree lists 12 files. git status: clean, branch main. CPU 6 cores, 7.9 GB RAM.";
  const { text, total } = redactString(plain);
  assert.equal(text, plain);
  assert.equal(total, 0);
});

test("isSensitiveKey flags credential-ish property names", () => {
  for (const k of [
    "password",
    "JWT_SECRET",
    "api_key",
    "apiKey",
    "private_key",
    "MASTER_KEY",
    "Authorization",
    "Set-Cookie",
    "AINTERCEPTOR_GOOGLE_CLIENT_SECRET",
    "tailscaleAuthKey",
  ]) {
    assert.equal(isSensitiveKey(k), true, `expected ${k} to be sensitive`);
  }
  for (const k of ["hostname", "port", "branch", "provider", "model", "cwd"]) {
    assert.equal(isSensitiveKey(k), false, `expected ${k} to be safe`);
  }
});

test("redactValue masks sensitive KEYS wholesale and keeps safe ones", () => {
  const input = {
    hostname: "ainterceptor",
    port: 22,
    password: "hunter2hunter2",
    nested: { JWT_SECRET: "abcdef0123456789abcdef0123456789", branch: "main" },
  };
  const out = redactValue(input) as Record<string, unknown>;
  assert.equal(out.hostname, "ainterceptor");
  assert.equal(out.port, 22);
  assert.equal(out.password, MASK);
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.JWT_SECRET, MASK);
  assert.equal(nested.branch, "main");
});

test("redactValue is cycle-safe and depth-limited", () => {
  const a: Record<string, unknown> = { name: "a" };
  a.self = a;
  const out = redactValue(a) as Record<string, unknown>;
  assert.equal(out.name, "a");
  assert.equal(out.self, "<cycle>");

  let deep: Record<string, unknown> = { end: true };
  for (let i = 0; i < 30; i++) deep = { down: deep };
  const s = redactJson(deep);
  assert.match(s, /depth-limit/);
});

test("redactValue handles Errors without leaking a token in the stack", () => {
  const err = new Error("request failed: Authorization: Bearer supersecrettoken123");
  err.stack = "Error: boom\n    at https://api.example.com/?access_token=abcdef123456";
  const out = redactValue(err) as Record<string, unknown>;
  assert.equal(String(out.message).includes("supersecrettoken123"), false);
  assert.equal(String(out.stack).includes("abcdef123456"), false);
});

test("redacted JSON never contains the original secret", () => {
  const secret = "ghp_" + "A".repeat(36);
  const payload = { provider: "deepseek", token: secret, note: `used ${secret}` };
  const json = redactJson(payload);
  assert.equal(json.includes(secret), false);
  assert.match(json, /<redacted/);
});

test("multiple secrets of different kinds in one line are all removed", () => {
  const line =
    "auth=Authorization: Bearer aaaBBBcccDDD111 tskey-auth-abcdefGHIJKL key=sk-aint-ZZZZZZZZZZZZZZZZZZZZZZZZ";
  const { text, counts } = redactString(line);
  assert.equal(/Bearer aaaBBBcccDDD111/.test(text), false);
  assert.equal(text.includes("tskey-auth-"), false);
  assert.equal(text.includes("sk-aint-ZZZZ"), false);
  assert.equal(Object.keys(counts).length >= 2, true);
});

console.log();
if (failures.length > 0) {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) {
    console.log(`--- ${f.name} ---`);
    console.log(f.error instanceof Error ? f.error.message : String(f.error));
    console.log();
  }
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
