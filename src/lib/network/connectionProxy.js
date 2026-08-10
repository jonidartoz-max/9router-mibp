import { getProxyPoolById } from "@/models";
import { fitPoolIds } from "open-sse/services/proxyPoolFitness.js";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

/**
 * Pick one proxy pool ID from a list based on strategy.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * smart:       region-aware — skip pools unfit for `scope`, round-robin on the fit subset
 * none/single: return first entry
 * @param {string[]} poolIds
 * @param {string} strategy
 * @param {string} providerId
 * @param {{ scope?: string, excludeIds?: string[] }} [opts]
 */
export function pickProxyPoolId(poolIds, strategy, providerId, opts = {}) {
  if (!poolIds || poolIds.length === 0) return null;
  const { scope = null, excludeIds = [] } = opts || {};

  let eligible = poolIds.filter((id) => !(excludeIds || []).includes(id));
  // Region-aware filtering is opt-in via the "smart" strategy.
  if (strategy === "smart" && scope) eligible = fitPoolIds(eligible, scope);

  if (eligible.length === 0) {
    // Every candidate is unfit/excluded — fall back to the first non-excluded
    // pool rather than deadlocking; its egress may have recovered.
    eligible = poolIds.filter((id) => !(excludeIds || []).includes(id));
    if (eligible.length === 0) return null;
  }
  if (eligible.length === 1) return eligible[0];

  if (strategy === "round-robin" || strategy === "smart") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % eligible.length;
    rotateState.set(providerId, state);
    return eligible[state.index];
  }

  if (strategy === "random") {
    return eligible[Math.floor(Math.random() * eligible.length)];
  }

  return eligible[0]; // "none" or unknown
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Multi-Proxy Pool (new format with rotation)
 * 2. Single Proxy Pool (legacy)
 * 3. Legacy Proxy
 * 4. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {},
  connectionId = null,
  excludePoolIds = null
) {
  try {
    // Handle new multi-proxy format
    const proxyPoolIds = providerSpecificData?.proxyPoolIds || [];
    const proxyRotationStrategy = providerSpecificData?.proxyRotationStrategy || "none";
    
    // Handle legacy single-proxy format
    const legacyProxyPoolId = normalizeString(providerSpecificData?.proxyPoolId);
    const proxyPoolIdRaw = legacyProxyPoolId === "__none__" ? "" : legacyProxyPoolId;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    /**
     * -----------------------------
     * Multi-Proxy Pool Resolution (NEW)
     * -----------------------------
     */
    if (proxyPoolIds.length > 0) {
      const scope = providerSpecificData?.proxyPoolScope || null;
      const selectedPoolId = pickProxyPoolId(proxyPoolIds, proxyRotationStrategy, connectionId, { scope, excludeIds: excludePoolIds });
      
      if (selectedPoolId) {
        const proxyPool = await getProxyPoolById(selectedPoolId);
        const proxyUrl = normalizeString(proxyPool?.proxyUrl);
        const noProxy = normalizeString(proxyPool?.noProxy);

        const isValidPool = proxyPool && proxyPool.isActive === true && proxyUrl;

        if (isValidPool) {
          /**
           * Vercel/Cloudflare relay proxies use base URL rewriting
           * instead of HTTP_PROXY environment variables.
           */
          if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
            return {
              source: proxyPool.type,
              proxyPoolId: selectedPoolId,
              proxyPool,
              connectionProxyEnabled: false,
              connectionProxyUrl: "",
              connectionNoProxy: noProxy,
              strictProxy: proxyPool.strictProxy === true,
              vercelRelayUrl: proxyUrl,
            };
          }

          /**
           * Standard proxy pool
           */
          return {
            source: "pool",
            proxyPoolId: selectedPoolId,
            proxyPool,
            connectionProxyEnabled: true,
            connectionProxyUrl: proxyUrl,
            connectionNoProxy: noProxy,
            strictProxy: proxyPool.strictProxy === true,
          };
        }
      }
    }

    /**
     * -----------------------------
     * Single Proxy Pool Resolution (LEGACY)
     * -----------------------------
     */
    if (proxyPoolIdRaw) {
      const proxyPool = await getProxyPoolById(proxyPoolIdRaw);
      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);
      const isValidPool = proxyPool && proxyPool.isActive === true && proxyUrl;

      if (isValidPool) {
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
          return {
            source: proxyPool.type,
            proxyPoolId: proxyPoolIdRaw,
            proxyPool,
            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,
            strictProxy: proxyPool.strictProxy === true,
            vercelRelayUrl: proxyUrl,
          };
        }

        return {
          source: "pool",
          proxyPoolId: proxyPoolIdRaw,
          proxyPool,
          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,
          strictProxy: proxyPool.strictProxy === true,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolIdRaw || null,
        proxyPool: null,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolIdRaw || null,
      proxyPool: null,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}
