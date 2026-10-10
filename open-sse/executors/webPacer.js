// webPacer — shared pacing + health ledger for every web-cookie provider.
//
// Anti-ban strategy (the "be a polite client" layer):
//   * ONE in-flight request per (provider, account) — requests serialize on a
//     per-account queue instead of bursting in parallel (agent tool-loops and
//     parallel clients used to hammer upstreams with N concurrent calls).
//   * A minimum gap between two consecutive upstream requests from the same
//     account, plus a small jitter so the cadence never looks metronomic.
//   * When an upstream answers 429, the account enters a cooldown during which
//     new requests WAIT BEFORE hitting it again (instead of re-triggering the
//     limiter immediately).
//   * When an upstream body mentions a suspension/ban, the account is parked
//     for a long cooldown and flagged in the health ledger.
//   * A per-account health ledger (ok / rate_limited / auth_failed / suspended)
//     exposed via /api/web-health so the UI can warn before a cookie is dead.
//
// This deliberately does NOT rotate fingerprints, proxies or User-Agents —
// those are evasion, and we keep the pacer honest about that.
//
// Tuning knobs (env, read once at import):
//   WEB_PACE_MIN_INTERVAL_MS  default 2500   (per-account min gap)
//   WEB_PACE_JITTER_MS        default 1500   (random extra delay, 0..jitter)
//   WEB_PACE_COOLDOWN_MS      default 90000  (post-429 pause)
//   WEB_PACE_MAX_HOLD_MS      default 300000 (watchdog: force-release a slot)

import crypto from "node:crypto";

function numSafe(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

const MIN_INTERVAL_MS = numSafe(process.env.WEB_PACE_MIN_INTERVAL_MS, 2500);
const JITTER_MS = numSafe(process.env.WEB_PACE_JITTER_MS, 1500);
const COOLDOWN_MS = Math.max(5000, numSafe(process.env.WEB_PACE_COOLDOWN_MS, 90000));
const MAX_HOLD_MS = Math.max(30000, numSafe(process.env.WEB_PACE_MAX_HOLD_MS, 300000));

/**
 * Stable per-account key. The raw credential is hashed so the health endpoint
 * can never leak a cookie/session token — only a short fingerprint.
 */
export function accountKey(rawCredential) {
  const s = String(rawCredential ?? "").trim();
  if (!s) return "anon";
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}

const accounts = new Map(); // provider -> Map(ak -> state)
const locks = new Map();    // `${provider}:${ak}` -> Promise resolved when holder releases

function getState(provider, ak) {
  let m = accounts.get(provider);
  if (!m) { m = new Map(); accounts.set(provider, m); }
  let st = m.get(ak);
  if (!st) {
    st = {
      status: "ok",
      cooldownUntil: 0,
      lastRequestAt: 0,
      inFlight: false,
      stats: { ok: 0, rateLimited: 0, authFailed: 0, suspended: 0 },
      events: [],
    };
    m.set(ak, st);
  }
  return st;
}

function pushEvent(st, type, detail) {
  st.events.push({ at: Date.now(), type, detail });
  if (st.events.length > 8) st.events.splice(0, st.events.length - 8);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Take a slot for `provider`/`account`. Resolves once it is safe to fire the
 * next upstream request; call the returned `release()` when the request is
 * fully done (stream finished or response sent). Holding the slot for the
 * whole stream is what serializes concurrent requests from one account.
 */
export async function acquire(provider, rawCredential) {
  const ak = accountKey(rawCredential);
  const key = `${provider}:${ak}`;
  const st = getState(provider, ak);

  // Register our gate synchronously so waiters queue in call order.
  const prev = locks.get(key) || Promise.resolve();
  let releaseLock;
  const myTurn = new Promise(r => { releaseLock = r; });
  locks.set(key, myTurn);

  await prev.catch(() => {});

  // Enforce the min gap + any active cooldown, then a small jitter.
  let waitUntil = Math.max(st.lastRequestAt + MIN_INTERVAL_MS, st.cooldownUntil);
  if (JITTER_MS > 0) waitUntil = Math.max(waitUntil, Date.now() + Math.floor(Math.random() * (JITTER_MS + 1)));
  if (waitUntil > Date.now()) await sleep(waitUntil - Date.now());

  st.inFlight = true;
  st.lastRequestAt = Date.now();
  if (st.status === "rate_limited" && Date.now() >= st.cooldownUntil) {
    st.status = "ok";
    pushEvent(st, "recovered", "cooldown elapsed");
  }

  let done = false;
  // Watchdog: never let a stuck request hold the slot forever.
  const watchdog = setTimeout(() => release(), MAX_HOLD_MS);
  watchdog.unref?.();

  function release() {
    if (done) return;
    done = true;
    clearTimeout(watchdog);
    st.inFlight = false;
    releaseLock();
    if (locks.get(key) === myTurn) locks.delete(key);
  }
  return release;
}

const SUSPEND_RE = /suspend|banned|\bviolat|deactivat|disabled|terminated/i;

/**
 * Map an upstream HTTP status (+ optional body text) to a ledger outcome.
 *   → "suspended" | "rate_limit" | "auth_fail" | null
 */
export function classifyUpstream(status, bodyText) {
  if (SUSPEND_RE.test(String(bodyText || ""))) return "suspended";
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth_fail";
  return null;
}

/**
 * Report the outcome of an upstream request.
 *   kind: "ok" | "rate_limit" | "auth_fail" | "suspended"
 */
export function noteOutcome(provider, rawCredential, kind, detail) {
  const st = getState(provider, accountKey(rawCredential));
  switch (kind) {
    case "ok":
      st.stats.ok += 1;
      break;
    case "rate_limit":
      st.stats.rateLimited += 1;
      st.status = "rate_limited";
      st.cooldownUntil = Date.now() + COOLDOWN_MS;
      pushEvent(st, "rate_limit", detail || `429 — cooling down ${Math.round(COOLDOWN_MS / 1000)}s`);
      break;
    case "auth_fail":
      st.stats.authFailed += 1;
      st.status = "auth_failed";
      pushEvent(st, "auth_fail", detail || "401/403 — cookie/session may be expired");
      break;
    case "suspended":
      st.stats.suspended += 1;
      st.status = "suspended";
      // Park a suspended account far longer than a rate-limit blip.
      st.cooldownUntil = Math.max(st.cooldownUntil, Date.now() + 30 * 60 * 1000);
      pushEvent(st, "suspended", detail || "upstream reported the account as suspended");
      break;
    default:
      return;
  }
}

/**
 * Wrap an async generator so `release()` runs exactly when the consumer is
 * done (stream finished, errored, or cancelled). This is what holds the
 * per-account slot for the whole streaming lifetime.
 */
export async function* pacedStream(gen, release) {
  try {
    for await (const chunk of gen) yield chunk;
  } finally {
    try { release?.(); } catch { /* ignore */ }
  }
}

/**
 * Wrap a fetch Response body (ReadableStream) so `release()` runs when the
 * stream is fully read, errors, or is cancelled. Used by executors that hand
 * the raw SSE body to their own streaming builder (grok, perplexity).
 */
export function releaseOnStream(body, release) {
  if (!body) { release?.(); return body; }
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          try { release?.(); } catch { /* ignore */ }
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        try { release?.(); } catch { /* ignore */ }
        controller.error(err);
      }
    },
    cancel(reason) {
      try { release?.(); } catch { /* ignore */ }
      return reader.cancel(reason);
    },
  });
}

/** Snapshot for /api/web-health (credentials already hashed). */
export function healthStatus() {
  const out = {};
  for (const [provider, m] of accounts) {
    for (const [ak, st] of m) {
      out[`${provider}:${ak}`] = {
        provider,
        account: ak,
        status: st.status,
        inFlight: st.inFlight,
        cooldownRemainingMs: Math.max(0, st.cooldownUntil - Date.now()),
        lastRequestAt: st.lastRequestAt || null,
        stats: { ...st.stats },
        events: st.events.slice(-8),
      };
    }
  }
  return { ok: true, minIntervalMs: MIN_INTERVAL_MS, jitterMs: JITTER_MS, cooldownMs: COOLDOWN_MS, accounts: out };
}

/** Test hook. */
export function _resetForTests() {
  for (const m of accounts.values()) m.clear();
  accounts.clear();
  locks.clear();
}
