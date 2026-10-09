# Chat2API Pack (webCookie providers)

Turns a **logged-in web session** for popular chat sites into an OpenAI-compatible
provider inside 9Router — no official API key, no per-token billing. These sit in the
`webCookie` category alongside the pre-existing `grok-web` and `perplexity-web`.

## Providers added

| Provider id | Site | Credential to paste | Notes |
|---|---|---|---|
| `deepseek-web` | chat.deepseek.com | `userToken\|cookie` | PoW (DeepSeekHashV1) solved automatically with Node's built-in SHA3-256 — no wasm |
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

## Caveats (read before shipping)

These are **reverse-engineered** endpoints. They can break without notice when the
site changes its protocol or anti-bot rules:

- **DeepSeek** — needs the `aws-waf-token` cookie the browser earned; the PoW step is
  self-contained and robust.
- **Qwen** — the WAF (`ssxmod_itna`, `bx-ua`) rotates; a plain token may 403 eventually.
- **Claude** — Cloudflare `cf_clearance` is bound to the browser User-Agent that
  created it; a mismatch 403s.
- **Gemini** — the page build label (`bl`) and `SNlM0e` token rotate; the executor
  re-scrapes them per session (30-min cache). Anonymous access is Flash-only.

Treat all four as **best-effort**. They are opt-in per connection; a broken one never
affects the standard API-key providers.
