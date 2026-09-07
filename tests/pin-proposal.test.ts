/**
 * pin-proxy checks - behavioural coverage.
 *
 * These start the real handler and send real requests. The pin route spends the
 * operator's Pinata credential, so "the guard exists in the source" is not
 * enough - each refusal is exercised.
 *
 * The success case deliberately stubs an empty JWT: reaching the 503 proves
 * every gate ahead of it passed, without touching Pinata from a unit test.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";

import pinModule from "../scripts/pin-proposal-server.cjs";

const { createPinProposalHandler } = pinModule as {
  createPinProposalHandler: (options?: {
    getJwt?: () => string;
    getGateway?: () => string;
    pinsPerMinute?: number;
  }) => (req: unknown, res: unknown) => Promise<void>;
};

const GOOD_ORIGIN = "http://127.0.0.1:5180";
const WALLET = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
// Distinct real pubkeys, one per block: the limiter is 10/min per
// (client ip, wallet) and it correctly rate-limited this very suite.
const WALLET_ORIGIN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WALLET_CT = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const WALLET_BODY = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const WALLET_LEAK = "ComputeBudget111111111111111111111111111111";

let server: Server;
let base: string;

before(async () => {
  // Empty JWT: all gates run, the pin itself does not.
  // Suite issues more than 10 valid-wallet posts from one IP; production
  // cap is 10/min per IP (wallet rotation must not mint a new bucket).
  const handle = createPinProposalHandler({
    getJwt: () => "",
    getGateway: () => "gw.example",
    pinsPerMinute: 1_000,
  });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("no port");
  }
  base = `http://127.0.0.1:${String(addr.port)}/api/pin-proposal`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(init: {
  origin?: string;
  contentType?: string;
  wallet?: string;
  body?: string | Uint8Array;
}): Promise<number> {
  const headers: Record<string, string> = {};
  if (init.origin !== undefined) headers.origin = init.origin;
  if (init.contentType !== undefined) headers["content-type"] = init.contentType;
  if (init.wallet !== undefined) headers["x-wallet-pubkey"] = init.wallet;
  // Blob with an empty type: fetch sets no Content-Type of its own, so an
  // omitted `contentType` is genuinely absent on the wire.
  const raw = init.body ?? "# body";
  const res = await fetch(base, { method: "POST", headers, body: new Blob([raw]) });
  return res.status;
}

function okWith(wallet: string) {
  return { origin: GOOD_ORIGIN, contentType: "text/markdown; charset=utf-8", wallet };
}

describe("pin route - origin gate (H1)", () => {
  it("refuses a request with no Origin", async () => {
    assert.equal(await post({ contentType: "text/markdown", wallet: WALLET_ORIGIN }), 403);
  });

  it("refuses a foreign origin", async () => {
    assert.equal(await post({ ...okWith(WALLET_ORIGIN), origin: "https://evil.tld" }), 403);
  });

  it("refuses a lookalike suffix origin", async () => {
    // The exact bug a startsWith/includes check would let through.
    assert.equal(await post({ ...okWith(WALLET_ORIGIN), origin: "https://dao.kekbull.com.evil.tld" }), 403);
  });

  it("accepts the governance origin", async () => {
    assert.equal(await post({ ...okWith(WALLET_ORIGIN), origin: "https://dao.kekbull.com" }), 503);
  });
});

describe("pin route - content-type gate (H3)", () => {
  it("refuses an absent content-type", async () => {
    // Previously skipped the check entirely and pinned the body verbatim.
    assert.equal(await post({ origin: GOOD_ORIGIN, wallet: WALLET_CT }), 415);
  });

  it("refuses multipart smuggling an allowed type in the boundary", async () => {
    assert.equal(
      await post({ ...okWith(WALLET_CT), contentType: "multipart/form-data; boundary=----text/plain" }),
      415,
    );
  });

  it("refuses an image type carrying an allowed type as a parameter", async () => {
    assert.equal(await post({ ...okWith(WALLET_CT), contentType: "image/png; note=text/plain" }), 415);
  });

  it("accepts text/markdown and text/plain, with or without charset", async () => {
    assert.equal(await post({ ...okWith(WALLET_CT), contentType: "text/markdown" }), 503);
    assert.equal(await post({ ...okWith(WALLET_CT), contentType: "TEXT/PLAIN; charset=utf-8" }), 503);
  });
});

describe("pin route - wallet gate (H2)", () => {
  it("refuses a missing wallet header", async () => {
    assert.equal(await post({ origin: GOOD_ORIGIN, contentType: "text/markdown" }), 400);
  });

  it("refuses the old free-text default", async () => {
    assert.equal(await post({ ...okWith(WALLET), wallet: "anon" }), 400);
  });

  it("refuses a counter, which used to mint a fresh rate bucket each time", async () => {
    assert.equal(await post({ ...okWith(WALLET), wallet: "1" }), 400);
    assert.equal(await post({ ...okWith(WALLET), wallet: "2" }), 400);
  });

  it("refuses base58 that does not decode to 32 bytes", async () => {
    assert.equal(await post({ ...okWith(WALLET), wallet: "111111111111111111111111111111111" }), 400);
  });
});

describe("pin route - body gate", () => {
  it("refuses an empty body", async () => {
    assert.equal(await post({ ...okWith(WALLET_BODY), body: "   \n  " }), 400);
  });

  it("refuses non-UTF8 bytes", async () => {
    assert.equal(await post({ ...okWith(WALLET_BODY), body: new Uint8Array([0xff, 0xfe, 0xff, 0xfe]) }), 400);
  });

  it("refuses control characters", async () => {
    assert.equal(await post({ ...okWith(WALLET_BODY), body: "# ok\u0007hidden" }), 400);
  });

  it("refuses a body over the cap", async () => {
    assert.equal(await post({ ...okWith(WALLET_BODY), body: "x".repeat(64 * 1024 + 1) }), 413);
  });

  it("accepts a body at the cap", async () => {
    assert.equal(await post({ ...okWith(WALLET_BODY), body: "x".repeat(64 * 1024) }), 503);
  });
});

describe("pin route - IP spend cap, not per forged wallet", () => {
  it("rate-limits the eleventh distinct wallet from the same IP", async () => {
    const WALLETS = Array.from({ length: 11 }, () => Keypair.generate().publicKey.toBase58());
    const handle = createPinProposalHandler({
      getJwt: () => "",
      getGateway: () => "gw.example",
      pinsPerMinute: 10,
    });
    const isolated = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => isolated.listen(0, "127.0.0.1", resolve));
    const addr = isolated.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("no port");
    }
    const url = `http://127.0.0.1:${String(addr.port)}/api/pin-proposal`;
    const statuses: number[] = [];
    try {
      for (const wallet of WALLETS) {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            origin: GOOD_ORIGIN,
            "content-type": "text/markdown",
            "x-wallet-pubkey": wallet,
          },
          body: "# body",
        });
        statuses.push(res.status);
      }
    } finally {
      await new Promise<void>((resolve) => isolated.close(() => resolve()));
    }
    assert.deepEqual(statuses.slice(0, 10), Array.from({ length: 10 }, () => 503));
    assert.equal(statuses[10], 429);
  });
});

describe("pin route - does not leak configuration state", () => {
  it("returns a generic error when the JWT is unset", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: { origin: GOOD_ORIGIN, "content-type": "text/markdown", "x-wallet-pubkey": WALLET_LEAK },
      body: "# body",
    });
    const body = (await res.json()) as { error?: string };
    assert.equal(res.status, 503);
    assert.doesNotMatch(body.error ?? "", /PINATA|JWT|GATEWAY/i);
  });
});
