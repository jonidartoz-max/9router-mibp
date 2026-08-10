// Background pool egress geo probe — fills the poolGeo cache so the Proxy
// Fitness / Proxy Pools UI can show each pool's egress IP + country, and
// future provider region policies can pre-mark pools unfit.
// Fail-open everywhere; never blocks startup or requests.
//
// Rate safety: each probe hits ipinfo.io through the pool; quotas are small,
// so failing pools get a negative backoff instead of being re-probed every
// pass, and per-pass output is a single aggregated summary line.

import { getProxyPools } from "@/models";
import { probePoolGeo, setPoolGeo, getPoolGeo } from "open-sse/services/poolGeo.js";
import { isNonServerRuntime } from "@/sse/services/backgroundTokenRefresh.js";
import { getSettings } from "@/lib/localDb";

const PROBE_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 15 * 1000;
const CONCURRENCY = 3;
// Re-probe a pool when its last sample is older than this — multiple samples
// per pool are what let us flag flapping (changing egress) relays.
const GEO_REPROBE_MS = 30 * 60 * 1000;

// Backoff windows per failure family: server/rate problems are likely to
// persist (broken relay, exhausted quota), network blips recover sooner.
const BACKOFF = {
  "rate-limit": 2 * 60 * 60 * 1000,
  server: 2 * 60 * 60 * 1000,
  network: 30 * 60 * 1000,
  timeout: 30 * 60 * 1000,
  "no-ip": 30 * 60 * 1000,
};

let started = false;
let intervalHandle = null;
let initialTimeoutHandle = null;
let probing = false;
const probeBackoff = new Map(); // poolId -> retryAfter (ms epoch)

function isTruthyEnv(v) {
  if (v == null || v === "") return false;
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}

// probe with bounded concurrency; skips pools in backoff or with fresh samples.
async function probeAll() {
  if (probing) return;
  probing = true;
  try {
    // UI toggle (settings.poolGeoProbeEnabled) gates the whole feature; the
    // env var remains a hard override for headless setups.
    try {
      const settings = await getSettings();
      if (settings?.poolGeoProbeEnabled === false) return;
    } catch { /* DB hiccup — keep probing (fail-open) */ }

    const pools = await getProxyPools({ isActive: true });
    const now = Date.now();
    const active = (pools || []).filter((p) => !!p?.proxyUrl);
    const targets = active.filter((p) => {
      const until = probeBackoff.get(p.id);
      if (until && until > now) return false; // waiting out a failure
      const geo = getPoolGeo(p.id);
      return !geo || now - geo.ts >= GEO_REPROBE_MS;
    });
    if (targets.length === 0) return;

    const failTally = {};
    let next = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(targets.length, 1)) }, async () => {
      while (next < targets.length) {
        const pool = targets[next++];
        const res = await probePoolGeo(pool);
        if (res.ok) {
          setPoolGeo(pool.id, res.geo);
          if (probeBackoff.has(pool.id)) probeBackoff.delete(pool.id);
        } else {
          failTally[res.error] = (failTally[res.error] || 0) + 1;
          probeBackoff.set(pool.id, now + (BACKOFF[res.error] || BACKOFF.network));
        }
      }
    });
    await Promise.allSettled(workers);

    const filled = active.filter((p) => getPoolGeo(p.id)).length;
    const failSummary = Object.entries(failTally).map(([k, n]) => `${k}×${n}`).join(", ") || "none";
    console.log(`[PoolEgressProbe] geo ${filled}/${active.length} · fail: ${failSummary}`);
  } catch (e) {
    console.log(`[PoolEgressProbe] pass failed: ${e?.message || e}`);
  } finally {
    probing = false;
  }
}

export function startPoolEgressProbe({ intervalMs } = {}) {
  if (started) return false;
  if (isNonServerRuntime()) return false;
  if (isTruthyEnv(process.env.POOL_GEO_PROBE_DISABLED)) return false;
  started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : PROBE_INTERVAL_MS;
  console.log("[PoolEgressProbe] Scheduler started", { intervalMs: period, initialDelayMs: INITIAL_DELAY_MS });
  initialTimeoutHandle = setTimeout(() => { probeAll().catch(() => {}); }, INITIAL_DELAY_MS);
  if (initialTimeoutHandle.unref) initialTimeoutHandle.unref();
  intervalHandle = setInterval(() => { probeAll().catch(() => {}); }, period);
  if (intervalHandle.unref) intervalHandle.unref();
  return true;
}

export function stopPoolEgressProbe() {
  if (initialTimeoutHandle) clearTimeout(initialTimeoutHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  initialTimeoutHandle = null;
  intervalHandle = null;
  started = false;
}

export const __test__ = { probeAll };