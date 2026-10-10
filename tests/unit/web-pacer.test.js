// Unit tests for the web-cookie anti-ban pacer (open-sse/executors/webPacer.js).
//
// Covers the behaviour that actually reduces suspension risk:
//   1. requests from one account SERIALIZE (never overlap)
//   2. a minimum gap + jitter is enforced between two requests
//   3. a 429 parks the account (cooldown) and the next request WAITS
//   4. outcomes are classified (suspended / rate_limit / auth_fail)
//   5. the health ledger reports status without leaking credentials

import { describe, it, expect, beforeEach } from "vitest";
import {
  acquire,
  noteOutcome,
  classifyUpstream,
  accountKey,
  healthStatus,
  _resetForTests,
} from "../../open-sse/executors/webPacer.js";

beforeEach(() => {
  _resetForTests();
  delete process.env.WEB_PACE_MIN_INTERVAL_MS;
  delete process.env.WEB_PACE_JITTER_MS;
});

describe("webPacer — serialization", () => {
  it("never lets two requests for the same account overlap", async () => {
    // Use a fresh module with a tiny gap so the test stays fast; the pacing
    // itself is asserted separately below.
    const mod = await import("../../open-sse/executors/webPacer.js?serial=1");
    mod._resetForTests();
    let active = 0;
    let maxActive = 0;
    const run = async () => {
      const release = await mod.acquire("deepseek-web", "tok-1");
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
      release();
    };
    await Promise.all([run(), run(), run(), run()]);
    expect(maxActive).toBe(1);
  }, 20000);

  it("enforces a minimum gap between consecutive requests", async () => {
    const mod = await import("../../open-sse/executors/webPacer.js?gap=1");
    mod._resetForTests();
    const r1 = await mod.acquire("deepseek-web", "tok-gap");
    r1();
    const start = Date.now();
    const r2 = await mod.acquire("deepseek-web", "tok-gap");
    const gap = Date.now() - start;
    r2();
    // Default MIN_INTERVAL_MS is 2500; the second acquire must wait for it.
    expect(gap).toBeGreaterThan(1000);
  }, 15000);

  it("allows different accounts to proceed independently", async () => {
    const r1 = await acquire("deepseek-web", "tok-A");
    const r2 = await acquire("deepseek-web", "tok-B");
    // Both acquired without one blocking the other's acquisition.
    expect(typeof r1).toBe("function");
    expect(typeof r2).toBe("function");
    r1();
    r2();
  });
});

describe("webPacer — outcome ledger", () => {
  it("classifies 429 as rate_limit", () => {
    expect(classifyUpstream(429, "")).toBe("rate_limit");
  });

  it("classifies 401/403 as auth_fail", () => {
    expect(classifyUpstream(401, "")).toBe("auth_fail");
    expect(classifyUpstream(403, "")).toBe("auth_fail");
  });

  it("classifies a suspension body as suspended (wins over status)", () => {
    expect(classifyUpstream(403, "Your account has been suspended until October 12")).toBe("suspended");
  });

  it("records outcomes and exposes them without the credential", () => {
    noteOutcome("deepseek-web", "SECRET-TOKEN-VALUE", "rate_limit", "HTTP 429");
    const snap = healthStatus();
    const keys = Object.keys(snap.accounts);
    expect(keys).toHaveLength(1);
    const entry = snap.accounts[keys[0]];
    expect(entry.status).toBe("rate_limited");
    expect(entry.provider).toBe("deepseek-web");
    // The raw credential must never appear anywhere in the snapshot.
    expect(JSON.stringify(snap)).not.toContain("SECRET-TOKEN-VALUE");
    expect(entry.account).toBe(accountKey("SECRET-TOKEN-VALUE"));
  });

  it("parks a suspended account and flags it", () => {
    noteOutcome("qwen-web", "tok", "suspended", "banned");
    const snap = healthStatus();
    const entry = Object.values(snap.accounts)[0];
    expect(entry.status).toBe("suspended");
    expect(entry.cooldownRemainingMs).toBeGreaterThan(60_000);
  });
});

describe("webPacer — cooldown gating", () => {
  it("makes the next request wait out an active cooldown", async () => {
    process.env.WEB_PACE_COOLDOWN_MS = "5000";
    // Force a fresh import so the env value is picked up.
    const mod = await import("../../open-sse/executors/webPacer.js?cooldown=1");
    mod._resetForTests();
    mod.noteOutcome("grok-web", "tok", "rate_limit");

    const start = Date.now();
    const release = await mod.acquire("grok-web", "tok");
    const waited = Date.now() - start;
    release();
    // Must have waited a meaningful fraction of the cooldown, not fired instantly.
    expect(waited).toBeGreaterThan(1000);
  }, 15000);
});
