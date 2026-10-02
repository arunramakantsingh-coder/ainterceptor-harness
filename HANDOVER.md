# AInterceptor Harness — Handover Note

**Written:** 2026-10-02
**Purpose:** let a *fresh* session continue with zero re-discovery. Read this first; it
is deliberately dense and evidence-based. Anything uncertain is marked **UNVERIFIED**.

---

## 1. Where everything lives

| Thing | Path / address | Notes |
|---|---|---|
| Harness source | `C:\Users\Arun\Documents\deepseek-harness\default-workspace\ainterceptor-harness` | Node 24, native TS, **zero runtime deps, no build step** |
| Harness repo | `https://github.com/arunramakantsingh-coder/ainterceptor-harness` | branch `feature/phase-1-foundation` pushed |
| AInterceptor (VM) | `C:\Users\Arun\VirtualBox VMs\AInterceptor` — Debian 13, **8192 MB**, 6 vCPU | Tailscale `100.82.62.82`, SSH port 22 |
| AInterceptor source | VM: `/home/arun/ainterceptor` — branch `fix/cli-chat-provider-gate-cisco-shell` | also on GitHub |
| AInterceptor (host copy) | `C:\Projects\AInterceptor-M1.5` | same repo, branch `fix/nonclaude-three-providers-20260917`; carries the `airouter-agent` package |
| Discovery report | `…\default-workspace\AInterceptor-Harness-Discovery-Report.md` | 15 sections, 650 lines |
| DSH reference | `…\default-workspace\DSH-ARCHITECTURE-REFERENCE.md` | 969 lines |
| Phone runbook | `…\default-workspace\Phone-Foundation-Runbook.md` | Play→GitHub Termux migration |
| Phone backup script | `…\default-workspace\phone-foundation\backup_termux_home.sh` | run **before** any uninstall |

**SSH:** `ssh -i ~/.ssh/id_ed25519_ainterceptor ainterceptor` (alias in `~/.ssh/config`).
The key was created this engagement; `~/.ssh/config` is otherwise untouched.

---

## 2. How to start everything

```powershell
# 1. VM must be running (it does NOT auto-start)
& "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" startvm "AInterceptor" --type headless
# wait ~20s for SSH

# 2. AInterceptor stack inside the VM (Xvfb + Chrome + daemon)
ssh ainterceptor "setsid bash ~/bin/astart < /dev/null > /tmp/astart.log 2>&1 &"
# first boot of Chrome can take 60-290s; poll:  curl http://100.82.62.82:8000/health

# 3. the Harness on the host
cd C:\Users\Arun\Documents\deepseek-harness\default-workspace\ainterceptor-harness
$env:AINTERCEPTOR_API_KEY_REF = "file:./.credentials/ainterceptor.key"
node src/server.ts          # UI at http://127.0.0.1:8787/
```

**Critical gotchas, learned the hard way**

1. **`setsid` is required.** Plain `nohup` dies when the SSH session ends.
2. **The VM does not survive a host sleep.** It suspended with the host, the guest went
   unresponsive (`VMMDev: vmmDevHeartbeatFlatlinedTimer: Guest seems to be unresponsive`
   in `VBox.log`), and SSH timed out while port 8000 still *accepted* (VirtualBox's NAT
   answering, not the guest). Fix: `VBoxManage controlvm AInterceptor poweroff`, then
   `startvm`.
3. **`astart`'s own 60 s readiness check is too short** for a cold boot (measured 61–290 s),
   so it prints `[FAIL] daemon did not come up within 60s` even when it then succeeds.
4. **PowerShell mangles multi-line commands into CRLF** when piping to remote bash. Use
   `cmd /c "type script.sh | ssh host bash -s"`, or base64 the payload. Node's
   `spawn` also fails with `EPERM` under the file sandbox.
5. **`node --test` cannot spawn** here (`spawn EPERM`). Tests run in-process:
   `node test/run-tests.ts` and `node -e "import('./test/run-seam-tests.ts').then(m=>m.run())"`.

---

## 3. The AI-backend rule (do not break this)

The Harness talks to **AInterceptor only**. No `openai`/`@anthropic-ai`/any provider SDK.
This is enforced by a test (`test/run-seam-tests.ts` → "architecture guard") that walks
every source file and fails on a provider SDK import, and asserts `dependencies` stays `{}`.

Transport used, all verified:
| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness + `providers_active` / `providers_inactive` |
| `POST /v1/chat/completions` | the model call (SSE and non-streaming), OpenAI-shaped |
| `GET /admin/providers` | exists, **but rejects the API key (401)** — see §5 |

---

## 4. Provider sessions — the real story

### 4a. VERIFIED: `airouter-agent login <provider>` works, and injection works

Confirmed by inspecting the upload response's `injected` field (the part nobody
had looked at):

```
device token sk-dev-mwllsKqDI… -> authenticated (200)
admin  token sk-aint-0Lcs…     -> authenticated (200)
POST /api/sessions/upload (device token)
  http=200
  injected={"ok":true,"cookies":1,"local_storage":0,"reload_error":null}
```

So the session IS pushed into the live Chrome tab. The `_is_admin(user)` gate in
`sessions_routes.py` does not block it, because `AINTERCEPTOR_ADMIN_EMAIL` is set
to `arunramakantsingh@gmail.com` and that is the account the tokens map to.
**A session stored and injected is not the same as a session that works** — see 4c.

### 4b. VERIFIED WORKING: gemini

After `airouter-agent login gemini`, `/v1/chat/completions` with `model=gemini`
returned **HTTP 200 `PONG`** and the path trace recorded `gemini B OK` (47.8 s),
resolving to a real conversation URL (`/app/d2812a3291f1f635`, titled
"A Simple Ping-Pong Exchange").

### 4c. THE ACTUAL BLOCKER: Cloudflare binds the session to the browser that made it

The VM's own browser tabs are serving challenge pages:

```
DeepSeek - Into the Unknown       https://chat.deepseek.com/
Just a moment...                  https://claude.ai/api/challenge_redirect?to=…   <-- CHALLENGE
A Simple Ping-Pong Exchange       https://gemini.google.com/app/d2812a3291f1f635
Just a moment...                  https://chatgpt.com/                            <-- CHALLENGE
```

Path A (`path_a.py`) replays cookies over plain HTTP with **no browser involved**.
Cloudflare's `cf_clearance` is bound to the browser fingerprint, the IP and the TLS
signature that obtained it, so a cookie captured on your laptop does not clear a
challenge for the VM. The VM's public IP is `106.213.87.162`; the session was
minted on the host. That mismatch is the wall.

Observed consequence, same minute, same code:

| provider | result |
|---|---|
| gemini | `200 PONG` (green path, no challenge) |
| chatgpt | `500 Internal Server Error` (after copying the fresh 129 KB session) |
| deepseek | `503 A: …produced no text \| B: …` |
| claude | `503 claude: produced no text` |

Also note: the VM's chatgpt/claude tabs stay challenged, so Path B has nothing
logged-in to drive either. **No amount of code fixes this** — a human has to clear
the challenge once in the VM's Chrome, after which the persistent profile keeps it.

### 4d. FIXED EARLIER: the cookie bloat that broke Path A

All providers share one Chrome profile, so `ctx.storage_state()` captured every
provider's cookies. `path_a._cookies()` flattened the whole jar with no domain
filter, so each request carried ~258 cookies. Measured: deepseek had **259 cookies
/ 35,302 bytes**, of which exactly **one** (`ds_session_id`, 45 bytes) belonged to
`chat.deepseek.com`. Providers answered `400 Request Header Or Cookie Too Large`.

Fixes applied (backups: `*.pre_cookiefix`, `*.pre_idbfix`):
- `path_a._cookies(state, host)` filters by RFC-6265 domain match (exact, or suffix
  on a dot boundary), with a no-host fallback so nothing is silently dropped.
  6 provider call sites patched; 1 left on the fallback.
- `session_exporter.py` gained `_filter_cookies_for()` so captures are clean at source.
- `path_a._token_from_state()` now reads the **`indexeddb`** key (the exporter writes
  that, but the code only looked for `_ainterceptor_idb`) and accepts long non-JWT
  session tokens (`settingsJwt` is 412 chars and is not JWT-shaped).

After that fix deepseek's error became a well-formed `deepseek HTTP 400`, proving
the header-size bug was gone. It still does not answer, because of 4c.

### 4e. Session rows are keyed by USER — watch for duplicates

`/v1` resolves a session by the **caller's user id**. Two accounts had rows:

```
chatgpt  arunrsingh@outlook.com        129,492 B   <-- the fresh login
chatgpt  arunramakantsingh@gmail.com    38,978 B   <-- what /v1 read
claude   arunrsingh@outlook.com         26,820 B
claude   arunramakantsingh@gmail.com   875,912 B
deepseek arunramakantsingh@gmail.com    54,568 B
gemini   arunramakantsingh@gmail.com    14,530 B
```

`vm_sync_freshest.sh` copies the largest (freshest) blob per provider onto the
admin key's user. That is a repair, not a cure — the root fix is for the agent's
device token to belong to the same account you call `/v1` with.

### The login path (use this)

`airouter-agent` is installed on the **host** (from `C:\Projects\AInterceptor-M1.5`):

```powershell
airouter-agent status                    # server + token + reachability
airouter-agent login deepseek            # opens REAL Chrome, you log in, it uploads
airouter-agent login claude              # same for each provider
airouter-agent login chatgpt
airouter-agent login gemini
```

**Verified working end to end:**
- device token `sk-dev-…` in `~/.airouter/config.json` **authenticates** (`GET /api/sessions` → 200)
- `POST /api/sessions/upload` **accepts the device token** and creates/updates a row (200)
- `POST /api/devices/exchange` returns a clean `404 invalid or expired code` for a bad code
- the agent uses **real Chrome** (`channel="chrome"`) with a persistent per-provider profile,
  so Google OAuth trusts it — this is why host-side login works where VM-side does not
- it captures cookies + localStorage + **IndexedDB** and uploads all three

**So the fix for "provider X has no session" is: run `airouter-agent login X` on the host.**
For a broad refresh, `~/bin/alogin <provider>` inside the VM is the agent-first alternative.

**Known ceiling:** `/v1` with `model=auto` routes to whichever provider is first available and
can return `no active session for grok`. Pin the provider (`model=deepseek`) when testing.

---

## 5. Auth facts worth not re-learning

| Credential | Where | Behaviour |
|---|---|---|
| `sk-aint-…` API key | VM `~/.ainterceptor/admin_api_key.txt` (49 B) and harness `.credentials/ainterceptor.key` (gitignored) | **works** for `/api/keys`, `/api/sessions`, `/v1/chat/completions`; **401 on `/admin/providers`** |
| `sk-dev-…` device token | `~/.airouter/config.json` | **works** for `/api/sessions`, `/api/sessions/upload` |
| `/admin/providers` | — | 401 with auth, **422 without** — an admin-scope quirk. The harness therefore falls back to `/health` for the provider catalogue |
| `/auth/me` | — | returns the HTML login page, not JSON — browser-gated |

---

## 6. Harness state: done vs not

**Done and verified**
- redaction stage (fail-closed, at the write boundary) — 14 tests
- credentials seam (references only) — 14 tests incl. the architecture guard
- structured JSONL event log with requestId correlation
- AInterceptor-only AI backend (SSE + non-streaming, provider fallback to `/health`)
- real capability inventory + PASS/WARN/FAIL diagnostics in the UI
- workspace records with **realpath** identity, a real filesystem tree, read-only git overlay
- loopback HTTP API + a no-build UI at `http://127.0.0.1:8787/`

**Built but NOT yet proven (blocked by the sandbox's `spawn EPERM`)**
- `/api/exec` local transport
- `/api/exec` SSH-to-VM transport
- therefore also: the workspace tree/git overlay exercised end-to-end

Run `node src/server.ts` **outside** the confined shell (or with wider access) and those
three become testable. Everything else was verified against the live VM.

---

## 7. Phones (the resource pool)

Corrected facts — an earlier claim that "no phone exposes a shell" was **wrong**:

| Node | Tailscale | `:8022` | Notes |
|---|---|---|---|
| galaxy-a12 | 267 ms direct | **open** | Termux login verified |
| moto-g45-5g | 122 ms direct | **open** | ⚠️ **host key changed** — confirm before trusting |
| realme-15t-1 | 271 ms direct | **open** | Termux login verified |
| galaxy-z-fold3-5g | 496 ms DERP | **open** | Termux login verified |
| galaxy-m10-1 | 577 ms DERP | closed | no sshd |

- **Tailscale is already installed and authenticated on every phone** and MagicDNS resolves.
- **The Termux is the Google Play build** — discontinued, signed with a different key, so it
  **cannot be upgraded in place**. The appliance APK shares package name `com.termux`, so
  Android refuses the install (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). Replacing it means
  uninstalling first, which **deletes `$HOME`** (SSH keys, `~/.tailscale`, proot images).
  **Back up first** with `phone-foundation/backup_termux_home.sh`.
- **No phone has key-based SSH yet** — password auth only.
- Cheapest progress without any uninstall: install your SSH public key on each phone.

---

## 8. Security items still open

1. **Revoke the leaked Tailscale auth key.** `turmux-tailscal-debian` used to compile a live
   reusable key into the APK. Code fix is pushed
   (`fix/no-embedded-credentials-in-distributed-apk` = `6cd48d1`), but **the key itself must be
   revoked in the Tailscale admin console** — built APKs already contain it.
2. **AInterceptor's Tailscale Funnel is public** (`https://ainterceptor.taila2310c.ts.net` →
   `127.0.0.1:8000`) exposing a 63-route app with a login page. Should be tailnet-only
   (`tailscale serve`, not `funnel`).
3. `AINTERCEPTOR_VNC_PASSWORD` is **5 characters**.
4. Plaintext credentials on disk (mode 600): VM `~/.git-credentials`, VM `.env`,
   host `~/.airouter/config.json`, `~/.ainterceptor/admin_api_key.txt`.
5. A provisioned phone currently exposes an **unauthenticated `0.0.0.0:8080`** status page
   that prints its own SSH passwords in cleartext.

---

## 9. Next actions, in order

1. **`airouter-agent login deepseek`** on the host → then re-test
   `POST /v1/chat/completions {"model":"deepseek"}`. This is the live blocker.
2. Repeat for `claude` (it is stuck on a Cloudflare challenge), `chatgpt`, `gemini`.
3. Run the harness **unconfined** and prove `/api/exec` local + SSH.
4. Push the harness branch and open a PR (the VM PAT cannot create PRs — use the host `gho_`
   token or the browser link).
5. Consider `/dashboard/commandline`'s interactive console work from the earlier branch, and
   the xterm.js + node-pty terminal per the OSS shortlist.
6. Phone work: install SSH keys first; defer the Play→GitHub Termux migration.

---

## 10. Vocabulary discipline (avoid these traps)

- *workspace* = the project record, **not** the sandbox writable root.
- *remote* in DSH means browser RPC; **our** remote means another machine over SSH.
- Termux identity (`u0_a…@:8022`) and the Debian proot identity (`admin@:2222`) are
  **separate accounts on the same phone** — label them distinctly.
- Only the **VM** is a provisioned execution host today; the host runs the harness.
