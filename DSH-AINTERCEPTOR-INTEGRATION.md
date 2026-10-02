# Wiring DSH itself to AInterceptor

Goal: DSH's model picker offers AInterceptor's providers, so model selection happens
in the Harness application settings while AInterceptor supplies the AI.

## Where the change lives

| File | Change |
|---|---|
| `~/.dsh/.credentials.yaml` | added `refs.AINTERCEPTOR_API_KEY` (a **reference**; the value never enters the YAML config) |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | added the `ainterceptor` provider route under the `llm-pi-ai` plugin |

Nothing in the DSH installation was modified, and no harness-repo code changed.

## The provider route

```yaml
ainterceptor:
  displayName: AInterceptor (web-layer router)
  api: openai-completions          # required: pi-ai's catalog does not ship this route
  baseURL: http://100.82.62.82:8000/v1
  apiKeyEnv: AINTERCEPTOR_API_KEY  # credential reference, resolved per request
  timeoutMs: 300000
  streamIdleTimeoutMs: 180000
  retryPolicy: { mode: off, maxRetries: 0 }
  models:
    - { id: deepseek, name: DeepSeek (via AInterceptor), contextWindow: 128000, maxTokens: 8192 }
    - { id: gemini,   ... }
    - { id: chatgpt,  ... }
    - { id: claude,   ... }
    - { id: grok,     ... }
    - { id: mistral,  ... }
    - { id: qwen,     ... }
    - { id: huggingchat, ... }
```

### Why each non-obvious field is there

* **`api: openai-completions`** — from the plugin README: `api` is "only needed for
  routes the catalog does not supply". AInterceptor is a hand-declared gateway, and
  without `api` the plugin throws
  `model "<id>" needs an api; the installed catalog does not describe this route`.
  Confirmed against the built-in `openAICompletionsApi`.
* **`models[].id` is the provider NAME.** AInterceptor's dispatcher treats the
  request's `model` field as the provider to route to its logged-in web session.
  `id: deepseek` therefore selects the deepseek session. This is not a model
  identifier in the usual sense.
* **`discoverModels` is never called.** It only runs when the route declares no
  models (it would `GET {baseURL}/models`). AInterceptor returns **404** on
  `/v1/models`, so declaring the list explicitly is what keeps this working. Verified
  in the plugin source.
* **Large `timeoutMs` / `streamIdleTimeoutMs`.** AInterceptor drives a real browser;
  a reply takes 20–80 s and the **first streamed token often arrives only after ~50 s**.
  A short idle timeout would abort a call that is working.
* **`retryPolicy: off`.** AInterceptor already does its own Path A → Path B fallback
  with per-(provider,path) circuit breakers. Retrying here would stack onto an
  already slow call.

## Verified

| Check | Result |
|---|---|
| `GET /health` from host (tailnet IP) | 200 |
| `GET /health` from host (MagicDNS `ainterceptor`) | 200 |
| `GET /health` via Funnel `https://ainterceptor.taila2310c.ts.net` | **fails** — Funnel was down earlier today |
| `POST /v1/chat/completions` with `model=deepseek` (exact DSH call shape) | **200**, `content: "READY"` in 21.6 s |
| `GET /v1/models` | **200** after adding the route below (was 404) |
| `GET /v1/models` with a bogus key | 401 `invalid API key` |
| credential reference resolves | yes, 48 chars |
| config YAML | no tabs, consistent indentation, all keys present |

Transport choice: `http://100.82.62.82:8000/v1` — the **Tailscale IP**, matching the
harness's existing default. MagicDNS (`http://ainterceptor:8000/v1`) also works and
reads better; the Funnel URL is deliberately not used because it is public and was
unreachable.

## `/v1/models` was added to AInterceptor

DSH (like any OpenAI-compatible client) discovers a route's models from
`GET {baseURL}/models`. AInterceptor answered **404** there, which is why the
`models:` list above had to be written by hand.

`GET /v1/models` now exists, in `backend/app/api/chat_routes.py`:

* returns the OpenAI list envelope; **each entry's `id` is a provider name**,
  because AInterceptor routes on the request's `model` field
* lists the 8 **active** providers first, then the 12 inactive ones (each marked
  `ainterceptor.status: "inactive"` and named "<provider> (inactive)") so the
  catalogue is visible without pretending they are usable
* **does not require auth**, because discovery must not fail for a client that has
  not stored a key yet — but a *supplied* header is still validated exactly as
  `key_user` does, so a bad key returns `401 invalid API key` rather than being
  ignored. This is why it uses a new `optional_key_user` dependency instead of
  `key_user` (whose `Header(...)` makes the header mandatory, returning 422).

Verified live on the running daemon: `200`, 20 entries; bogus key `401`;
`/health` and `/docs` still 200; `POST /v1/chat/completions` still routes.

**Note on the first attempt:** my initial version called `state.list_active()` on the
`app.control_plane.state` *module*, which exposes only a `get_state()` singleton
factory — that raised AttributeError and surfaced as HTTP 500. It now mirrors
`health_routes`: `from app.control_plane.state import get_state`. Backups are kept
at `chat_routes.py.pre_models_route` and `chat_routes.py.pre_models_statefix`.

The explicit `models:` list in the DSH profile is **kept** even though discovery now
works: it is validated and known-good, and DSH refreshes a fixed catalogue rather
than calling discovery on every request. Enabling a *new* provider in AInterceptor
therefore still means adding one entry to the profile.

## A timing observation worth keeping

`GET /v1/models` answered 200 immediately, while the **first** `POST` after a daemon
restart took **31 s and returned 503** even though the tabs had settled. The same
call succeeds in **21.6 s** when the stack has been idle-warm for a while. So the
first chat request after `arestart` is not representative — warm the stack before
judging a provider.

## Expected behaviour after DSH restarts

* DSH's Models settings will list a new provider, **AInterceptor (web-layer router)**
  with eight selectable entries.
* Selecting **DeepSeek (via AInterceptor)** and sending a prompt should work, in
  roughly **20–80 s**.
* **gemini** works but is more variable.
* **chatgpt** and **claude** will fail until their Cloudflare challenge is cleared in
  the VM's Chrome — the tabs currently read `Just a moment...`. That is a
  session/browser problem, not a wiring problem.

## If it does not appear

1. Confirm DSH was fully restarted (config is read at startup; a config edit while
   running is not guaranteed to be picked up).
2. Check the DSH profile loaded without a validation error — a bad `compat` or a
   missing `api` fails plugin loading, and the message names the provider and field.
3. The credential file is watched-or-not depending on build; a restart covers both.
