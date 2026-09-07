import { PublicKey } from "@solana/web3.js";
import type { ClusterName, NamedProgramId, NetworkConfig, RealmsInstanceName } from "./types.ts";
import { ClientValidationError } from "./types.ts";

/**
 * Official Realms / SPL Governance instances from
 * https://docs.realms.today/developer-resources/sdk/sdk-dao-creation
 * (Program Instances table, retrieved 2026-08-23).
 *
 * These are named published IDs, not cluster assumptions. The docs label
 * `default-shared` as "Default mainnet" and `test` as "Test instance".
 * Devnet presence of either ID is a lead-review gate - select the instance
 * explicitly after a chain read.
 */
export const REALMS_INSTANCES: Record<RealmsInstanceName, NamedProgramId> = {
  "default-shared": {
    id: "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw",
    label: "Default shared SPL Governance instance",
    source: "https://docs.realms.today/developer-resources/sdk/sdk-dao-creation",
  },
  test: {
    id: "GTesTBiEWE32WHXXE2S4XbZvA5CrEc4xs6ZgRe895dP",
    label: "Published test instance for test DAOs",
    source: "https://docs.realms.today/developer-resources/sdk/sdk-dao-creation",
  },
  /**
   * KEKBULL minimal fork of governance-v3.1.2. TransferFeeConfig community
   * mints work for CastVote/FinalizeVote. Not GovER5 - never label it as such.
   * Program id measured from official-devnet deploy (upgrade auth = recovery).
   */
  kekbull: {
    id: "2uNHeSLiNn6dLLtiGrpCd8UZKBfV36kap57eg9kV39Fj",
    label: "KEKBULL kekbull_governance (GovER5 3.1.2 mint-validation fork)",
    source: "ichor/kekbull_governance/PROGRAM_ID.txt + official-devnet deploy",
  },
};

/** Official Realms SDK: use `3` for the deployed v3.1.2 line. */
export const REALMS_PROGRAM_VERSION = 3 as const;

/**
 * DAMM v2 / cp-amm program. Changelog for 0.2.3 / SDK 1.4.6 states the same
 * ID on mainnet and devnet.
 */
export const METEORA_CP_AMM: NamedProgramId = {
  id: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  label: "Meteora DAMM v2 cp-amm",
  source: "https://docs.meteora.ag/developer-guides/damm-v2/changelog",
};

export const TOKEN_PROGRAM: NamedProgramId = {
  id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  label: "Legacy SPL Token",
  source: "https://spl.solana.com/token",
};

export const TOKEN_2022_PROGRAM: NamedProgramId = {
  id: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  label: "Token-2022",
  source: "https://spl.solana.com/token-2022",
};

export const NATIVE_MINT: NamedProgramId = {
  id: "So11111111111111111111111111111111111111112",
  label: "Wrapped SOL mint",
  source: "https://spl.solana.com/token",
};

/**
 * PumpSwap AMM. Same ID on mainnet and devnet. Named from official public
 * docs and the measured `src/pumpswap/mod.rs` `AMM_PROGRAM` constant.
 * Canonical graduate pools are PDAs, not event-stream addresses.
 */
export const PUMP_SWAP: NamedProgramId = {
  id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  label: "PumpSwap AMM",
  source: "https://github.com/pump-fun/pump-public-docs/blob/master/docs/PUMP_SWAP_README.md",
};

/**
 * Official cluster genesis hashes from Agave/Solana `ClusterType::get_genesis_hash`.
 * Primary source: https://github.com/solana-labs/solana/blob/master/sdk/src/genesis_config.rs
 * (same values documented on https://solana.com/docs/rpc/http/getgenesishash and
 * Anza cluster connection details). These do not change. A live
 * `connection.getGenesisHash()` must match before any program account is read.
 */
export const CLUSTER_GENESIS_HASH: Record<"devnet" | "mainnet-beta", string> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};

/** Official hashes that a local validator must never present. */
export const OFFICIAL_CLUSTER_GENESIS = new Set<string>(Object.values(CLUSTER_GENESIS_HASH));

/**
 * BPF Upgradeable Loader. Primary source: `@solana/web3.js`
 * `BPF_LOADER_UPGRADEABLE_PROGRAM_ID` /
 * https://github.com/solana-labs/solana/blob/master/sdk/program/src/bpf_loader_upgradeable.rs
 *
 * Current Meteora DAMM v2 and Realms v3 deployments are upgradeable programs.
 * Other loaders (deprecated BPFLoader1111…, BPF Loader 2, Loader v4, native)
 * are rejected until a lead names one as required.
 */
export const BPF_LOADER_UPGRADEABLE: NamedProgramId = {
  id: "BPFLoaderUpgradeab1e11111111111111111111111",
  label: "BPF Upgradeable Loader",
  source: "https://github.com/solana-labs/solana/blob/master/sdk/program/src/bpf_loader_upgradeable.rs",
};

export function resolveNetwork(params: {
  cluster: ClusterName;
  realmsInstance: RealmsInstanceName;
}): NetworkConfig {
  const realms = REALMS_INSTANCES[params.realmsInstance];
  if (!realms) {
    throw new ClientValidationError("UNKNOWN_REALMS_INSTANCE", [
      `realmsInstance ${String(params.realmsInstance)} is not a named published instance`,
    ]);
  }
  return {
    cluster: params.cluster,
    realmsInstance: params.realmsInstance,
    realmsProgramId: new PublicKey(realms.id),
    programVersion: REALMS_PROGRAM_VERSION,
    meteoraCpAmmProgramId: new PublicKey(METEORA_CP_AMM.id),
    tokenProgramId: new PublicKey(TOKEN_PROGRAM.id),
    token2022ProgramId: new PublicKey(TOKEN_2022_PROGRAM.id),
    nativeMint: new PublicKey(NATIVE_MINT.id),
  };
}

/**
 * Mainnet CreateRealm / commit_dao_destination must target kekbull_governance.
 * `resolveNetwork` still accepts GovER5 on mainnet - phase-B ICHOR reads use
 * it - but a write-once Realm or commitment must not inherit that pairing.
 */
export function assertMainnetKekbullGovernance(network: NetworkConfig): void {
  if (network.cluster !== "mainnet-beta") {
    return;
  }
  const kekbull = REALMS_INSTANCES.kekbull.id;
  if (network.realmsInstance !== "kekbull") {
    throw new ClientValidationError("MAINNET_REALMS_INSTANCE", [
      `mainnet realmsInstance ${network.realmsInstance} is refused; CreateRealm and commit_dao_destination require kekbull`,
    ]);
  }
  if (network.realmsProgramId.toBase58() !== kekbull) {
    throw new ClientValidationError("MAINNET_REALMS_PROGRAM", [
      `mainnet realmsProgramId ${network.realmsProgramId.toBase58()} is not kekbull ${kekbull}`,
    ]);
  }
}
