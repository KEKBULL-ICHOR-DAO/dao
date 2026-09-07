import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { assertShippedDeploymentJson } from "./scripts/deployment-guard.ts";

const require = createRequire(import.meta.url);

/**
 * Browser globals required before ICHOR client / Meteora SDK evaluate.
 * `@solana/spl-token-metadata` reads `Buffer` at module scope; the DAMM v2
 * SDK reads `process`. Without this, React never mounts (blank page).
 * `vite build` does not catch it — the bundler does not execute those
 * modules. Do not add a third-party Node-stdlib Vite plugin.
 */
const VIRTUAL = "virtual:node-globals";
const RESOLVED = `\0${VIRTUAL}`;
const ENTRY = fileURLToPath(new URL("./src/main.tsx", import.meta.url));

function nodeGlobals(): Plugin {
  return {
    name: "ichor-node-globals",
    enforce: "pre",
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      return [
        'import { Buffer } from "buffer";',
        "globalThis.Buffer ??= Buffer;",
        "globalThis.global ??= globalThis;",
        "globalThis.process ??= {",
        "  env: {}, argv: [], platform: 'browser', browser: true,",
        "  version: '', versions: {}, cwd: () => '/',",
        "  nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),",
        "};",
        "export {};",
      ].join("\n");
    },
    // Inject into the app entry, not index.html.
    //
    // `transformIndexHtml` with a `/@id/__x00__...` src only resolves on the
    // dev server. `vite build` copies that tag into dist/index.html verbatim,
    // where it 404s, so the shim never runs in production and never lands in
    // the bundle. `globalThis.Buffer` then stays undefined on dao.kekbull.com
    // even though the page appears to load, and the failure surfaces later as
    // a broken transaction build rather than a blank page. Verified 2026-08-24
    // by loading dist/ in headless Chrome.
    //
    // Importing the virtual module from the entry works in both modes and is
    // bundled. ES modules evaluate imports depth-first in source order, so
    // placing it first in main.tsx guarantees the globals exist before any
    // dependency module body runs.
    transform(code, id) {
      if (id.split("?")[0] !== ENTRY) return null;
      return { code: `import ${JSON.stringify(VIRTUAL)};\n${code}`, map: null };
    },
  };
}

/**
 * Loopback `vite dev` only. Merges the official-devnet **product** kekbull DAO
 * fixture into `/deployment.json` so Preflight can read the live Config pin.
 * `apply: "serve"` so `vite build` / dao.kekbull.com still ship
 * public/deployment.json (all null). Abandoned GovER5 throwaway fixtures stay
 * under `fixtures/` for history only and are never served here.
 *
 * The browser talks to same-origin `/rpc`. This process forwards that POST
 * to an official-devnet HTTPS upstream. A keyed URL may be read from
 * `ICHOR_DEVNET_RPC` or a `*DEVNET_RPC_URL` line in the repo `.env`; it is
 * never written into deployment.json. Mainnet URLs are refused.
 */
const OFFICIAL_DEVNET_HTTP = "https://api.devnet.solana.com";
const LOOPBACK_RPC = "/rpc";

const KEKBULL_PRODUCT = fileURLToPath(
  new URL("./fixtures/official-devnet-kekbull.json", import.meta.url),
);
const PUBLIC_DEPLOYMENT = fileURLToPath(
  new URL("./public/deployment.json", import.meta.url),
);

/** Read PINATA_JWT / PINATA_GATEWAY from repo `.env` without printing values. */
function loadPinataEnvFromRepo(): { jwt: string; gateway: string } {
  let jwt = (process.env.PINATA_JWT ?? "").trim();
  let gateway = (process.env.PINATA_GATEWAY ?? "").trim();
  try {
    const envFile = readFileSync(
      fileURLToPath(new URL("../../.env", import.meta.url)),
      "utf8",
    );
    for (const line of envFile.split("\n")) {
      const match = /^(PINATA_JWT|PINATA_GATEWAY)=(.*)$/.exec(line);
      if (!match) continue;
      const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
      if (match[1] === "PINATA_JWT" && !jwt) jwt = value;
      if (match[1] === "PINATA_GATEWAY" && !gateway) gateway = value;
    }
  } catch {
    /* repo .env is optional */
  }
  return { jwt, gateway };
}

function officialDevnetRpcUpstream(): string {
  const found: string[] = [];
  const add = (raw: string | undefined): void => {
    const value = (raw ?? "").trim().replace(/^["']|["']$/g, "");
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
  try {
    const envFile = readFileSync(fileURLToPath(new URL("../../.env", import.meta.url)), "utf8");
    for (const line of envFile.split("\n")) {
      const match = /^(?:ICHOR_DEVNET_RPC|[A-Z0-9_]+DEVNET_RPC_URL)=(.*)$/.exec(line);
      if (match) {
        add(match[1]);
      }
    }
  } catch {
    /* repo .env is optional */
  }
  return found[0] ?? OFFICIAL_DEVNET_HTTP;
}

function officialDevnetKekbullOverlay(): Plugin {
  const upstream = officialDevnetRpcUpstream();
  /** Official public HTTP 429s a first-paint stampede. Cache identical reads
   *  and cap concurrent upstream POSTs. Writes and blockhashes stay live.
   *  Lives inside this plugin so Vite's config bundle cannot drop the helper
   *  the /rpc handler closes over (that crash took the preview down). */
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
  type RpcCacheEntry = { readonly body: Buffer; readonly at: number; readonly status: number };
  const rpcReadCache = new Map<string, RpcCacheEntry>();
  const rpcReadInflight = new Map<string, Promise<{ status: number; body: Buffer }>>();
  let rpcUpstreamInflight = 0;
  const rpcUpstreamWaiters: Array<() => void> = [];

  function rpcRequestId(value: unknown): unknown {
    if (value !== null && typeof value === "object" && "id" in value) {
      return (value as { id: unknown }).id;
    }
    return null;
  }

  function rewriteRpcId(cached: unknown, incoming: unknown): unknown {
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

  function rpcReadCacheKey(parsed: unknown): string | null {
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const parts: string[] = [];
    for (const row of rows) {
      if (row === null || typeof row !== "object") {
        return null;
      }
      const method = (row as { method?: unknown }).method;
      const params = (row as { params?: unknown }).params;
      if (typeof method !== "string" || !RPC_CACHEABLE.has(method)) {
        return null;
      }
      parts.push(`${method}:${JSON.stringify(params ?? null)}`);
    }
    return parts.join("|");
  }

  function acquireRpcUpstream(): Promise<void> {
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

  function releaseRpcUpstream(): void {
    rpcUpstreamInflight = Math.max(0, rpcUpstreamInflight - 1);
    const next = rpcUpstreamWaiters.shift();
    if (next) {
      next();
    }
  }

  function rpcJsonHasError(parsed: unknown): boolean {
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.some(
      (row) =>
        row !== null &&
        typeof row === "object" &&
        (row as { error?: unknown }).error != null,
    );
  }

  async function proxyOfficialDevnetRpc(
    rawBody: Buffer,
  ): Promise<{ status: number; body: Buffer }> {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      parsed = null;
    }
    const cacheKey = parsed === null ? null : rpcReadCacheKey(parsed);
    if (cacheKey) {
      const hit = rpcReadCache.get(cacheKey);
      if (hit && Date.now() - hit.at < RPC_READ_TTL_MS) {
        const cachedJson = JSON.parse(hit.body.toString("utf8")) as unknown;
        return {
          status: hit.status,
          body: Buffer.from(JSON.stringify(rewriteRpcId(cachedJson, parsed))),
        };
      }
      const pending = rpcReadInflight.get(cacheKey);
      if (pending) {
        const shared = await pending;
        const cachedJson = JSON.parse(shared.body.toString("utf8")) as unknown;
        return {
          status: shared.status,
          body: Buffer.from(JSON.stringify(rewriteRpcId(cachedJson, parsed))),
        };
      }
    }
    const load = (async (): Promise<{ status: number; body: Buffer }> => {
      await acquireRpcUpstream();
      try {
        let upstreamRes = await fetch(upstream, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new Uint8Array(rawBody),
        });
        if (
          upstream !== OFFICIAL_DEVNET_HTTP &&
          (upstreamRes.status === 429 ||
            upstreamRes.status === 502 ||
            upstreamRes.status === 503 ||
            upstreamRes.status === 504)
        ) {
          upstreamRes = await fetch(OFFICIAL_DEVNET_HTTP, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: new Uint8Array(rawBody),
          });
        }
        const body = Buffer.from(await upstreamRes.arrayBuffer());
        if (cacheKey && upstreamRes.status === 200) {
          try {
            const json = JSON.parse(body.toString("utf8")) as unknown;
            if (!rpcJsonHasError(json)) {
              rpcReadCache.set(cacheKey, {
                body,
                at: Date.now(),
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

  return {
    name: "ichor-official-devnet-kekbull-overlay",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(LOOPBACK_RPC, (req, res) => {
        if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") {
          res.statusCode = 426;
          res.setHeader("connection", "close");
          res.end();
          return;
        }
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32600, message: "POST only" },
              id: null,
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        req.on("end", () => {
          const rawBody = Buffer.concat(chunks);
          void proxyOfficialDevnetRpc(rawBody)
            .then((proxied) => {
              res.statusCode = proxied.status;
              res.setHeader("content-type", "application/json");
              res.end(proxied.body);
            })
            .catch(() => {
              res.statusCode = 502;
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: {
                    code: -32000,
                    message: "loopback official-devnet RPC proxy failed",
                  },
                  id: null,
                }),
              );
            });
        });
      });
      server.middlewares.use("/deployment.json", (_req, res) => {
        const base = JSON.parse(readFileSync(PUBLIC_DEPLOYMENT, "utf8")) as Record<
          string,
          unknown
        >;
        const overlay = JSON.parse(readFileSync(KEKBULL_PRODUCT, "utf8")) as Record<
          string,
          unknown
        >;
        if (overlay.rpcUrl !== OFFICIAL_DEVNET_HTTP) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "kekbull fixture rpcUrl must be official-devnet HTTP" }));
          return;
        }
        // Drop fixture bookkeeping keys — parseDeployment only wants DeploymentConfig fields.
        const { _proof: _p, _abandonedThrowawayProof: _a, ...overlayFields } = overlay;
        const merged = { ...base, ...overlayFields, rpcUrl: LOOPBACK_RPC };
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify(merged));
      });
      // Markdown-only proposal pin. JWT stays in this process. Images refused.
      // Reuse repo `.env` the same way the RPC overlay does — Vite does not
      // load PINATA_* into process.env on its own.
      const pinEnv = loadPinataEnvFromRepo();
      const pinScript = fileURLToPath(
        new URL("./scripts/pin-proposal-server.cjs", import.meta.url),
      );
      const { createPinProposalHandler } = require(pinScript) as {
        createPinProposalHandler: (options?: {
          getJwt?: () => string;
          getGateway?: () => string;
        }) => (
          req: import("node:http").IncomingMessage,
          res: import("node:http").ServerResponse,
        ) => Promise<void>;
      };
      const pinHandler = createPinProposalHandler({
        getJwt: () => process.env.PINATA_JWT?.trim() || pinEnv.jwt,
        getGateway: () => {
          const fromEnv = (process.env.PINATA_GATEWAY ?? "").trim();
          const host = (fromEnv || pinEnv.gateway)
            .replace(/^https?:\/\//, "")
            .replace(/\/+$/, "");
          if (!host) {
            throw new Error("PINATA_GATEWAY is not set");
          }
          return host;
        },
      });
      server.middlewares.use("/api/pin-proposal", (req, res) => {
        void pinHandler(req, res);
      });
      const chatScript = fileURLToPath(
        new URL("./scripts/proposal-chat-server.cjs", import.meta.url),
      );
      const { createProposalChatHandler } = require(chatScript) as {
        createProposalChatHandler: (options?: {
          dbPath?: string;
          getDeployment?: (cluster: string) => {
            cluster: string;
            realmsInstance: string;
            realm: string | null;
            ichorMint: string | null;
          };
        }) => (
          req: import("node:http").IncomingMessage,
          res: import("node:http").ServerResponse,
        ) => Promise<void>;
      };
      const overlay = JSON.parse(readFileSync(KEKBULL_PRODUCT, "utf8")) as {
        cluster?: string;
        realmsInstance?: string;
        realm?: string | null;
        ichorMint?: string | null;
      };
      const chatHandler = createProposalChatHandler({
        dbPath: "/tmp/kekbull-proposal-chat-vite.sqlite",
        getDeployment: (cluster) => {
          if (cluster === "devnet") {
            return {
              cluster: "devnet",
              realmsInstance: overlay.realmsInstance ?? "kekbull",
              realm: overlay.realm ?? null,
              ichorMint: overlay.ichorMint ?? null,
            };
          }
          return {
            cluster: "mainnet-beta",
            realmsInstance: "kekbull",
            realm: null,
            ichorMint: overlay.ichorMint ?? null,
          };
        },
      });
      server.middlewares.use("/api/proposal-chat", (req, res) => {
        void chatHandler(req, res);
      });
    },
  };
}

/**
 * Measured PLAN §15.3 C pins (2026-08-27). `vite build` copies
 * public/deployment.json into dist/. A leftover `{ cluster: "devnet" }`
 * would label dao.kekbull.com DEVNET. A leftover official-devnet program
 * or an arbitrary filled Realm would close D in the shipped file. Fail
 * the build. After D the same guard accepts only the measured pins.
 * The official-devnet overlay is serve-only and never reaches dist/.
 *
 * Vite also copies every other public/*.json. `deployment.devnet.json`
 * and `deployment.mainnet.json` stay in public/ for `deploy-dao.sh
 * --devnet` (overlay source) and as the mainnet twin. They must not
 * survive in the production outDir — the guarded file is the only
 * deployment JSON a mainnet dist may contain. Serve mode still serves
 * the named files from public/ on loopback; that is not a ship tree.
 */
const GUARDED_DEPLOYMENT_JSON = "deployment.json";
const NAMED_DEPLOYMENT_JSON = new Set(["deployment.devnet.json", "deployment.mainnet.json"]);

function stripNamedDeploymentJson(dir: string): string[] {
  const leftovers: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      leftovers.push(...stripNamedDeploymentJson(path));
      continue;
    }
    if (entry.name === GUARDED_DEPLOYMENT_JSON) {
      continue;
    }
    if (NAMED_DEPLOYMENT_JSON.has(entry.name)) {
      unlinkSync(path);
      continue;
    }
    if (/^deployment.*\.json$/i.test(entry.name)) {
      leftovers.push(path);
    }
  }
  return leftovers;
}

function refuseWrongDistDeployment(): Plugin {
  let outDir = "";
  return {
    name: "ichor-refuse-wrong-dist-deployment",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const distDir = outDir || fileURLToPath(new URL("./dist/", import.meta.url));
      const shippedPath = join(distDir, GUARDED_DEPLOYMENT_JSON);
      const shipped = JSON.parse(readFileSync(shippedPath, "utf8")) as {
        cluster?: unknown;
        rpcUrl?: unknown;
        ichorProgram?: unknown;
        ichorMint?: unknown;
        kekbullMint?: unknown;
        realm?: unknown;
        governance?: unknown;
        nativeTreasury?: unknown;
        voteProgram?: unknown;
        realmsInstance?: unknown;
      };
      assertShippedDeploymentJson(shipped);
      const leftovers = stripNamedDeploymentJson(distDir);
      if (leftovers.length > 0) {
        throw new Error(
          `REFUSING: ${distDir} still contains ${leftovers.join(", ")}; only guarded ${GUARDED_DEPLOYMENT_JSON} may ship`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [nodeGlobals(), officialDevnetKekbullOverlay(), refuseWrongDistDeployment(), react()],
  define: { global: "globalThis" },
  optimizeDeps: { include: ["buffer"] },
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    fs: {
      allow: [".."],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 5181,
    strictPort: true,
  },
});
