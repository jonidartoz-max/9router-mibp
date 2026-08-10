import { describe, it, expect, beforeEach } from "vitest";
import { setPoolGeo, getPoolGeo, poolGeoSnapshot, pruneStaleGeo, resetPoolGeo } from "open-sse/services/poolGeo.js";

describe("pool egress geo cache", () => {
  beforeEach(() => resetPoolGeo());

  it("stores geo and classifies stability from egress changes", () => {
    setPoolGeo("p1", { ip: "1.1.1.1", country: "US" });
    setPoolGeo("p1", { ip: "1.1.1.1", country: "US" }); // same IP twice
    expect(getPoolGeo("p1").isUnstable).toBe(false);
    expect(getPoolGeo("p1").ipCount).toBe(1);

    setPoolGeo("p1", { ip: "2.2.2.2", country: "US" }); // changed
    expect(getPoolGeo("p1").isUnstable).toBe(true);
    expect(getPoolGeo("p1").ipCount).toBe(2);
  });

  it("prunes TTL-stale entries (ipHistory rides along)", () => {
    setPoolGeo("p1", { ip: "1.1.1.1", country: "US" });
    setPoolGeo("p1", { ip: "2.2.2.2", country: "US" });
    const cache = globalThis["__9routerPoolGeo__"];
    cache.get("p1").ts = Date.now() - 2 * 60 * 60 * 1000;
    expect(pruneStaleGeo()).toBe(1);
    expect(poolGeoSnapshot()).toEqual({});
  });
});