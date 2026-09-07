import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createOfficialFallbackFetch,
  jsonRpcLooksRateLimited,
  shouldFailoverHttpStatus,
  shouldFailoverResponse,
} from "../src/rpc-failover.ts";
import { preflightHasResolvedRpc, resolveBrowserRpcUrl } from "../src/config.ts";

describe("rpc-failover", () => {
  it("fails over 429 / 5xx / missing proxy, not ordinary 400", () => {
    assert.equal(shouldFailoverHttpStatus(429), true);
    assert.equal(shouldFailoverHttpStatus(502), true);
    assert.equal(shouldFailoverHttpStatus(404), true);
    assert.equal(shouldFailoverHttpStatus(400), false);
    assert.equal(shouldFailoverHttpStatus(200), false);
  });

  it("fails over Solana JSON-RPC rate-limit codes on HTTP 200", () => {
    assert.equal(jsonRpcLooksRateLimited(JSON.stringify({ error: { code: -32005 } })), true);
    assert.equal(jsonRpcLooksRateLimited(JSON.stringify({ result: { value: 1 } })), false);
    assert.equal(
      shouldFailoverResponse(200, JSON.stringify({ jsonrpc: "2.0", error: { code: -32005 } })),
      true,
    );
  });

  it("retries the official URL when the primary 429s", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("/rpc")) {
        return new Response("rate", { status: 429 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: 1 }), { status: 200 });
    }) as typeof fetch;
    const fetchWithFallback = createOfficialFallbackFetch({
      fallbackUrl: "https://api.mainnet-beta.solana.com",
      fetchImpl,
    });
    const res = await fetchWithFallback("https://dao.kekbull.com/rpc", {
      method: "POST",
      body: "{}",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ["https://dao.kekbull.com/rpc", "https://api.mainnet-beta.solana.com"]);
  });
});

describe("resolveBrowserRpcUrl - named governance /rpc", () => {
  it("uses same-origin /rpc on dao.kekbull.com when rpcUrl is empty", () => {
    assert.equal(
      resolveBrowserRpcUrl("", "mainnet-beta", "https://dao.kekbull.com"),
      "https://dao.kekbull.com/rpc",
    );
  });

  it("still uses same-origin /rpc on the official-devnet preview", () => {
    assert.equal(
      resolveBrowserRpcUrl("", "devnet", "https://devnet.dao.kekbull.com"),
      "https://devnet.dao.kekbull.com/rpc",
    );
  });

  it("refuses a relative rpcUrl on an unsigned host", () => {
    assert.throws(
      () => resolveBrowserRpcUrl("/rpc", "mainnet-beta", "https://evil.tld"),
      /named governance origin or loopback only/,
    );
  });
});

describe("preflightHasResolvedRpc", () => {
  it("treats empty mainnet rpcUrl as runnable on dao.kekbull.com", () => {
    assert.equal(preflightHasResolvedRpc("", "mainnet-beta", "https://dao.kekbull.com"), true);
  });

  it("treats empty rpcUrl as runnable on the official-devnet preview", () => {
    assert.equal(preflightHasResolvedRpc("", "devnet", "https://devnet.dao.kekbull.com"), true);
  });

  it("does not auto-run from official-cluster fallback on an unsigned host", () => {
    assert.equal(preflightHasResolvedRpc("", "mainnet-beta", "https://evil.tld"), false);
  });

  it("accepts an explicit rpcUrl pin", () => {
    assert.equal(
      preflightHasResolvedRpc("https://api.mainnet-beta.solana.com", "mainnet-beta", "https://evil.tld"),
      true,
    );
  });
});
