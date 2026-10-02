/**
 * Why does the git overlay report isRepo:false for a real repo?
 * Run the same script the store uses, through the executor, and show raw output.
 */
import { loadConfig } from "../src/config.ts";
import { Executor } from "../src/exec/executor.ts";
import { MemoryEventSink } from "../src/events.ts";

const cfg = loadConfig();
const ex = new Executor(cfg, new MemoryEventSink());

const ROOT = "C:/Users/Arun/Documents/deepseek-harness/default-workspace/ainterceptor-harness";

// The exact script shape from workspace/store.ts
const script = [
  "set -u",
  'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "ISREPO=0"; exit 0; fi',
  'echo "ISREPO=1"',
  'echo "BRANCH=$(git branch --show-current 2>/dev/null)"',
  'echo "HEAD=$(git rev-parse --short HEAD 2>/dev/null)"',
  'echo "COUNTS=$(git rev-list --left-right --count @{upstream}...HEAD 2>/dev/null || echo "")"',
  'echo "CHANGES_BEGIN"',
  "git status --porcelain=v1 2>/dev/null | head -100",
  'echo "CHANGES_END"',
].join("\n");

for (const local of [true, false]) {
  const command = local ? `cd ${JSON.stringify(ROOT)} && ${script}` : script;
  const res = await ex.run({
    target: "local",
    command,
    cwd: local ? undefined : ROOT,
    permission: "read",
    timeoutMs: 30_000,
  });
  console.log(`\n=== ${local ? "cd-prefix" : "cwd-option"} ===`);
  console.log("  exit:", res.exitCode);
  console.log("  stdout:", JSON.stringify(res.stdout.slice(0, 400)));
  console.log("  stderr:", JSON.stringify(res.stderr.slice(0, 400)));
}

// Does a bare git command work at all?
const bare = await ex.run({ target: "local", command: "git rev-parse --is-inside-work-tree", cwd: ROOT, permission: "read" });
console.log("\n=== bare git rev-parse with cwd ===");
console.log("  exit:", bare.exitCode, "stdout:", JSON.stringify(bare.stdout), "stderr:", JSON.stringify(bare.stderr.slice(0, 200)));
