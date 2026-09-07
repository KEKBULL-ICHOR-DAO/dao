#!/usr/bin/env node
/**
 * Loopback markdown pin helper for dao.kekbull.com / vite dev.
 * PINATA_JWT and PINATA_GATEWAY come from the environment. Never from the SPA.
 *
 *   POST /api/pin-proposal
 *   Origin: an allowlisted governance origin (required)
 *   Content-Type: text/markdown | text/plain (exact, required)
 *   X-Wallet-Pubkey: base58 32-byte pubkey (required)
 *   body: utf-8 markdown ≤ 64 KiB
 *
 *   → { ok, cid, descriptionLink }
 *
 * Bind 127.0.0.1 only. Caddy may reverse_proxy only this path.
 *
 * RESIDUAL RISK - read before putting this on a public origin.
 * The wallet header is validated for shape, not ownership. It does not mint
 * a rate bucket: Pinata spend is capped per client IP Caddy observed
 * (last X-Forwarded-For hop). Closing the remaining hole - spoofed Origin
 * from a non-browser caller - needs a signature over a server-issued nonce
 * checked against a TokenOwnerRecord with deposited ICHOR. Until that exists,
 * keep this route off any origin you would not hand the operator's Pinata
 * quota to.
 * pin-proxy checks.
 */
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { createServer } = require("node:http");

const PINATA_UPLOAD = "https://uploads.pinata.cloud/v3/files";
const MAX_BYTES = 64 * 1024;
const PORT = Number(process.env.ICHOR_PIN_PROPOSAL_PORT ?? "5182");
const HOST = "127.0.0.1";
const PINS_PER_IP_PER_MINUTE = 10;

function gatewayHost() {
  const raw = (process.env.PINATA_GATEWAY ?? "").trim();
  const host = raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host) {
    throw new Error("PINATA_GATEWAY is not set");
  }
  return host;
}

/** Origins permitted to spend the operator's Pinata credential. */
const DEFAULT_ORIGINS = [
  "https://dao.kekbull.com",
  "http://127.0.0.1:5180",
  "http://localhost:5180",
];

function allowedOrigins() {
  const extra = String(process.env.ICHOR_PIN_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => o.length > 0);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

/**
 * Exact-origin match. Never substring: `startsWith("https://dao.kekbull.com")`
 * would accept `https://dao.kekbull.com.evil.tld`.
 */
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

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Decode and require exactly 32 bytes. A character-class regex would accept a
 * 31- or 33-byte value, which is not a pubkey and would still mint a bucket.
 */
function isBase58Pubkey(value) {
  if (value.length < 32 || value.length > 44) {
    return false;
  }
  const bytes = [0];
  for (const ch of value) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) {
      return false;
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
  return bytes.length + leading === 32;
}

/**
 * The client as Caddy saw it. Caddy appends the peer address to whatever
 * X-Forwarded-For the client supplied, so the LAST entry is the one Caddy
 * observed and the only one the client cannot forge. `socket.remoteAddress`
 * alone is always 127.0.0.1 behind the proxy, which is why the old key
 * collapsed to a single bucket for every remote caller.
 */
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
  const rate = new Map();
  return function rateLimit(key) {
    const now = Date.now();
    // Expired rows for keys that never return were retained forever, so a stream
    // of distinct keys grew the heap without bound.
    if (rate.size > 10_000) {
      for (const [existing, row] of rate) {
        if (now >= row.resetAt) {
          rate.delete(existing);
        }
      }
    }
    const row = rate.get(key);
    if (!row || now >= row.resetAt) {
      rate.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (row.count >= limitPerMinute) {
      return false;
    }
    row.count += 1;
    return true;
  };
}

async function pinMarkdown(jwt, markdown, gateway) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([markdown], { type: "text/markdown" }),
    "proposal.md",
  );
  form.append("network", "public");
  const res = await fetch(PINATA_UPLOAD, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Pinata non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    // Never relay Pinata's body: it reports credential validity and quota
    // state, which is a live oracle for whether a drain has landed.
    process.stderr.write(
      `[pin-proposal] Pinata HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}\n`,
    );
    throw new Error(`Pinata rejected the pin (HTTP ${res.status})`);
  }
  const cid = body?.data?.cid;
  if (typeof cid !== "string" || cid.length === 0) {
    throw new Error("Pinata response carried no CID");
  }
  return {
    cid,
    descriptionLink: `https://${gateway}/ipfs/${cid}`,
  };
}

function loadPinataFromEnvFile() {
  const path = String(process.env.ICHOR_PIN_ENV_FILE ?? "").trim();
  if (!path || !existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^(PINATA_JWT|PINATA_GATEWAY)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const value = String(match[2] ?? "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value.length > 0 && !process.env[match[1]]) {
      process.env[match[1]] = value;
    }
  }
}

function createPinProposalHandler(options = {}) {
  const getJwt = options.getJwt ?? (() => process.env.PINATA_JWT ?? "");
  const getGateway = options.getGateway ?? gatewayHost;
  const pinsPerMinute = options.pinsPerMinute ?? PINS_PER_IP_PER_MINUTE;
  const rateLimit = createRateLimiter(pinsPerMinute);
  return async function handlePinProposal(req, res) {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "POST only" });
      return;
    }

    // H1/H3: the plan required an origin check and none existed. An absent
    // Origin is refused, not waved through - browsers set it on every POST,
    // same-origin included, so absence means a non-browser caller, which has
    // no business spending the operator's credential. This also blunts the
    // CSRF shape: text/plain is CORS-safelisted, so a cross-origin form POST
    // fires with no preflight and used to reach Pinata.
    if (!originAllowed(String(req.headers.origin ?? "").trim())) {
      json(res, 403, { ok: false, error: "origin not allowed" });
      return;
    }

    // H2: this header used to be free text defaulting to "anon", and pairing
    // it into the rate key let a fresh pubkey mint a new 10/min bucket.
    // Require a well-formed pubkey still (bounds accidents); the spend cap
    // is the client IP Caddy observed, not the claimed wallet.
    const wallet = String(req.headers["x-wallet-pubkey"] ?? "").trim();
    if (!isBase58Pubkey(wallet)) {
      json(res, 400, {
        ok: false,
        error: "x-wallet-pubkey must be a base58 32-byte pubkey",
      });
      return;
    }
    if (!rateLimit(clientIp(req))) {
      json(res, 429, { ok: false, error: "rate limited" });
      return;
    }

    // Exact media type. The old test was a substring match that was skipped
    // entirely when the header was absent, so a bare header-less POST and
    // `multipart/form-data; boundary=----text/plain` both passed. JSON bodies
    // are gone: the plan says these two text types only.
    const mediaType = String(req.headers["content-type"] ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (mediaType !== "text/markdown" && mediaType !== "text/plain") {
      json(res, 415, { ok: false, error: "text/markdown or text/plain only" });
      return;
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        json(res, 413, { ok: false, error: `body exceeds ${MAX_BYTES} bytes` });
        return;
      }
      chunks.push(chunk);
    }
    const rawBytes = Buffer.concat(chunks);
    const markdown = rawBytes.toString("utf8");
    // Round-trip check. Invalid UTF-8 decodes to U+FFFD and re-encodes to
    // different bytes, so this refuses binary rather than silently corrupting
    // it - which is what "no images, no binary" actually requires, since the
    // declared content type is only a claim.
    if (!Buffer.from(markdown, "utf8").equals(rawBytes)) {
      json(res, 400, { ok: false, error: "body is not valid UTF-8" });
      return;
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(markdown)) {
      json(res, 400, { ok: false, error: "body contains control characters" });
      return;
    }
    const trimmed = markdown.trim();
    if (trimmed.length === 0) {
      json(res, 400, { ok: false, error: "markdown is empty" });
      return;
    }
    if (Buffer.byteLength(trimmed, "utf8") > MAX_BYTES) {
      json(res, 413, { ok: false, error: `markdown exceeds ${MAX_BYTES} bytes` });
      return;
    }
    const jwt = getJwt();
    if (!jwt) {
      process.stderr.write("[pin-proposal] PINATA_JWT is not set\n");
      json(res, 503, { ok: false, error: "pin route unavailable" });
      return;
    }
    let gateway;
    try {
      gateway = getGateway();
    } catch (err) {
      process.stderr.write(
        `[pin-proposal] gateway unavailable: ${err instanceof Error ? err.message : "unknown"}\n`,
      );
      json(res, 503, { ok: false, error: "pin route unavailable" });
      return;
    }
    try {
      const pinned = await pinMarkdown(jwt, trimmed, gateway);
      json(res, 200, { ok: true, ...pinned });
    } catch (err) {
      process.stderr.write(
        `[pin-proposal] ${err instanceof Error ? err.message : "pin failed"}\n`,
      );
      json(res, 502, { ok: false, error: "pin failed" });
    }
  };
}

module.exports = { createPinProposalHandler, PINS_PER_IP_PER_MINUTE };

if (require.main === module) {
  loadPinataFromEnvFile();
  const handle = createPinProposalHandler();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    if (url.pathname !== "/api/pin-proposal") {
      json(res, 404, { ok: false, error: "not found" });
      return;
    }
    void handle(req, res);
  });
  server.listen(PORT, HOST, () => {
    process.stdout.write(`pin-proposal listening on http://${HOST}:${PORT}/api/pin-proposal\n`);
  });
}
