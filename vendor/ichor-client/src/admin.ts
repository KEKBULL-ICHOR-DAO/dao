import { PublicKey, Transaction, TransactionInstruction, type AccountMeta, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import { assertVerifiedIchorConfig, configPda } from "./burn.ts";
import { assertBoundConnection } from "./preflight.ts";
import { assertVerifiedGovernanceIdentity } from "./realms.ts";
import type {
  BuildAcceptAuthorityAsGovernanceParams,
  BuildAcceptAuthorityParams,
  BuildAdminParams,
  BuildApplyEmissionRatioParams,
  BuildApplyEmissionRatioTransactionParams,
  BuildIncreaseRatioTimelockParams,
  BuildProposeEmissionRatioParams,
  BuildSetPausedParams,
  BuildSetPendingAuthorityParams,
  BuildSetPendingAuthorityToGovernanceParams,
  IchorConfigSnapshot,
  UnsignedInstructionBuild,
  UnsignedTransactionBuild,
  VerifiedGovernanceIdentity,
  VerifiedIchorConfig,
  VerifiedIchorProgram,
} from "./types.ts";
import { ClientValidationError } from "./types.ts";
import { assertNoSecretMaterial, requirePublicKey, requireU64Bn } from "./validation.ts";

/**
 * Anchor 0.32 sighash: first 8 bytes of sha256("global:<name>").
 * Pinned so this module stays browser-safe. Tests recompute each hash.
 */
export const SET_PAUSED_DISCRIMINATOR = new Uint8Array([0x5b, 0x3c, 0x7d, 0xc0, 0xb0, 0xe1, 0xa6, 0xda]);
export const PROPOSE_EMISSION_RATIO_DISCRIMINATOR = new Uint8Array([0x82, 0x40, 0x6e, 0xf5, 0xfb, 0x42, 0xa6, 0xe4]);
export const APPLY_EMISSION_RATIO_DISCRIMINATOR = new Uint8Array([0x45, 0x91, 0x56, 0xb0, 0x57, 0x4e, 0x56, 0x67]);
export const CANCEL_PENDING_RATIO_DISCRIMINATOR = new Uint8Array([0x1f, 0xe9, 0x58, 0x20, 0x68, 0x9a, 0xff, 0xeb]);
export const FREEZE_RATIO_UPDATES_DISCRIMINATOR = new Uint8Array([0x07, 0xd3, 0x0e, 0x16, 0x59, 0x2b, 0xfb, 0x77]);
export const INCREASE_RATIO_TIMELOCK_DISCRIMINATOR = new Uint8Array([0x71, 0xe1, 0x87, 0xeb, 0x95, 0xe4, 0x41, 0x0d]);
export const SET_PENDING_AUTHORITY_DISCRIMINATOR = new Uint8Array([0xaf, 0x47, 0xa7, 0xdf, 0x31, 0x90, 0x66, 0xc1]);
export const ACCEPT_AUTHORITY_DISCRIMINATOR = new Uint8Array([0x6b, 0x56, 0xc6, 0x5b, 0x21, 0x0c, 0x6b, 0xa0]);

/** Borsh `Option` tag: 0 = None, 1 = Some. Four-byte optional tags are rejected by tests. */
const OPTION_NONE = 0;
const OPTION_SOME = 1;

const CALLER_PROGRAM_OR_CONFIG_FIELDS = [
  "programId",
  "ichorProgramId",
  "config",
  "configAddress",
  "configAccount",
  "configPda",
  "program",
  "accounts",
  "remainingAccounts",
  "keys",
] as const;

const CALLER_APPLY_SIGNER_FIELDS = ["authority", "pendingAuthority"] as const;

/** Derived Governance builders refuse a caller-substituted pending pubkey. */
const CALLER_PENDING_FIELDS = ["pending", "pendingAuthority"] as const;

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u64LeBytes(value: BN, label: string): Uint8Array {
  return Uint8Array.from(requireU64Bn(value, label).toArray("le", 8));
}

function pubkeyBytes(key: PublicKey): Uint8Array {
  return Uint8Array.from(key.toBytes());
}

function encodeBool(value: unknown, label: string): Uint8Array {
  if (typeof value !== "boolean") {
    throw new ClientValidationError("INVALID_BOOL", [`${label} must be a boolean`]);
  }
  return new Uint8Array([value ? 1 : 0]);
}

function encodeOptionPubkey(value: PublicKey | null, label: string): Uint8Array {
  if (value === null) {
    return new Uint8Array([OPTION_NONE]);
  }
  const key = requirePublicKey(value, label);
  if (key.equals(PublicKey.default)) {
    throw new ClientValidationError("INVALID_PENDING_AUTHORITY", [
      `${label} cannot be the default pubkey`,
    ]);
  }
  return concatBytes(new Uint8Array([OPTION_SOME]), pubkeyBytes(key));
}

function instruction(
  programId: PublicKey,
  keys: AccountMeta[],
  data: Uint8Array,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys,
    data: data as TransactionInstruction["data"],
  });
}

function unsignedIx(
  ix: TransactionInstruction,
  derivedAddresses: Record<string, PublicKey>,
): UnsignedInstructionBuild {
  return { instructions: [ix], derivedAddresses };
}

function assertNoCallerProgramOrConfig(params: object, label: string): void {
  const hits = CALLER_PROGRAM_OR_CONFIG_FIELDS.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError("CALLER_PROGRAM_OR_CONFIG", [
      `${label} takes program and config from the issued VerifiedIchorConfig; ${hits.join(", ")} cannot substitute`,
    ]);
  }
}

function assertNoCallerApplySigner(params: object, label: string): void {
  const hits = CALLER_APPLY_SIGNER_FIELDS.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError("CALLER_SIGNER", [
      `${label} is permissionless; ${hits.join(", ")} is not a program signer and cannot be invented`,
    ]);
  }
}

function assertNoCallerPending(params: object, label: string): void {
  const hits = CALLER_PENDING_FIELDS.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError("CALLER_PENDING", [
      `${label} derives pending authority from issued VerifiedGovernanceIdentity.governance; ${hits.join(", ")} cannot substitute`,
    ]);
  }
}

function assertSharedIssuedNetworkProof(
  verifiedProgram: VerifiedIchorProgram,
  verifiedGovernance: VerifiedGovernanceIdentity,
): void {
  if (verifiedGovernance.verifiedRealm.verified !== verifiedProgram.verified) {
    throw new ClientValidationError("NETWORK_PROOF", [
      "ICHOR program and Governance identity must share the exact issued network proof",
    ]);
  }
}

function requireIssuedConfig(
  params: { connection: Connection; verifiedConfig: VerifiedIchorConfig },
  label: string,
): { verifiedProgram: VerifiedIchorProgram; config: IchorConfigSnapshot; configAddress: PublicKey } {
  assertNoSecretMaterial(params, label);
  assertNoCallerProgramOrConfig(params, label);
  assertVerifiedIchorConfig(params.verifiedConfig);
  const { verifiedProgram, config } = params.verifiedConfig;
  assertBoundConnection(verifiedProgram.verified, params.connection);
  const derived = configPda(verifiedProgram.programId);
  if (!config.config.equals(derived.address) || config.bump !== derived.bump) {
    throw new ClientValidationError("CONFIG_PDA", [
      `config ${config.config.toBase58()} bump ${String(config.bump)} is not seeds=["config"] for ${verifiedProgram.programId.toBase58()}`,
    ]);
  }
  return { verifiedProgram, config, configAddress: config.config };
}

function requireMatchingAuthority(params: BuildAdminParams, label: string): {
  verifiedProgram: VerifiedIchorProgram;
  config: IchorConfigSnapshot;
  configAddress: PublicKey;
  authority: PublicKey;
} {
  const ctx = requireIssuedConfig(params, label);
  const authority = requirePublicKey(params.authority, "authority");
  if (!authority.equals(ctx.config.authority)) {
    throw new ClientValidationError("UNAUTHORIZED", [
      `authority ${authority.toBase58()} is not config.authority ${ctx.config.authority.toBase58()}`,
    ]);
  }
  return { ...ctx, authority };
}

function adminAccounts(authority: PublicKey, config: PublicKey): AccountMeta[] {
  return [
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: true },
  ];
}

function applyAccounts(config: PublicKey): AccountMeta[] {
  return [{ pubkey: config, isSigner: false, isWritable: true }];
}

function acceptAccounts(pendingAuthority: PublicKey, config: PublicKey): AccountMeta[] {
  return [
    { pubkey: pendingAuthority, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: true },
  ];
}

async function readConfirmedUnixTs(connection: Connection): Promise<BN> {
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) {
    throw new ClientValidationError("CLOCK_UNAVAILABLE", [
      `confirmed slot ${String(slot)} has no block time; ratio unlock cannot be determined`,
    ]);
  }
  return new BN(blockTime);
}

export function encodeSetPausedInstructionData(paused: boolean): Uint8Array {
  return concatBytes(SET_PAUSED_DISCRIMINATOR, encodeBool(paused, "paused"));
}

export function encodeProposeEmissionRatioInstructionData(numerator: BN, denominator: BN): Uint8Array {
  if (requireU64Bn(numerator, "numerator").isZero() || requireU64Bn(denominator, "denominator").isZero()) {
    throw new ClientValidationError("ZERO_RATIO", ["emission numerator/denominator is zero"]);
  }
  return concatBytes(
    PROPOSE_EMISSION_RATIO_DISCRIMINATOR,
    u64LeBytes(numerator, "numerator"),
    u64LeBytes(denominator, "denominator"),
  );
}

export function encodeApplyEmissionRatioInstructionData(): Uint8Array {
  return Uint8Array.from(APPLY_EMISSION_RATIO_DISCRIMINATOR);
}

export function encodeCancelPendingRatioInstructionData(): Uint8Array {
  return Uint8Array.from(CANCEL_PENDING_RATIO_DISCRIMINATOR);
}

export function encodeFreezeRatioUpdatesInstructionData(): Uint8Array {
  return Uint8Array.from(FREEZE_RATIO_UPDATES_DISCRIMINATOR);
}

export function encodeIncreaseRatioTimelockInstructionData(newSecs: BN): Uint8Array {
  return concatBytes(INCREASE_RATIO_TIMELOCK_DISCRIMINATOR, u64LeBytes(newSecs, "newSecs"));
}

export function encodeSetPendingAuthorityInstructionData(pending: PublicKey | null): Uint8Array {
  return concatBytes(SET_PENDING_AUTHORITY_DISCRIMINATOR, encodeOptionPubkey(pending, "pending"));
}

export function encodeAcceptAuthorityInstructionData(): Uint8Array {
  return Uint8Array.from(ACCEPT_AUTHORITY_DISCRIMINATOR);
}

/**
 * Unsigned `set_paused` instruction shape. Used by `buildSetPaused` after the
 * issued-config authority check, and by offline defensive-stake fixtures.
 */
export function composeSetPausedInstruction(params: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  paused: boolean;
}): TransactionInstruction {
  return instruction(
    params.programId,
    adminAccounts(params.authority, params.config),
    encodeSetPausedInstructionData(params.paused),
  );
}

/**
 * Unsigned `set_paused`. Admin accounts: authority signer readonly, config writable.
 */
export async function buildSetPaused(params: BuildSetPausedParams): Promise<UnsignedInstructionBuild> {
  const { verifiedProgram, configAddress, authority } = requireMatchingAuthority(
    params,
    "buildSetPaused",
  );
  return unsignedIx(
    composeSetPausedInstruction({
      programId: verifiedProgram.programId,
      authority,
      config: configAddress,
      paused: params.paused,
    }),
    { programId: verifiedProgram.programId, config: configAddress, authority },
  );
}

/**
 * Unsigned `propose_emission_ratio`. Rejects zero ratios, frozen updates, and a
 * zero timelock (`RatioLocked`). Unlock timestamp is computed on-chain.
 */
export async function buildProposeEmissionRatio(
  params: BuildProposeEmissionRatioParams,
): Promise<UnsignedInstructionBuild> {
  const { verifiedProgram, config, configAddress, authority } = requireMatchingAuthority(
    params,
    "buildProposeEmissionRatio",
  );
  if (config.ratioUpdatesFrozen) {
    throw new ClientValidationError("RATIO_UPDATES_FROZEN", ["emission-ratio updates are frozen"]);
  }
  if (config.ratioTimelockSecs.isZero()) {
    throw new ClientValidationError("RATIO_LOCKED", [
      "ratio timelock is zero; the initialized ratio is immutable",
    ]);
  }
  const data = encodeProposeEmissionRatioInstructionData(params.numerator, params.denominator);
  return unsignedIx(
    instruction(verifiedProgram.programId, adminAccounts(authority, configAddress), data),
    { programId: verifiedProgram.programId, config: configAddress, authority },
  );
}

/**
 * Unsigned permissionless `apply_emission_ratio`. No program signer. Validates
 * frozen/pending/timelock gates against the issued config and confirmed clock.
 */
export async function buildApplyEmissionRatio(
  params: BuildApplyEmissionRatioParams,
): Promise<UnsignedInstructionBuild> {
  assertNoCallerApplySigner(params, "buildApplyEmissionRatio");
  const { verifiedProgram, config, configAddress, connection } = {
    ...requireIssuedConfig(params, "buildApplyEmissionRatio"),
    connection: params.connection,
  };
  if (config.ratioUpdatesFrozen) {
    throw new ClientValidationError("RATIO_UPDATES_FROZEN", ["emission-ratio updates are frozen"]);
  }
  if (!config.hasPendingRatio) {
    throw new ClientValidationError("NO_PENDING_RATIO", ["no pending emission ratio"]);
  }
  if (config.pendingEmissionNumerator.isZero() || config.pendingEmissionDenominator.isZero()) {
    throw new ClientValidationError("ZERO_RATIO", ["pending emission numerator/denominator is zero"]);
  }
  const now = await readConfirmedUnixTs(connection);
  if (now.lt(config.pendingRatioUnlockTs)) {
    throw new ClientValidationError("RATIO_TIMELOCK_NOT_ELAPSED", [
      `confirmed unix ${now.toString()} is before pending unlock ${config.pendingRatioUnlockTs.toString()}`,
    ]);
  }
  const data = encodeApplyEmissionRatioInstructionData();
  return unsignedIx(
    instruction(verifiedProgram.programId, applyAccounts(configAddress), data),
    { programId: verifiedProgram.programId, config: configAddress },
  );
}

/**
 * Wraps permissionless apply in an unsigned transaction. `payer` is required
 * as the fee payer only; it is not added as a program account.
 */
export async function buildApplyEmissionRatioTransaction(
  params: BuildApplyEmissionRatioTransactionParams,
): Promise<UnsignedTransactionBuild> {
  assertNoSecretMaterial(params, "buildApplyEmissionRatioTransaction");
  assertNoCallerApplySigner(params, "buildApplyEmissionRatioTransaction");
  if (!("payer" in params) || params.payer === undefined || params.payer === null) {
    throw new ClientValidationError("PAYER_REQUIRED", [
      "apply transaction wrapper needs an explicit fee payer; this client does not invent one",
    ]);
  }
  const payer = requirePublicKey(params.payer, "payer");
  if (payer.equals(PublicKey.default)) {
    throw new ClientValidationError("DEFAULT_PUBKEY", ["apply fee payer cannot be the default pubkey"]);
  }
  const built = await buildApplyEmissionRatio(params);
  const transaction = new Transaction();
  transaction.feePayer = payer;
  transaction.add(...built.instructions);
  return {
    transaction,
    instructions: built.instructions,
    requiredSignerPubkeys: [payer],
  };
}

export async function buildCancelPendingRatio(
  params: BuildAdminParams,
): Promise<UnsignedInstructionBuild> {
  const { verifiedProgram, config, configAddress, authority } = requireMatchingAuthority(
    params,
    "buildCancelPendingRatio",
  );
  if (!config.hasPendingRatio) {
    throw new ClientValidationError("NO_PENDING_RATIO", ["no pending emission ratio"]);
  }
  const data = encodeCancelPendingRatioInstructionData();
  return unsignedIx(
    instruction(verifiedProgram.programId, adminAccounts(authority, configAddress), data),
    { programId: verifiedProgram.programId, config: configAddress, authority },
  );
}

export async function buildFreezeRatioUpdates(
  params: BuildAdminParams,
): Promise<UnsignedInstructionBuild> {
  const { verifiedProgram, configAddress, authority } = requireMatchingAuthority(
    params,
    "buildFreezeRatioUpdates",
  );
  const data = encodeFreezeRatioUpdatesInstructionData();
  return unsignedIx(
    instruction(verifiedProgram.programId, adminAccounts(authority, configAddress), data),
    { programId: verifiedProgram.programId, config: configAddress, authority },
  );
}

export async function buildIncreaseRatioTimelock(
  params: BuildIncreaseRatioTimelockParams,
): Promise<UnsignedInstructionBuild> {
  const { verifiedProgram, config, configAddress, authority } = requireMatchingAuthority(
    params,
    "buildIncreaseRatioTimelock",
  );
  const newSecs = requireU64Bn(params.newSecs, "newSecs");
  if (newSecs.lt(config.ratioTimelockSecs)) {
    throw new ClientValidationError("TIMELOCK_CANNOT_DECREASE", [
      `new timelock ${newSecs.toString()} is below current ${config.ratioTimelockSecs.toString()}`,
    ]);
  }
  const data = encodeIncreaseRatioTimelockInstructionData(newSecs);
  return unsignedIx(
    instruction(verifiedProgram.programId, adminAccounts(authority, configAddress), data),
    { programId: verifiedProgram.programId, config: configAddress, authority },
  );
}

export async function buildSetPendingAuthority(
  params: BuildSetPendingAuthorityParams,
): Promise<UnsignedInstructionBuild> {
  const { verifiedProgram, configAddress, authority } = requireMatchingAuthority(
    params,
    "buildSetPendingAuthority",
  );
  const data = encodeSetPendingAuthorityInstructionData(params.pending);
  return unsignedIx(
    instruction(verifiedProgram.programId, adminAccounts(authority, configAddress), data),
    { programId: verifiedProgram.programId, config: configAddress, authority },
  );
}

export async function buildAcceptAuthority(
  params: BuildAcceptAuthorityParams,
): Promise<UnsignedInstructionBuild> {
  const { verifiedProgram, config, configAddress } = requireIssuedConfig(
    params,
    "buildAcceptAuthority",
  );
  const pendingAuthority = requirePublicKey(params.pendingAuthority, "pendingAuthority");
  if (config.pendingAuthority === null) {
    throw new ClientValidationError("NO_PENDING_AUTHORITY", ["no pending authority"]);
  }
  if (config.pendingAuthority.equals(PublicKey.default)) {
    throw new ClientValidationError("INVALID_PENDING_AUTHORITY", [
      "pending authority cannot be the default pubkey",
    ]);
  }
  if (!pendingAuthority.equals(config.pendingAuthority)) {
    throw new ClientValidationError("PENDING_AUTHORITY_MISMATCH", [
      `signer ${pendingAuthority.toBase58()} is not pending authority ${config.pendingAuthority.toBase58()}`,
    ]);
  }
  const data = encodeAcceptAuthorityInstructionData();
  return unsignedIx(
    instruction(verifiedProgram.programId, acceptAccounts(pendingAuthority, configAddress), data),
    {
      programId: verifiedProgram.programId,
      config: configAddress,
      pendingAuthority,
    },
  );
}

/**
 * Unsigned `set_pending_authority` to the issued Governance PDA. Current
 * `config.authority` still signs. No caller `pending` field.
 */
export async function buildSetPendingAuthorityToGovernance(
  params: BuildSetPendingAuthorityToGovernanceParams,
): Promise<UnsignedInstructionBuild> {
  assertNoCallerPending(params, "buildSetPendingAuthorityToGovernance");
  const { verifiedProgram, configAddress, authority } = requireMatchingAuthority(
    params,
    "buildSetPendingAuthorityToGovernance",
  );
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertSharedIssuedNetworkProof(verifiedProgram, params.verifiedGovernance);
  const governance = params.verifiedGovernance.governance;
  const data = encodeSetPendingAuthorityInstructionData(governance);
  return unsignedIx(
    instruction(verifiedProgram.programId, adminAccounts(authority, configAddress), data),
    {
      programId: verifiedProgram.programId,
      config: configAddress,
      authority,
      governance,
      pendingAuthority: governance,
    },
  );
}

/**
 * Unsigned `accept_authority` whose pending signer is the issued Governance
 * PDA. Live config must already have that pubkey pending. No on-curve check:
 * Governance is a PDA (off-curve). That is the point.
 */
export async function buildAcceptAuthorityAsGovernance(
  params: BuildAcceptAuthorityAsGovernanceParams,
): Promise<UnsignedInstructionBuild> {
  assertNoCallerPending(params, "buildAcceptAuthorityAsGovernance");
  const { verifiedProgram, config, configAddress } = requireIssuedConfig(
    params,
    "buildAcceptAuthorityAsGovernance",
  );
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertSharedIssuedNetworkProof(verifiedProgram, params.verifiedGovernance);
  const pendingAuthority = params.verifiedGovernance.governance;
  if (config.pendingAuthority === null) {
    throw new ClientValidationError("NO_PENDING_AUTHORITY", ["no pending authority"]);
  }
  if (config.pendingAuthority.equals(PublicKey.default)) {
    throw new ClientValidationError("INVALID_PENDING_AUTHORITY", [
      "pending authority cannot be the default pubkey",
    ]);
  }
  if (!pendingAuthority.equals(config.pendingAuthority)) {
    throw new ClientValidationError("PENDING_AUTHORITY_MISMATCH", [
      `signer ${pendingAuthority.toBase58()} is not pending authority ${config.pendingAuthority.toBase58()}`,
    ]);
  }
  const data = encodeAcceptAuthorityInstructionData();
  return unsignedIx(
    instruction(verifiedProgram.programId, acceptAccounts(pendingAuthority, configAddress), data),
    {
      programId: verifiedProgram.programId,
      config: configAddress,
      pendingAuthority,
      governance: pendingAuthority,
    },
  );
}
