/**
 * Diagnose why a provider call fails from the host but worked from the VM.
 *
 * Compares several models and prints the raw AInterceptor error plus the
 * backend's own health view. Never prints the API key.
 */
import { readFileSync } from "node:fs";

const key = readFileSync(
  "C:/Users/Arun/Documents/deepseek-harness/default-workspace/ainterceptor-harness/.credentials/ainterceptor.key",
  "utf8",
).trim();

const URLS = [
  { label: "tailscale-ip", base: "http://100.82.62.82:8000" },
  { label: "tailnet-dns", base: "https://ainterceptor.taila2310c.ts.net" },
];

async function j(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

for (const { label, base } of URLS) {
  console.log(`\n================ ${label}  ${base} ================`);

  // 1. health: which providers does AInterceptor think are active?
  try {
    const h = await j(base + "/health", { headers: { Authorization: `Bearer ${key}` } });
    console.log(`  GET /health -> ${h.status}`);
    if (h.body && typeof h.body === "object") {
      const b = h.body as Record<string, unknown>;
      console.log(`    providers_active  : ${JSON.stringify(b.providers_active)}`);
      console.log(`    db                : ${b.db}`);
      const sup = b.supervisor as Record<string, unknown> | undefined;
      if (sup) console.log(`    supervisor.ready  : ${sup.ready}`);
    }
  } catch (err) {
    console.log(`  /health ERR ${(err as Error).message}`);
  }

  // 2. try several models, including auto, so we learn whether it is
  //    provider-specific or global.
  for (const model of ["deepseek", "gemini", "auto"]) {
    try {
      const r = await j(base + "/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: "user", content: "reply with exactly PONG" }],
        }),
      });
      const b = r.body as Record<string, unknown>;
      let summary: string;
      if (b && typeof b === "object" && "choices" in b) {
        const choices = b.choices as Array<{ message?: { content?: string } }>;
        summary = `text=${JSON.stringify(choices?.[0]?.message?.content)}`;
      } else {
        summary = JSON.stringify(b).slice(0, 260);
      }
      console.log(`  POST model=${model.padEnd(9)} -> ${r.status}  ${summary}`);
    } catch (err) {
      console.log(`  POST model=${model.padEnd(9)} -> ERR ${(err as Error).message}`);
    }
  }
}
