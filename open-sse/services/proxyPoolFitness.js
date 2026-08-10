// Pool fitness registry — shared, in-memory, engine layer.
//
// Rotation strategies can opt into region/provider-aware pool selection: an
// executor that learns a pool's egress is unfit for a provider/model (e.g.
// Freebuff limited-mode IP) marks it here, and the pool picker skips it for
// that scope until the cooldown expires.
//
// Scope format: `provider::model` (e.g. "freebuff::openai/gpt-5.6-luna").
// All functions are fail-open: unknown pool/scope ⇒ fit.

// Scope format: `provider::model` (e.g. "freebuff::openai/gpt-5.6-luna").
// All functions are fail-open: unknown pool/scope ⇒ fit.
//
// State lives on globalThis so Next dev (Turbopack) never splits one Map into
// several per-bundle copies — the executor/chatCore marks and the
// /api/proxy-pools/fitness reader must share the SAME registry.

const FITNESS_STATE_KEY = "__9routerPoolFitness__";
const fitness = (globalThis[FITNESS_STATE_KEY] ??= new Map()); // poolId -> Map<scope, { until, reason }>

export const POOL_UNFIT_MS = 5 * 60 * 1000;

export function markPoolUnfit(poolId, scope, until = Date.now() + POOL_UNFIT_MS, reason = "") {
  if (!poolId || !scope) return;
  const byScope = fitness.get(poolId) || new Map();
  byScope.set(scope, { until, reason });
  fitness.set(poolId, byScope);
}

export function clearPoolUnfit(poolId, scope) {
  const byScope = fitness.get(poolId);
  if (!byScope) return;
  byScope.delete(scope);
  if (byScope.size === 0) fitness.delete(poolId);
}

// "provider::model" -> "provider::*" (null when the scope has no provider part)
function providerWildcardScope(scope) {
  const sep = String(scope || "").indexOf("::");
  if (sep < 0) return null;
  return `${scope.slice(0, sep)}::*`;
}

export function isPoolFit(poolId, scope, now = Date.now()) {
  if (!poolId) return true;
  const byScope = fitness.get(poolId);
  if (!byScope) return true;
  // A provider-wide mark ("provider::*", e.g. manual blocks) also covers any
  // model lookup for that provider.
  const candidates = [scope, providerWildcardScope(scope)];
  for (const key of candidates) {
    if (!key) continue;
    const entry = byScope.get(key);
    if (!entry) continue;
    if (entry.until <= now) {
      byScope.delete(key);
      if (byScope.size === 0) fitness.delete(poolId);
      continue;
    }
    return false;
  }
  return true;
}

// Keep only pool ids that are not in cooldown for the scope.
export function fitPoolIds(poolIds, scope, now = Date.now()) {
  return (poolIds || []).filter((id) => isPoolFit(id, scope, now));
}

// Clear every mark — or only scopes belonging to one provider (`provider::*`).
export function clearAllPoolUnfit(provider = null) {
  if (provider) {
    const prefix = `${provider}::`;
    for (const [poolId, byScope] of fitness) {
      for (const scope of [...byScope.keys()]) {
        if (scope.startsWith(prefix)) byScope.delete(scope);
      }
      if (byScope.size === 0) fitness.delete(poolId);
    }
    return;
  }
  fitness.clear();
}

// Snapshot of live (non-expired) marks — expired entries are pruned here so
// consumers never see stale data and memory stays bounded.
// Test helper: drop all marks (module state is globalThis-backed).
export function resetPoolFitness() {
  fitness.clear();
}

// Sweep all expired marks. Returns how many scope entries were removed.
export function pruneExpired(now = Date.now()) {
  let removed = 0;
  for (const [poolId, byScope] of fitness) {
    for (const [scope, entry] of byScope) {
      if (entry.until <= now) {
        byScope.delete(scope);
        removed += 1;
      }
    }
    if (byScope.size === 0) fitness.delete(poolId);
  }
  return removed;
}

export function poolFitnessSnapshot(now = Date.now()) {
  const out = {};
  for (const [poolId, byScope] of fitness) {
    let pruned = false;
    for (const [scope, entry] of byScope) {
      if (entry.until <= now) {
        byScope.delete(scope);
        pruned = true;
      }
    }
    if (byScope.size === 0) {
      fitness.delete(poolId);
      continue;
    }
    if (pruned || byScope.size > 0) {
      out[poolId] = Object.fromEntries(byScope);
    }
  }
  return out;
}
