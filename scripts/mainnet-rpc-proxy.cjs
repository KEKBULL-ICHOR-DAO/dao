#!/usr/bin/env node
/**
 * Loopback mainnet JSON-RPC proxy for dao.kekbull.com.
 *
 * Browser talks to same-origin /rpc. This process forwards POST to a keyed
 * HTTPS upstream (ICHOR_MAINNET_RPC or *MAINNET_RPC_URL) and, on 429 / 5xx /
 * timeout, to official https://api.mainnet-beta.solana.com. The keyed URL is
 * never written into deployment.json. This file does not name a provider.
 *
 * Devnet URLs are refused. Bind 127.0.0.1 only. Caddy may reverse_proxy
 * only this path (5185) on dao.kekbull.com - not on the official-devnet
 * preview (that origin stays on 5184).
 */
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { dirname, join } = require("node:path");

const PORT = Number(process.env.ICHOR_MAINNET_RPC_PROXY_PORT ?? "5185");
const HOST = "127.0.0.1";
const OFFICIAL_MAINNET_HTTP = "https://api.mainnet-beta.solana.com";
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
  "https://dao.kekbull.com",
  "http://127.0.0.1:5180",
  "http://localhost:5180",
];

function allowedOrigins() {
  const extra = String(process.env.ICHOR_MAINNET_RPC_ALLOWED_ORIGINS ?? "")
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
    const match = /^(ICHOR_MAINNET_RPC|[A-Z0-9_]+MAINNET_RPC_URL)=(.*)$/.exec(line);
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

function loadPrimaryFromEnv() {
  const found = [];
  const add = (raw) => {
    const value = String(raw ?? "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value.length === 0) {
      return;
    }
    if (/devnet/i.test(value)) {
      return;
    }
    if (!/^https:\/\//i.test(value)) {
      return;
    }
    found.push(value);
  };
  add(process.env.ICHOR_MAINNET_RPC);
  for (const [key, value] of Object.entries(process.env)) {
    if (/^[A-Z0-9_]+MAINNET_RPC_URL$/.test(key)) {
      add(value);
    }
  }
  return found[0] ?? OFFICIAL_MAINNET_HTTP;
}

function resolvePrimary() {
  const repoEnv = join(dirname(__filename), "..", "..", "..", ".env");
  readEnvFile(repoEnv);
  const extra = String(process.env.ICHOR_MAINNET_RPC_ENV_FILE ?? "").trim();
  if (extra) {
    readEnvFile(extra);
  }
  return loadPrimaryFromEnv();
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

function shouldFailoverStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function jsonRpcLooksRateLimited(body) {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.some((row) => {
      const code = row && typeof row === "object" ? row.error?.code : undefined;
      return code === -32005 || code === -32429;
    });
  } catch {
    return false;
  }
}

function createMainnetRpcProxyHandler(options = {}) {
  const primary = options.primary ?? resolvePrimary();
  const fallback = options.fallback ?? OFFICIAL_MAINNET_HTTP;
  if (/devnet/i.test(primary)) {
    throw new Error("mainnet RPC proxy refuses a devnet primary");
  }
  if (/devnet/i.test(fallback)) {
    throw new Error("mainnet RPC proxy refuses a devnet fallback");
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

  async function postUpstream(url, rawBody) {
    const upstreamRes = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array(rawBody),
    });
    const body = Buffer.from(await upstreamRes.arrayBuffer());
    return { status: upstreamRes.status, body };
  }

  async function proxyMainnetRpc(rawBody) {
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
        let result;
        try {
          result = await postUpstream(primary, rawBody);
        } catch {
          result = null;
        }
        const primaryFailed =
          result === null ||
          shouldFailoverStatus(result.status) ||
          (result.status === 200 && jsonRpcLooksRateLimited(result.body));
        if (primaryFailed && primary !== fallback) {
          result = await postUpstream(fallback, rawBody);
        }
        if (!result) {
          throw new Error("both RPC upstreams failed");
        }
        if (cacheKey && result.status === 200) {
          try {
            const json = JSON.parse(result.body.toString("utf8"));
            if (!rpcJsonHasError(json)) {
              rpcReadCache.set(cacheKey, {
                body: result.body,
                at: nowMs(),
                status: result.status,
              });
            }
          } catch {
            /* leave uncached */
          }
        }
        return result;
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

  return async function handleMainnetRpcProxy(req, res) {
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
      const proxied = await proxyMainnetRpc(Buffer.concat(chunks));
      res.writeHead(proxied.status, { "content-type": "application/json" });
      res.end(proxied.body);
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "loopback mainnet RPC proxy failed" },
          id: null,
        }),
      );
    }
  };
}

module.exports = {
  createMainnetRpcProxyHandler,
  loadPrimaryFromEnv,
  originAllowed,
  OFFICIAL_MAINNET_HTTP,
  HOST,
  PORT,
};

if (require.main === module) {
  const handle = createMainnetRpcProxyHandler();
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(PORT, HOST, () => {
    process.stderr.write(`[mainnet-rpc-proxy] loopback ${HOST}:${String(PORT)}\n`);
  });
}
