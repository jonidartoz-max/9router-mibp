// Per-site capture recipes for the "login with browser" flow.
//
// Each entry describes, for one webCookie provider:
//   - loginUrl   : where to send the user to sign in
//   - match      : hostname test (the tab may be on any path of the site)
//   - probe      : runs in the page, returns a truthy value once signed in
//   - capture    : runs after sign-in, returns { credential, name, detail }
//                  where `credential` is exactly the string the executor expects
//                  (the same value a user would otherwise paste by hand).
//
// Everything is read from the user's own logged-in tab — no password or 2FA
// code is ever handled by 9Router.

// DeepSeek keeps the bearer token inside a JSON blob: {"value":"<token>",...}
// Guests get {"value":null}. Returns the inner token, or "" when absent.
function extractDsToken(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s);
      return typeof o?.value === "string" ? o.value : "";
    } catch {
      return "";
    }
  }
  return s;
}

const cookieMap = (cookies) => {
  const m = {};
  for (const c of cookies || []) m[c.name] = c.value;
  return m;
};

// "__Secure-1PSID=...; __Secure-1PSIDTS=...; SAPISID=..."
function geminiCookieString(map) {
  const order = [
    "__Secure-1PSID",
    "__Secure-1PSIDTS",
    "__Secure-1PSIDCC",
    "SID",
    "HSID",
    "SSID",
    "APISID",
    "SAPISID",
    "__Secure-3PSID",
    "__Secure-3PSIDTS",
    "SIDCC",
  ];
  const parts = [];
  for (const k of order) if (map[k]) parts.push(`${k}=${map[k]}`);
  // Fall back to every cookie on the domain if the known names are absent.
  if (!parts.length) for (const [k, v] of Object.entries(map)) parts.push(`${k}=${v}`);
  return parts.join("; ");
}

export const WEB_LOGIN_SITES = {
  "deepseek-web": {
    loginUrl: "https://chat.deepseek.com/sign_in",
    hosts: ["chat.deepseek.com", "deepseek.com"],
    // localStorage.userToken is a JSON wrapper ({"value":null,...}) even for
    // guests, so a plain truthiness check would treat "not signed in" as ready.
    // Ask the site's own API instead — it is the ground truth.
    probe: `fetch("/api/v0/users/current", { headers: { accept: "application/json" } }).then(r => r.json()).then(d => d && d.code === 0 && !!(d.data && (d.data.id || d.data.email))).catch(() => false)`,
    async capture(ctx) {
      const raw = await ctx.eval(`(() => { try { return localStorage.getItem("userToken") || ""; } catch { return ""; } })()`);
      const userToken = extractDsToken(raw);
      const cookies = await ctx.getCookies("https://chat.deepseek.com/");
      const map = cookieMap(cookies);
      const WANTED = ["aws-waf-token", "ds_session_id", "smidV2"];
      const cookieStr = cookies
        .filter((c) => WANTED.includes(c.name))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      const detail = [];
      if (userToken) detail.push("userToken");
      if (map["aws-waf-token"]) detail.push("aws-waf-token");
      if (map["ds_session_id"]) detail.push("ds_session_id");
      if (!userToken) return { error: "Could not find the DeepSeek userToken. Make sure you are signed in, then click Capture again." };
      return {
        credential: `${userToken}|${cookieStr}`,
        name: "DeepSeek Web",
        detail: detail.join(" + ") || "userToken",
      };
    },
  },

  "qwen-web": {
    loginUrl: "https://chat.qwen.ai/auth",
    hosts: ["chat.qwen.ai"],
    probe: `fetch("/api/v1/auths/", { headers: { accept: "application/json" } }).then(r => r.ok).catch(() => false)`,
    async capture(ctx) {
      const lsToken = await ctx.eval(`(() => { try { return localStorage.getItem("token") || ""; } catch { return ""; } })()`);
      const cookies = await ctx.getCookies("https://chat.qwen.ai/");
      const map = cookieMap(cookies);
      const token = lsToken || map["token"] || "";
      const ssxmod = map["ssxmod_itna"] || "";
      if (!token) return { error: "Could not find the Qwen token. Sign in at chat.qwen.ai, then click Capture again." };
      return {
        credential: ssxmod ? `${token}|${ssxmod}` : token,
        name: "Qwen Chat",
        detail: ssxmod ? "token + ssxmod_itna" : "token",
      };
    },
  },

  "claude-web": {
    loginUrl: "https://claude.ai/login",
    hosts: ["claude.ai"],
    probe: `fetch("/api/organizations", { headers: { accept: "application/json" } }).then(r => r.ok).catch(() => false)`,
    async capture(ctx) {
      const cookies = await ctx.getCookies("https://claude.ai/");
      const map = cookieMap(cookies);
      const sessionKey = map["sessionKey"] || "";
      let orgId = map["lastActiveOrg"] || "";
      const cf = map["cf_clearance"] || "";
      if (!orgId) {
        // Ask the API which org the session belongs to.
        const orgs = await ctx.eval(
          `fetch("/api/organizations", { headers: { accept: "application/json" } }).then(r => r.ok ? r.json() : null).then(a => (Array.isArray(a) && a[0] && a[0].uuid) ? a[0].uuid : "").catch(() => "")`,
          "https://claude.ai/",
        );
        if (orgs) orgId = orgs;
      }
      if (!sessionKey) return { error: "Could not find the Claude sessionKey cookie. Sign in at claude.ai, then click Capture again." };
      const detail = ["sessionKey"];
      if (orgId) detail.push("orgUuid");
      if (cf) detail.push("cf_clearance");
      return {
        credential: cf ? `${sessionKey}|${orgId}|${cf}` : `${sessionKey}|${orgId}`,
        name: "Claude Web",
        detail: detail.join(" + "),
      };
    },
  },

  "gemini-web": {
    loginUrl: "https://gemini.google.com/app",
    hosts: ["gemini.google.com", "accounts.google.com"],
    probe: `(() => { try { return document.cookie.includes("__Secure-1PSID=") || /gemini\\.google\\.com/.test(location.host) && !!document.querySelector('[data-test-id], .conversation-container, rich-textarea, .ql-editor'); } catch { return false; } })()`,
    async capture(ctx) {
      const cookies = await ctx.getCookies("https://gemini.google.com/");
      const map = cookieMap(cookies);
      const str = geminiCookieString(map);
      if (!map["__Secure-1PSID"]) {
        return {
          credential: "",
          anonymous: true,
          name: "Gemini Web",
          detail: "anonymous (Flash only)",
        };
      }
      const detail = ["__Secure-1PSID"];
      if (map["__Secure-1PSIDTS"]) detail.push("__Secure-1PSIDTS");
      return { credential: str, name: "Gemini Web", detail: detail.join(" + ") };
    },
  },

  "grok-web": {
    loginUrl: "https://grok.com/",
    hosts: ["grok.com", "x.com", "twitter.com", "accounts.x.ai"],
    probe: `(() => { try { return document.cookie.includes("sso=") || document.cookie.includes("sso-rw="); } catch { return false; } })()`,
    async capture(ctx) {
      const cookies = await ctx.getCookies("https://grok.com/");
      const map = cookieMap(cookies);
      const sso = map["sso"] || map["sso-rw"] || "";
      if (!sso) return { error: "Could not find the grok.com sso cookie. Sign in at grok.com, then click Capture again." };
      return { credential: sso, name: "Grok Web", detail: "sso cookie" };
    },
  },

  "perplexity-web": {
    loginUrl: "https://www.perplexity.ai/",
    hosts: ["perplexity.ai", "www.perplexity.ai"],
    probe: `(() => { try { return document.cookie.includes("__Secure-next-auth.session-token="); } catch { return false; } })()`,
    async capture(ctx) {
      const cookies = await ctx.getCookies("https://www.perplexity.ai/");
      const map = cookieMap(cookies);
      const token = map["__Secure-next-auth.session-token"] || map["next-auth.session-token"] || "";
      if (!token) return { error: "Could not find the Perplexity session cookie. Sign in at perplexity.ai, then click Capture again." };
      return { credential: token, name: "Perplexity Web", detail: "session-token" };
    },
  },
};

export function siteFor(provider) {
  return WEB_LOGIN_SITES[provider] || null;
}

export function isWebLoginProvider(provider) {
  return !!WEB_LOGIN_SITES[provider];
}
