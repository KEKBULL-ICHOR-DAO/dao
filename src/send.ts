import {
  CLUSTER_GENESIS_HASH,
  ClientValidationError,
  assertBoundConnection,
  type StagedProposalActions,
  type VerifiedGovernanceIdentity,
  type VerifiedNetwork,
} from "@kekbull/ichor-client";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  Transaction,
  VersionedTransaction,
  type Connection,
  type Keypair,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";

export interface UnsignedPayload {
  readonly label: string;
  readonly instructions: readonly TransactionInstruction[];
  readonly derivedAddresses: Readonly<Record<string, PublicKey>>;
  /**
   * In-memory extra signers (throwaway mint createAccount). Never logged.
   * `payloadReview` ignores this field. Dropped after send.
   */
  readonly extraSigners?: readonly Keypair[];
  /** Dedicated official-devnet genesis gate. Skips ICHOR VerifiedNetwork. */
  readonly genesisMode?: "official-devnet";
  readonly measuredGenesisHash?: string;
  /** Holder confirm copy. Ignored by payloadReview. */
  readonly holderSummary?: {
    readonly kind: "burn" | "deposit" | "withdraw" | "propose" | "vote" | "other";
    readonly headline: string;
    readonly details: readonly string[];
  };
}

/** Inner proposal action owned by App. Any panel may set or clear this. */
export type StagedGovernanceAction = UnsignedPayload;

/**
 * Exact inner instruction bytes plus the insert-issued staged receipt.
 * Execute must consume this record, not the insert instruction.
 */
export interface InsertedProposalSession {
  readonly action: StagedGovernanceAction;
  readonly staged: StagedProposalActions;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
}

export interface InstructionReview {
  readonly index: number;
  readonly program: string;
  readonly dataHex: string;
  readonly accounts: ReadonlyArray<{
    readonly pubkey: string;
    readonly isSigner: boolean;
    readonly isWritable: boolean;
  }>;
}

export interface PayloadReview {
  readonly label: string;
  readonly instructions: readonly InstructionReview[];
  readonly derived: ReadonlyArray<{ name: string; address: string }>;
}

export interface SimulationReview {
  readonly logs: readonly string[];
  readonly unitsConsumed: string | null;
}

export interface SendResult {
  readonly signature: string;
  readonly simulationLogs: readonly string[];
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

export function dropExtraSigners(signers: readonly Keypair[] | undefined): void {
  if (signers === undefined) {
    return;
  }
  for (const signer of signers) {
    signer.secretKey.fill(0);
  }
}

function extraSignersOf(payload: UnsignedPayload): readonly Keypair[] {
  return payload.extraSigners ?? [];
}

function applyExtraSigners(transaction: Transaction, signers: readonly Keypair[]): void {
  if (signers.length === 0) {
    return;
  }
  transaction.partialSign(...signers);
}

/** Live getGenesisHash must equal official devnet. Refuses mainnet-beta. */
export async function proveOfficialDevnetConnection(connection: Connection): Promise<string> {
  const live = await connection.getGenesisHash();
  const official = CLUSTER_GENESIS_HASH.devnet;
  if (live !== official) {
    throw new ClientValidationError("GENESIS_MISMATCH", [
      `live genesis ${live} is not official devnet ${official}; throwaway Q3b mint refuses mainnet-beta and any other cluster`,
    ]);
  }
  return live;
}

async function assertPayloadGenesis(
  connection: Connection,
  verified: VerifiedNetwork | null,
  payload: UnsignedPayload,
): Promise<void> {
  if (payload.genesisMode === "official-devnet") {
    await proveOfficialDevnetConnection(connection);
    return;
  }
  if (verified === null) {
    throw new ClientValidationError("NETWORK_PROOF", [
      "preflight VerifiedNetwork is required before send",
    ]);
  }
  await assertLiveGenesis(connection, verified);
}

export function payloadReview(payload: UnsignedPayload): PayloadReview {
  return {
    label: payload.label,
    instructions: payload.instructions.map((ix, index) => ({
      index,
      program: ix.programId.toBase58(),
      dataHex: Array.from(ix.data, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      accounts: ix.keys.map((key) => ({
        pubkey: key.pubkey.toBase58(),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
    })),
    derived: Object.entries(payload.derivedAddresses).map(([name, address]) => ({
      name,
      address: address.toBase58(),
    })),
  };
}

function requireWallet(wallet: WalletContextState): {
  publicKey: PublicKey;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
} {
  if (!wallet.publicKey) {
    throw new Error("connect a wallet before sending; this app never receives private keys");
  }
  if (!wallet.signTransaction) {
    throw new Error("connected wallet cannot sign; refusing sendTransaction fallback that may replace the blockhash");
  }
  return { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction };
}

async function assertLiveGenesis(connection: Connection, verified: VerifiedNetwork): Promise<void> {
  assertBoundConnection(verified, connection);
  const live = await connection.getGenesisHash();
  if (verified.network.cluster === "localnet") {
    throw new ClientValidationError("LOCALNET_REFUSED", [
      "governance UI refuses localnet; official-devnet or mainnet-beta only",
    ]);
  }
  const official = CLUSTER_GENESIS_HASH[verified.network.cluster];
  if (live !== verified.genesisHash || live !== official) {
    throw new ClientValidationError("GENESIS_MISMATCH", [
      `live genesis ${live} does not match issued proof ${verified.genesisHash} / official ${official}`,
    ]);
  }
}

function buildTransaction(
  payload: UnsignedPayload,
  feePayer: PublicKey,
  blockhash: string,
): Transaction {
  if (payload.instructions.length === 0) {
    throw new Error("unsigned payload has no instructions");
  }
  const transaction = new Transaction();
  transaction.feePayer = feePayer;
  transaction.recentBlockhash = blockhash;
  for (const instruction of payload.instructions) {
    transaction.add(instruction);
  }
  return transaction;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((byte, index) => byte === b[index]);
}

export function sameInstructionBytes(
  left: readonly TransactionInstruction[],
  right: readonly TransactionInstruction[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((instruction, index) => {
    const other = right[index];
    if (
      other === undefined ||
      !instruction.programId.equals(other.programId) ||
      instruction.keys.length !== other.keys.length ||
      !equalBytes(Uint8Array.from(instruction.data), Uint8Array.from(other.data))
    ) {
      return false;
    }
    return instruction.keys.every((key, keyIndex) => {
      const match = other.keys[keyIndex];
      return (
        match !== undefined &&
        key.pubkey.equals(match.pubkey) &&
        key.isSigner === match.isSigner &&
        key.isWritable === match.isWritable
      );
    });
  });
}

/**
 * The only program a wallet may add to or rewrite in a transaction we built.
 *
 * ComputeBudget can set a compute-unit limit, a unit price, or a heap frame.
 * It cannot move value, touch an account, or invoke anything. Wallets
 * legitimately rewrite these to apply their own priority fee, so refusing
 * outright would break normal signing for no security gain.
 */
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
/** Placeholder so a refreshed recentBlockhash does not fail the core compare. */
const BLOCKHASH_PLACEHOLDER = "11111111111111111111111111111111";

function withoutComputeBudget(
  instructions: readonly TransactionInstruction[],
): TransactionInstruction[] {
  return instructions.filter(
    (instruction) => instruction.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID,
  );
}

export function cloneTransaction(transaction: Transaction): Transaction {
  const clone = new Transaction();
  clone.feePayer = transaction.feePayer;
  clone.recentBlockhash = transaction.recentBlockhash;
  for (const instruction of transaction.instructions) {
    clone.add(instruction);
  }
  return clone;
}

/**
 * Compiled message bytes for everything that is not a fee/blockhash tweak.
 * Compare at Message level - not raw TransactionInstruction metas - because
 * wallets round-trip through serialize/sign/deserialize and promote isSigner /
 * isWritable to match the account-keys header. Meta-flag drift alone is not a
 * substitution; a changed program, data, pubkey order, or account set is.
 */
export function messageCoreWithoutComputeBudget(transaction: Transaction): Uint8Array {
  const feePayer = transaction.feePayer;
  if (feePayer === undefined) {
    throw new ClientValidationError("SIGNED_MESSAGE_CHANGED", [
      "transaction has no fee payer",
      "nothing was broadcast",
    ]);
  }
  const core = new Transaction();
  core.feePayer = feePayer;
  core.recentBlockhash = BLOCKHASH_PLACEHOLDER;
  for (const instruction of withoutComputeBudget(transaction.instructions)) {
    core.add(instruction);
  }
  if (core.instructions.length === 0) {
    throw new ClientValidationError("SIGNED_MESSAGE_CHANGED", [
      "wallet returned no non-ComputeBudget instructions",
      "nothing was broadcast",
    ]);
  }
  return core.serializeMessage();
}

function instructionProgramSummary(instructions: readonly TransactionInstruction[]): string {
  const core = withoutComputeBudget(instructions);
  return core
    .map((instruction, index) => `${String(index)}:${instruction.programId.toBase58()}`)
    .join(", ");
}

/**
 * AUDIT_20260824_ICHOR_DAO.md B1 - refuse a wallet-mutated message.
 *
 * This used to append a line to a log array that no code path rendered, then
 * broadcast the wallet's bytes anyway with `skipPreflight: true`. That is the
 * exact hop the "review every instruction, then simulate" story rests on, and
 * a compromised wallet or wallet-adapter dependency could rewrite a recipient
 * or append a transfer and still be sent. The extra mint-signer check below
 * always refused this same condition; the user's own wallet now matches.
 *
 * Allowed: a refreshed `recentBlockhash`, and added or altered ComputeBudget
 * instructions. Every other instruction must compile to the same message core
 * (program ids, data, account pubkeys / roles as the Message encodes them).
 * The fee payer must be unchanged.
 *
 * Call with a snapshot cloned *before* `signTransaction` - some wallets mutate
 * the object you pass in place; comparing that to the return value would
 * false-negative a substitution.
 */
export function assertWalletOnlyAdjustedFees(expected: Transaction, signed: Transaction): void {
  const expectedFeePayer = expected.feePayer;
  const signedFeePayer = signed.feePayer;
  if (
    expectedFeePayer === undefined ||
    signedFeePayer === undefined ||
    !expectedFeePayer.equals(signedFeePayer)
  ) {
    throw new ClientValidationError("SIGNED_MESSAGE_CHANGED", [
      "the wallet changed the fee payer on this transaction",
      "nothing was broadcast",
    ]);
  }
  const expectedCore = messageCoreWithoutComputeBudget(expected);
  const signedCore = messageCoreWithoutComputeBudget(signed);
  if (!equalBytes(expectedCore, signedCore)) {
    throw new ClientValidationError("SIGNED_MESSAGE_CHANGED", [
      "the wallet returned different instructions than the ones reviewed and simulated",
      "only a refreshed blockhash and ComputeBudget changes are accepted",
      `expected programs [${instructionProgramSummary(expected.instructions)}]`,
      `signed programs [${instructionProgramSummary(signed.instructions)}]`,
      "nothing was broadcast",
    ]);
  }
}

export async function simulateBoundPayload(params: {
  connection: Connection;
  verified: VerifiedNetwork | null;
  wallet: WalletContextState;
  payload: UnsignedPayload;
}): Promise<SimulationReview> {
  const { publicKey } = requireWallet(params.wallet);
  await assertPayloadGenesis(params.connection, params.verified, params.payload);
  const latest = await params.connection.getLatestBlockhash("confirmed");
  const transaction = buildTransaction(params.payload, publicKey, latest.blockhash);
  applyExtraSigners(transaction, extraSignersOf(params.payload));
  return simulateUnsigned(
    params.connection,
    new VersionedTransaction(transaction.compileMessage()),
  );
}

async function readLandedTransaction(
  connection: Connection,
  signature: string,
): Promise<{ err: unknown } | null> {
  const landed = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (landed === null) {
    return null;
  }
  return { err: landed.meta?.err ?? null };
}

/**
 * Phantom often replaces the blockhash. Pairing that hash with a later
 * getLatestBlockhash().lastValidBlockHeight made confirmTransaction throw
 * "block height exceeded" after convert had already finalized
 * (5UyVerwG… 2026-08-24, ICHOR supply 1_000_000).
 *
 * Confirm the signed hash against the lastValid from the fetch that built
 * the pre-sign message. If that race fires, read the signature before
 * telling the holder nothing landed.
 */
async function confirmSentSignature(params: {
  connection: Connection;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}): Promise<void> {
  try {
    const confirmation = await params.connection.confirmTransaction(
      {
        signature: params.signature,
        blockhash: params.blockhash,
        lastValidBlockHeight: params.lastValidBlockHeight,
      },
      "confirmed",
    );
    if (confirmation.value.err != null) {
      throw new ClientValidationError("CONFIRM_FAILED", [JSON.stringify(confirmation.value.err)]);
    }
    return;
  } catch (error) {
    if (error instanceof ClientValidationError) {
      throw error;
    }
    const landed = await readLandedTransaction(params.connection, params.signature);
    if (landed !== null) {
      if (landed.err != null) {
        throw new ClientValidationError("CONFIRM_FAILED", [JSON.stringify(landed.err)]);
      }
      return;
    }
    const stillValid = await params.connection.isBlockhashValid(params.blockhash, {
      commitment: "processed",
    });
    if (stillValid.value) {
      const retry = await params.connection.confirmTransaction(
        {
          signature: params.signature,
          blockhash: params.blockhash,
          lastValidBlockHeight: params.lastValidBlockHeight,
        },
        "confirmed",
      );
      if (retry.value.err != null) {
        throw new ClientValidationError("CONFIRM_FAILED", [JSON.stringify(retry.value.err)]);
      }
      return;
    }
    const lastLook = await readLandedTransaction(params.connection, params.signature);
    if (lastLook !== null) {
      if (lastLook.err != null) {
        throw new ClientValidationError("CONFIRM_FAILED", [JSON.stringify(lastLook.err)]);
      }
      return;
    }
    throw new ClientValidationError("CONFIRM_EXPIRED", [
      error instanceof Error ? error.message : String(error),
      `signature ${params.signature} was not on chain after its blockhash died; getTransaction before treating this as a miss`,
    ]);
  }
}

async function simulateUnsigned(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<SimulationReview> {
  let simulated;
  try {
    simulated = await connection.simulateTransaction(transaction, {
      sigVerify: false,
      commitment: "confirmed",
    });
  } catch (error) {
    throw new ClientValidationError("SIMULATION_UNAVAILABLE", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  if (simulated.value == null) {
    throw new ClientValidationError("SIMULATION_UNAVAILABLE", [
      "simulateTransaction returned no value",
    ]);
  }
  const logs = simulated.value.logs;
  if (logs == null) {
    throw new ClientValidationError("SIMULATION_UNAVAILABLE", [
      "simulateTransaction returned no logs for operator review",
    ]);
  }
  if (simulated.value.err != null) {
    throw new ClientValidationError("SIMULATION_FAILED", [
      JSON.stringify(simulated.value.err),
      ...logs,
    ]);
  }
  return {
    logs,
    unitsConsumed:
      simulated.value.unitsConsumed === undefined ? null : String(simulated.value.unitsConsumed),
  };
}

export async function sendWithConnectedWallet(params: {
  connection: Connection;
  verified: VerifiedNetwork | null;
  wallet: WalletContextState;
  payload: UnsignedPayload;
  /**
   * Caller already ran simulateBoundPayload on these instruction bytes.
   * Skip the pre-sign simulate so Phantom opens immediately. The wallet may
   * refresh the blockhash or rewrite ComputeBudget; any other instruction
   * change still throws SIGNED_MESSAGE_CHANGED before broadcast.
   */
  reusePassedSimulation?: boolean;
  onPhase?: (phase: "signing" | "landing") => void;
}): Promise<SendResult> {
  const signers = extraSignersOf(params.payload);
  try {
    const { publicKey, signTransaction } = requireWallet(params.wallet);
    await assertPayloadGenesis(params.connection, params.verified, params.payload);
    const latest = await params.connection.getLatestBlockhash("confirmed");
    const transaction = buildTransaction(params.payload, publicKey, latest.blockhash);
    // Snapshot before signTransaction - wallets may mutate the input in place.
    const expectedBeforeSign = cloneTransaction(transaction);
    let simulation: SimulationReview = params.reusePassedSimulation
      ? { logs: ["reused caller-passed simulation"], unitsConsumed: null }
      : await simulateUnsigned(
          params.connection,
          new VersionedTransaction(transaction.compileMessage()),
        );
    const expectedMessage = expectedBeforeSign.serializeMessage();
    params.onPhase?.("signing");
    const signed = await signTransaction(transaction);
    const signedMessage = signed.serializeMessage();
    if (!equalBytes(expectedMessage, signedMessage)) {
      // Bytes differ. Structural check decides whether that is a fee
      // adjustment or a substitution; a substitution throws before broadcast.
      assertWalletOnlyAdjustedFees(expectedBeforeSign, signed);
      simulation = {
        logs: [
          ...simulation.logs,
          "wallet adjusted ComputeBudget and/or blockhash; instructions verified unchanged",
        ],
        unitsConsumed: simulation.unitsConsumed,
      };
    }
    const messageBeforeExtra = signed.serializeMessage();
    applyExtraSigners(signed, signers);
    if (signers.length > 0 && !equalBytes(messageBeforeExtra, signed.serializeMessage())) {
      throw new ClientValidationError("SIGNED_MESSAGE_CHANGED", [
        "extra mint signer changed the simulated transaction message; refusing to send",
      ]);
    }
    params.onPhase?.("landing");
    const signature = await params.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: true,
    });
    const confirmHash = signed.recentBlockhash ?? latest.blockhash;
    await confirmSentSignature({
      connection: params.connection,
      signature,
      blockhash: confirmHash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });
    return {
      signature,
      simulationLogs: simulation.logs,
      blockhash: confirmHash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    };
  } finally {
    dropExtraSigners(params.payload.extraSigners);
  }
}
