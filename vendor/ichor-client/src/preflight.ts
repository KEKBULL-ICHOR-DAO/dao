import type { Connection, PublicKey } from "@solana/web3.js";
import {
  BPF_LOADER_UPGRADEABLE,
  CLUSTER_GENESIS_HASH,
  METEORA_CP_AMM,
  OFFICIAL_CLUSTER_GENESIS,
  REALMS_INSTANCES,
} from "./network.ts";
import type {
  AccountReadCommitment,
  NetworkConfig,
  ProgramDeploymentProof,
  VerifiedNetwork,
} from "./types.ts";
import { ClientValidationError } from "./types.ts";
import { resolveAccountReadCommitment } from "./mint.ts";
import { assertNetworkConfig, requirePublicKey } from "./validation.ts";

/** Only `verifyNetworkDeployment` may add. Not exported. */
const issuedNetworkProofs = new WeakSet<object>();

const ALLOWED_PROGRAM_LOADERS = new Set<string>([BPF_LOADER_UPGRADEABLE.id]);

/**
 * Runtime-unforgeable proof. Not exported - a structural lookalike is not an
 * instance and is not in `issuedNetworkProofs`.
 */
class IssuedVerifiedNetwork implements VerifiedNetwork {
  readonly network: NetworkConfig;
  readonly genesisHash: string;
  readonly rpcEndpoint: string;
  readonly meteora: ProgramDeploymentProof;
  readonly realms: ProgramDeploymentProof;
  readonly #connection: Connection;

  constructor(args: {
    network: NetworkConfig;
    genesisHash: string;
    rpcEndpoint: string;
    connection: Connection;
    meteora: ProgramDeploymentProof;
    realms: ProgramDeploymentProof;
  }) {
    this.network = args.network;
    this.genesisHash = args.genesisHash;
    this.rpcEndpoint = args.rpcEndpoint;
    this.meteora = args.meteora;
    this.realms = args.realms;
    this.#connection = args.connection;
  }

  boundTo(connection: Connection): boolean {
    return connection === this.#connection;
  }
}

function requireAllowedLoader(owner: PublicKey, label: string, namedId: string): string {
  const loaderId = owner.toBase58();
  if (!ALLOWED_PROGRAM_LOADERS.has(loaderId)) {
    throw new ClientValidationError("PROGRAM_LOADER_UNKNOWN", [
      `${label} ${namedId} owner ${loaderId} is not a documented Solana loader allowed by this client`,
    ]);
  }
  return loaderId;
}

async function readExecutableProgram(
  connection: Connection,
  programId: PublicKey,
  namedId: string,
  label: string,
  cluster: NetworkConfig["cluster"],
  commitment?: AccountReadCommitment,
): Promise<ProgramDeploymentProof> {
  requirePublicKey(programId, `${label}.programId`);
  if (programId.toBase58() !== namedId) {
    throw new ClientValidationError("PROGRAM_ID_MISMATCH", [
      `${label} ${programId.toBase58()} is not the named ID ${namedId}`,
    ]);
  }
  const info = await connection.getAccountInfo(programId, resolveAccountReadCommitment(commitment));
  if (info === null) {
    throw new ClientValidationError("PROGRAM_NOT_DEPLOYED", [
      `${label} ${namedId} has no account on ${cluster}; a named ID is not a deployment proof`,
    ]);
  }
  if (!info.executable) {
    throw new ClientValidationError("PROGRAM_NOT_EXECUTABLE", [
      `${label} ${namedId} exists on ${cluster} but executable=false`,
    ]);
  }
  const loaderId = requireAllowedLoader(info.owner, label, namedId);
  return {
    cluster,
    programId,
    namedId,
    executable: true,
    owner: info.owner,
    loaderId,
    dataLength: info.data.length,
  };
}

async function readMeteoraProgram(
  connection: Connection,
  network: NetworkConfig,
  commitment?: AccountReadCommitment,
): Promise<ProgramDeploymentProof> {
  return readExecutableProgram(
    connection,
    network.meteoraCpAmmProgramId,
    METEORA_CP_AMM.id,
    "meteoraCpAmm",
    network.cluster,
    commitment,
  );
}

async function readRealmsProgram(
  connection: Connection,
  network: NetworkConfig,
  commitment?: AccountReadCommitment,
): Promise<ProgramDeploymentProof> {
  const named = REALMS_INSTANCES[network.realmsInstance];
  if (!named) {
    throw new ClientValidationError("UNKNOWN_REALMS_INSTANCE", [
      `realmsInstance ${String(network.realmsInstance)} is not a named published instance`,
    ]);
  }
  return readExecutableProgram(
    connection,
    network.realmsProgramId,
    named.id,
    `realms.${network.realmsInstance}`,
    network.cluster,
    commitment,
  );
}

/**
 * Only issuer of `VerifiedNetwork`. Calls `connection.getGenesisHash` and
 * rejects a cluster mismatch before any program account is read.
 */
export async function verifyNetworkDeployment(
  connection: Connection,
  network: NetworkConfig,
  commitment?: AccountReadCommitment,
): Promise<VerifiedNetwork> {
  assertNetworkConfig(network);
  const liveGenesis = await connection.getGenesisHash();
  if (network.cluster === "localnet") {
    if (OFFICIAL_CLUSTER_GENESIS.has(liveGenesis)) {
      throw new ClientValidationError("LOCALNET_IS_OFFICIAL_CLUSTER", [
        `localnet genesis ${liveGenesis} matches an official cluster; refusing to treat it as a local validator`,
      ]);
    }
  } else {
    const expectedGenesis = CLUSTER_GENESIS_HASH[network.cluster];
    if (!expectedGenesis) {
      throw new ClientValidationError("GENESIS_UNKNOWN_CLUSTER", [
        `cluster ${String(network.cluster)} has no official genesis hash`,
      ]);
    }
    if (liveGenesis !== expectedGenesis) {
      throw new ClientValidationError("GENESIS_MISMATCH", [
        `connection genesis ${liveGenesis} is not the official ${network.cluster} hash ${expectedGenesis}`,
      ]);
    }
  }
  const readCommitment = resolveAccountReadCommitment(commitment);
  const [meteora, realms] = await Promise.all([
    readMeteoraProgram(connection, network, readCommitment),
    readRealmsProgram(connection, network, readCommitment),
  ]);
  const proof = new IssuedVerifiedNetwork({
    network,
    genesisHash: liveGenesis,
    rpcEndpoint: connection.rpcEndpoint,
    connection,
    meteora,
    realms,
  });
  issuedNetworkProofs.add(proof);
  return proof;
}

export function assertVerifiedNetwork(
  verified: VerifiedNetwork,
): asserts verified is VerifiedNetwork {
  if (verified === null || typeof verified !== "object") {
    throw new ClientValidationError("NETWORK_PROOF", ["VerifiedNetwork is missing"]);
  }
  if (!issuedNetworkProofs.has(verified) || !(verified instanceof IssuedVerifiedNetwork)) {
    throw new ClientValidationError("NETWORK_PROOF", [
      "fabricated VerifiedNetwork lookalike; only verifyNetworkDeployment may issue this proof",
    ]);
  }
  assertNetworkConfig(verified.network);
  if (verified.network.cluster === "localnet") {
    if (OFFICIAL_CLUSTER_GENESIS.has(verified.genesisHash)) {
      throw new ClientValidationError("LOCALNET_IS_OFFICIAL_CLUSTER", [
        "issued localnet proof genesisHash matches an official cluster",
      ]);
    }
  } else if (verified.genesisHash !== CLUSTER_GENESIS_HASH[verified.network.cluster]) {
    throw new ClientValidationError("GENESIS_MISMATCH", [
      "issued proof genesisHash does not match the official hash for network.cluster",
    ]);
  }
  if (!verified.meteora.executable || !verified.realms.executable) {
    throw new ClientValidationError("NETWORK_PROOF", ["both Meteora and Realms proofs must be executable"]);
  }
  if (!ALLOWED_PROGRAM_LOADERS.has(verified.meteora.loaderId)) {
    throw new ClientValidationError("PROGRAM_LOADER_UNKNOWN", [
      `meteora proof loader ${verified.meteora.loaderId} is not allowed`,
    ]);
  }
  if (!ALLOWED_PROGRAM_LOADERS.has(verified.realms.loaderId)) {
    throw new ClientValidationError("PROGRAM_LOADER_UNKNOWN", [
      `realms proof loader ${verified.realms.loaderId} is not allowed`,
    ]);
  }
  if (!verified.meteora.programId.equals(verified.network.meteoraCpAmmProgramId)) {
    throw new ClientValidationError("PROGRAM_ID_MISMATCH", [
      "meteora proof programId does not match network.meteoraCpAmmProgramId",
    ]);
  }
  if (!verified.realms.programId.equals(verified.network.realmsProgramId)) {
    throw new ClientValidationError("PROGRAM_ID_MISMATCH", [
      "realms proof programId does not match network.realmsProgramId",
    ]);
  }
  if (verified.meteora.namedId !== METEORA_CP_AMM.id) {
    throw new ClientValidationError("PROGRAM_ID_MISMATCH", ["meteora proof is not the named DAMM v2 ID"]);
  }
  const realmsNamed = REALMS_INSTANCES[verified.network.realmsInstance];
  if (!realmsNamed || verified.realms.namedId !== realmsNamed.id) {
    throw new ClientValidationError("PROGRAM_ID_MISMATCH", [
      "realms proof is not the named instance selected on the network config",
    ]);
  }
  if (
    verified.meteora.cluster !== verified.network.cluster ||
    verified.realms.cluster !== verified.network.cluster
  ) {
    throw new ClientValidationError("NETWORK_PROOF", ["proof cluster does not match network.cluster"]);
  }
}

/** Builders that take a Connection must use the exact issued Connection instance. */
export function assertBoundConnection(verified: VerifiedNetwork, connection: Connection): void {
  assertVerifiedNetwork(verified);
  if (!(verified instanceof IssuedVerifiedNetwork) || !verified.boundTo(connection)) {
    throw new ClientValidationError("CONNECTION_MISMATCH", [
      "builder Connection is not the exact Connection instance verified by preflight",
    ]);
  }
}
