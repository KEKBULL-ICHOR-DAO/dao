/**
 * Loopback mainnet /rpc helper. Origin-gated. Primary then official fallback.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import proxyModule from "../scripts/mainnet-rpc-proxy.cjs";

const { createMainnetRpcProxyHandler, originAllowed } = proxyModule as {
  createMainnetRpcProxyHandler: (options?: {
    primary?: string;
    fallback?: string;
    fetch?: typeof fetch;
    nowMs?: () => number;
  }) => (req: unknown, res: unknown) => Promise<void>;
  originAllowed: (origin: string) => boolean;
};

const GOOD_ORIGIN = "https://dao.kekbull.com";
const PRIMARY = "https://primary.example/rpc";
const FALLBACK = "https://api.mainnet-beta.solana.com";

let server: Server;
let base: string;
let now = Date.now();
let urls: string[] = [];
let primaryStatus = 200;

before(async () => {
  const handle = createMainnetRpcProxyHandler({
    primary: PRIMARY,
    fallback: FALLBACK,
    nowMs: () => now,
    fetch: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      urls.push(url);
      if (url === PRIMARY) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 7 } }), {
          status: primaryStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 9 } }), {
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

describe("mainnet-rpc-proxy - origin gate", () => {
  it("allows the mainnet DAO origin and refuses the official-devnet preview", () => {
    assert.equal(originAllowed(GOOD_ORIGIN), true);
    assert.equal(originAllowed("https://devnet.dao.kekbull.com"), false);
    assert.equal(originAllowed("https://evil.tld"), false);
  });
});

describe("mainnet-rpc-proxy - fallback", () => {
  it("uses the official cluster when the primary 429s", async () => {
    urls = [];
    primaryStatus = 429;
    const res = await fetch(base, {
      method: "POST",
      headers: { origin: GOOD_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSlot",
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(urls, [PRIMARY, FALLBACK]);
    const json = (await res.json()) as { result: { value: number } };
    assert.equal(json.result.value, 9);
  });
});
