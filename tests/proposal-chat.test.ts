/**
 * Behavioural coverage for proposal-chat-server.cjs - the first signature +
 * TOR verifier in this tree. Each refusal is sent at the real handler.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";

import { buildChatMessage as buildChatMessageTs } from "../src/proposal-chat.ts";
import chatModule from "../scripts/proposal-chat-server.cjs";

const {
  createProposalChatHandler,
  buildChatMessage,
  sha256Hex,
  findTokenOwnerRecordAddress,
  findProgramAddress,
  isOnCurve,
  parseTokenOwnerRecordDeposit,
  parseProposalWindow,
  proposalChatOpen,
  openDatabase,
  purgeExpiredNonces,
  encodeBase58,
  decodeBase58,
  MAX_COMMENT_BYTES,
  NONCE_TTL_MS,
} = chatModule as {
  createProposalChatHandler: (options?: Record<string, unknown>) => (
    req: unknown,
    res: unknown,
  ) => Promise<void>;
  buildChatMessage: (fields: {
    cluster: string;
    realm: string;
    action: string;
    proposal: string;
    parent: string;
    id: string;
    nonce: string;
    bodySha256: string;
  }) => string;
  sha256Hex: (bytes: Buffer) => string;
  findTokenOwnerRecordAddress: (
    programId: Buffer,
    realm: Buffer,
    mint: Buffer,
    owner: Buffer,
  ) => Buffer;
  findProgramAddress: (seeds: Buffer[], programId: Buffer) => { address: Buffer; bump: number };
  isOnCurve: (bytes: Buffer) => boolean;
  parseTokenOwnerRecordDeposit: (
    data: Buffer,
    expected: { realm: Buffer; mint: Buffer; owner: Buffer },
  ) => bigint;
  parseProposalWindow: (data: Buffer) => {
    state: number;
    votingAt: number | null;
    maxVotingTime: number | null;
  };
  proposalChatOpen: (
    parsed: { state: number; votingAt: number | null; maxVotingTime: number | null },
    baseVotingTime: number,
    nowSecs: number,
  ) => boolean;
  openDatabase: (path: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      run: (...args: unknown[]) => unknown;
      get: (...args: unknown[]) => { n?: number } | undefined;
    };
  };
  purgeExpiredNonces: (db: unknown, now: number) => void;
  NONCE_TTL_MS: number;
  encodeBase58: (bytes: Buffer) => string;
  decodeBase58: (value: string) => Buffer | null;
  MAX_COMMENT_BYTES: number;
};

const GOOD_ORIGIN = "http://127.0.0.1:5180";
const MAINNET_ORIGIN = "https://dao.kekbull.com";
const REALM = "6EpLSH6mHesrapFcFqZ4fTFWseccuktgz7ESUSzfNKzz";
const MINT = "DFh21oYa7xnAHD9FiravvvKQExdTteiHaxbyxmPfNUeS";
const PROPOSAL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const OTHER_PROPOSAL = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PROGRAM = "2uNHeSLiNn6dLLtiGrpCd8UZKBfV36kap57eg9kV39Fj";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    wallet: new PublicKey(raw).toBase58(),
    sign(message: string): string {
      return sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");
    },
  };
}

const author = keypair();
const stranger = keypair();

const deployment = {
  cluster: "devnet" as const,
  realmsInstance: "kekbull",
  realm: REALM,
  ichorMint: MINT,
};

let server: Server;
let base: string;
let now = Date.now();
let depositAmount = 1n;
let windowOpen = true;
const db = openDatabase(":memory:");

before(async () => {
  const handle = createProposalChatHandler({
    db,
    nowMs: () => now,
    noncesPerMinute: 1_000,
    getDeployment: (cluster: string) =>
      cluster === "mainnet-beta"
        ? { cluster: "mainnet-beta", realmsInstance: "kekbull", realm: null, ichorMint: MINT }
        : deployment,
    fetchDeposit: async () => depositAmount,
    fetchProposalWindow: async () => ({ open: windowOpen, reason: windowOpen ? "ok" : "closed" }),
  });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("no port");
  }
  base = `http://127.0.0.1:${String(addr.port)}/api/proposal-chat`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function getNonce(origin = GOOD_ORIGIN): Promise<{ status: number; nonce?: string; realm?: string | null }> {
  const res = await fetch(`${base}/nonce`, { headers: { origin } });
  const body = (await res.json()) as { nonce?: string; realm?: string | null };
  return { status: res.status, nonce: body.nonce, realm: body.realm };
}

async function list(
  proposal = PROPOSAL,
  origin = GOOD_ORIGIN,
  extra: { limit?: number; before?: string; parent?: string } = {},
) {
  const query = new URLSearchParams({ proposal });
  if (extra.limit != null) query.set("limit", String(extra.limit));
  if (extra.before) query.set("before", extra.before);
  if (extra.parent) query.set("parent", extra.parent);
  const res = await fetch(`${base}?${query.toString()}`, { headers: { origin } });
  return {
    status: res.status,
    body: (await res.json()) as {
      comments?: Array<{ id: string; body: string | null; hidden?: boolean; children?: unknown[] }>;
      nextBefore?: string | null;
      total?: number;
      error?: string;
    },
  };
}

async function post(init: {
  origin?: string;
  wallet?: ReturnType<typeof keypair>;
  proposal?: string;
  parent?: string;
  body?: string;
  nonce?: string;
  cluster?: string;
  realm?: string;
  action?: "post" | "hide";
  id?: string;
  bodySha256?: string;
  signature?: string;
}): Promise<{ status: number; body: { ok?: boolean; error?: string; id?: string } }> {
  const wallet = init.wallet ?? author;
  const origin = init.origin ?? GOOD_ORIGIN;
  const nonce = init.nonce ?? (await getNonce(origin)).nonce;
  if (!nonce) {
    return { status: 500, body: { error: "no nonce" } };
  }
  const action = init.action ?? "post";
  const parent = init.parent ?? "root";
  const proposal = init.proposal ?? PROPOSAL;
  const comment = init.body ?? "a comment";
  const bodySha256 =
    init.bodySha256 ??
    (action === "post" ? sha256Hex(Buffer.from(comment.trim(), "utf8")) : "-");
  const message = buildChatMessage({
    cluster: init.cluster ?? "devnet",
    realm: init.realm ?? REALM,
    action,
    proposal,
    parent,
    id: init.id ?? "-",
    nonce,
    bodySha256,
  });
  const payload: Record<string, string> = {
    action,
    wallet: wallet.wallet,
    proposal,
    nonce,
    signature: init.signature ?? wallet.sign(message),
    parent,
    body: comment,
  };
  if (init.id) {
    payload.id = init.id;
  }
  const res = await fetch(base, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; id?: string } };
}

describe("proposal-chat - nonce issuance", () => {
  it("rate-limits the eleventh nonce from the same IP", async () => {
    const handle = createProposalChatHandler({
      db: openDatabase(":memory:"),
      nowMs: () => Date.now(),
      noncesPerMinute: 10,
      getDeployment: () => deployment,
      fetchDeposit: async () => 1n,
      fetchProposalWindow: async () => ({ open: true, reason: "ok" }),
    });
    const isolated = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => isolated.listen(0, "127.0.0.1", resolve));
    const addr = isolated.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("no port");
    }
    const url = `http://127.0.0.1:${String(addr.port)}/api/proposal-chat/nonce`;
    const statuses: number[] = [];
    try {
      for (let i = 0; i < 11; i += 1) {
        const res = await fetch(url, { headers: { origin: GOOD_ORIGIN } });
        statuses.push(res.status);
      }
    } finally {
      await new Promise<void>((resolve) => isolated.close(() => resolve()));
    }
    assert.deepEqual(statuses.slice(0, 10), Array.from({ length: 10 }, () => 200));
    assert.equal(statuses[10], 429);
  });

  it("deletes expired unused nonces so they cannot fill the disk", () => {
    const isolated = openDatabase(":memory:");
    isolated.prepare("INSERT INTO nonces (nonce, created_at, consumed_at) VALUES (?, ?, NULL)").run(
      "ab".repeat(32),
      999,
    );
    isolated.prepare("INSERT INTO nonces (nonce, created_at, consumed_at) VALUES (?, ?, NULL)").run(
      "cd".repeat(32),
      1_000 + NONCE_TTL_MS,
    );
    purgeExpiredNonces(isolated, 1_000 + NONCE_TTL_MS);
    const leftover = isolated.prepare("SELECT COUNT(*) AS n FROM nonces").get();
    assert.equal(leftover?.n, 1);
  });
});

describe("proposal-chat - origin gate", () => {
  it("allows same-origin GET when Origin is omitted and Host is loopback", async () => {
    const res = await fetch(`${base}/nonce`);
    assert.equal(res.status, 200);
  });

  it("refuses GET with no Origin and an unknown Host", async () => {
    const url = new URL(`${base}/nonce`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "GET",
          headers: { host: "evil.tld" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  it("refuses POST with no Origin even from loopback Host", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 403);
  });

  it("refuses a foreign origin", async () => {
    const res = await fetch(`${base}/nonce`, { headers: { origin: "https://evil.tld" } });
    assert.equal(res.status, 403);
  });

  it("refuses a lookalike suffix origin", async () => {
    const res = await fetch(`${base}/nonce`, {
      headers: { origin: "https://dao.kekbull.com.evil.tld" },
    });
    assert.equal(res.status, 403);
  });
});

describe("proposal-chat - signed post", () => {
  it("refuses empty markdown", async () => {
    const { status, body } = await post({ wallet: keypair(), body: "   \n  " });
    assert.equal(status, 400);
    assert.match(body.error ?? "", /empty/);
  });

  it("refuses a body over 8 KiB", async () => {
    const { status } = await post({
      wallet: keypair(),
      body: "x".repeat(MAX_COMMENT_BYTES + 1),
    });
    assert.equal(status, 413);
  });

  it("refuses a bad signature", async () => {
    const { status } = await post({
      wallet: keypair(),
      signature: Buffer.alloc(64).toString("base64"),
    });
    assert.equal(status, 401);
  });

  it("refuses a signature bound to the other cluster", async () => {
    const { status } = await post({ wallet: keypair(), cluster: "mainnet-beta" });
    assert.equal(status, 401);
  });

  it("refuses a signature bound to another realm", async () => {
    const { status } = await post({ wallet: keypair(), realm: PROPOSAL });
    assert.equal(status, 401);
  });

  it("refuses deposit 0", async () => {
    depositAmount = 0n;
    const { status, body } = await post({ wallet: keypair() });
    depositAmount = 1n;
    assert.equal(status, 403);
    assert.match(body.error ?? "", /deposit/);
  });

  it("refuses a closed proposal", async () => {
    windowOpen = false;
    const { status, body } = await post({ wallet: keypair() });
    windowOpen = true;
    assert.equal(status, 409);
    assert.match(body.error ?? "", /closed/);
  });

  it("accepts a deposited post and lists it", async () => {
    const { status, body } = await post({ wallet: keypair(), body: "first comment" });
    assert.equal(status, 200);
    assert.equal(typeof body.id, "string");
    const listed = await list();
    assert.equal(listed.status, 200);
    const comments = listed.body.comments as Array<{ body: string }>;
    assert.equal(comments.some((row) => row.body === "first comment"), true);
  });

  it("refuses a parent on another proposal", async () => {
    const poster = keypair();
    const first = await post({ wallet: poster, proposal: OTHER_PROPOSAL, body: "other thread" });
    assert.equal(first.status, 200);
    const { status, body } = await post({
      wallet: poster,
      parent: first.body.id,
      body: "cross",
    });
    assert.equal(status, 400);
    assert.match(body.error ?? "", /parent/);
  });

  it("consumes the nonce in the same transaction as the insert", async () => {
    const poster = keypair();
    const nonce = (await getNonce()).nonce;
    assert.ok(nonce);
    const first = await post({ wallet: poster, nonce, body: "once" });
    assert.equal(first.status, 200);
    const second = await post({ wallet: poster, nonce, body: "twice" });
    assert.equal(second.status, 409);
    assert.match(second.body.error ?? "", /nonce/);
  });
});

describe("proposal-chat - author hide only", () => {
  it("lets the author hide and refuses a stranger", async () => {
    const created = await post({ wallet: author, body: "hide me" });
    assert.equal(created.status, 200);
    const id = created.body.id as string;
    const strangerHide = await post({
      action: "hide",
      wallet: stranger,
      id,
      parent: "root",
      bodySha256: "-",
    });
    assert.equal(strangerHide.status, 403);
    const authorHide = await post({
      action: "hide",
      wallet: author,
      id,
      parent: "root",
      bodySha256: "-",
    });
    assert.equal(authorHide.status, 200);
    const listed = await list();
    const found = (listed.body.comments as Array<{ id: string; hidden: boolean; body: string | null }>).find(
      (row) => row.id === id,
    );
    assert.ok(found);
    assert.equal(found.hidden, true);
    assert.equal(found.body, null);
  });
});

describe("proposal-chat - mainnet unpublished", () => {
  it("issues a nonce but refuses POST while realm is null", async () => {
    const nonce = await getNonce(MAINNET_ORIGIN);
    assert.equal(nonce.status, 200);
    assert.equal(nonce.realm, null);
    const { status, body } = await post({
      origin: MAINNET_ORIGIN,
      wallet: keypair(),
      nonce: nonce.nonce,
      cluster: "mainnet-beta",
      realm: REALM,
    });
    assert.equal(status, 409);
    assert.equal(body.error, "REALM_UNPUBLISHED");
  });
});

describe("proposal-chat - one-pager pagination", () => {
  it("pages newest roots and older via before", async () => {
    const poster = keypair();
    const pageProposal = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
    now += 1000;
    const a = await post({ wallet: poster, proposal: pageProposal, body: "oldest" });
    now += 1000;
    const b = await post({ wallet: poster, proposal: pageProposal, body: "middle" });
    now += 1000;
    const c = await post({ wallet: poster, proposal: pageProposal, body: "newest" });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 200);
    const first = await list(pageProposal, GOOD_ORIGIN, { limit: 2 });
    assert.equal(first.status, 200);
    assert.equal(first.body.total, 3);
    assert.deepEqual(
      (first.body.comments ?? []).map((row) => row.body),
      ["newest", "middle"],
    );
    assert.equal(typeof first.body.nextBefore, "string");
    const second = await list(pageProposal, GOOD_ORIGIN, {
      limit: 2,
      before: first.body.nextBefore ?? undefined,
    });
    assert.equal(second.status, 200);
    assert.deepEqual(
      (second.body.comments ?? []).map((row) => row.body),
      ["oldest"],
    );
    assert.equal(second.body.nextBefore ?? null, null);
  });
});

describe("proposal-chat - rate limit", () => {
  it("refuses more than 10 posts per minute for one wallet", async () => {
    const flooder = keypair();
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      last = (await post({ wallet: flooder, body: `flood ${String(i)}` })).status;
    }
    assert.equal(last, 429);
  });
});

describe("proposal-chat - PDA and parsers (no RPC)", () => {
  it("matches @solana/web3.js findProgramAddressSync for a TOR", () => {
    const program = new PublicKey(PROGRAM);
    const realm = new PublicKey(REALM);
    const mint = new PublicKey(MINT);
    const owner = new PublicKey(author.wallet);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("governance"), realm.toBuffer(), mint.toBuffer(), owner.toBuffer()],
      program,
    );
    const mine = findTokenOwnerRecordAddress(
      program.toBuffer(),
      realm.toBuffer(),
      mint.toBuffer(),
      owner.toBuffer(),
    );
    assert.equal(encodeBase58(mine), expected.toBase58());
    assert.equal(isOnCurve(Buffer.from(expected.toBytes())), false);
    assert.equal(isOnCurve(Buffer.from(owner.toBytes())), true);
  });

  it("reads a TokenOwnerRecord deposit and treats missing as the caller's job", () => {
    const realm = decodeBase58(REALM);
    const mint = decodeBase58(MINT);
    const owner = decodeBase58(author.wallet);
    assert.ok(realm && mint && owner);
    const data = Buffer.alloc(1 + 32 * 3 + 8);
    data[0] = 17;
    realm.copy(data, 1);
    mint.copy(data, 33);
    owner.copy(data, 65);
    data.writeBigUInt64LE(42n, 97);
    assert.equal(parseTokenOwnerRecordDeposit(data, { realm, mint, owner }), 42n);
  });

  it("opens Draft/SigningOff and closes Voting after the measured window", () => {
    assert.equal(proposalChatOpen({ state: 0, votingAt: null, maxVotingTime: null }, 300, 1000), true);
    assert.equal(proposalChatOpen({ state: 1, votingAt: null, maxVotingTime: null }, 300, 1000), true);
    assert.equal(proposalChatOpen({ state: 2, votingAt: 1000, maxVotingTime: 30 }, 300, 1029), true);
    assert.equal(proposalChatOpen({ state: 2, votingAt: 1000, maxVotingTime: 30 }, 300, 1030), false);
    assert.equal(proposalChatOpen({ state: 3, votingAt: 1000, maxVotingTime: 30 }, 300, 1001), false);
  });

  it("parses a minimal ProposalV2 Yes/No layout", () => {
    const parts: Buffer[] = [];
    const pushU8 = (n: number) => parts.push(Buffer.from([n]));
    const pushU16 = (n: number) => {
      const b = Buffer.alloc(2);
      b.writeUInt16LE(n);
      parts.push(b);
    };
    const pushU32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      parts.push(b);
    };
    const pushU64 = (n: bigint) => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(n);
      parts.push(b);
    };
    const pushI64 = (n: bigint) => {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(n);
      parts.push(b);
    };
    pushU8(14);
    parts.push(Buffer.alloc(32, 1));
    parts.push(Buffer.alloc(32, 2));
    pushU8(2);
    parts.push(Buffer.alloc(32, 3));
    pushU8(1);
    pushU8(1);
    pushU8(0);
    pushU32(1);
    pushU32(3);
    parts.push(Buffer.from("Yes"));
    pushU64(0n);
    pushU8(0);
    pushU16(0);
    pushU16(0);
    pushU16(0);
    pushU8(1);
    pushU64(0n);
    pushU8(0);
    pushU8(0);
    pushU8(0);
    pushI64(1n);
    pushU8(0);
    pushU8(1);
    pushI64(1_700_000_000n);
    pushU8(0);
    pushU8(0);
    pushU8(0);
    pushU8(0);
    pushU8(0);
    pushU8(0);
    pushU8(1);
    pushU32(30);
    const parsed = parseProposalWindow(Buffer.concat(parts));
    assert.equal(parsed.state, 2);
    assert.equal(parsed.votingAt, 1_700_000_000);
    assert.equal(parsed.maxVotingTime, 30);
  });

  it("freezes the same v1 signed-message lines in the SPA and the helper", () => {
    const fields = {
      cluster: "devnet",
      realm: REALM,
      action: "post" as const,
      proposal: PROPOSAL,
      parent: "root",
      id: "-",
      nonce: "ab".repeat(32),
      bodySha256: "cd".repeat(32),
    };
    assert.equal(buildChatMessage(fields), buildChatMessageTs(fields));
    assert.match(buildChatMessage(fields), /^kekbull-proposal-chat\/v1\ncluster=devnet\nrealm=/);
  });

  it("exports findProgramAddress for hygiene-free reuse", () => {
    const program = decodeBase58(PROGRAM);
    assert.ok(program);
    const found = findProgramAddress([Buffer.from("governance"), Buffer.alloc(32, 9)], program);
    assert.equal(found.address.length, 32);
    assert.ok(found.bump <= 255);
    const digest = createHash("sha256").update("x").digest();
    assert.equal(typeof isOnCurve(digest), "boolean");
  });
});
