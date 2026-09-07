#!/usr/bin/env node
/**
 * Loopback official-devnet JSON-RPC proxy for devnet.dao.kekbull.com.
 *
 * Browser talks to same-origin /rpc. This process forwards POST to an
 * official-devnet HTTPS upstream. A keyed URL may be read from
 * ICHOR_DEVNET_RPC or a *DEVNET_RPC_URL env/file line. It is never written
 * into deployment.json and this file does not name a provider.
 *
 * Mainnet URLs are refused. Bind 127.0.0.1 only. Caddy may reverse_proxy
 * only this path (5184) on the official-devnet preview origin - not on
 * dao.kekbull.com.
 *
 * Official public HTTP 429s a first-paint stampede. Identical reads are
 * cached and concurrent upstream POSTs are capped. Writes and blockhashes
 * stay live.
 */
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { dirname, join } = require("node:path");

const PORT = Number(process.env.ICHOR_DEVNET_RPC_PROXY_PORT ?? "5184");
const HOST = "127.0.0.1";
const OFFICIAL_DEVNET_HTTP = "https://api.devnet.solana.com";
const RPC_READ_TTL_MS = 15_000;
const RPC_UPSTREAM_CONCURRENCY = 2;
const RPC_CACHEABLE = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getMultipleAccountsInfo",
  "getParsedAccountInfo",
  "getBalance",
  "getEpochInfo",
  "getTokenAccountBalance",
  "getTokenSupply",
]);
const DEFAULT_ORIGINS = [
  "https://devnet.dao.kekbull.com",
  "http://127.0.0.1:5180",
  "http://localhost:5180",
];

function allowedOrigins() {
  const extra = String(process.env.ICHOR_DEVNET_RPC_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => o.length > 0);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

function originAllowed(origin) {
  if (origin.length === 0) {
    return false;
  }
  try {
    return allowedOrigins().has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function readEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const match = /^(ICHOR_DEVNET_RPC|[A-Z0-9_]+DEVNET_RPC_URL)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    const value = String(match[2] ?? "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value.length > 0 && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

function loadUpstreamFromEnv() {
  const found = [];
  const add = (raw) => {
    const value = String(raw ?? "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value.length === 0) {
      return;
    }
    if (/mainnet/i.test(value)) {
      return;
    }
    if (!/^https:\/\//i.test(value)) {
      return;
    }
    found.push(value);
  };
  add(process.env.ICHOR_DEVNET_RPC);
  for (const [key, value] of Object.entries(process.env)) {
    if (/^[A-Z0-9_]+DEVNET_RPC_URL$/.test(key)) {
      add(value);
    }
  }
  return found[0] ?? OFFICIAL_DEVNET_HTTP;
}

function resolveUpstream() {
  const repoEnv = join(dirname(__filename), "..", "..", "..", ".env");
  readEnvFile(repoEnv);
  const extra = String(process.env.ICHOR_DEVNET_RPC_ENV_FILE ?? "").trim();
  if (extra) {
    readEnvFile(extra);
  }
  return loadUpstreamFromEnv();
}

function rpcRequestId(value) {
  if (value !== null && typeof value === "object" && "id" in value) {
    return value.id;
  }
  return null;
}

function rewriteRpcId(cached, incoming) {
  if (Array.isArray(cached) && Array.isArray(incoming)) {
    return cached.map((row, index) => {
      if (row !== null && typeof row === "object") {
        return { ...row, id: rpcRequestId(incoming[index]) };
      }
      return row;
    });
  }
  if (cached !== null && typeof cached === "object" && !Array.isArray(cached)) {
    return { ...cached, id: rpcRequestId(incoming) };
  }
  return cached;
}

function rpcReadCacheKey(parsed) {
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const parts = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") {
      return null;
    }
    const method = row.method;
    const params = row.params;
    if (typeof method !== "string" || !RPC_CACHEABLE.has(method)) {
      return null;
    }
    parts.push(`${method}:${JSON.stringify(params ?? null)}`);
  }
  return parts.join("|");
}

function rpcJsonHasError(parsed) {
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.some((row) => row !== null && typeof row === "object" && row.error != null);
}

function createDevnetRpcProxyHandler(options = {}) {
  const upstream = options.upstream ?? resolveUpstream();
  if (/mainnet/i.test(upstream)) {
    throw new Error("devnet RPC proxy refuses a mainnet upstream");
  }
  const fetchImpl = options.fetch ?? fetch;
  const nowMs = options.nowMs ?? (() => Date.now());
  /** @type {Map<string, { body: Buffer; at: number; status: number }>} */
  const rpcReadCache = new Map();
  /** @type {Map<string, Promise<{ status: number; body: Buffer }>>} */
  const rpcReadInflight = new Map();
  let rpcUpstreamInflight = 0;
  /** @type {Array<() => void>} */
  const rpcUpstreamWaiters = [];

  function acquireRpcUpstream() {
    if (rpcUpstreamInflight < RPC_UPSTREAM_CONCURRENCY) {
      rpcUpstreamInflight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      rpcUpstreamWaiters.push(() => {
        rpcUpstreamInflight += 1;
        resolve();
      });
    });
  }

  function releaseRpcUpstream() {
    rpcUpstreamInflight = Math.max(0, rpcUpstreamInflight - 1);
    const next = rpcUpstreamWaiters.shift();
    if (next) {
      next();
    }
  }

  async function proxyOfficialDevnetRpc(rawBody) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      parsed = null;
    }
    const cacheKey = parsed === null ? null : rpcReadCacheKey(parsed);
    if (cacheKey) {
      const hit = rpcReadCache.get(cacheKey);
      if (hit && nowMs() - hit.at < RPC_READ_TTL_MS) {
        const cachedJson = JSON.parse(hit.body.toString("utf8"));
        return {
          status: hit.status,
          body: Buffer.from(JSON.stringify(rewriteRpcId(cachedJson, parsed))),
        };
      }
      const pending = rpcReadInflight.get(cacheKey);
      if (pending) {
        const shared = await pending;
        const cachedJson = JSON.parse(shared.body.toString("utf8"));
        return {
          status: shared.status,
          body: Buffer.from(JSON.stringify(rewriteRpcId(cachedJson, parsed))),
        };
      }
    }
    const load = (async () => {
      await acquireRpcUpstream();
      try {
        const upstreamRes = await fetchImpl(upstream, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new Uint8Array(rawBody),
        });
        const body = Buffer.from(await upstreamRes.arrayBuffer());
        if (cacheKey && upstreamRes.status === 200) {
          try {
            const json = JSON.parse(body.toString("utf8"));
            if (!rpcJsonHasError(json)) {
              rpcReadCache.set(cacheKey, {
                body,
                at: nowMs(),
                status: upstreamRes.status,
              });
            }
          } catch {
            /* leave uncached */
          }
        }
        return { status: upstreamRes.status, body };
      } finally {
        releaseRpcUpstream();
      }
    })();
    if (cacheKey) {
      rpcReadInflight.set(cacheKey, load);
      try {
        return await load;
      } finally {
        rpcReadInflight.delete(cacheKey);
      }
    }
    return load;
  }

  return async function handleDevnetRpcProxy(req, res) {
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      res.writeHead(426, { connection: "close" });
      res.end();
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const origin = String(req.headers.origin ?? "").trim();
    if (!originAllowed(origin)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32600, message: "origin not allowed" },
          id: null,
        }),
      );
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32600, message: "POST only" },
          id: null,
        }),
      );
      return;
    }
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    try {
      const proxied = await proxyOfficialDevnetRpc(Buffer.concat(chunks));
      res.writeHead(proxied.status, { "content-type": "application/json" });
      res.end(proxied.body);
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "loopback official-devnet RPC proxy failed" },
          id: null,
        }),
      );
    }
  };
}

module.exports = {
  createDevnetRpcProxyHandler,
  loadUpstreamFromEnv,
  originAllowed,
  OFFICIAL_DEVNET_HTTP,
  HOST,
  PORT,
};

if (require.main === module) {
  const handle = createDevnetRpcProxyHandler();
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(PORT, HOST, () => {
    process.stderr.write(`[devnet-rpc-proxy] loopback ${HOST}:${String(PORT)}\n`);
  });
}
