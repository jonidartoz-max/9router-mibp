// Regression: a transport failure (never reached the provider) must not consume
// the status ladder or the account.
//
// Observed in production as a ~50s 502:
//   UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted address:
//   www.codebuddy.ai:443, timeout: 10000ms)
//   → [AUTH] Account 2 locked modelLock_deepseek-v4.1-flash for 30s [502]
//
// Two things were wrong and both are locked here:
//   1. the network-error path reused the 502 ladder, so one call = 1 connect
//      attempt + `attempts` retries, each paying the full connect timeout
//      (10s x 4 + 3 x 3s delays ≈ 50.8s, matching the log's 50836ms);
//   2. the same failure then went through checkFallbackError as an unmatched
//      "transient" 5xx and cooled the credential for 30s — for a host-side
//      network condition the account had nothing to do with.
//
// Note: mocks here are `mockImplementationOnce`, never persistent
// (mockRejectedValue / a standing mockImplementation). vitest records a reused
// rejection as an unhandled error and fails an otherwise-correct test.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
const { isTransportError } = await import("../../open-sse/config/errorConfig.js");
const { DEFAULT_NETWORK_RETRY_BUDGET } = await import("../../open-sse/config/runtimeConfig.js");

const creds = { apiKey: "probe" };

function res(status) {
  return { status, headers: { get: () => "" } };
}

// undici's shape: TypeError: fetch failed, with the real reason on `cause`.
function connectTimeout() {
  const cause = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
  return new TypeError("fetch failed", { cause });
}

// Queue n connect-timeout rejections. One call per queued rejection; a call
// beyond the queue resolves with the standing mock (undefined), which the
// executor treats as a real response — so the exact count matters.
function failConnectTimes(n) {
  for (let i = 0; i < n; i++) {
    fetchMock.mockImplementationOnce(async () => { throw connectTimeout(); });
  }
}

beforeEach(() => fetchMock.mockReset());

describe("BaseExecutor.execute — transport failures use their own budget", () => {
  it("caps transport attempts instead of walking the whole status ladder", async () => {
    // A permissive ladder: without the budget this is 1 + 5 = 6 attempts.
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", retry: { 502: { attempts: 5, delayMs: 0 } } });
    failConnectTimes(1 + DEFAULT_NETWORK_RETRY_BUDGET);

    let thrown = null;
    try {
      await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    } catch (e) {
      thrown = e;
    }

    expect(thrown?.message).toBe("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(DEFAULT_NETWORK_RETRY_BUDGET + 1);
  });

  it("keeps the budget per call, not per fallback url", async () => {
    // A fresh connect timeout per URL must not buy each URL its own retry:
    // that is how a dead route turns 3 baseUrls into 3 x (1 + attempts) waits.
    const ex = new BaseExecutor("test", {
      baseUrls: ["https://a/api", "https://b/api", "https://c/api"],
      retry: { 502: { attempts: 5, delayMs: 0 } },
    });
    failConnectTimes(1 + DEFAULT_NETWORK_RETRY_BUDGET);

    let thrown = null;
    try {
      await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeTruthy();
    // 3 urls walked once + a single budgeted retry.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3 + DEFAULT_NETWORK_RETRY_BUDGET);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("still retries a transient network error when a retry is available", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", retry: { 502: { attempts: 1, delayMs: 0 } } });
    fetchMock
      .mockImplementationOnce(async () => { throw new Error("ECONNRESET"); })
      .mockImplementationOnce(async () => res(200));

    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still propagates a caller abort instead of retrying it", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", retry: { 502: { attempts: 5, delayMs: 0 } } });
    fetchMock.mockImplementationOnce(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    let thrown = null;
    try {
      await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    } catch (e) {
      thrown = e;
    }

    expect(thrown?.name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("checkFallbackError — a transport failure must not lock the account", () => {
  it("returns zero cooldown for a connect timeout", () => {
    const errorText =
      "fetch failed (cause: UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted address: www.codebuddy.ai:443, timeout: 10000ms))";
    const result = checkFallbackError(502, errorText, 0, "codebuddy-intl");

    expect(result).toEqual({ shouldFallback: true, cooldownMs: 0 });
  });

  it("recognises the transport error by code, not just by wording", () => {
    expect(isTransportError(connectTimeout())).toBe(true);
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "UND_ERR_HEADERS_TIMEOUT"]) {
      expect(isTransportError(Object.assign(new Error("x"), { code }))).toBe(true);
    }
  });

  it("does not mistake a provider verdict for a transport error", () => {
    expect(isTransportError("rate limit exceeded")).toBe(false);
    expect(isTransportError('{"code":11140,"msg":"Your account has been restricted"}')).toBe(false);
  });

  it("still cools the account for genuine provider verdicts", () => {
    expect(checkFallbackError(429, "rate limit exceeded", 0, "codebuddy-intl").cooldownMs).toBeGreaterThan(0);
    expect(
      checkFallbackError(403, '{"code":11140,"msg":"Your account has been restricted"}', 0, "codebuddy-intl").cooldownMs
    ).toBeGreaterThan(0);
  });
});