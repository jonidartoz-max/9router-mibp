// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { provider: "codex", text: "model is not supported when using codex with a chatgpt account", cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS },
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};

/**
 * Transport failures: the request never reached the provider's application.
 *
 * These are socket/DNS/connect errors (raised by undici as `TypeError: fetch
 * failed` with a `cause.code`, or by Node as a bare errno). They say nothing
 * about the credential: the account was never asked anything. Treating such a
 * 502 like a provider verdict removes a healthy account from rotation for the
 * cooldown window and, with several connections, cascades through all of them —
 * one unreachable route from the host empties the whole pool.
 *
 * Matched against the message text (what survives into `lastError`) and against
 * the error object's own code/cause.
 */
export const TRANSPORT_ERROR_CODE_PATTERNS = [
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
];

export const TRANSPORT_ERROR_TEXT_PATTERNS = [
  "fetch failed",
  "connect timeout",
  "socket hang up",
  "network is unreachable",
  "err_connect_timeout",
];

/**
 * Is this failure a transport-level error (never reached the provider)?
 * Accepts an Error (preferred — checks `code`/`cause.code`) or a plain string
 * (an already-serialized `lastError`).
 * @param {Error|string|object|null} input
 * @returns {boolean}
 */
export function isTransportError(input) {
  if (input == null) return false;
  if (typeof input === "object") {
    const codes = [
      input.code,
      input.errno,
      input.cause?.code,
      input.cause?.cause?.code,
    ];
    if (codes.some((c) => typeof c === "string" && TRANSPORT_ERROR_CODE_PATTERNS.includes(c.toUpperCase()))) {
      return true;
    }
    return isTransportError(`${input.message || ""} ${input.cause?.message || ""}`);
  }
  const text = String(input).toLowerCase();
  if (TRANSPORT_ERROR_CODE_PATTERNS.some((p) => text.includes(p.toLowerCase()))) return true;
  return TRANSPORT_ERROR_TEXT_PATTERNS.some((p) => text.includes(p.toLowerCase()));
}
