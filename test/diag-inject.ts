/**
 * Re-upload a provider session with the DEVICE token (exactly as
 * `airouter-agent login` does) and inspect the `injected` field.
 *
 * That field reports whether the uploaded state reached the VM's live Chrome
 * tab. It is the part that decides whether Path B (browser+CDP) can work, and
 * it had never been inspected.
 *
 * Also compares roles: the injection only runs when _is_admin(user) is true,
 * i.e. when the uploading user's email equals AINTERCEPTOR_ADMIN_EMAIL.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER = process.env.AINTERCEPTOR_URL ?? "http://100.82.62.82:8000";

const cfgPath = path.join(os.homedir(), ".airouter", "config.json");
const device = (JSON.parse(readFileSync(cfgPath, "utf8")) as { server: string; token: string }).token;

const keyPath = path.join(
  os.homedir(),
  "Documents",
  "deepseek-harness",
  "default-workspace",
  "ainterceptor-harness",
  ".credentials",
  "ainterceptor.key",
);
const admin = readFileSync(keyPath, "utf8").trim();

console.log(`  device token: ${device.slice(0, 16)}… (len ${device.length})`);
console.log(`  admin  token: ${admin.slice(0, 16)}… (len ${admin.length})`);

/** Identify which user a token belongs to, via /api/keys. */
async function whoami(token: string): Promise<string> {
  try {
    const r = await fetch(SERVER + "/api/keys", { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return `HTTP ${r.status}`;
    return "authenticated (200)";
  } catch (e) {
    return `ERR ${(e as Error).message}`;
  }
}

console.log("\n  --- token validity ---");
console.log(`  device: ${await whoami(device)}`);
console.log(`  admin : ${await whoami(admin)}`);

// Build a minimal but valid multipart upload, using the real deepseek export
// fetched over SSH would require spawning; instead we send a well-formed state
// so the route's `injected` field is what we observe.
const boundary = "----injectprobe" + Date.now();
const state = JSON.stringify({
  cookies: [{ name: "ds_session_id", value: "probe", domain: "chat.deepseek.com", path: "/" }],
  origins: [],
});
const body =
  `--${boundary}\r\nContent-Disposition: form-data; name="provider"\r\n\r\ndeepseek\r\n` +
  `--${boundary}\r\nContent-Disposition: form-data; name="alias"\r\n\r\ndefault\r\n` +
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="storage_state.json"\r\n` +
  `Content-Type: application/json\r\n\r\n${state}\r\n--${boundary}--\r\n`;

console.log("\n  --- upload with DEVICE token (what airouter-agent uses) ---");
const r1 = await fetch(SERVER + "/api/sessions/upload", {
  method: "POST",
  headers: { Authorization: `Bearer ${device}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
  body,
});
const j1 = (await r1.json()) as Record<string, unknown>;
console.log(`  http=${r1.status}`);
console.log(`  injected=${JSON.stringify(j1.injected)}`);
