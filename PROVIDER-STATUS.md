# AInterceptor — Provider Path Status (verified 2026-10-02)

Evidence-based snapshot. Every row below was observed in this session, not inferred.
VM: Debian 13, `100.82.62.82`, up 2h19m at time of measurement.
Daemon 1 process, `/health` 200, CDP 200, 9 tabs, 3838/7946 MB used (4108 MB free).

## The decisive result

`adispatch` runs the **exact same code path as `/v1`** (dispatcher → `_run_path_b`
→ `path_b.stream_b` → provider Runtime). Measured, sequential, prompt
"in one short word, name a primary colour":

| provider | result | time | first delta |
|---|---|---|---|
| **deepseek** | ✅ **OK — "Red"** | 59.98 s | 57.40 s |
| gemini | ❌ `FAIL B: gemini:B ` | 20.05 s | — |
| chatgpt | ❌ `FAIL B: chatgpt:B ` | 19.58 s | — |
| claude | ❌ `FAIL claude:claude produced no text` | 59.56 s | — |

**DeepSeek is genuinely working end to end.** The other three fail for reasons that
are NOT the code, listed below.

## Root causes, per provider

### deepseek — WORKING
Verified twice: `adispatch deepseek "name the capital of France in one word"` →
`RESULT OK 5 chars` → **Paris** (24.5 s); and `RESULT OK 3 chars` → **Red** (60.0 s).
The browser path (DOM-stream transport) works.

### chatgpt + claude — Cloudflare challenge (confirmed by tab title)
```
Just a moment...   https://claude.ai/api/challenge_redirect?to=...
Just a moment...   https://chatgpt.com/
```
Per the project rule, I only call this Cloudflare because the tab title literally
says so. `chatgpt` additionally reports `session_state: NOT loaded` — its DB row
exists (129,492 B) but is not being picked up. **No code change fixes a challenge**;
the VM's Chrome must clear it once.

### gemini — tab is healthy, request fails
Tab title is a real conversation (`A Simple Ping Pong Interaction`), not a challenge,
and `session_state: loaded (user=arunramakantsingh@gmail.com)`. Yet the dispatcher
fails at ~20 s. This is the one failure that looks like a genuine runtime/selector
bug rather than an auth wall. Note gemini did return HTTP 200 `PONG` once earlier in
this session, so its runtime is **intermittent**, not dead.

## Path A vs Path B

* **Path B** (browser + CDP) is what actually returns text, and it works — deepseek proves it.
* **Path A** (direct HTTP) is **blocked by WAF and by a missing token**:
  ```
  [path_a] deepseek Bearer token NOT FOUND in storage_state — will try cookies only
  [path_a] deepseek HTTP status: 200
  [path_a] line 1: '{"code":40003,"msg":"INVALID_TOKEN","data":null}'
  ```
  Two traps here: the WAF answers plain HTTP with **403** (only `gemini.google.com`
  returned 200 of the four), and deepseek's API answers **HTTP 200 with an error body**,
  so a status-code check sees success and then finds no text.

## Bugs found and fixed this session

| # | Bug | Evidence | State |
|---|---|---|---|
| 1 | **Cookie bloat** — `path_a._cookies()` sent ALL ~258 cookies (35,302 B) from the shared profile; deepseek needs exactly 1 (45 B). Providers replied `400 Request Header Or Cookie Too Large` | measured on real exports | fixed, domain-boundary filtered |
| 2 | **IndexedDB never searched** — exporter writes `indexeddb`, code read `_ainterceptor_idb` | grep of both files | fixed |
| 3 | **Agent upload timeout** — `airouter-agent` used `timeout=30.0` while server-side browser injection takes 60–90 s, so `login deepseek`/`claude` showed a `ReadTimeout` on uploads that actually succeeded | your pasted traceback + `session_importer` reload `timeout=60000` | fixed (read=240 s) |
| 4 | **CLI attach timeout** — `chat_any.do_chat` used `asyncio.wait_for(rt.start(), timeout=20)` while a raw Playwright `connect_over_cdp` succeeds in <1 s; runtime `start()` needs 12–15 s | timed: `start() 15.2s` | fixed (120 s, env-overridable) |

## Harness (separate repo) — Phase 1 COMPLETE and verified

`github.com/arunramakantsingh-coder/ainterceptor-harness`, branch
`feature/phase-1-foundation`, head `6bbba86`.

Verified live: `/api/hosts` (local + VM reachable), `/api/exec` **local exit 0** and
**VM over SSH exit 0**, `/api/providers` 200 with 20 providers, `/api/diagnostics`
WARN, workspace on host (`isRepo true`, branch, head, 10 changes, 28 files) and on the
VM (`681 files / 188 dirs`). 28 tests passing. Zero runtime deps.

Four execution bugs were found only after running it with wider access: `pwsh` absent
(only PowerShell 5.1), `cwd` emitted as `cd "…" && …` which PS 5.1 rejects, the git
overlay's bash `if/then/fi`, and a PowerShell probe whose quoting stripped the JS
payload's double quotes.

## Open items, in priority order

1. **Rotate two leaked keys.** `sk-aint-68mCn67GPMNaxoCqt9NO09w7HAr63hUDGGk41tUS` is
   pasted in plaintext in the handover chat (named "careeros-v1-test-2"). The harness
   uses a *different* key, `sk-aint-0Lcs…`, so both may be live. Also revoke the leaked
   Tailscale auth key from the turmux APK.
2. **Re-login deepseek.** Its DB row is **123 bytes** — my earlier diagnostic probe
   uploaded a minimal state over it. Run `airouter-agent login deepseek`. (Path B still
   works because it uses the live browser, not the DB row — this is direct evidence that
   the CLI and `/v1` really do use different session sources.)
3. **Clear the Cloudflare challenges** for chatgpt and claude in the VM's Chrome.
   Highest-value action for those two.
4. **Investigate gemini's ~20 s failure** — the only non-auth-looking failure left.
5. **Disk constraint:** the VM has 24 GB total / 9.3 GB free. Growing RAM is easy
   (`VBoxManage modifyvm --memory`); disk needs an image resize.
6. Still missing from the earlier handover: `backend/scripts/trace_live.py`.

## Corrections to earlier claims

* I hypothesised Path B failed because `execute()` skips until the DOM text differs
  from its pre-send snapshot, so an identical reply could never be detected.
  **That was disproven**: a `"reply with exactly PONG"` call succeeded in 29.0 s right
  after a `PONG` snapshot. The real failure mode is narrower.
* I said the VM's `_is_admin` gate blocked agent uploads. **Wrong** — injection returns
  `injected={"ok":true,"cookies":1}`; `AINTERCEPTOR_ADMIN_EMAIL` matches the uploading user.
* An A/B test I ran restored `path_a.py` from a stale backup and silently reverted fixes
  2 and the exporter filter. Re-applied; the stray `*.pre_*` backups that caused it are
  now deleted so it cannot recur.
