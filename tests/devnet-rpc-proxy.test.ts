/**
 * Loopback official-devnet /rpc helper. Origin-gated. Read-cache only.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import proxyModule from "../scripts/devnet-rpc-proxy.cjs";

const { createDevnetRpcProxyHandler, originAllowed } = proxyModule as {
  createDevnetRpcProxyHandler: (options?: {
    upstream?: string;
    fetch?: typeof fetch;
    nowMs?: () => number;
  }) => (req: unknown, res: unknown) => Promise<void>;
  originAllowed: (origin: string) => boolean;
};

const GOOD_ORIGIN = "https://devnet.dao.kekbull.com";
const UPSTREAM = "https://api.devnet.solana.com";

let server: Server;
let base: string;
let now = Date.now();
let fetchCalls = 0;

before(async () => {
  const handle = createDevnetRpcProxyHandler({
    upstream: UPSTREAM,
    nowMs: () => now,
    fetch: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 7 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("no port");
  }
  base = `http://127.0.0.1:${String(addr.port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("devnet-rpc-proxy - origin gate", () => {
  it("allows the official-devnet preview origin", () => {
    assert.equal(originAllowed(GOOD_ORIGIN), true);
    assert.equal(originAllowed("https://dao.kekbull.com"), false);
    assert.equal(originAllowed("https://evil.tld"), false);
  });

  it("refuses POST with no Origin", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    assert.equal(res.status, 403);
  });
});

describe("devnet-rpc-proxy - read cache", () => {
  it("forwards getAccountInfo once and serves the next from cache", async () => {
    fetchCalls = 0;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "getAccountInfo",
      params: ["4JPcmxfCEDddhs9AtoyYpDLWmLCgS6vJGE6NP7ccnD82", { encoding: "base64" }],
    });
    const first = await fetch(base, {
      method: "POST",
      headers: { origin: GOOD_ORIGIN, "content-type": "application/json" },
      body,
    });
    const second = await fetch(base, {
      method: "POST",
      headers: { origin: GOOD_ORIGIN, "content-type": "application/json" },
      body: body.replace('"id":9', '"id":10'),
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(fetchCalls, 1);
    const secondJson = (await second.json()) as { id?: number };
    assert.equal(secondJson.id, 10);
  });
});
