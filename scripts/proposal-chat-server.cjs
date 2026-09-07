#!/usr/bin/env node
/**
 * Loopback proposal-thread helper for dao.kekbull.com / official-devnet preview / vite.
 *
 * This is the first signature + TokenOwnerRecord verifier in this tree. Do not
 * treat it as a copy of pin-proposal-server.cjs. That helper gates on Origin
 * and a shape-checked wallet header. This one verifies an ed25519 signature
 * over a server-issued nonce, then reads a live community TOR deposit and the
 * proposal window from chain.
 *
 *   GET  /api/proposal-chat/nonce
 *   GET  /api/proposal-chat?proposal=<base58>
 *   POST /api/proposal-chat   { action: "post"|"hide", ... }
 *
 * Bind 127.0.0.1 only. Caddy may reverse_proxy only this path (5183).
 *
 * Live store is SQLite on the host. Paths must be siblings of the deploy
 * roots, never inside them:
 *   ~/www/kekbull-dao-chat.sqlite
 *   ~/www/kekbull-dao-devnet-chat.sqlite
 * deploy-dao.sh --delete would wipe a file under kekbull-dao/.
 *
 * Author-hide only. No operator pubkey allowlist. Emergency illegal-content
 * wipe is a host runbook (proposal-chat-RUNBOOK.md), not a public API.
 */
"use strict";

const { createHash, createPublicKey, randomBytes, randomUUID, verify } = require("node:crypto");
const { chmodSync, existsSync } = require("node:fs");
const { createServer } = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const { join } = require("node:path");

const PORT = Number(process.env.ICHOR_CHAT_PORT ?? "5183");
const HOST = "127.0.0.1";
const MAX_COMMENT_BYTES = 8 * 1024;
const MAX_DEPTH = 8;
const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;
const REPLY_PAGE_DEFAULT = 8;
const NONCE_TTL_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const POSTS_PER_WALLET_PROPOSAL_HOUR = 20;
const RATE_PER_MINUTE = 10;
const NONCES_PER_IP_PER_MINUTE = 10;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const GOVERNANCE_SEED = Buffer.from("governance");
const PDA_MARKER = Buffer.from("ProgramDerivedAddress");
const ED25519_P = 2n ** 255n - 19n;
const ED25519_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

const ACCOUNT_PROPOSAL_V2 = 14;
const ACCOUNT_TOR_V2 = 17;
const ACCOUNT_GOVERNANCE_V2 = new Set([18, 19, 20, 21]);
const STATE_DRAFT = 0;
const STATE_SIGNING_OFF = 1;
const STATE_VOTING = 2;

const REALMS_PROGRAM = {
  "default-shared": "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw",
  test: "GTesTBiEWE32WHXXE2S4XbZvA5CrEc4xs6ZgRe895dP",
  kekbull: "2uNHeSLiNn6dLLtiGrpCd8UZKBfV36kap57eg9kV39Fj",
};

const OFFICIAL_HTTP_RPC = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

const DEFAULT_ORIGINS = [
  "https://dao.kekbull.com",
  "https://devnet.dao.kekbull.com",
  "http://127.0.0.1:5180",
  "http://localhost:5180",
];

// Where this host keeps DAO data. Overridable, and derived from $HOME rather
// than pinned to one operator's home directory: a successor who clones this
// and rehosts it must not have to patch source to make the helper start.
const DATA_ROOT = String(process.env.ICHOR_DAO_DATA_ROOT ?? "").trim() || join(process.env.HOME ?? ".", "www");

const DEFAULT_DB = {
  "mainnet-beta": join(DATA_ROOT, "kekbull-dao-chat.sqlite"),
  devnet: join(DATA_ROOT, "kekbull-dao-devnet-chat.sqlite"),
};

const DEFAULT_DEPLOYMENT = {
  "mainnet-beta": join(DATA_ROOT, "kekbull-dao", "deployment.json"),
  devnet: join(DATA_ROOT, "kekbull-dao-devnet", "deployment.json"),
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function allowedOrigins() {
  const extra = String(process.env.ICHOR_CHAT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => o.length > 0);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

function originAllowed(origin) {
  if (origin.length === 0) {
    return false;
  }
  let normalized;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }
  return allowedOrigins().has(normalized);
}

function clusterForOrigin(origin) {
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "dao.kekbull.com") {
    return "mainnet-beta";
  }
  if (host === "devnet.dao.kekbull.com" || host === "127.0.0.1" || host === "localhost") {
    return "devnet";
  }
  return null;
}

/** Host-only cluster for same-origin GET. Some browsers omit Origin on GET. */
function clusterForHost(hostHeader) {
  const host = String(hostHeader ?? "")
    .trim()
    .toLowerCase()
    .split(":")[0];
  if (host === "dao.kekbull.com") {
    return "mainnet-beta";
  }
  if (host === "devnet.dao.kekbull.com" || host === "127.0.0.1" || host === "localhost") {
    return "devnet";
  }
  return null;
}

function clusterForRequest(req) {
  const origin = String(req.headers.origin ?? "").trim();
  if (origin.length > 0) {
    if (!originAllowed(origin)) {
      return null;
    }
    return clusterForOrigin(origin);
  }
  const method = String(req.method ?? "GET").toUpperCase();
  if (method === "GET") {
    return clusterForHost(req.headers.host);
  }
  return null;
}

function decodeBase58(value) {
  if (value.length < 32 || value.length > 44) {
    return null;
  }
  const bytes = [0];
  for (const ch of value) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) {
      return null;
    }
    let carry = idx;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leading = 0;
  for (const ch of value) {
    if (ch !== "1") {
      break;
    }
    leading += 1;
  }
  const out = Buffer.alloc(bytes.length + leading);
  for (let i = 0; i < bytes.length; i += 1) {
    out[out.length - 1 - i] = bytes[i];
  }
  return out.length === 32 ? out : null;
}

function encodeBase58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let zeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    zeros += 1;
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i]];
  }
  return out;
}

function isBase58Pubkey(value) {
  return decodeBase58(value) !== null;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyEd25519(pubkey32, message, signature64) {
  if (pubkey32.length !== 32 || signature64.length !== 64) {
    return false;
  }
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pubkey32]),
      format: "der",
      type: "spki",
    });
    return verify(null, message, key, signature64);
  } catch {
    return false;
  }
}

function modP(n) {
  const x = n % ED25519_P;
  return x < 0n ? x + ED25519_P : x;
}

function powmod(base, exp, mod) {
  let r = 1n;
  let b = modP(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      r = (r * b) % mod;
    }
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

function isOnCurve(bytes) {
  if (bytes.length !== 32) {
    return false;
  }
  let y = 0n;
  for (let i = 0; i < 32; i += 1) {
    y |= BigInt(bytes[i]) << (8n * BigInt(i));
  }
  const sign = y >> 255n;
  y &= (1n << 255n) - 1n;
  if (y >= ED25519_P) {
    return false;
  }
  const y2 = modP(y * y);
  const u = modP(y2 - 1n);
  const v = modP(ED25519_D * y2 + 1n);
  const x2 = modP(u * powmod(v, ED25519_P - 2n, ED25519_P));
  let x = powmod(x2, (ED25519_P + 3n) / 8n, ED25519_P);
  if (modP(x * x) !== x2) {
    const imag = powmod(2n, (ED25519_P - 1n) / 4n, ED25519_P);
    x = modP(x * imag);
    if (modP(x * x) !== x2) {
      return false;
    }
  }
  if (x === 0n && sign === 1n) {
    return false;
  }
  return true;
}

function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = createHash("sha256")
      .update(Buffer.concat([...seeds, Buffer.from([bump]), programId, PDA_MARKER]))
      .digest();
    if (!isOnCurve(hash)) {
      return { address: hash, bump };
    }
  }
  throw new Error("unable to find viable program address");
}

function findTokenOwnerRecordAddress(programId, realm, mint, owner) {
  return findProgramAddress([GOVERNANCE_SEED, realm, mint, owner], programId).address;
}

function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] ?? "").trim();
  if (xff.length > 0) {
    const parts = xff
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length > 0) {
      return parts[parts.length - 1].slice(0, 64);
    }
  }
  return String(req.socket?.remoteAddress ?? "unknown").slice(0, 64);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function createRateLimiter(limitPerMinute) {
  /** @type {Map<string, { count: number; resetAt: number }>} */
  const buckets = new Map();
  return function rateLimit(key) {
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [existing, row] of buckets) {
        if (now >= row.resetAt) {
          buckets.delete(existing);
        }
      }
    }
    const row = buckets.get(key);
    if (!row || now >= row.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (row.count >= limitPerMinute) {
      return false;
    }
    row.count += 1;
    return true;
  };
}

const rateLimit = createRateLimiter(RATE_PER_MINUTE);

function purgeExpiredNonces(db, now) {
  db.prepare("DELETE FROM nonces WHERE created_at < ?").run(now - NONCE_TTL_MS);
}

function assertCommentBody(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw Object.assign(new Error("comment is empty"), { status: 400 });
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_COMMENT_BYTES) {
    throw Object.assign(new Error(`comment exceeds ${MAX_COMMENT_BYTES} bytes`), { status: 413 });
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(trimmed)) {
    throw Object.assign(new Error("comment contains control characters"), { status: 400 });
  }
  return trimmed;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isNonceHex(value) {
  return /^[0-9a-f]{64}$/i.test(value);
}

function buildChatMessage(fields) {
  return [
    "kekbull-proposal-chat/v1",
    `cluster=${fields.cluster}`,
    `realm=${fields.realm}`,
    `action=${fields.action}`,
    `proposal=${fields.proposal}`,
    `parent=${fields.parent}`,
    `id=${fields.id}`,
    `nonce=${fields.nonce}`,
    `body_sha256=${fields.bodySha256}`,
  ].join("\n");
}

class Cursor {
  constructor(buf) {
    this.buf = buf;
    this.i = 0;
  }
  rest() {
    return this.buf.length - this.i;
  }
  u8() {
    if (this.rest() < 1) {
      throw new Error("truncated u8");
    }
    return this.buf[this.i++];
  }
  take(n) {
    if (this.rest() < n) {
      throw new Error("truncated bytes");
    }
    const slice = this.buf.subarray(this.i, this.i + n);
    this.i += n;
    return slice;
  }
  u16() {
    const b = this.take(2);
    return b[0] | (b[1] << 8);
  }
  u32() {
    const b = this.take(4);
    return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
  }
  u64() {
    const lo = this.u32() >>> 0;
    const hi = this.u32() >>> 0;
    return BigInt(lo) + (BigInt(hi) << 32n);
  }
  i64() {
    const v = this.u64();
    return v >= 1n << 63n ? v - (1n << 64n) : v;
  }
  option(read) {
    const tag = this.u8();
    if (tag === 0) {
      return null;
    }
    if (tag !== 1) {
      throw new Error("bad option tag");
    }
    return read();
  }
  string() {
    const len = this.u32();
    if (len > 10_000) {
      throw new Error("string too long");
    }
    return this.take(len).toString("utf8");
  }
}

function parseTokenOwnerRecordDeposit(data, expected) {
  if (data.length < 1 + 32 * 3 + 8) {
    throw new Error("TokenOwnerRecord too small");
  }
  const cur = new Cursor(data);
  const accountType = cur.u8();
  if (accountType !== ACCOUNT_TOR_V2 && accountType !== 2) {
    throw new Error("not a TokenOwnerRecord");
  }
  const realm = cur.take(32);
  const mint = cur.take(32);
  const owner = cur.take(32);
  const amount = cur.u64();
  if (!realm.equals(expected.realm) || !mint.equals(expected.mint) || !owner.equals(expected.owner)) {
    throw new Error("TokenOwnerRecord identity mismatch");
  }
  return amount;
}

function skipVoteType(cur) {
  const tag = cur.u8();
  if (tag === 0) {
    return;
  }
  if (tag === 1) {
    cur.u8();
    cur.u8();
    cur.u8();
    cur.u8();
    return;
  }
  throw new Error("unknown VoteType");
}

function skipProposalOptions(cur) {
  const n = cur.u32();
  if (n > 64) {
    throw new Error("too many proposal options");
  }
  for (let i = 0; i < n; i += 1) {
    cur.string();
    cur.u64();
    cur.u8();
    cur.u16();
    cur.u16();
    cur.u16();
  }
}

function parseProposalWindow(data) {
  const cur = new Cursor(data);
  const accountType = cur.u8();
  if (accountType !== ACCOUNT_PROPOSAL_V2) {
    throw new Error("not a ProposalV2");
  }
  const governance = cur.take(32);
  const governingTokenMint = cur.take(32);
  const state = cur.u8();
  cur.take(32);
  cur.u8();
  cur.u8();
  skipVoteType(cur);
  skipProposalOptions(cur);
  cur.option(() => cur.u64());
  cur.u8();
  cur.option(() => cur.u64());
  cur.option(() => cur.i64());
  cur.i64();
  cur.option(() => cur.i64());
  const votingAt = cur.option(() => Number(cur.i64()));
  cur.option(() => cur.u64());
  cur.option(() => cur.i64());
  cur.option(() => cur.i64());
  cur.option(() => cur.i64());
  cur.u8();
  cur.option(() => cur.u64());
  const maxVotingTime = cur.option(() => cur.u32() >>> 0);
  return {
    governance: Buffer.from(governance),
    governingTokenMint: Buffer.from(governingTokenMint),
    state,
    votingAt,
    maxVotingTime,
  };
}

function skipVoteThreshold(cur) {
  const tag = cur.u8();
  if (tag === 0 || tag === 1) {
    cur.u8();
    return;
  }
  if (tag === 2) {
    return;
  }
  throw new Error("unknown VoteThreshold");
}

function parseGovernanceVotingBaseTime(data) {
  const cur = new Cursor(data);
  const accountType = cur.u8();
  if (!ACCOUNT_GOVERNANCE_V2.has(accountType) && accountType !== 3 && accountType !== 4) {
    throw new Error("not a Governance account");
  }
  cur.take(32);
  cur.take(32);
  cur.u32();
  skipVoteThreshold(cur);
  cur.u64();
  cur.u32();
  return cur.u32() >>> 0;
}

function proposalChatOpen(parsed, baseVotingTime, nowSecs) {
  if (parsed.state === STATE_DRAFT || parsed.state === STATE_SIGNING_OFF) {
    return true;
  }
  if (parsed.state !== STATE_VOTING) {
    return false;
  }
  if (parsed.votingAt == null) {
    return false;
  }
  const window =
    parsed.maxVotingTime != null && parsed.maxVotingTime > 0
      ? parsed.maxVotingTime
      : baseVotingTime;
  if (!Number.isFinite(window) || window <= 0) {
    return false;
  }
  return nowSecs < parsed.votingAt + window;
}

function openDatabase(path) {
  const created = path !== ":memory:" && !existsSync(path);
  const db = new DatabaseSync(path);
  if (created && path !== ":memory:") {
    chmodSync(path, 0o600);
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      proposal TEXT NOT NULL,
      parent_id TEXT,
      wallet TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      hidden_at INTEGER,
      hidden_by TEXT,
      depth INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comments_proposal_created ON comments(proposal, created_at);
    CREATE INDEX IF NOT EXISTS comments_parent ON comments(parent_id);
    CREATE INDEX IF NOT EXISTS comments_page ON comments(proposal, parent_id, created_at, id);
    CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS nonces_created ON nonces(created_at);
  `);
  return db;
}

function loadDeploymentFile(path) {
  const { readFileSync } = require("node:fs");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const cluster = raw.cluster;
  const realmsInstance = raw.realmsInstance;
  const realm = typeof raw.realm === "string" && raw.realm.length > 0 ? raw.realm : null;
  const ichorMint =
    typeof raw.ichorMint === "string" && raw.ichorMint.length > 0 ? raw.ichorMint : null;
  if (cluster !== "devnet" && cluster !== "mainnet-beta") {
    throw new Error("deployment cluster must be devnet or mainnet-beta");
  }
  if (!REALMS_PROGRAM[realmsInstance]) {
    throw new Error("deployment realmsInstance is unknown");
  }
  return { cluster, realmsInstance, realm, ichorMint };
}

async function rpcGetAccount(rpcUrl, pubkey) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [pubkey, { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  if (!res.ok) {
    throw new Error(`rpc HTTP ${res.status}`);
  }
  const body = await res.json();
  const value = body?.result?.value;
  if (value == null) {
    return null;
  }
  const raw = value.data?.[0];
  const owner = value.owner;
  if (typeof raw !== "string" || typeof owner !== "string") {
    throw new Error("rpc account missing data");
  }
  return { data: Buffer.from(raw, "base64"), owner };
}

function defaultRpcUrl(cluster) {
  if (cluster === "devnet") {
    const override = String(process.env.ICHOR_CHAT_RPC_DEVNET ?? "").trim();
    return override || OFFICIAL_HTTP_RPC.devnet;
  }
  const override = String(process.env.ICHOR_CHAT_RPC_MAINNET ?? "").trim();
  return override || OFFICIAL_HTTP_RPC["mainnet-beta"];
}

function defaultDbPath(cluster) {
  if (cluster === "devnet") {
    return String(process.env.ICHOR_CHAT_DB_DEVNET ?? "").trim() || DEFAULT_DB.devnet;
  }
  return String(process.env.ICHOR_CHAT_DB_MAINNET ?? "").trim() || DEFAULT_DB["mainnet-beta"];
}

function defaultDeploymentPath(cluster) {
  if (cluster === "devnet") {
    return (
      String(process.env.ICHOR_CHAT_DEPLOYMENT_DEVNET ?? "").trim() || DEFAULT_DEPLOYMENT.devnet
    );
  }
  return (
    String(process.env.ICHOR_CHAT_DEPLOYMENT_MAINNET ?? "").trim() || DEFAULT_DEPLOYMENT["mainnet-beta"]
  );
}

function requestRoute(req) {
  const raw = req.url ?? "/";
  const url = new URL(raw, `http://${HOST}`);
  let path = url.pathname;
  if (path.startsWith("/api/proposal-chat")) {
    path = path.slice("/api/proposal-chat".length) || "/";
  }
  if (path.length === 0) {
    path = "/";
  }
  return { path, searchParams: url.searchParams };
}

function createProposalChatHandler(options = {}) {
  const nowMs = options.nowMs ?? (() => Date.now());
  const getDeployment =
    options.getDeployment ??
    ((cluster) => loadDeploymentFile(defaultDeploymentPath(cluster)));
  const fetchDeposit = options.fetchDeposit ?? defaultFetchDeposit;
  const fetchProposalWindow = options.fetchProposalWindow ?? defaultFetchProposalWindow;
  const nonceLimit = createRateLimiter(options.noncesPerMinute ?? NONCES_PER_IP_PER_MINUTE);
  /** @type {Map<string, import("node:sqlite").DatabaseSync>} */
  const dbs = new Map();

  function dbFor(cluster) {
    const existing = dbs.get(cluster);
    if (existing) {
      return existing;
    }
    const path = options.dbPath ?? (options.db ? ":memory:" : defaultDbPath(cluster));
    const db = options.db && !options.dbPath ? options.db : openDatabase(path);
    dbs.set(cluster, db);
    return db;
  }

  async function defaultFetchDeposit(params) {
    const program = decodeBase58(REALMS_PROGRAM[params.realmsInstance]);
    const realm = decodeBase58(params.realm);
    const mint = decodeBase58(params.ichorMint);
    const owner = decodeBase58(params.wallet);
    if (!program || !realm || !mint || !owner) {
      throw new Error("deposit identity is not a pubkey");
    }
    const tor = findTokenOwnerRecordAddress(program, realm, mint, owner);
    const info = await rpcGetAccount(params.rpcUrl, encodeBase58(tor));
    if (info === null) {
      return 0n;
    }
    if (info.owner !== REALMS_PROGRAM[params.realmsInstance]) {
      throw new Error("TokenOwnerRecord owner is not the Realms program");
    }
    return parseTokenOwnerRecordDeposit(info.data, { realm, mint, owner });
  }

  async function defaultFetchProposalWindow(params) {
    const info = await rpcGetAccount(params.rpcUrl, params.proposal);
    if (info === null) {
      return { open: false, reason: "proposal not found" };
    }
    if (info.owner !== REALMS_PROGRAM[params.realmsInstance]) {
      throw new Error("proposal owner is not the Realms program");
    }
    const parsed = parseProposalWindow(info.data);
    let baseVotingTime = 0;
    if (parsed.state === STATE_VOTING) {
      if (parsed.maxVotingTime != null && parsed.maxVotingTime > 0) {
        baseVotingTime = parsed.maxVotingTime;
      } else {
        const gov = await rpcGetAccount(params.rpcUrl, encodeBase58(parsed.governance));
        if (gov === null) {
          return { open: false, reason: "governance not found" };
        }
        baseVotingTime = parseGovernanceVotingBaseTime(gov.data);
      }
    }
    const open = proposalChatOpen(parsed, baseVotingTime, Math.floor(params.nowMs / 1000));
    return { open, reason: open ? "ok" : "proposal is closed" };
  }

  return async function handleProposalChat(req, res) {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const origin = String(req.headers.origin ?? "").trim();
    const cluster = clusterForRequest(req);
    if (cluster == null) {
      json(res, 403, { ok: false, error: "origin not allowed" });
      return;
    }

    const { path, searchParams } = requestRoute(req);
    let deployment;
    try {
      deployment = getDeployment(cluster, origin);
    } catch (err) {
      process.stderr.write(
        `[proposal-chat] deployment: ${err instanceof Error ? err.message : "failed"}\n`,
      );
      json(res, 503, { ok: false, error: "deployment unavailable" });
      return;
    }
    if (deployment.cluster !== cluster) {
      json(res, 503, { ok: false, error: "deployment cluster mismatch" });
      return;
    }

    const db = dbFor(cluster);
    const now = nowMs();

    if (req.method === "GET" && (path === "/nonce" || path === "nonce")) {
      if (!nonceLimit(clientIp(req))) {
        json(res, 429, { ok: false, error: "rate limited" });
        return;
      }
      purgeExpiredNonces(db, now);
      const nonce = randomBytes(32).toString("hex");
      db.prepare("INSERT INTO nonces (nonce, created_at, consumed_at) VALUES (?, ?, NULL)").run(
        nonce,
        now,
      );
      json(res, 200, { ok: true, nonce, cluster, realm: deployment.realm });
      return;
    }

    if (req.method === "GET" && (path === "/" || path === "")) {
      const proposal = String(searchParams.get("proposal") ?? "").trim();
      if (!isBase58Pubkey(proposal)) {
        json(res, 400, { ok: false, error: "proposal must be a base58 32-byte pubkey" });
        return;
      }
      const parentRaw = String(searchParams.get("parent") ?? "").trim();
      if (parentRaw.length > 0 && parentRaw !== "root" && !isUuid(parentRaw)) {
        json(res, 400, { ok: false, error: "parent must be root or a comment id" });
        return;
      }
      const parentId = parentRaw.length === 0 || parentRaw === "root" ? null : parentRaw;
      const limit = parseLimit(searchParams.get("limit"), parentId ? REPLY_PAGE_DEFAULT : PAGE_DEFAULT);
      const before = parseCursor(searchParams.get("before"));
      const page = listCommentPage(db, { proposal, parentId, before, limit });
      json(res, 200, {
        ok: true,
        cluster,
        realm: deployment.realm,
        comments: page.comments,
        nextBefore: page.nextBefore,
        total: page.total,
      });
      return;
    }

    if (req.method !== "POST" || (path !== "/" && path !== "" && path !== "/hide")) {
      json(res, 404, { ok: false, error: "not found" });
      return;
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_COMMENT_BYTES + 4096) {
        json(res, 413, { ok: false, error: "body exceeds limit" });
        return;
      }
      chunks.push(chunk);
    }
    const rawBytes = Buffer.concat(chunks);
    let payload;
    try {
      payload = JSON.parse(rawBytes.toString("utf8"));
    } catch {
      json(res, 400, { ok: false, error: "body is not JSON" });
      return;
    }
    if (payload === null || typeof payload !== "object") {
      json(res, 400, { ok: false, error: "body is not JSON" });
      return;
    }

    const action = String(payload.action ?? (path === "/hide" ? "hide" : "")).trim();
    const wallet = String(payload.wallet ?? "").trim();
    const proposal = String(payload.proposal ?? "").trim();
    const nonce = String(payload.nonce ?? "").trim();
    const signatureB64 = String(payload.signature ?? "").trim();
    if (action !== "post" && action !== "hide") {
      json(res, 400, { ok: false, error: "action must be post or hide" });
      return;
    }
    if (!isBase58Pubkey(wallet) || !isBase58Pubkey(proposal) || !isNonceHex(nonce)) {
      json(res, 400, { ok: false, error: "wallet, proposal, and nonce are required" });
      return;
    }
    if (!rateLimit(`${clientIp(req)}:${wallet}`)) {
      json(res, 429, { ok: false, error: "rate limited" });
      return;
    }
    if (deployment.realm == null || deployment.ichorMint == null) {
      json(res, 409, { ok: false, error: "REALM_UNPUBLISHED" });
      return;
    }

    let signature;
    try {
      signature = Buffer.from(signatureB64, "base64");
    } catch {
      json(res, 400, { ok: false, error: "signature is not base64" });
      return;
    }

    if (action === "post") {
      await handlePost({
        res,
        db,
        now,
        cluster,
        deployment,
        wallet,
        proposal,
        nonce,
        signature,
        parent: String(payload.parent ?? "").trim(),
        body: typeof payload.body === "string" ? payload.body : "",
        fetchDeposit,
        fetchProposalWindow,
      });
      return;
    }

    await handleHide({
      res,
      db,
      now,
      cluster,
      deployment,
      wallet,
      proposal,
      nonce,
      signature,
      id: String(payload.id ?? "").trim(),
    });
  };
}

function parseLimit(raw, fallback) {
  if (raw == null || String(raw).trim().length === 0) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return fallback;
  }
  return Math.min(n, PAGE_MAX);
}

function parseCursor(raw) {
  if (raw == null) {
    return null;
  }
  const text = String(raw).trim();
  if (text.length === 0) {
    return null;
  }
  const sep = text.indexOf(":");
  if (sep < 1) {
    return null;
  }
  const createdAt = Number(text.slice(0, sep));
  const id = text.slice(sep + 1);
  if (!Number.isSafeInteger(createdAt) || !isUuid(id)) {
    return null;
  }
  return { createdAt, id };
}

function cursorOf(row) {
  return `${row.created_at}:${row.id}`;
}

function rowToNode(row, children, childNextBefore, childCount) {
  const hidden = row.hidden_at != null;
  return {
    id: row.id,
    parentId: row.parent_id,
    wallet: row.wallet,
    body: hidden ? null : row.body,
    hidden,
    createdAt: row.created_at,
    depth: row.depth,
    children,
    childNextBefore,
    childCount,
  };
}

function selectSiblings(db, proposal, parentId, before, limit) {
  const extra = before
    ? "AND (created_at < ? OR (created_at = ? AND id < ?))"
    : "";
  const params = before
    ? [proposal, parentId, before.createdAt, before.createdAt, before.id, limit]
    : [proposal, parentId, limit];
  return db
    .prepare(
      `SELECT id, parent_id, wallet, body, created_at, hidden_at, hidden_by, depth
       FROM comments
       WHERE proposal = ? AND parent_id IS ?
       ${extra}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params);
}

function countSiblings(db, proposal, parentId) {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM comments WHERE proposal = ? AND parent_id IS ?")
    .get(proposal, parentId);
  return Number(row?.n ?? 0);
}

function listCommentPage(db, params) {
  const rows = selectSiblings(db, params.proposal, params.parentId, params.before, params.limit);
  const total = countSiblings(db, params.proposal, params.parentId);
  const nextBefore = rows.length === params.limit ? cursorOf(rows[rows.length - 1]) : null;
  const comments = rows.map((row) => {
    const childRows = selectSiblings(db, params.proposal, row.id, null, REPLY_PAGE_DEFAULT);
    const childCount = countSiblings(db, params.proposal, row.id);
    const childNextBefore =
      childCount > childRows.length && childRows.length > 0
        ? cursorOf(childRows[childRows.length - 1])
        : null;
    const children = childRows.map((child) => {
      const grandCount = countSiblings(db, params.proposal, child.id);
      return rowToNode(child, [], null, grandCount);
    });
    return rowToNode(row, children, childNextBefore, childCount);
  });
  return { comments, nextBefore, total };
}

function consumeNonce(db, nonce, now) {
  const row = db.prepare("SELECT created_at, consumed_at FROM nonces WHERE nonce = ?").get(nonce);
  if (!row || row.consumed_at != null || now - row.created_at > NONCE_TTL_MS) {
    return false;
  }
  db.prepare("UPDATE nonces SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL").run(
    now,
    nonce,
  );
  return true;
}

async function handlePost(ctx) {
  let body;
  try {
    body = assertCommentBody(ctx.body);
  } catch (err) {
    json(ctx.res, err.status ?? 400, { ok: false, error: err.message });
    return;
  }
  const parent = ctx.parent;
  if (parent !== "root" && !isUuid(parent)) {
    json(ctx.res, 400, { ok: false, error: "parent must be root or a comment id" });
    return;
  }
  const message = buildChatMessage({
    cluster: ctx.cluster,
    realm: ctx.deployment.realm,
    action: "post",
    proposal: ctx.proposal,
    parent,
    id: "-",
    nonce: ctx.nonce,
    bodySha256: sha256Hex(Buffer.from(body, "utf8")),
  });
  const pubkey = decodeBase58(ctx.wallet);
  if (!pubkey || !verifyEd25519(pubkey, Buffer.from(message, "utf8"), ctx.signature)) {
    json(ctx.res, 401, { ok: false, error: "signature rejected" });
    return;
  }

  let deposit;
  try {
    deposit = await ctx.fetchDeposit({
      cluster: ctx.cluster,
      realmsInstance: ctx.deployment.realmsInstance,
      realm: ctx.deployment.realm,
      ichorMint: ctx.deployment.ichorMint,
      wallet: ctx.wallet,
      rpcUrl: defaultRpcUrl(ctx.cluster),
    });
  } catch (err) {
    process.stderr.write(
      `[proposal-chat] deposit: ${err instanceof Error ? err.message : "failed"}\n`,
    );
    json(ctx.res, 502, { ok: false, error: "deposit unread" });
    return;
  }
  if (deposit <= 0n) {
    json(ctx.res, 403, { ok: false, error: "deposit is zero" });
    return;
  }

  let window;
  try {
    window = await ctx.fetchProposalWindow({
      cluster: ctx.cluster,
      realmsInstance: ctx.deployment.realmsInstance,
      proposal: ctx.proposal,
      rpcUrl: defaultRpcUrl(ctx.cluster),
      nowMs: ctx.now,
    });
  } catch (err) {
    process.stderr.write(
      `[proposal-chat] proposal: ${err instanceof Error ? err.message : "failed"}\n`,
    );
    json(ctx.res, 502, { ok: false, error: "proposal unread" });
    return;
  }
  if (!window.open) {
    json(ctx.res, 409, { ok: false, error: "proposal is closed" });
    return;
  }

  const id = randomUUID();
  try {
    ctx.db.exec("BEGIN");
    if (!consumeNonce(ctx.db, ctx.nonce, ctx.now)) {
      ctx.db.exec("ROLLBACK");
      json(ctx.res, 409, { ok: false, error: "nonce reused or expired" });
      return;
    }
    const hourCount = ctx.db
      .prepare(
        "SELECT COUNT(*) AS n FROM comments WHERE wallet = ? AND proposal = ? AND created_at >= ?",
      )
      .get(ctx.wallet, ctx.proposal, ctx.now - HOUR_MS);
    if (Number(hourCount?.n ?? 0) >= POSTS_PER_WALLET_PROPOSAL_HOUR) {
      ctx.db.exec("ROLLBACK");
      json(ctx.res, 429, { ok: false, error: "rate limited" });
      return;
    }
    let depth = 0;
    let parentId = null;
    if (parent !== "root") {
      const parentRow = ctx.db
        .prepare("SELECT id, proposal, depth FROM comments WHERE id = ?")
        .get(parent);
      if (!parentRow || parentRow.proposal !== ctx.proposal) {
        ctx.db.exec("ROLLBACK");
        json(ctx.res, 400, { ok: false, error: "parent is not on this proposal" });
        return;
      }
      if (parentRow.depth >= MAX_DEPTH) {
        ctx.db.exec("ROLLBACK");
        json(ctx.res, 400, { ok: false, error: "reply depth exceeds 8" });
        return;
      }
      depth = parentRow.depth + 1;
      parentId = parentRow.id;
    }
    ctx.db
      .prepare(
        "INSERT INTO comments (id, proposal, parent_id, wallet, body, created_at, hidden_at, hidden_by, depth) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
      )
      .run(id, ctx.proposal, parentId, ctx.wallet, body, ctx.now, depth);
    ctx.db.exec("COMMIT");
  } catch (err) {
    try {
      ctx.db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    process.stderr.write(
      `[proposal-chat] insert: ${err instanceof Error ? err.message : "failed"}\n`,
    );
    json(ctx.res, 500, { ok: false, error: "insert failed" });
    return;
  }
  json(ctx.res, 200, { ok: true, id });
}

async function handleHide(ctx) {
  if (!isUuid(ctx.id)) {
    json(ctx.res, 400, { ok: false, error: "id must be a comment uuid" });
    return;
  }
  const message = buildChatMessage({
    cluster: ctx.cluster,
    realm: ctx.deployment.realm,
    action: "hide",
    proposal: ctx.proposal,
    parent: "root",
    id: ctx.id,
    nonce: ctx.nonce,
    bodySha256: "-",
  });
  const pubkey = decodeBase58(ctx.wallet);
  if (!pubkey || !verifyEd25519(pubkey, Buffer.from(message, "utf8"), ctx.signature)) {
    json(ctx.res, 401, { ok: false, error: "signature rejected" });
    return;
  }
  try {
    ctx.db.exec("BEGIN");
    if (!consumeNonce(ctx.db, ctx.nonce, ctx.now)) {
      ctx.db.exec("ROLLBACK");
      json(ctx.res, 409, { ok: false, error: "nonce reused or expired" });
      return;
    }
    const row = ctx.db
      .prepare("SELECT id, wallet, proposal, hidden_at FROM comments WHERE id = ?")
      .get(ctx.id);
    if (!row || row.proposal !== ctx.proposal) {
      ctx.db.exec("ROLLBACK");
      json(ctx.res, 404, { ok: false, error: "comment not found" });
      return;
    }
    if (row.wallet !== ctx.wallet) {
      ctx.db.exec("ROLLBACK");
      json(ctx.res, 403, { ok: false, error: "only the author can hide" });
      return;
    }
    if (row.hidden_at == null) {
      ctx.db
        .prepare("UPDATE comments SET hidden_at = ?, hidden_by = ? WHERE id = ?")
        .run(ctx.now, ctx.wallet, ctx.id);
    }
    ctx.db.exec("COMMIT");
  } catch (err) {
    try {
      ctx.db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    json(ctx.res, 500, { ok: false, error: "hide failed" });
    return;
  }
  json(ctx.res, 200, { ok: true, id: ctx.id, hidden: true });
}

module.exports = {
  HOST,
  PORT,
  MAX_COMMENT_BYTES,
  NONCE_TTL_MS,
  NONCES_PER_IP_PER_MINUTE,
  MAX_DEPTH,
  PAGE_DEFAULT,
  REPLY_PAGE_DEFAULT,
  REALMS_PROGRAM,
  DEFAULT_DB,
  createProposalChatHandler,
  buildChatMessage,
  sha256Hex,
  verifyEd25519,
  findTokenOwnerRecordAddress,
  findProgramAddress,
  isOnCurve,
  parseTokenOwnerRecordDeposit,
  parseProposalWindow,
  parseGovernanceVotingBaseTime,
  proposalChatOpen,
  openDatabase,
  purgeExpiredNonces,
  encodeBase58,
  decodeBase58,
  assertCommentBody,
};

if (require.main === module) {
  const handle = createProposalChatHandler();
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(PORT, HOST, () => {
    process.stdout.write(`proposal-chat listening on http://${HOST}:${PORT}/api/proposal-chat\n`);
  });
}
