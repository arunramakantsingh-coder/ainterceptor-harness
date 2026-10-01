/**
 * Guard tests for the AI-backend and credentials seams.
 *
 * The most important test here is the ARCHITECTURAL one: the harness must
 * never import a model-provider SDK. Provider choice belongs to AInterceptor.
 * If someone later adds `import OpenAI from "openai"`, this suite fails.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeSecret, isSecretRef, refFromEnv, refFromFile, resolveSecret } from "../src/security/credentials.ts";
import { loadConfig, redactedConfigView } from "../src/config.ts";
import { MemoryEventSink, sessionEmitter } from "../src/events.ts";
import { redactString } from "../src/security/redact.ts";

let passed = 0;
const failures: Array<{ name: string; error: unknown }> = [];

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok   ${name}`);
    })
    .catch((error) => {
      failures.push({ name, error });
      console.log(`  FAIL ${name}`);
    });
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

export async function run(): Promise<void> {
  console.log("credentials\n");

  await test("recognises reference shapes and rejects raw values", () => {
    assert.equal(isSecretRef("env:MY_KEY"), true);
    assert.equal(isSecretRef("file:~/some/key.txt"), true);
    assert.equal(isSecretRef("sk-aint-realkeyvalue"), false);
    assert.equal(isSecretRef(""), false);
    assert.equal(isSecretRef(undefined), false);
  });

  await test("describeSecret reports presence and length WITHOUT the value", async () => {
    process.env.__HARNESS_TEST_KEY = "super-secret-value-123";
    const meta = await describeSecret(refFromEnv("__HARNESS_TEST_KEY"));
    assert.equal(meta.present, true);
    assert.equal(meta.source, "env");
    assert.equal(meta.length, "super-secret-value-123".length);
    // the metadata object must not carry the value anywhere
    assert.equal(JSON.stringify(meta).includes("super-secret-value"), false);
    delete process.env.__HARNESS_TEST_KEY;
  });

  await test("describeSecret reports a missing secret honestly", async () => {
    const meta = await describeSecret(refFromEnv("__DEFINITELY_NOT_SET__"));
    assert.equal(meta.present, false);
    assert.equal(meta.length, 0);
  });

  await test("resolveSecret returns the value only to a direct caller", async () => {
    process.env.__HARNESS_TEST_KEY2 = "another-secret";
    assert.equal(await resolveSecret(refFromEnv("__HARNESS_TEST_KEY2")), "another-secret");
    delete process.env.__HARNESS_TEST_KEY2;
  });

  await test("resolveSecret returns undefined for a bad reference", async () => {
    assert.equal(await resolveSecret("not-a-ref"), undefined);
    assert.equal(await resolveSecret(refFromFile("~/definitely/not/here.txt")), undefined);
  });

  console.log("\nconfig\n");

  await test("loadConfig carries only a REFERENCE, never a key value", () => {
    const cfg = loadConfig({ ainterceptor: { ...loadConfig().ainterceptor, apiKeyRef: refFromEnv("X") } });
    assert.equal(isSecretRef(cfg.ainterceptor.apiKeyRef), true);
  });

  await test("redactedConfigView never contains a secret value", () => {
    const cfg = loadConfig();
    const view = redactedConfigView(cfg) as unknown as Record<string, unknown>;
    const text = JSON.stringify(view);
    // it must show the reference shape...
    assert.match(text, /"apiKeyRef"/);
    // ...and must never carry a key-looking literal
    assert.equal(/\bsk-[A-Za-z0-9]{16,}/.test(text), false);
    // ssh identity is deliberately not exposed
    assert.equal(text.includes("sshIdentity"), false);
  });

  await test("default hosts include a local target and the VM over ssh", () => {
    const cfg = loadConfig();
    const ids = cfg.hosts.map((h) => h.id);
    assert.equal(ids.includes("local"), true);
    assert.equal(ids.includes("vm"), true);
    const vm = cfg.hosts.find((h) => h.id === "vm")!;
    assert.equal(vm.transport, "ssh");
  });

  console.log("\nevents\n");

  await test("events are redacted at the sink boundary", () => {
    const sink = new MemoryEventSink();
    const log = sessionEmitter(sink, "ainterceptor", { provider: "deepseek" });
    log.emit("ainterceptor.request.started", {
      requestId: "r1",
      data: {
        note: "Authorization: Bearer abcDEF123456ghi",
        apiKey: "sk-aint-ZZZZZZZZZZZZZZZZZZZZZZZZ",
        model: "deepseek",
      },
    });
    const raw = JSON.stringify(sink.events);
    assert.equal(raw.includes("abcDEF123456ghi"), false);
    assert.equal(raw.includes("sk-aint-ZZZZ"), false);
    // safe fields survive so the event is still useful
    assert.equal(raw.includes("deepseek"), true);
    const ev = sink.events[0];
    assert.equal(ev.kind, "ainterceptor.request.started");
    assert.equal(ev.session, "ainterceptor");
    assert.equal(ev.provider, "deepseek");
  });

  await test("event vocabulary carries the session kinds separately", () => {
    const sink = new MemoryEventSink();
    sessionEmitter(sink, "execution", { host: "vm" }).emit("execution.completed", { data: { exitCode: 0 } });
    sessionEmitter(sink, "ssh", { host: "vm" }).emit("ssh.connected", {});
    assert.deepEqual(
      sink.events.map((e) => e.session),
      ["execution", "ssh"],
    );
  });

  console.log("\narchitecture guard\n");

  await test("NO provider SDK appears anywhere in src/ or package.json", async () => {
    const banned = [
      /from\s+["']openai["']/,
      /from\s+["']@anthropic-ai\//,
      /from\s+["']@google\/generative-ai["']/,
      /from\s+["']@google-cloud\//,
      /from\s+["']cohere-ai["']/,
      /from\s+["']mistralai["']/,
      /from\s+["']@mistralai\//,
      /from\s+["']groq-sdk["']/,
      /from\s+["']ollama["']/,
      /require\(["']openai["']\)/,
    ];
    const files = (await walk(SRC)).filter((f) => /\.(ts|js|mjs)$/.test(f));
    assert.equal(files.length > 0, true, "expected source files to scan");

    const offenders: string[] = [];
    for (const f of files) {
      const text = await readFile(f, "utf8");
      for (const re of banned) {
        if (re.test(text)) offenders.push(`${path.relative(SRC, f)} matches ${re}`);
      }
    }
    assert.deepEqual(offenders, [], `provider SDK import found:\n${offenders.join("\n")}`);
  });

  await test("package.json declares no runtime dependencies", async () => {
    const pkg = JSON.parse(await readFile(path.join(HERE, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  });

  await test("the only model endpoint used is AInterceptor's OpenAI-compatible path", async () => {
    const aiSource = await readFile(path.join(SRC, "ai", "ainterceptor.ts"), "utf8");
    assert.match(aiSource, /\/v1\/chat\/completions/);
    // no other vendor endpoint may be constructed
    for (const host of ["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com"]) {
      assert.equal(aiSource.includes(host), false, `must not call ${host} directly`);
    }
  });

  console.log("\nredaction integration\n");

  await test("a redaction marker proves the stage ran on written events", () => {
    const sink = new MemoryEventSink();
    sessionEmitter(sink, "ssh", {}).emit("ssh.failed", {
      severity: "error",
      data: { stderr: "fatal: Authentication failed for 'https://x-access-token:ghp_" + "B".repeat(36) + "@github.com/x.git'" },
    });
    const raw = JSON.stringify(sink.events);
    assert.equal(raw.includes("ghp_BBBB"), false);
  });

  console.log("");
  if (failures.length > 0) {
    console.log(`${passed} passed, ${failures.length} FAILED\n`);
    for (const f of failures) {
      console.log(`--- ${f.name} ---`);
      console.log(f.error instanceof Error ? f.error.message : String(f.error));
      console.log();
    }
    process.exitCode = 1;
    return;
  }
  console.log(`${passed} passed, 0 failed`);
}
