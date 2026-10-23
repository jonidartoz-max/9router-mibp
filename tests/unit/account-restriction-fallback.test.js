import { describe, it, expect } from "vitest";
import { checkFallbackError, buildModelLockUpdate, MODEL_LOCK_ALL } from "../../open-sse/services/accountFallback.js";
import { RESTRICTED_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

// Realistic body captured from CodeBuddy: the provider returns 403 with this
// payload when it has barred an account. The wording matters — it contains
// "account restricted" AND the pool previously matched "rate limit"-adjacent
// rules instead, producing a 2-minute cooldown and an endless retry loop.
const RESTRICTED_BODY = JSON.stringify({
  error: {
    code: 11140,
    message:
      "CodeBuddy account restricted (11140): the request cleared channel verification but the upstream flagged this account for unusual activity.",
  },
});

const RESTRICTED_TEXT =
  "CodeBuddy account restricted (11140): the request cleared channel verification but the upstream flagged this account for unusual activity.";

describe("permanent account restriction", () => {
  it("classifies a restriction notice as account-scoped", () => {
    const result = checkFallbackError(403, RESTRICTED_TEXT, 0, "codebuddy-intl");

    expect(result.shouldFallback).toBe(true);
    expect(result.accountScoped).toBe(true);
  });

  it("parks the account far longer than a transient 403", () => {
    const restricted = checkFallbackError(403, RESTRICTED_TEXT, 0, "codebuddy-intl");
    const plain403 = checkFallbackError(403, "Forbidden", 0, "codebuddy-intl");

    expect(restricted.cooldownMs).toBe(RESTRICTED_COOLDOWN_MS);
    // The old behaviour: 2 minutes, then the same dead account re-enters the pool.
    expect(restricted.cooldownMs).toBeGreaterThan(plain403.cooldownMs * 10);
  });

  it("outranks the rate-limit wording that used to swallow it", () => {
    // "unusual activity" alone must be enough; it must not fall through to the
    // exponential `backoff` rules that keep the account in rotation.
    const result = checkFallbackError(403, "We detected unusual activity on this account.", 3, "codebuddy-intl");

    expect(result.accountScoped).toBe(true);
    expect(result.newBackoffLevel).toBeUndefined();
    expect(result.cooldownMs).toBe(RESTRICTED_COOLDOWN_MS);
  });

  it("does not leak the restriction class onto unrelated providers' errors", () => {
    const result = checkFallbackError(429, "rate limit exceeded", 0, "codebuddy-intl");

    expect(result.accountScoped ?? false).toBe(false);
    expect(result.newBackoffLevel).toBeDefined();
  });

  it("leaves an unmatched 4xx non-fallback", () => {
    // 422 with wording no rule matches: not an account problem, so the request
    // must fail through to the client instead of walking the whole pool.
    const result = checkFallbackError(422, "unprocessable entity", 0, "codebuddy-intl");

    expect(result.shouldFallback).toBe(false);
  });

  it("keeps the pre-existing explicit 400 rule working", () => {
    const result = checkFallbackError(400, "improperly formed request", 0, "codebuddy-intl");

    expect(result.shouldFallback).toBe(true);
    expect(result.accountScoped ?? false).toBe(false);
  });
});

describe("lock key scoping", () => {
  it("locks the whole credential for an account-wide bar", () => {
    const update = buildModelLockUpdate("deepseek-v4.1-flash", 1000, true);

    expect(Object.keys(update)).toEqual([MODEL_LOCK_ALL]);
  });

  it("still locks a single model for a per-model quota", () => {
    const update = buildModelLockUpdate("deepseek-v4.1-flash", 1000, false);

    expect(Object.keys(update)).toEqual(["modelLock_deepseek-v4.1-flash"]);
  });
});

describe("RESTRICTED_BODY fixture sanity", () => {
  it("contains the phrase the rules key on", () => {
    expect(RESTRICTED_BODY.toLowerCase()).toContain("account restricted");
  });
});
