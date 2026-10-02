/**
 * Restore a provider session in the DB from the cold export file.
 *
 * Context: my diagnostic multipart probe posted an EMPTY deepseek session to
 * /api/sessions/upload and replaced the real row. The real captured state still
 * exists at <repo>/.ainterceptor/exports/<provider>.json, so we re-upload that.
 *
 * The export is read on the VM (where it lives) and posted straight back, so it
 * never has to travel through the host.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PROVIDER = process.argv[2] ?? "deepseek";
const KEY_FILE = path.join(
  os.homedir(),
  "Documents",
  "deepseek-harness",
  "default-workspace",
  "ainterceptor-harness",
  ".credentials",
  "ainterceptor.key",
);
const key = readFileSync(KEY_FILE, "utf8").trim();
const SSH_KEY = path.join(os.homedir(), ".ssh", "id_ed25519_ainterceptor");

function ssh(script: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      ["-i", SSH_KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
       "ainterceptor", "bash", "-s"],
      { windowsHide: true },
    );
    let out = "";
    let err = "";
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`ssh exit ${code}: ${err.slice(0, 300)}`));
    });
    child.stdin.end(script, "utf8");
  });
}

// 1. Does the export file exist, and how big is it?
const probe = await ssh(`
cd ~/ainterceptor || exit 1
f=".ainterceptor/exports/${PROVIDER}.json"
if [ -f "$f" ]; then
  echo "exists=1"
  echo "bytes=$(wc -c < "$f")"
  echo "has_cookies=$(python3 -c "import json;d=json.load(open('$f'));print(len(d.get('cookies') or []))" 2>/dev/null || echo 0)"
  echo "captured=$(python3 -c "import json;d=json.load(open('$f'));print(d.get('captured_from',''))" 2>/dev/null || echo '')"
else
  echo "exists=0"
fi
`);
console.log("  export file:\n" + probe.split("\n").map((l) => "    " + l).join("\n"));

if (!/exists=1/.test(probe)) {
  console.error(`\n  [FAIL] no export file for ${PROVIDER}; run: airouter-agent login ${PROVIDER}`);
  process.exit(1);
}

// 2. Re-upload that exact file from the VM side, using curl there so the
//    session content never crosses to the host.
const upload = await ssh(`
cd ~/ainterceptor || exit 1
f=".ainterceptor/exports/${PROVIDER}.json"
curl -s -X POST http://127.0.0.1:8000/api/sessions/upload \
  -H "Authorization: Bearer ${key}" \
  -F "provider=${PROVIDER}" -F "alias=default" \
  -F "file=@$f;type=application/json;filename=storage_state.json" \
  --max-time 60
`);
console.log("\n  upload response:\n    " + upload.slice(0, 400));

// 3. Confirm the row now reports a real cookie count by calling the API for the
//    provider and checking it is not the empty placeholder.
const verify = await ssh(`
cd ~/ainterceptor || exit 1
source .venv/bin/activate 2>/dev/null
export PYTHONPATH=backend
set -a; . ./.env 2>/dev/null; set +a
python3 - <<'PY'
import sys
sys.path.insert(0, "backend")
try:
    from app.db.session import SessionLocal
    from app.db.models import UserSession
    import json
    db = SessionLocal()
    rows = db.query(UserSession).filter(UserSession.provider == "${PROVIDER}").all()
    print(f"rows={len(rows)}")
    for r in rows:
        blob = None
        for attr in ("storage_state", "state", "data", "session_state", "payload"):
            if hasattr(r, attr):
                blob = getattr(r, attr); break
        n = -1
        try:
            n = len((json.loads(blob) or {}).get("cookies") or [])
        except Exception:
            pass
        print(f"  id={r.id[:8]} alias={getattr(r,'alias','?')} cookies={n}")
    db.close()
except Exception as e:
    print("verify error:", type(e).__name__, str(e)[:160])
PY
`);
console.log("\n  db verification:\n" + verify.split("\n").map((l) => "    " + l).join("\n"));
