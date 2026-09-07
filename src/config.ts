import {
  assertNoSecretMaterial,
  requirePublicKey,
  type ClusterName,
  type RealmsInstanceName,
} from "@kekbull/ichor-client";
import { parsePositiveDecimalIntegerString } from "./format.ts";

/**
 * The clusters this UI will actually talk to.
 *
 * `ClusterName` also carries `"localnet"` for the e2e harness, but the browser
 * app refuses it in two places already: `parseDeployment` rejects it below, and
 * `send.ts` throws `LOCALNET_REFUSED` at the genesis check. This alias makes the
 * type say what those guards enforce, which is what lets `OFFICIAL_HTTP_RPC` be
 * a total map instead of a partial one.
 *
 * `Extract` rather than a bare union on purpose: if the client ever renames or
 * drops one of these, `CLUSTERS` below stops compiling instead of silently
 * disagreeing with the parser.
 */
export type UiClusterName = Extract<ClusterName, "devnet" | "mainnet-beta">;

export interface DeploymentConfig {
  readonly cluster: UiClusterName;
  readonly realmsInstance: RealmsInstanceName;
  readonly rpcUrl: string;
  readonly ichorProgram: string | null;
  readonly ichorMint: string | null;
  readonly kekbullMint: string | null;
  readonly realm: string | null;
  readonly governance: string | null;
  readonly nativeTreasury: string | null;
  readonly communityTokenOwnerRecord: string | null;
  readonly meteoraPool: string | null;
  readonly meteoraPosition: string | null;
  readonly meteoraPositionNftMint: string | null;
  /** Bootstrap `liquidityDelta` as a strict positive decimal integer string. */
  readonly expectedLockedLiquidityBaseUnits: string | null;
  /**
   * Public source repository for this UI and the on-chain programs.
   *
   * Null until it is actually published. The succession copy renders "not
   * published yet" rather than a guessed URL - a dead link in the one section
   * that tells holders how to survive without the operator is worse than an
   * honest gap.
   */
  readonly sourceRepo: string | null;
}

export const EMPTY_DEPLOYMENT: DeploymentConfig = {
  cluster: "mainnet-beta",
  realmsInstance: "kekbull",
  rpcUrl: "",
  ichorProgram: null,
  ichorMint: null,
  kekbullMint: null,
  realm: null,
  governance: null,
  nativeTreasury: null,
  communityTokenOwnerRecord: null,
  meteoraPool: null,
  meteoraPosition: null,
  meteoraPositionNftMint: null,
  expectedLockedLiquidityBaseUnits: null,
  sourceRepo: null,
};

const CLUSTERS = new Set<UiClusterName>(["devnet", "mainnet-beta"]);
const REALMS_INSTANCES = new Set<RealmsInstanceName>(["default-shared", "test", "kekbull"]);

/**
 * An absolute https URL, or null.
 *
 * Refuses anything else rather than coercing. This value is rendered as the
 * one link that tells holders where to get the source if the operator is
 * unreachable; a malformed or http:// link there is worse than none.
 */
function optionalHttpsUrl(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string URL or null`);
  }
  const v = value.trim();
  if (!v.startsWith("https://")) {
    throw new Error(`${label} must be an absolute https:// URL. Got ${JSON.stringify(v)}`);
  }
  return v;
}

function optionalPublicKey(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a PublicKey base58 string or null`);
  }
  if (/\s/.test(value)) {
    throw new Error(`${label} must not contain whitespace`);
  }
  return requirePublicKey(value, label).toBase58();
}

function optionalPositiveDecimalInteger(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a strict positive decimal integer string or null`);
  }
  return parsePositiveDecimalIntegerString(value, label).toString(10);
}

export function parseDeployment(value: unknown): DeploymentConfig {
  assertNoSecretMaterial(value, "deployment");
  if (value === null || typeof value !== "object") {
    throw new Error("deployment must be an object");
  }
  const rec = value as Record<string, unknown>;
  const cluster = rec.cluster;
  const realmsInstance = rec.realmsInstance;
  if (typeof cluster !== "string" || !CLUSTERS.has(cluster as UiClusterName)) {
    throw new Error("cluster must be devnet or mainnet-beta");
  }
  if (
    typeof realmsInstance !== "string" ||
    !REALMS_INSTANCES.has(realmsInstance as RealmsInstanceName)
  ) {
    throw new Error("realmsInstance must be default-shared, test, or kekbull");
  }
  if (typeof rec.rpcUrl !== "string") {
    throw new Error("rpcUrl must be a string (empty until the operator supplies one)");
  }
  const rpcUrl = rec.rpcUrl.trim();
  if (rpcUrl.startsWith("ws:") || rpcUrl.startsWith("wss:")) {
    throw new Error("rpcUrl must be an HTTP(S) JSON-RPC endpoint, not a websocket URL");
  }
  return {
    cluster: cluster as UiClusterName,
    realmsInstance: realmsInstance as RealmsInstanceName,
    rpcUrl,
    ichorProgram: optionalPublicKey(rec.ichorProgram, "ichorProgram"),
    ichorMint: optionalPublicKey(rec.ichorMint, "ichorMint"),
    kekbullMint: optionalPublicKey(rec.kekbullMint, "kekbullMint"),
    realm: optionalPublicKey(rec.realm, "realm"),
    governance: optionalPublicKey(rec.governance, "governance"),
    nativeTreasury: optionalPublicKey(rec.nativeTreasury, "nativeTreasury"),
    communityTokenOwnerRecord: optionalPublicKey(
      rec.communityTokenOwnerRecord,
      "communityTokenOwnerRecord",
    ),
    meteoraPool: optionalPublicKey(rec.meteoraPool, "meteoraPool"),
    meteoraPosition: optionalPublicKey(rec.meteoraPosition, "meteoraPosition"),
    meteoraPositionNftMint: optionalPublicKey(
      rec.meteoraPositionNftMint,
      "meteoraPositionNftMint",
    ),
    expectedLockedLiquidityBaseUnits: optionalPositiveDecimalInteger(
      rec.expectedLockedLiquidityBaseUnits,
      "expectedLockedLiquidityBaseUnits",
    ),
    sourceRepo: optionalHttpsUrl(rec.sourceRepo, "sourceRepo"),
  };
}

export async function loadDeploymentFile(): Promise<DeploymentConfig> {
  const response = await fetch("/deployment.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`deployment.json HTTP ${String(response.status)}`);
  }
  return parseDeployment(await response.json());
}

export const OFFICIAL_HTTP_RPC: Record<UiClusterName, string> = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

/** Exact public hostname. Other kekbull.com names stay fail-closed unless added here. */
export const GOVERNANCE_UI_HOST = "dao.kekbull.com";
/** Official-devnet preview of the same SPA. Exact name only - not a *.kekbull.com grant. */
export const GOVERNANCE_UI_PREVIEW_HOST = "devnet.dao.kekbull.com";

/**
 * `@solana/web3.js` Connection calls `new URL(endpoint)` for the websocket
 * URL. A same-origin path like `/rpc` throws and the React tree never mounts.
 * Resolve it against the page origin on a named governance host or loopback.
 * The keyed provider stays on the loopback helper; official cluster HTTP is
 * the browser fallback when `/rpc` is down (`rpc-failover.ts`).
 */
function allowsSameOriginRpc(hostname: string): boolean {
  return isOfficialGovernanceHost(hostname) || isLocalGovernanceDevHost(hostname);
}

export function resolveBrowserRpcUrl(
  rpcUrl: string,
  cluster: UiClusterName,
  origin: string,
): string {
  let parsedOrigin: URL | null = null;
  if (origin.length > 0) {
    try {
      parsedOrigin = new URL(origin);
    } catch {
      parsedOrigin = null;
    }
  }
  // First paint on loopback / official-devnet preview loads EMPTY_DEPLOYMENT
  // (rpcUrl "") before the overlay arrives. Using official HTTP for that
  // frame opens a second Connection, 429s, and piles wallet EventEmitter
  // listeners until Chrome returns ERR_INSUFFICIENT_RESOURCES and a white page.
  if (rpcUrl.length === 0 && parsedOrigin && allowsSameOriginRpc(parsedOrigin.hostname)) {
    return `${parsedOrigin.origin}/rpc`;
  }
  const raw = rpcUrl.length > 0 ? rpcUrl : OFFICIAL_HTTP_RPC[cluster];
  if (!raw.startsWith("/")) {
    return raw;
  }
  if (!parsedOrigin) {
    throw new Error("relative rpcUrl requires a valid page origin");
  }
  if (!allowsSameOriginRpc(parsedOrigin.hostname)) {
    throw new Error("relative rpcUrl is a named governance origin or loopback only");
  }
  return `${parsedOrigin.origin}${raw}`;
}

const NAMED_GOVERNANCE_HOSTS = new Set<string>([
  GOVERNANCE_UI_HOST,
  GOVERNANCE_UI_PREVIEW_HOST,
]);
const KEKBULL_APEX = "kekbull.com";

export function canonicalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export function isOfficialGovernanceHost(hostname: string): boolean {
  return NAMED_GOVERNANCE_HOSTS.has(canonicalizeHostname(hostname));
}

/** Loopback only. No 0.0.0.0, no LAN IPs, no Traefik hostnames. */
export function isLocalGovernanceDevHost(hostname: string): boolean {
  const host = canonicalizeHostname(hostname);
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/**
 * Wallet-connect / send is allowlisted: exact dao.kekbull.com,
 * exact devnet.dao.kekbull.com, or loopback for Vite. Every other host -
 * including a byte-identical copy on an IP, a staging box, or
 * dao-kekbull.com - is fail-closed.
 */
export function isGovernanceSigningAllowed(hostname: string): boolean {
  return isOfficialGovernanceHost(hostname) || isLocalGovernanceDevHost(hostname);
}

/**
 * Marketing apex, www, and any unnamed *.kekbull.com host.
 * Named exceptions are the two entries in NAMED_GOVERNANCE_HOSTS.
 */
export function isKekbullPublicHost(hostname: string): boolean {
  const host = canonicalizeHostname(hostname);
  if (NAMED_GOVERNANCE_HOSTS.has(host)) {
    return false;
  }
  return host === KEKBULL_APEX || host.endsWith(`.${KEKBULL_APEX}`);
}
