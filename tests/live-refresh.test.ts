import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIVE_MINT_SNAPSHOT_TTL_MS, invalidateLiveMintCache } from "../src/chain.ts";
import { LIVE_REFRESH_TTL_MS } from "../src/live-refresh.ts";

describe("live refresh floor", () => {
  it("keeps the mint snapshot and panel auto-refresh on the same 15s floor", () => {
    assert.equal(LIVE_MINT_SNAPSHOT_TTL_MS, 15_000);
    assert.equal(LIVE_REFRESH_TTL_MS, 15_000);
    assert.equal(LIVE_MINT_SNAPSHOT_TTL_MS, LIVE_REFRESH_TTL_MS);
  });

  it("exposes a cache bust for a confirmed write", () => {
    assert.equal(typeof invalidateLiveMintCache, "function");
    invalidateLiveMintCache();
  });
});
