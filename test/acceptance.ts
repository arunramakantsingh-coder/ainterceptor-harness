/**
 * End-to-end acceptance: real chat through the Harness -> AInterceptor -> provider.
 *
 * These calls are slow by nature. AInterceptor tries Path A (direct HTTP) and
 * then Path B (live browser + CDP), and the browser path alone can take 40-60s.
 * Observed timings: deepseek ~41s, gemini ~36-57s. The harness default is 180s,
 * which is right; do not lower it here or a slow-but-working provider will look
 * like a failure.
 */
const B = "http://127.0.0.1:8787";

async function chat(model: string) {
  const t0 = Date.now();
  const r = await fetch(B + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "reply with exactly PONG" }],
    }),
  });
  const j = (await r.json()) as Record<string, unknown>;
  const ms = Date.now() - t0;
  const text = typeof j.text === "string" ? j.text.trim().slice(0, 70) : undefined;
  return { status: r.status, ms, text, error: j.error as string | undefined };
}

// Run sequentially: AInterceptor shares one browser, and firing concurrent
// provider calls at it makes every one of them slower and flakier.
console.log("=== chat through the harness (/api/chat), one at a time ===");
for (const model of ["deepseek", "gemini", "chatgpt", "claude"]) {
  try {
    const res = await chat(model);
    const ok = res.status === 200 && res.text;
    console.log(
      `  ${ok ? "PASS" : "FAIL"} ${model.padEnd(10)} http=${res.status} ${String(res.ms).padStart(6)}ms  ` +
        (ok ? `text=${JSON.stringify(res.text)}` : `error=${String(res.error).slice(0, 100)}`),
    );
  } catch (e) {
    console.log(`  FAIL ${model.padEnd(10)} ERR ${(e as Error).message}`);
  }
}
