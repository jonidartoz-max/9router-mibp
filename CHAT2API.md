# Chat2API Pack (webCookie providers)

Turns a **logged-in web session** for popular chat sites into an OpenAI-compatible
provider inside 9Router — no official API key, no per-token billing. These sit in the
`webCookie` category alongside the pre-existing `grok-web` and `perplexity-web`.

## Providers added

| Provider id | Site | Credential to paste | Notes |
|---|---|---|---|
| `deepseek-web` | chat.deepseek.com | `userToken` (cookie optional) | Web-client headers + auto-generated session cookie + auto token refresh (ported from `xiaoY233/Chat2API`). PoW (DeepSeekHashV1) solved with Node's built-in SHA3-256 — no wasm |
| `qwen-web` | chat.qwen.ai | `token` cookie (optionally `token\|ssxmod_itna`) | Anonymous works but is rate-limited; add `-thinking` to a model for reasoning |
| `claude-web` | claude.ai | `sessionKey\|orgUuid` (optionally `\|cfClearance`) | Cloudflare may require `cf_clearance` as a 3rd field |
| `gemini-web` | gemini.google.com | Google cookie string (`__Secure-1PSID=…; __Secure-1PSIDTS=…; SAPISID=…`) | Anonymous serves Flash only; cookie unlocks Pro/thinking |

Aliases: `dsw`, `qw`, `cw`, `gw2`.

## One-click login (no DevTools) ⭐

Every `webCookie` provider now has a **"Login with browser"** button in the Add
Connection modal. It opens your real browser on the site's login page, you sign in
normally (password, Google, 2FA — all on the site itself), and 9Router reads the
resulting cookies + localStorage over the Chrome DevTools Protocol and fills the
form for you. **No password, token or 2FA code ever passes through 9Router or the
chat.**

Supported: `deepseek-web`, `qwen-web`, `claude-web`, `gemini-web`, `grok-web`,
`perplexity-web` (anything in `src/lib/webLogin/sites.js`).

- Needs a Chromium browser installed (Chrome / Edge / Brave / Chromium). Detected
  automatically; the same profile is reused, so a later login is often instant.
- Sign-in is detected by asking the site's own API (e.g. `/api/v0/users/current`
  for DeepSeek) — a guest session is *not* mistaken for a real one.
- If no browser is found, the manual paste still works exactly as before.

## How to get each credential (browser DevTools)

*Only needed if you skip the one-click login above.*

- **DeepSeek** — DevTools → Network → click any `/api/v0/…` request → copy the
  `authorization: Bearer …` value (that's the userToken) and the `Cookie` header.
  Paste as `userToken|cookie`.
- **Qwen** — DevTools → Application → Cookies → `https://chat.qwen.ai` → copy the
  `token` value (starts with `eyJ…`).
- **Claude** — DevTools → Application → Cookies → `https://claude.ai` → copy
  `sessionKey` (`sk-ant-sid02-…`) and `lastActiveOrg` (org UUID). Paste `key|org`.
  If you get 403, also copy `cf_clearance` and paste `key|org|cf`.
- **Gemini** — DevTools → Application → Cookies → `https://gemini.google.com` →
  copy the `k=v; k=v` string with at least `__Secure-1PSID`, `__Secure-1PSIDTS`,
  `SAPISID`.

## Architecture

- `open-sse/executors/webChatShared.js` — shared request parsing, SSE framing and
  non-streaming assembly (`parseOpenAIMessages`, `buildStreamingResponse`,
  `buildNonStreamingResponse`, `readLines`, `formatToolsHint`, credential split).
- `open-sse/executors/{deepseek,qwen,claude,gemini}-web.js` — one thin executor per
  provider; only the upstream call + stream parser are provider-specific.
- `open-sse/providers/registry/{…}-web.js` — registry entries (`category: "webCookie"`).
- Wiring: `executors/index.js` (map), `providers/registry/index.js` (imports + array,
  p140–p143), `providers/validate/route.js` + `test/testUtils.js` (connection test),
  `AddApiKeyModal.js` (cookie placeholder hints).

## DeepSeek client fingerprint (ported from `xiaoY233/Chat2API`)

The DeepSeek web API rejects requests whose client profile it doesn't recognise.
Probing `/api/v0/chat_session/create` shows the difference plainly:

| Client profile | Response |
|---|---|
| Old Android headers (`DeepSeek/1.0.13 Android/35`) | `{"code":40005,"msg":"CLIENT_VERSION_TOO_LOW"}` ❌ |
| Web headers (`X-Client-Platform: web`, `X-Client-Version: 2.0.0`, Origin/Referer/Sec-Fetch) | `{"code":40003,"msg":"Authorization Failed (invalid token)"}` ✅ (accepted; only the token was fake) |

Three things the executor now does that it didn't before:

1. **Web client headers** — a real `chat.deepseek.com` browser profile, so the
   request isn't classified as a stale/mobile client. **`Content-Type: application/json`
   is required**: without it the API answers HTTP 422 and the executor used to
   report the misleading "userToken expired".
2. **Generated session cookie** — `intercom-HWWAFSESTIME`, `HWWAFSESID`, `_frid`, … are
   minted per request. Pasting cookies from DevTools is now **optional**; only the
   `userToken` is required.
3. **Token refresh** — `userToken` is exchanged at `GET /api/v0/users/current` for a
   fresh access token (cached 1 h).

### Protocol details that must be right

These were all wrong at first and each one silently broke a feature:

- **Proof of work** — the challenge is *not* a plain SHA3-256 preimage search. The
  server validates the output of the official `sha3_wasm_bg.wasm`; a naive loop
  returns `INVALID_POW_RESPONSE` (40301). The WASM ships next to the executor and is
  loaded once per process.
- **Session id path** — `data.biz_data.chat_session.id`, not `data.biz_data.id`.
- **SSE parsing** — the completion endpoint streams JSON-Patch. Deltas arrive as
  `response/fragments/-1/content`, where `-1` is *the last fragment*; the fragment's
  **type** decides the channel: `THINK` → `reasoning_content`, `RESPONSE` → `content`,
  `SEARCH` → ignored. Continuation frames carry `{v}` with **no** `{p}` (they append to
  the previous path), and `BATCH` frames wrap an array of ops.
- **`model_type`** — `"default"` | `"expert"` (not `"chat"`/`"reasoner"`).
- **Tool calls** — the model is prompted with the bracket protocol
  (`[function_calls]` / `[call:name]{json}[/call]`); a parser converts the reply into
  OpenAI `tool_calls` with `finish_reason: "tool_calls"` for both streaming and
  non-streaming. The same builder is shared by qwen/claude/gemini executors.
  - The transcript must **keep the call/result pairing**: a prior assistant
    `tool_calls` is re-rendered as a `[function_calls]` block and each result as
    `[TOOL_RESULT for <id>] <text>`. Without this the model never learns the tool
    already ran and re-calls it forever.
  - When the transcript **ends** with tool results, a `TOOL_RESULT_FOLLOWUP`
    directive is appended after the tool instructions ("results are final, answer
    now, do NOT emit another [function_calls] block"). Otherwise the trailing
    "call a tool" instruction wins and the agent loops.

Verified end-to-end through the running server **and with the real OpenAI SDK**
(streaming and non-streaming): plain chat, web-search (with `[citation:N]`),
reasoning (`reasoning_content`), single-tool and 4-parallel-tool agent loops, all
terminating on turn 2 with a final answer.

## Caveats (read before shipping)

These are **reverse-engineered** endpoints. They can break without notice when the
site changes its protocol or anti-bot rules:

- **DeepSeek** — the executor supplies its own web-client headers and session cookie,
  so only `userToken` is needed. Registration/sign-up itself is separately gated by
  DeepSeek's IP/device fingerprinting ("Current device environment error" /
  `RECAPTCHA_VERIFY_FAILED`) — that affects *creating* accounts, not using them.
  The PoW step is self-contained and robust.
- **Qwen** — the WAF (`ssxmod_itna`, `bx-ua`) rotates; a plain token may 403 eventually.
- **Claude** — Cloudflare `cf_clearance` is bound to the browser User-Agent that
  created it; a mismatch 403s.
- **Gemini** — the page build label (`bl`) and `SNlM0e` token rotate; the executor
  re-scrapes them per session (30-min cache). Anonymous access is Flash-only.

Treat all four as **best-effort**. They are opt-in per connection; a broken one never
affects the standard API-key providers.
