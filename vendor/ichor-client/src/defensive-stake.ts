/**
 * Atomic post-graduation defensive-stake composer.
 *
 * One message, creator wallet sole signer when ATA/TOR creation permits:
 *   set_paused(false) → KEKBULL→ICHOR convert → DepositGoverningTokens → set_paused(true)
 *
 * Re-pause is mandatory in v1. Any on-chain failure rolls the whole message
 * back. Normal `buildConvertTransaction` stays paused-gated; this file calls
 * `composeConvertInstructionsFromIssuedConfig` only after unpause is first.
 *
 * DepositGoverningTokens `amount` is the **gross** Token-2022 transfer (fork
 * `process_deposit_governing_tokens.rs`: CPI `transfer_checked` uses `amount`,
 * then `deposit_amount = amount - get_current_mint_fee`). TOR records the net.
 *
 * Packet size is MEASURED_OFFLINE from the exact legacy wire (one dummy
 * signature + a well-formed non-default size-only blockhash). That blockhash
 * is not current chain state and is never broadcast-ready. Packets above
 * 1232 are refused. Compute units stay UNVERIFIED until exact on-cluster
 * simulation. After a measured CU rebuild, packet size is rechecked because
 * the ComputeBudget prefix changes the wire. Send stays impossible. Do not
 * split this ceremony.
 *
 * Issued groups and returned assemble artifacts hold deep clones
 * (`TransactionInstruction` + AccountMeta objects + data bytes). Mutating
 * builder outputs or one returned copy must not change the branded source or
 * another returned artifact. Assemble revalidates and remeasures the cloned
 * instruction set it returns.
 *
 * E-stage keystore signer (`examples/ichor_mainnet_e_signer`) independently
 * pins the exact serialized message and the four validated groups. It must
 * not trust composer status fields (`sendImplemented`, packet/CU labels).
 */

import { Buffer } from "buffer";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  getRealmConfigAddress,
  getTokenHoldingAddress,
  getTokenOwnerRecordAddress,
} from "@realms-today/spl-governance";
import {
  ComputeBudgetProgram,
  PACKET_DATA_SIZE,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { buildSetPaused, encodeSetPausedInstructionData } from "./admin.ts";
import {
  CONVERT_DISCRIMINATOR,
  assertVerifiedIchorConfig,
  composeConvertInstructionsFromIssuedConfig,
  encodeConvertInstructionData,
  verifyIchorConfigDeployment,
  verifyIchorProgramDeployment,
} from "./burn.ts";
import { OFFICIAL_CLUSTER_GENESIS, REALMS_INSTANCES } from "./network.ts";
import { assertBoundConnection, verifyNetworkDeployment } from "./preflight.ts";
import {
  assertVerifiedGovernanceIdentity,
  assertVerifiedRealm,
  buildDepositIchorVotes,
  verifyGovernanceIdentity,
  verifyRealmDeployment,
} from "./realms.ts";
import { fetchMintSnapshot } from "./mint.ts";
import {
  ClientValidationError,
  type AtomicDefensiveStakeBuild,
  type BuildAtomicDefensiveStakeParams,
  type ComputeUnitsStatus,
  type DefensiveStakeAccountMeta,
  type DefensiveStakeComputePlan,
  type PacketSizeStatus,
  type ExplicitTokenAmount,
  type VerifyAndBuildAtomicDefensiveStakeParams,
} from "./types.ts";
import {
  assertNoSecretMaterial,
  ichorFromKekbull,
  requirePositiveBn,
  requirePublicKey,
  requireU64Bn,
  tenPowU8,
} from "./validation.ts";

/** Solana packet data size. Same ceiling as `@solana/web3.js` PACKET_DATA_SIZE. */
export const SOLANA_PACKET_DATA_SIZE = PACKET_DATA_SIZE;

/**
 * Protocol compute-unit ceiling, margin, and floor.
 * Must stay byte-equal to `src/launch/compute.rs` MAX_TX_COMPUTE_UNITS /
 * MARGIN_PERCENT / MIN_COMPUTE_UNITS. The client/e2e parity test reads both
 * sources so drift fails.
 */
export const SOLANA_MAX_TX_COMPUTE_UNITS = 1_400_000;
export const COMPUTE_MARGIN_PERCENT = 25;
export const COMPUTE_MIN_UNITS = 120_000;

/**
 * Well-formed non-default 32-byte blockhash used only to size an offline
 * legacy wire. It is not current chain state and must never be treated as
 * broadcast-ready. Distinct from `PublicKey.default`.
 */
export const OFFLINE_PACKET_BLOCKHASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** Borsh tag for `GovernanceInstruction::DepositGoverningTokens` (variant after CreateRealm). */
export const DEPOSIT_GOVERNING_TOKENS_TAG = 1;

/** Exact 0.3.33/v3 DepositGoverningTokens data: u8 tag + u64 amount. */
export const DEPOSIT_GOVERNING_TOKENS_DATA_LEN = 9;

/** Installed `@solana/spl-token` createIdempotent data is exactly `[1]`. */
export const ATA_CREATE_IDEMPOTENT_TAG = 1;

/** Installed helper emits 6 metas; no rent sysvar. */
export const ATA_CREATE_IDEMPOTENT_KEY_COUNT = 6;

/** Patched ICHOR deposit: SDK 10 keys + Token-2022 mint at 10. */
export const DEPOSIT_GOVERNING_TOKENS_KEY_COUNT = 11;

/**
 * Fork deposit instruction amount is the gross transfer. Vote weight stored on
 * the TokenOwnerRecord is net after `get_current_mint_fee`.
 */
export const DEPOSIT_GOVERNING_TOKENS_AMOUNT_IS_GROSS = true as const;

/** Mainnet creator / Config authority / recovery wallet. Official-devnet uses live Config.authority. */
export const MAINNET_CREATOR_WALLET = "5E6eeUqF2UunqwGDavfCgh28smQe88JSN7MXGvCdh4Zd";

/** This E ceremony is kekbull_governance only. GovER5 cannot CastVote TransferFee ICHOR. */
export const DEFENSIVE_STAKE_REALMS_PROGRAM = REALMS_INSTANCES.kekbull.id;

const GOVERNANCE_PDA_SEED = new TextEncoder().encode("governance");
const REALM_CONFIG_PDA_SEED = new TextEncoder().encode("realm-config");

const EXTRA_SIGNER_FIELDS = [
  "keypairPath",
  "keypairFile",
  "secretKeyFile",
  "signerKeypair",
  "payerKeypair",
  "creatorKeypair",
  "recoveryKeypair",
] as const;

export function assertNoExtraSignerMaterial(params: object, label: string): void {
  assertNoSecretMaterial(params, label);
  const hits = EXTRA_SIGNER_FIELDS.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError("EXTRA_SIGNER_REFUSED", [
      `${label} refuses extra signer/keypair fields: ${hits.join(", ")}`,
    ]);
  }
}

export function parseExplicitTokenAmount(
  amount: unknown,
  decimals: number,
  label: string,
): BN {
  if (amount === undefined || amount === null) {
    throw new ClientValidationError("AMOUNT_REQUIRED", [
      `${label} has no default; supply explicit { kind: "raw", value: BN } or { kind: "human", value: string } after chain reads`,
    ]);
  }
  if (typeof amount !== "object" || Array.isArray(amount)) {
    throw new ClientValidationError("AMOUNT_REQUIRED", [
      `${label} must be { kind: "raw", value: BN } or { kind: "human", value: string }`,
    ]);
  }
  const record = amount as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    (keys.includes("raw") && keys.includes("human")) ||
    (record.kind === "raw" && keys.includes("human")) ||
    (record.kind === "human" && keys.includes("raw"))
  ) {
    throw new ClientValidationError("AMOUNT_EXCLUSIVE", [
      `${label} must be raw or human, not both`,
    ]);
  }
  if (record.kind === "raw" && keys.length === 2 && keys.includes("kind") && keys.includes("value")) {
    return requireU64Bn(requirePositiveBn(record.value, `${label}.value`), `${label}.value`);
  }
  if (record.kind === "human" && keys.length === 2 && keys.includes("kind") && keys.includes("value")) {
    return parseHumanTokenAmount(record.value, decimals, `${label}.value`);
  }
  throw new ClientValidationError("AMOUNT_REQUIRED", [
    `${label} has no default; supply exclusive kind "raw" or "human"`,
  ]);
}

export function parseHumanTokenAmount(value: unknown, decimals: number, label: string): BN {
  if (typeof value !== "string") {
    throw new ClientValidationError("AMOUNT_REQUIRED", [`${label} human amount must be a decimal string`]);
  }
  if (value !== value.trim() || value.length === 0) {
    throw new ClientValidationError("AMOUNT_REQUIRED", [`${label} human amount is empty or padded`]);
  }
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) {
    throw new ClientValidationError("AMOUNT_REQUIRED", [
      `${label} human amount must be a non-scientific decimal string`,
    ]);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ClientValidationError("MINT_DECIMALS", [`${label} decimals are not a u8`]);
  }
  const [whole, frac = ""] = value.split(".");
  if (frac.length > decimals) {
    throw new ClientValidationError("AMOUNT_SCALE", [
      `${label} has ${String(frac.length)} fractional digits; live mint decimals are ${String(decimals)}`,
    ]);
  }
  const padded = frac.padEnd(decimals, "0");
  const wholeDigits = whole ?? "0";
  const raw = new BN(wholeDigits).mul(tenPowU8(decimals)).add(padded.length === 0 ? new BN(0) : new BN(padded));
  return requireU64Bn(requirePositiveBn(raw, label), label);
}

/**
 * Same integer identity as `src/launch/compute.rs` `limit_from_measured`
 * (`saturating_mul(100+MARGIN)/100`, then floor 120_000) except this ceremony
 * **refuses** when the 25% result exceeds the protocol max instead of silently
 * clamping. A clamp would claim an adequate limit that is still below the
 * requested headroom.
 */
export function limitFromMeasured(unitsConsumed: number): number {
  if (!Number.isInteger(unitsConsumed) || unitsConsumed < 0) {
    throw new ClientValidationError("COMPUTE_UNVERIFIED", [
      `unitsConsumed ${String(unitsConsumed)} is not a measured non-negative integer`,
    ]);
  }
  const withMargin = Number(
    (BigInt(unitsConsumed) * BigInt(100 + COMPUTE_MARGIN_PERCENT)) / 100n,
  );
  if (withMargin > SOLANA_MAX_TX_COMPUTE_UNITS) {
    throw new ClientValidationError("COMPUTE_EXCEEDS_PROTOCOL_MAX", [
      `measured ${String(unitsConsumed)} + ${String(COMPUTE_MARGIN_PERCENT)}% is ${String(withMargin)} which exceeds ${String(SOLANA_MAX_TX_COMPUTE_UNITS)}; refuse rather than clamp`,
    ]);
  }
  return Math.max(withMargin, COMPUTE_MIN_UNITS);
}

export function deriveMeasuredComputePlan(unitsConsumed: number): DefensiveStakeComputePlan {
  if (!Number.isInteger(unitsConsumed) || unitsConsumed <= 0 || unitsConsumed > SOLANA_MAX_TX_COMPUTE_UNITS) {
    throw new ClientValidationError("COMPUTE_UNVERIFIED", [
      `unitsConsumed ${String(unitsConsumed)} is not a measured protocol-range integer`,
    ]);
  }
  return {
    kind: "measured",
    unitsConsumed,
    computeUnitLimit: limitFromMeasured(unitsConsumed),
  };
}

export function assertOfficialIchorCluster(params: {
  cluster: string;
  genesisHash: string;
}): void {
  if (params.cluster !== "mainnet-beta" && params.cluster !== "devnet") {
    throw new ClientValidationError("CLUSTER_REFUSED", [
      `atomic defensive stake requires mainnet-beta or official-devnet; got ${params.cluster}`,
    ]);
  }
  if (!OFFICIAL_CLUSTER_GENESIS.has(params.genesisHash)) {
    throw new ClientValidationError("GENESIS_MISMATCH", [
      `genesis ${params.genesisHash} is not an official cluster hash`,
    ]);
  }
}

export function assertDefensiveStakeIdentities(params: {
  creator: PublicKey;
  configAuthority: PublicKey;
  configRealm: PublicKey | null;
  configGovernance: PublicKey | null;
  configRealmsProgram: PublicKey | null;
  configIchorMint: PublicKey;
  configPaused: boolean;
  realm: PublicKey;
  governance: PublicKey;
  communityMint: PublicKey;
  realmsProgramId: PublicKey;
  cluster: string;
}): void {
  const errors: string[] = [];
  if (!params.creator.equals(params.configAuthority)) {
    errors.push(
      `creator ${params.creator.toBase58()} is not Config.authority ${params.configAuthority.toBase58()}`,
    );
  }
  if (params.cluster === "mainnet-beta" && params.creator.toBase58() !== MAINNET_CREATOR_WALLET) {
    errors.push(`mainnet creator ${params.creator.toBase58()} is not ${MAINNET_CREATOR_WALLET}`);
  }
  if (!params.configPaused) {
    errors.push("Config is already unpaused; atomic first-stake requires a paused convert door");
  }
  if (params.configRealm === null || !params.configRealm.equals(params.realm)) {
    errors.push("Config.realms_realm is not the verified Realm");
  }
  if (params.configGovernance === null || !params.configGovernance.equals(params.governance)) {
    errors.push("Config.realms_governance is not the verified Governance");
  }
  if (params.configRealmsProgram === null || !params.configRealmsProgram.equals(params.realmsProgramId)) {
    errors.push("Config.realms_program is not the verified Realms program");
  }
  if (!params.communityMint.equals(params.configIchorMint)) {
    errors.push("verified Realm community mint is not Config.ichor_mint");
  }
  if (params.realmsProgramId.toBase58() !== DEFENSIVE_STAKE_REALMS_PROGRAM) {
    errors.push(
      `realms program ${params.realmsProgramId.toBase58()} is not kekbull_governance ${DEFENSIVE_STAKE_REALMS_PROGRAM}`,
    );
  }
  if (errors.length > 0) {
    throw new ClientValidationError("DEFENSIVE_STAKE_IDENTITY", errors);
  }
}

function ixData(ix: TransactionInstruction): Uint8Array {
  return ix.data instanceof Uint8Array ? ix.data : Uint8Array.from(ix.data);
}

export function cloneTransactionInstruction(ix: TransactionInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: ix.programId,
    keys: ix.keys.map((key) => ({
      pubkey: key.pubkey,
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(ixData(ix)),
  });
}

function cloneInstructionList(instructions: readonly TransactionInstruction[]): TransactionInstruction[] {
  return instructions.map(cloneTransactionInstruction);
}

export function deriveGoverningTokenHoldingAddress(
  realmsProgramId: PublicKey,
  realm: PublicKey,
  communityMint: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [GOVERNANCE_PDA_SEED, realm.toBytes(), communityMint.toBytes()],
    realmsProgramId,
  )[0];
}

export function deriveTokenOwnerRecordAddress(
  realmsProgramId: PublicKey,
  realm: PublicKey,
  communityMint: PublicKey,
  owner: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [GOVERNANCE_PDA_SEED, realm.toBytes(), communityMint.toBytes(), owner.toBytes()],
    realmsProgramId,
  )[0];
}

export function deriveRealmConfigAddress(realmsProgramId: PublicKey, realm: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([REALM_CONFIG_PDA_SEED, realm.toBytes()], realmsProgramId)[0];
}

export function assertDefensiveStakeKekbullGovernance(realmsProgramId: PublicKey): void {
  if (realmsProgramId.toBase58() !== DEFENSIVE_STAKE_REALMS_PROGRAM) {
    throw new ClientValidationError("KEKBULL_GOVERNANCE_REQUIRED", [
      `atomic defensive stake requires kekbull_governance ${DEFENSIVE_STAKE_REALMS_PROGRAM}; GovER5 cannot CastVote/FinalizeVote TransferFee ICHOR`,
    ]);
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function isSetPausedIx(
  ix: TransactionInstruction,
  ichorProgramId: PublicKey,
  paused: boolean,
): boolean {
  if (!ix.programId.equals(ichorProgramId)) {
    return false;
  }
  return bytesEqual(ixData(ix), encodeSetPausedInstructionData(paused));
}

/** Borsh-identical to 0.3.33 `DepositGoverningTokensArgs` at programVersion >= 2. */
export function encodeDepositGoverningTokensData(amount: BN): Uint8Array {
  const checked = requireU64Bn(requirePositiveBn(amount, "depositAmount"), "depositAmount");
  const data = new Uint8Array(DEPOSIT_GOVERNING_TOKENS_DATA_LEN);
  data[0] = DEPOSIT_GOVERNING_TOKENS_TAG;
  data.set(Uint8Array.from(checked.toArray("le", 8)), 1);
  return data;
}

function requireScalarAmount(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new ClientValidationError("STAKE_GROUP", [
      `${label} must be a positive decimal string of the exact raw amount`,
    ]);
  }
  requireU64Bn(new BN(value), label);
  return value;
}

function isConvertIx(ix: TransactionInstruction, ichorProgramId: PublicKey): boolean {
  if (!ix.programId.equals(ichorProgramId)) {
    return false;
  }
  const data = ixData(ix);
  if (data.length !== CONVERT_DISCRIMINATOR.length + 16) {
    return false;
  }
  for (let i = 0; i < CONVERT_DISCRIMINATOR.length; i++) {
    if (data[i] !== CONVERT_DISCRIMINATOR[i]) {
      return false;
    }
  }
  return true;
}

function isDepositGoverningTokensIx(ix: TransactionInstruction, realmsProgramId: PublicKey): boolean {
  if (!ix.programId.equals(realmsProgramId)) {
    return false;
  }
  const data = ixData(ix);
  return data.length === DEPOSIT_GOVERNING_TOKENS_DATA_LEN && data[0] === DEPOSIT_GOVERNING_TOKENS_TAG;
}

function isAtaCreateIdempotentIx(ix: TransactionInstruction): boolean {
  if (!ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
    return false;
  }
  const data = ixData(ix);
  return data.length === 1 && data[0] === ATA_CREATE_IDEMPOTENT_TAG;
}

/**
 * Immutable expected identities and scalar amounts. Production fills these
 * only from issued proofs and builder-returned / canonical PDA addresses.
 * Amounts are decimal strings so they cannot be mutated after freeze.
 */
export interface DefensiveStakeGroupIdentities {
  readonly creator: PublicKey;
  readonly ichorProgramId: PublicKey;
  readonly realmsProgramId: PublicKey;
  readonly config: PublicKey;
  readonly kekbullMint: PublicKey;
  readonly ichorMint: PublicKey;
  readonly kekbullFrom: PublicKey;
  readonly ichorTo: PublicKey;
  readonly bondingCurve: PublicKey;
  readonly kekbullTokenProgram: PublicKey;
  readonly ichorTokenProgram: PublicKey;
  readonly realm: PublicKey;
  readonly governingTokenHolding: PublicKey;
  readonly tokenOwnerRecord: PublicKey;
  readonly realmConfig: PublicKey;
  readonly kekbullAmount: string;
  readonly expectedIchorGross: string;
}

function freezeIdentities(identities: DefensiveStakeGroupIdentities): DefensiveStakeGroupIdentities {
  return Object.freeze({
    creator: identities.creator,
    ichorProgramId: identities.ichorProgramId,
    realmsProgramId: identities.realmsProgramId,
    config: identities.config,
    kekbullMint: identities.kekbullMint,
    ichorMint: identities.ichorMint,
    kekbullFrom: identities.kekbullFrom,
    ichorTo: identities.ichorTo,
    bondingCurve: identities.bondingCurve,
    kekbullTokenProgram: identities.kekbullTokenProgram,
    ichorTokenProgram: identities.ichorTokenProgram,
    realm: identities.realm,
    governingTokenHolding: identities.governingTokenHolding,
    tokenOwnerRecord: identities.tokenOwnerRecord,
    realmConfig: identities.realmConfig,
    kekbullAmount: requireScalarAmount(identities.kekbullAmount, "kekbullAmount"),
    expectedIchorGross: requireScalarAmount(identities.expectedIchorGross, "expectedIchorGross"),
  });
}

class IssuedValidatedDefensiveStakeGroups {
  readonly unpause: TransactionInstruction;
  readonly convert: readonly TransactionInstruction[];
  readonly deposit: readonly TransactionInstruction[];
  readonly repause: TransactionInstruction;
  readonly identities: DefensiveStakeGroupIdentities;

  constructor(args: {
    unpause: TransactionInstruction;
    convert: readonly TransactionInstruction[];
    deposit: readonly TransactionInstruction[];
    repause: TransactionInstruction;
    identities: DefensiveStakeGroupIdentities;
  }) {
    this.unpause = args.unpause;
    this.convert = Object.freeze([...args.convert]);
    this.deposit = Object.freeze([...args.deposit]);
    this.repause = args.repause;
    this.identities = freezeIdentities(args.identities);
    Object.freeze(this);
  }
}

const issuedStakeGroups = new WeakSet<object>();

export type ValidatedDefensiveStakeGroups = IssuedValidatedDefensiveStakeGroups;

function requireKey(
  ix: TransactionInstruction,
  index: number,
  expected: PublicKey,
  signer: boolean,
  writable: boolean,
  label: string,
): void {
  const key = ix.keys[index];
  if (
    key === undefined ||
    !key.pubkey.equals(expected) ||
    key.isSigner !== signer ||
    key.isWritable !== writable
  ) {
    throw new ClientValidationError("STAKE_GROUP", [
      `${label} key[${String(index)}] is not the expected identity/signer/writable flags`,
    ]);
  }
}

function assertSetPausedGroup(
  ix: TransactionInstruction,
  identities: DefensiveStakeGroupIdentities,
  paused: boolean,
  label: string,
): void {
  if (!isSetPausedIx(ix, identities.ichorProgramId, paused)) {
    throw new ClientValidationError("STAKE_GROUP", [
      `${label} must be set_paused(${String(paused)}) on the ICHOR program`,
    ]);
  }
  if (ix.keys.length !== 2) {
    throw new ClientValidationError("STAKE_GROUP", [`${label} must have exactly 2 accounts`]);
  }
  requireKey(ix, 0, identities.creator, true, false, label);
  requireKey(ix, 1, identities.config, false, true, label);
}

function assertCanonicalAtas(identities: DefensiveStakeGroupIdentities): void {
  const kekbullFrom = getAssociatedTokenAddressSync(
    identities.kekbullMint,
    identities.creator,
    false,
    identities.kekbullTokenProgram,
  );
  const ichorTo = getAssociatedTokenAddressSync(
    identities.ichorMint,
    identities.creator,
    true,
    identities.ichorTokenProgram,
  );
  if (!identities.kekbullFrom.equals(kekbullFrom)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "kekbullFrom is not the canonical KEKBULL ATA for the creator",
    ]);
  }
  if (!identities.ichorTo.equals(ichorTo)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "ichorTo is not the canonical ICHOR ATA for the creator",
    ]);
  }
  if (!identities.ichorTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "ICHOR token program must be Token-2022",
    ]);
  }
  if (!identities.kekbullTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "KEKBULL token program must be Token-2022",
    ]);
  }
}

function assertDerivedRealmPdas(identities: DefensiveStakeGroupIdentities): void {
  const holding = deriveGoverningTokenHoldingAddress(
    identities.realmsProgramId,
    identities.realm,
    identities.ichorMint,
  );
  const tokenOwnerRecord = deriveTokenOwnerRecordAddress(
    identities.realmsProgramId,
    identities.realm,
    identities.ichorMint,
    identities.creator,
  );
  const realmConfig = deriveRealmConfigAddress(identities.realmsProgramId, identities.realm);
  if (!identities.governingTokenHolding.equals(holding)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "governingTokenHolding is not the canonical PDA for realm/mint/program",
    ]);
  }
  if (!identities.tokenOwnerRecord.equals(tokenOwnerRecord)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "tokenOwnerRecord is not the canonical PDA for realm/mint/creator/program",
    ]);
  }
  if (!identities.realmConfig.equals(realmConfig)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "realmConfig is not the canonical PDA for realm/program",
    ]);
  }
}

function assertAtaCreateIdempotent(
  ix: TransactionInstruction,
  identities: DefensiveStakeGroupIdentities,
): void {
  if (!isAtaCreateIdempotentIx(ix)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "only Associated Token createIdempotent may precede convert",
    ]);
  }
  if (ix.keys.length !== ATA_CREATE_IDEMPOTENT_KEY_COUNT) {
    throw new ClientValidationError("STAKE_GROUP", [
      `ATA createIdempotent must have ${String(ATA_CREATE_IDEMPOTENT_KEY_COUNT)} accounts from the installed helper`,
    ]);
  }
  requireKey(ix, 0, identities.creator, true, true, "ata");
  requireKey(ix, 1, identities.ichorTo, false, true, "ata");
  requireKey(ix, 2, identities.creator, false, false, "ata");
  requireKey(ix, 3, identities.ichorMint, false, false, "ata");
  requireKey(ix, 4, SystemProgram.programId, false, false, "ata");
  requireKey(ix, 5, identities.ichorTokenProgram, false, false, "ata");
}

function assertConvertGroup(
  instructions: readonly TransactionInstruction[],
  identities: DefensiveStakeGroupIdentities,
): void {
  if (instructions.length < 1 || instructions.length > 2) {
    throw new ClientValidationError("STAKE_GROUP", [
      `convert group must be [optional ATA create] + convert; got ${String(instructions.length)}`,
    ]);
  }
  let convert = instructions[0]!;
  if (instructions.length === 2) {
    assertAtaCreateIdempotent(instructions[0]!, identities);
    convert = instructions[1]!;
  }
  if (!isConvertIx(convert, identities.ichorProgramId)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "convert group must contain exactly one ICHOR convert instruction",
    ]);
  }
  const expectedData = encodeConvertInstructionData(
    new BN(identities.kekbullAmount),
    new BN(identities.expectedIchorGross),
  );
  if (!bytesEqual(ixData(convert), expectedData)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "convert data must be the exact encoded kekbullAmount and minIchorAmount",
    ]);
  }
  if (convert.keys.length !== 9) {
    throw new ClientValidationError("STAKE_GROUP", ["convert must have the 9-account Convert layout"]);
  }
  requireKey(convert, 0, identities.creator, true, false, "convert");
  requireKey(convert, 1, identities.config, false, true, "convert");
  requireKey(convert, 2, identities.kekbullMint, false, true, "convert");
  requireKey(convert, 3, identities.ichorMint, false, true, "convert");
  requireKey(convert, 4, identities.kekbullFrom, false, true, "convert");
  requireKey(convert, 5, identities.ichorTo, false, true, "convert");
  requireKey(convert, 6, identities.bondingCurve, false, false, "convert");
  requireKey(convert, 7, identities.kekbullTokenProgram, false, false, "convert");
  requireKey(convert, 8, identities.ichorTokenProgram, false, false, "convert");
}

function assertDepositGroup(
  instructions: readonly TransactionInstruction[],
  identities: DefensiveStakeGroupIdentities,
): void {
  if (instructions.length !== 1) {
    throw new ClientValidationError("STAKE_GROUP", [
      `deposit group must be exactly one DepositGoverningTokens; got ${String(instructions.length)}`,
    ]);
  }
  const ix = instructions[0]!;
  if (ix.programId.equals(SystemProgram.programId)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "System Program instructions are not allowed in the deposit group",
    ]);
  }
  if (!isDepositGoverningTokensIx(ix, identities.realmsProgramId)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "deposit group must be DepositGoverningTokens on the verified Realms program",
    ]);
  }
  const expectedData = encodeDepositGoverningTokensData(new BN(identities.expectedIchorGross));
  if (!bytesEqual(ixData(ix), expectedData)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "deposit data must be the exact 9-byte DepositGoverningTokens encoding of the gross ICHOR amount",
    ]);
  }
  if (ix.keys.length !== DEPOSIT_GOVERNING_TOKENS_KEY_COUNT) {
    throw new ClientValidationError("STAKE_GROUP", [
      `DepositGoverningTokens must have exactly ${String(DEPOSIT_GOVERNING_TOKENS_KEY_COUNT)} keys after the Token-2022 mint patch`,
    ]);
  }
  requireKey(ix, 0, identities.realm, false, false, "deposit");
  requireKey(ix, 1, identities.governingTokenHolding, false, true, "deposit");
  requireKey(ix, 2, identities.ichorTo, false, true, "deposit");
  requireKey(ix, 3, identities.creator, true, false, "deposit");
  requireKey(ix, 4, identities.creator, true, false, "deposit");
  requireKey(ix, 5, identities.tokenOwnerRecord, false, true, "deposit");
  requireKey(ix, 6, identities.creator, true, true, "deposit");
  requireKey(ix, 7, SystemProgram.programId, false, false, "deposit");
  requireKey(ix, 8, TOKEN_2022_PROGRAM_ID, false, false, "deposit");
  requireKey(ix, 9, identities.realmConfig, false, true, "deposit");
  requireKey(ix, 10, identities.ichorMint, false, false, "deposit");
}

/**
 * Validate exact builder outputs into a branded group object. External callers
 * cannot forge this type: only this function issues it, and assemble refuses
 * lookalikes. Arbitrary System/Token/program ixs between the four groups fail.
 */
export function validateDefensiveStakeGroups(params: {
  unpause: TransactionInstruction;
  convert: readonly TransactionInstruction[];
  deposit: readonly TransactionInstruction[];
  repause: TransactionInstruction;
  identities: DefensiveStakeGroupIdentities;
}): ValidatedDefensiveStakeGroups {
  const identities = freezeIdentities(params.identities);
  assertDefensiveStakeKekbullGovernance(identities.realmsProgramId);
  assertCanonicalAtas(identities);
  assertDerivedRealmPdas(identities);
  const unpause = cloneTransactionInstruction(params.unpause);
  const convert = cloneInstructionList(params.convert);
  const deposit = cloneInstructionList(params.deposit);
  const repause = cloneTransactionInstruction(params.repause);
  assertSetPausedGroup(unpause, identities, false, "unpause");
  assertConvertGroup(convert, identities);
  assertDepositGroup(deposit, identities);
  assertSetPausedGroup(repause, identities, true, "repause");
  const extraIchor = [...convert, ...deposit].filter(
    (ix) =>
      ix.programId.equals(identities.ichorProgramId) &&
      !isConvertIx(ix, identities.ichorProgramId),
  );
  if (extraIchor.length > 0) {
    throw new ClientValidationError("STAKE_GROUP", [
      "extra ICHOR program instruction is not allowed between unpause and re-pause",
    ]);
  }
  const deposits = deposit.filter((ix) =>
    isDepositGoverningTokensIx(ix, identities.realmsProgramId),
  );
  if (deposits.length !== 1) {
    throw new ClientValidationError("STAKE_GROUP", ["exactly one DepositGoverningTokens is required"]);
  }
  const groups = new IssuedValidatedDefensiveStakeGroups({
    unpause,
    convert,
    deposit,
    repause,
    identities,
  });
  issuedStakeGroups.add(groups);
  return groups;
}

function assertIssuedGroups(
  groups: ValidatedDefensiveStakeGroups,
): asserts groups is IssuedValidatedDefensiveStakeGroups {
  if (
    !issuedStakeGroups.has(groups) ||
    !(groups instanceof IssuedValidatedDefensiveStakeGroups)
  ) {
    throw new ClientValidationError("STAKE_GROUP", [
      "fabricated defensive-stake groups; only validateDefensiveStakeGroups may issue this proof",
    ]);
  }
  assertDefensiveStakeKekbullGovernance(groups.identities.realmsProgramId);
  assertCanonicalAtas(groups.identities);
  assertDerivedRealmPdas(groups.identities);
  assertSetPausedGroup(groups.unpause, groups.identities, false, "unpause");
  assertConvertGroup(groups.convert, groups.identities);
  assertDepositGroup(groups.deposit, groups.identities);
  assertSetPausedGroup(groups.repause, groups.identities, true, "repause");
}

export function enumerateRequiredSigners(instructions: readonly TransactionInstruction[]): PublicKey[] {
  const seen = new Map<string, PublicKey>();
  for (const ix of instructions) {
    for (const key of ix.keys) {
      if (key.isSigner && !seen.has(key.pubkey.toBase58())) {
        seen.set(key.pubkey.toBase58(), key.pubkey);
      }
    }
  }
  return [...seen.values()];
}

export function enumerateAccountMetas(
  instructions: readonly TransactionInstruction[],
): DefensiveStakeAccountMeta[] {
  const out: DefensiveStakeAccountMeta[] = [];
  const seen = new Set<string>();
  let index = 0;
  for (const ix of instructions) {
    for (const key of ix.keys) {
      const id = key.pubkey.toBase58();
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push({
        pubkey: key.pubkey,
        isSigner: key.isSigner,
        isWritable: key.isWritable,
        firstAppearance: index,
      });
      index += 1;
    }
  }
  return out;
}

/**
 * Exact legacy packet size: one dummy 64-byte signature slot per required
 * signer and a well-formed non-default size-only blockhash. This ceremony
 * requires the fee payer to be the sole required signer, so the helper
 * cannot undercount a multi-signer packet. MEASURED_OFFLINE, not a chain
 * simulation, and never broadcast-ready.
 */
export function measureOfflineLegacyPacket(params: {
  feePayer: PublicKey;
  instructions: readonly TransactionInstruction[];
  blockhash?: string;
}): PacketSizeStatus {
  const blockhash = params.blockhash ?? OFFLINE_PACKET_BLOCKHASH;
  if (blockhash === "" || blockhash === PublicKey.default.toBase58()) {
    throw new ClientValidationError("PACKET_BLOCKHASH", [
      "offline packet measure requires a non-default size-only blockhash; it is not chain state",
    ]);
  }
  const signers = enumerateRequiredSigners(params.instructions);
  if (signers.length !== 1 || !signers[0]!.equals(params.feePayer)) {
    throw new ClientValidationError("EXTRA_SIGNER_REFUSED", [
      "offline packet measure requires the fee payer to be the sole required signer; this ceremony uses exactly one creator signature",
    ]);
  }
  const dummySignatureSlots = signers.length;
  const tx = new Transaction();
  tx.feePayer = params.feePayer;
  tx.recentBlockhash = blockhash;
  tx.add(...params.instructions);
  tx.signatures = signers.map((publicKey) => ({ publicKey, signature: Buffer.alloc(64) }));
  let packetBytes: number;
  try {
    packetBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("out of range") || msg.includes("1232") || msg.includes("too large")) {
      throw new ClientValidationError("PACKET_TOO_LARGE", [
        `legacy serialize exceeded ${String(SOLANA_PACKET_DATA_SIZE)}: ${msg}`,
      ]);
    }
    throw err;
  }
  if (packetBytes > SOLANA_PACKET_DATA_SIZE) {
    throw new ClientValidationError("PACKET_TOO_LARGE", [
      `offline legacy packet ${String(packetBytes)} exceeds ${String(SOLANA_PACKET_DATA_SIZE)}; refuse to split into race transactions`,
    ]);
  }
  return {
    status: "MEASURED_OFFLINE",
    packetBytes,
    blockhash,
    dummySignatureSlots: dummySignatureSlots as 1,
  };
}

function computeBudgetPrefix(plan: DefensiveStakeComputePlan): TransactionInstruction[] {
  if (plan.kind === "none") {
    return [];
  }
  if (plan.kind === "protocol-max-for-simulation") {
    return [ComputeBudgetProgram.setComputeUnitLimit({ units: SOLANA_MAX_TX_COMPUTE_UNITS })];
  }
  if (
    !Number.isInteger(plan.unitsConsumed) ||
    plan.unitsConsumed <= 0 ||
    plan.unitsConsumed > SOLANA_MAX_TX_COMPUTE_UNITS
  ) {
    throw new ClientValidationError("COMPUTE_UNVERIFIED", [
      "measured unitsConsumed is missing or outside the protocol range",
    ]);
  }
  const expected = limitFromMeasured(plan.unitsConsumed);
  if (plan.computeUnitLimit !== expected) {
    throw new ClientValidationError("COMPUTE_UNVERIFIED", [
      "measured computeUnitLimit must be limitFromMeasured(unitsConsumed); do not invent a CU number",
    ]);
  }
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: plan.computeUnitLimit })];
}

function computeUnitsStatus(plan: DefensiveStakeComputePlan): ComputeUnitsStatus {
  if (plan.kind === "measured") {
    if (plan.computeUnitLimit !== limitFromMeasured(plan.unitsConsumed)) {
      throw new ClientValidationError("COMPUTE_UNVERIFIED", [
        "measured computeUnitLimit must be limitFromMeasured(unitsConsumed); do not invent a CU number",
      ]);
    }
    return {
      status: "MEASURED",
      unitsConsumed: plan.unitsConsumed,
      computeUnitLimit: plan.computeUnitLimit,
    };
  }
  return {
    status: "UNVERIFIED",
    reason:
      plan.kind === "protocol-max-for-simulation"
        ? "simulation plan uses the protocol max; CU stays UNVERIFIED until exact on-cluster simulation"
        : "ComputeBudget is omitted until exact on-cluster simulation; CU is UNVERIFIED. Packet size is MEASURED_OFFLINE separately",
  };
}

export function assembleValidatedDefensiveStakeMessage(params: {
  groups: ValidatedDefensiveStakeGroups;
  computePlan: DefensiveStakeComputePlan;
}): {
  instructions: TransactionInstruction[];
  requiredSignerPubkeys: PublicKey[];
  accountMetas: DefensiveStakeAccountMeta[];
  packet: PacketSizeStatus;
  computeUnits: ComputeUnitsStatus;
} {
  assertIssuedGroups(params.groups);
  const creator = params.groups.identities.creator;
  const prefix = computeBudgetPrefix(params.computePlan).map(cloneTransactionInstruction);
  const clonedGroups = {
    unpause: cloneTransactionInstruction(params.groups.unpause),
    convert: cloneInstructionList(params.groups.convert),
    deposit: cloneInstructionList(params.groups.deposit),
    repause: cloneTransactionInstruction(params.groups.repause),
  };
  assertSetPausedGroup(clonedGroups.unpause, params.groups.identities, false, "unpause");
  assertConvertGroup(clonedGroups.convert, params.groups.identities);
  assertDepositGroup(clonedGroups.deposit, params.groups.identities);
  assertSetPausedGroup(clonedGroups.repause, params.groups.identities, true, "repause");
  const instructions = [
    ...prefix,
    clonedGroups.unpause,
    ...clonedGroups.convert,
    ...clonedGroups.deposit,
    clonedGroups.repause,
  ];
  const signers = enumerateRequiredSigners(instructions);
  if (signers.length !== 1 || !signers[0]!.equals(creator)) {
    throw new ClientValidationError("EXTRA_SIGNER_REFUSED", [
      `creator must be the sole signer; got [${signers.map((s) => s.toBase58()).join(",")}]`,
    ]);
  }
  const packet = measureOfflineLegacyPacket({
    feePayer: creator,
    instructions,
  });
  return {
    instructions,
    requiredSignerPubkeys: signers,
    accountMetas: enumerateAccountMetas(instructions),
    packet,
    computeUnits: computeUnitsStatus(params.computePlan),
  };
}

/**
 * Dedicated atomic composer. Fetches/verifies issued proofs and live
 * Config/Realm/Governance/mint/curve/ATA identities before encoding.
 * Amount has no default. Re-pause is mandatory.
 */
export async function buildAtomicDefensiveStake(
  params: BuildAtomicDefensiveStakeParams,
): Promise<AtomicDefensiveStakeBuild> {
  assertNoExtraSignerMaterial(params, "buildAtomicDefensiveStake");
  assertVerifiedIchorConfig(params.verifiedConfig);
  assertVerifiedRealm(params.verifiedRealm);
  assertVerifiedGovernanceIdentity(params.verifiedGovernanceIdentity);
  assertBoundConnection(params.verifiedConfig.verifiedProgram.verified, params.connection);
  assertBoundConnection(params.verifiedRealm.verified, params.connection);
  if (params.verifiedRealm.verified !== params.verifiedConfig.verifiedProgram.verified) {
    throw new ClientValidationError("CONNECTION_MISMATCH", [
      "verified Realm and ICHOR config are not bound to the same issued network proof",
    ]);
  }
  if (params.verifiedGovernanceIdentity.verifiedRealm !== params.verifiedRealm) {
    throw new ClientValidationError("GOVERNANCE_REALM", [
      "verified Governance identity is not bound to the issued Realm",
    ]);
  }

  const verified = params.verifiedConfig.verifiedProgram.verified;
  assertOfficialIchorCluster({
    cluster: verified.network.cluster,
    genesisHash: verified.genesisHash,
  });
  const creator = requirePublicKey(params.creator, "creator");
  const config = params.verifiedConfig.config;
  assertDefensiveStakeIdentities({
    creator,
    configAuthority: config.authority,
    configRealm: config.realmsRealm,
    configGovernance: config.realmsGovernance,
    configRealmsProgram: config.realmsProgram,
    configIchorMint: config.ichorMint,
    configPaused: config.paused,
    realm: params.verifiedRealm.realm,
    governance: params.verifiedGovernanceIdentity.governance,
    communityMint: params.verifiedRealm.communityMint,
    realmsProgramId: verified.network.realmsProgramId,
    cluster: verified.network.cluster,
  });

  const kekbullMint = await fetchMintSnapshot(params.connection, verified.network, config.kekbullMint);
  const kekbullAmount = parseExplicitTokenAmount(params.amount, kekbullMint.decimals, "amount");
  const ichorMint = await fetchMintSnapshot(params.connection, verified.network, config.ichorMint);
  const expectedIchorGross = ichorFromKekbull({
    kekbullAmount,
    kekbullDecimals: kekbullMint.decimals,
    ichorDecimals: ichorMint.decimals,
    numerator: config.emissionNumerator,
    denominator: config.emissionDenominator,
  });

  const unpause = await buildSetPaused({
    connection: params.connection,
    verifiedConfig: params.verifiedConfig,
    authority: creator,
    paused: false,
  });
  if (unpause.instructions.length !== 1) {
    throw new ClientValidationError("STAKE_ORDER", [
      `set_paused(false) produced ${String(unpause.instructions.length)} instructions`,
    ]);
  }

  const convert = await composeConvertInstructionsFromIssuedConfig({
    connection: params.connection,
    verifiedConfig: params.verifiedConfig,
    burner: creator,
    recipient: creator,
    kekbullAmount,
    minIchorAmount: expectedIchorGross,
  });
  if (!convert.expectedIchorAmount.eq(expectedIchorGross)) {
    throw new ClientValidationError("CONVERT_AMOUNT", [
      `composer expected ${expectedIchorGross.toString(10)} ICHOR but convert computed ${convert.expectedIchorAmount.toString(10)}`,
    ]);
  }

  const deposit = await buildDepositIchorVotes({
    connection: params.connection,
    verifiedRealm: params.verifiedRealm,
    tokenSourceAccount: convert.ichorTo,
    tokenOwner: creator,
    sourceAuthority: creator,
    payer: creator,
    amount: expectedIchorGross,
  });

  const repause = await buildSetPaused({
    connection: params.connection,
    verifiedConfig: params.verifiedConfig,
    authority: creator,
    paused: true,
  });
  if (repause.instructions.length !== 1) {
    throw new ClientValidationError("STAKE_ORDER", [
      `set_paused(true) produced ${String(repause.instructions.length)} instructions`,
    ]);
  }

  const realm = params.verifiedRealm.realm;
  const tokenOwnerRecord = requirePublicKey(
    deposit.derivedAddresses.tokenOwnerRecord,
    "tokenOwnerRecord",
  );
  const realmConfig = requirePublicKey(deposit.derivedAddresses.realmConfig, "realmConfig");
  const expectedTor = await getTokenOwnerRecordAddress(
    verified.network.realmsProgramId,
    realm,
    convert.ichorMint.mint,
    creator,
  );
  const expectedRealmConfig = await getRealmConfigAddress(verified.network.realmsProgramId, realm);
  const governingTokenHolding = await getTokenHoldingAddress(
    verified.network.realmsProgramId,
    realm,
    convert.ichorMint.mint,
  );
  if (!tokenOwnerRecord.equals(expectedTor)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "builder TokenOwnerRecord is not the canonical PDA",
    ]);
  }
  if (!realmConfig.equals(expectedRealmConfig)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "builder RealmConfig is not the canonical PDA",
    ]);
  }
  const expectedKekbullFrom = getAssociatedTokenAddressSync(
    convert.kekbullMint.mint,
    creator,
    false,
    convert.kekbullMint.ownerProgram,
  );
  const expectedIchorTo = getAssociatedTokenAddressSync(
    convert.ichorMint.mint,
    creator,
    true,
    convert.ichorMint.ownerProgram,
  );
  if (!convert.kekbullFrom.equals(expectedKekbullFrom) || !convert.ichorTo.equals(expectedIchorTo)) {
    throw new ClientValidationError("STAKE_GROUP", [
      "convert ATAs are not the canonical creator accounts",
    ]);
  }

  const groups = validateDefensiveStakeGroups({
    unpause: unpause.instructions[0]!,
    convert: convert.unsigned.instructions,
    deposit: deposit.instructions,
    repause: repause.instructions[0]!,
    identities: {
      creator,
      ichorProgramId: params.verifiedConfig.verifiedProgram.programId,
      realmsProgramId: verified.network.realmsProgramId,
      config: config.config,
      kekbullMint: convert.kekbullMint.mint,
      ichorMint: convert.ichorMint.mint,
      kekbullFrom: convert.kekbullFrom,
      ichorTo: convert.ichorTo,
      bondingCurve: convert.bondingCurve.address,
      kekbullTokenProgram: convert.kekbullMint.ownerProgram,
      ichorTokenProgram: convert.ichorMint.ownerProgram,
      realm,
      governingTokenHolding,
      tokenOwnerRecord,
      realmConfig,
      kekbullAmount: kekbullAmount.toString(10),
      expectedIchorGross: expectedIchorGross.toString(10),
    },
  });
  const assembled = assembleValidatedDefensiveStakeMessage({
    groups,
    computePlan: params.computePlan,
  });
  const returnedInstructions = cloneInstructionList(assembled.instructions);
  const unsignedInstructions = cloneInstructionList(assembled.instructions);
  const tx = new Transaction();
  tx.feePayer = creator;
  tx.add(...cloneInstructionList(assembled.instructions));

  return {
    unsigned: {
      transaction: tx,
      instructions: unsignedInstructions,
      requiredSignerPubkeys: assembled.requiredSignerPubkeys,
    },
    instructions: returnedInstructions,
    requiredSignerPubkeys: assembled.requiredSignerPubkeys,
    accountMetas: assembled.accountMetas,
    packet: assembled.packet,
    packetBytes: assembled.packet.packetBytes,
    fitsPacket: true,
    computeUnits: assembled.computeUnits,
    sendImplemented: false,
    depositAmountSemantics: "gross",
    kekbullAmount,
    expectedIchorGross,
    expectedMintFee: deposit.transfer.expectedMintFee,
    expectedTorNet: deposit.transfer.expectedNet,
    conversionRatio: {
      numerator: config.emissionNumerator,
      denominator: config.emissionDenominator,
    },
    kekbullFrom: convert.kekbullFrom,
    ichorTo: convert.ichorTo,
    tokenOwnerRecord: requirePublicKey(
      deposit.derivedAddresses.tokenOwnerRecord,
      "tokenOwnerRecord",
    ),
    groups: ["unpause", "convert", "deposit", "repause"],
  };
}

/**
 * Fetch-and-verify path: official genesis, ICHOR program/config, Realm,
 * Governance, then the atomic composer. Still unsigned. Send stays false.
 */
export async function verifyAndBuildAtomicDefensiveStake(
  params: VerifyAndBuildAtomicDefensiveStakeParams,
): Promise<AtomicDefensiveStakeBuild> {
  assertNoExtraSignerMaterial(params, "verifyAndBuildAtomicDefensiveStake");
  if (params.network.cluster !== "mainnet-beta" && params.network.cluster !== "devnet") {
    throw new ClientValidationError("CLUSTER_REFUSED", [
      "verifyAndBuildAtomicDefensiveStake requires mainnet-beta or official-devnet",
    ]);
  }
  const verified = await verifyNetworkDeployment(params.connection, params.network);
  assertOfficialIchorCluster({
    cluster: verified.network.cluster,
    genesisHash: verified.genesisHash,
  });
  const program = await verifyIchorProgramDeployment(
    params.connection,
    verified,
    params.ichorProgramId,
  );
  const verifiedConfig = await verifyIchorConfigDeployment(params.connection, program);
  const verifiedRealm = await verifyRealmDeployment(
    params.connection,
    verified,
    params.realm,
    verifiedConfig.config.ichorMint,
  );
  const verifiedGovernanceIdentity = await verifyGovernanceIdentity(
    params.connection,
    verifiedRealm,
    params.governance,
  );
  return buildAtomicDefensiveStake({
    connection: params.connection,
    verifiedConfig,
    verifiedRealm,
    verifiedGovernanceIdentity,
    creator: params.creator,
    amount: params.amount,
    computePlan: params.computePlan,
  });
}
