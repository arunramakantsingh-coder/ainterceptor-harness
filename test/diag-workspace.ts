/**
 * End-to-end proof of the workspace core: register a real directory, walk the
 * REAL filesystem, and read the git overlay.
 */
const B = "http://127.0.0.1:8787";

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(B + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as any };
}

const ROOT = "C:/Users/Arun/Documents/deepseek-harness/default-workspace/ainterceptor-harness";

console.log("=== open the harness repo as a workspace ===");
const open = await call("POST", "/api/workspaces", { path: ROOT, host: "local" });
console.log("  status:", open.status);
console.log("  id    :", open.body.id);
console.log("  root  :", open.body.root);
console.log("  name  :", open.body.name);

console.log("\n=== list workspaces ===");
const list = await call("GET", "/api/workspaces");
console.log("  count:", Array.isArray(list.body) ? list.body.length : list.body);

console.log("\n=== inspect (real tree + git overlay) ===");
const detail = await call("GET", `/api/workspaces/${encodeURIComponent(open.body.id)}`);
const d = detail.body;
console.log("  status      :", detail.status);
console.log("  git.isRepo  :", d.git?.isRepo);
console.log("  git.branch  :", d.git?.branch);
console.log("  git.head    :", d.git?.head);
console.log("  git.clean   :", d.git?.clean);
console.log("  changes     :", (d.git?.changes ?? []).length);
console.log("  tree files  :", d.treeStats?.files);
console.log("  tree dirs   :", d.treeStats?.dirs);
console.log("  truncated   :", d.treeStats?.truncated);

console.log("\n=== is the tree the REAL filesystem? (top level) ===");
for (const n of (d.tree ?? []).slice(0, 12)) {
  console.log(`  ${n.type === "dir" ? "d" : "f"} ${n.name}${n.size !== undefined ? ` (${n.size} B)` : ""}`);
}

console.log("\n=== does a known file appear with the right size? ===");
function find(nodes: any[], name: string): any {
  for (const n of nodes) {
    if (n.name === name) return n;
    if (n.children) {
      const hit = find(n.children, name);
      if (hit) return hit;
    }
  }
  return undefined;
}
for (const [name, expect] of [["package.json", 496], ["redact.ts", 7472]] as Array<[string, number]>) {
  const hit = find(d.tree ?? [], name);
  console.log(`  ${name}: ${hit ? `found size=${hit.size}` : "NOT FOUND"}${hit && expect ? ` (expected ${expect})` : ""}`);
}

console.log("\n=== git overlay on the VM host too ===");
const vmWs = await call("POST", "/api/workspaces", { path: "/home/arun/ainterceptor", host: "vm" });
console.log("  open status:", vmWs.status, "| id:", vmWs.body.id ?? vmWs.body.error);
if (vmWs.body.id) {
  const vd = await call("GET", `/api/workspaces/${encodeURIComponent(vmWs.body.id)}`);
  const v = vd.body;
  console.log("  vm git.isRepo:", v.git?.isRepo, "| branch:", v.git?.branch, "| head:", v.git?.head);
  console.log("  vm changes   :", (v.git?.changes ?? []).length);
  console.log("  vm tree files:", v.treeStats?.files, "dirs:", v.treeStats?.dirs);
  console.log("  vm top level :", (v.tree ?? []).slice(0, 8).map((n: any) => n.name).join(", "));
}
