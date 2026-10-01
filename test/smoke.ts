/**
 * Smoke test the running harness over its HTTP API.
 * Uses Node's own fetch so there is no PowerShell HTTP client in the way.
 */
const BASE = process.env.HARNESS_URL ?? "http://127.0.0.1:8787";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function line(label, v) {
  console.log(`  ${label.padEnd(26)} ${v}`);
}

const health = await call("GET", "/api/health");
line("GET /api/health", health.status);

const cfg = await call("GET", "/api/config");
line("GET /api/config", cfg.status);

console.log("\n--- GET /api/hosts ---");
const hosts = await call("GET", "/api/hosts");
line("status", hosts.status);
if (Array.isArray(hosts.body)) {
  for (const h of hosts.body) {
    line(
      `${h.id} (${h.transport})`,
      h.reachable
        ? `reachable host=${h.identity?.hostname} os=${h.identity?.os} cores=${h.resources?.cpuCores} caps=${h.capabilities?.filter((c) => c.present).length}`
        : `UNREACHABLE ${h.error ?? ""}`,
    );
  }
} else {
  line("body", JSON.stringify(hosts.body).slice(0, 300));
}

console.log("\n--- POST /api/exec local ---");
const local = await call("POST", "/api/exec", { target: "local", command: "node --version" });
line("status", local.status);
if (local.body && typeof local.body === "object" && "stdout" in local.body) {
  line("exit", local.body.exitCode);
  line("transport", local.body.transport);
  line("durationMs", local.body.durationMs);
  line("stdout", JSON.stringify(local.body.stdout.trim()));
  if (local.body.stderr) line("stderr", JSON.stringify(local.body.stderr.slice(0, 200)));
} else {
  line("body", JSON.stringify(local.body).slice(0, 400));
}

console.log("\n--- POST /api/exec vm (ssh) ---");
const vm = await call("POST", "/api/exec", { target: "vm", command: "hostname; nproc; free -m | sed -n 2p" });
line("status", vm.status);
if (vm.body && typeof vm.body === "object" && "stdout" in vm.body) {
  line("exit", vm.body.exitCode);
  line("transport", vm.body.transport);
  line("durationMs", vm.body.durationMs);
  line("stdout", JSON.stringify(vm.body.stdout.trim()));
  if (vm.body.stderr) line("stderr", JSON.stringify(vm.body.stderr.slice(0, 200)));
} else {
  line("body", JSON.stringify(vm.body).slice(0, 400));
}

console.log("\n--- GET /api/providers ---");
const prov = await call("GET", "/api/providers");
line("status", prov.status);
if (prov.body && prov.body.providers) {
  line("backend", prov.body.backend);
  line("count", prov.body.providers.length);
  for (const p of prov.body.providers.slice(0, 6)) {
    line("  " + p.name, `status=${p.status} session=${p.session}`);
  }
} else {
  line("body", JSON.stringify(prov.body).slice(0, 300));
}

console.log("\n--- GET /api/diagnostics ---");
const diag = await call("GET", "/api/diagnostics");
line("status", diag.status);
if (diag.body && diag.body.checks) {
  line("overall", diag.body.overall);
  for (const c of diag.body.checks) {
    line(`  ${c.verdict} ${c.name}`, c.detail.slice(0, 110));
  }
} else {
  line("body", JSON.stringify(diag.body).slice(0, 300));
}

