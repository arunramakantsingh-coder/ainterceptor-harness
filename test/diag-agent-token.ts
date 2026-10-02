/**
 * Verify the airouter-agent device token against the VM's AInterceptor.
 * Tests the endpoints the login flow depends on:
 *   POST /api/devices/exchange   (connect)
 *   POST /api/sessions/upload    (what login uploads to)
 *   GET  /api/sessions
 * Never prints the token.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const cfgPath = path.join(os.homedir(), ".airouter", "config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { server: string; token: string };
const server = (process.env.AINTERCEPTOR_URL ?? cfg.server).replace(/\/$/, "");
const token = cfg.token;

console.log(`  config     : ${cfgPath}`);
console.log(`  server     : ${server}`);
console.log(`  token      : ${token.slice(0, 16)}… (${token.startsWith("sk-dev-") ? "device" : "other"}, len ${token.length})`);

async function probe(label, url, init) {
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    console.log(`  ${label.padEnd(34)} -> ${r.status}  ${text.slice(0, 150).replace(/\s+/g, " ")}`);
    return { status: r.status, text };
  } catch (err) {
    console.log(`  ${label.padEnd(34)} -> ERR ${(err as Error).message}`);
    return { status: 0, text: "" };
  }
}

console.log("\n--- health (no auth) ---");
await probe("GET /health", server + "/health");

console.log("\n--- device-token auth ---");
await probe("GET /api/sessions (device tok)", server + "/api/sessions", {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
await probe("GET /api/sessions (no auth)", server + "/api/sessions", {
  headers: { Accept: "application/json" },
});
await probe("GET /auth/me (device tok)", server + "/auth/me", {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});

console.log("\n--- upload endpoint: does it accept a multipart POST shape at all? ---");
// Send a deliberately tiny but well-formed multipart body. If the route exists
// and auth passes we expect a validation/parse outcome, not a 401/404.
const boundary = "----harnessprobe" + Date.now();
const state = JSON.stringify({ cookies: [], origins: [] });
const body =
  `--${boundary}\r\n` +
  `Content-Disposition: form-data; name="provider"\r\n\r\n` +
  `deepseek\r\n` +
  `--${boundary}\r\n` +
  `Content-Disposition: form-data; name="alias"\r\n\r\n` +
  `default\r\n` +
  `--${boundary}\r\n` +
  `Content-Disposition: form-data; name="file"; filename="storage_state.json"\r\n` +
  `Content-Type: application/json\r\n\r\n` +
  `${state}\r\n` +
  `--${boundary}--\r\n`;

await probe("POST /api/sessions/upload (device tok)", server + "/api/sessions/upload", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
  },
  body,
});

console.log("\n--- exchange endpoint (needs a valid code; expect a clean error) ---");
await probe("POST /api/devices/exchange (bad code)", server + "/api/devices/exchange", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ code: "0000-0000", device_name: "harness-probe", os: "Windows" }),
});
