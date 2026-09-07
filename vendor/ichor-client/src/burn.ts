import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
  type Connection,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  parseIchorTransferFeeConfig,
  requireIchorTransferFeeConfig,
} from "./extensions.ts";
import { fetchMintSnapshot, resolveAccountReadCommitment } from "./mint.ts";
import {
  BPF_LOADER_UPGRADEABLE,
  METEORA_CP_AMM,
  NATIVE_MINT,
  REALMS_INSTANCES,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "./network.ts";
import { assertBoundConnection, assertVerifiedNetwork } from "./preflight.ts";
import type {
  AccountReadCommitment,
  BondingCurveSnapshot,
  BuildConvertParams,
  BuildInitializeParams,
  ConvertBuild,
  IchorConfigSnapshot,
  InitializeBuild,
  MintSnapshot,
  ProgramDeploymentProof,
  UnsignedTransactionBuild,
  VerifiedIchorConfig,
  VerifiedIchorProgram,
  VerifiedNetwork,
} from "./types.ts";
import { ClientValidationError } from "./types.ts";
import {
  assertIchorIsToken2022,
  assertKekbullIsToken2022,
  assertMintSnapshot,
  assertNoSecretMaterial,
  ichorFromKekbull,
  requireConfiguredDeploymentAddress,
  requirePositiveBn,
  requirePublicKey,
  requireU64Bn,
  U64_MAX,
} from "./validation.ts";

/** Official pump.fun program. Same ID and bytecode on devnet and mainnet. */
export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const utf8 = new TextEncoder();

/** PDA seed for the single Config account. ICHOR mint authority is this PDA. */
export const CONFIG_SEED = utf8.encode("config");

/** PDA seed for the withdraw-withheld authority. Distinct from Config. */
export const WITHDRAW_WITHHELD_SEED = utf8.encode("withdraw-withheld");

/** PDA seed for the creator-fee escrow authority. Distinct from Config and withdraw-withheld. */
export const CREATOR_ESCROW_SEED = utf8.encode("creator-escrow");

/** Pump bonding-curve PDA seed. Matches `src/pumpfun/program.rs`. */
export const BONDING_CURVE_SEED = utf8.encode("bonding-curve");

/** Anchor `BondingCurve` discriminator from `docs/idl/pump.json`. */
export const BONDING_CURVE_DISCRIMINATOR = new Uint8Array([23, 183, 248, 55, 96, 216, 172, 96]);

/**
 * Anchor 0.32 sighash: first 8 bytes of sha256("global:convert").
 * Pinned so this module stays browser-safe. Tests recompute the hash.
 */
export const CONVERT_DISCRIMINATOR = new Uint8Array([0x7a, 0x50, 0xd4, 0xd0, 0x5c, 0xc8, 0x22, 0xa1]);

/** First 8 bytes of sha256("global:initialize"). */
export const INITIALIZE_DISCRIMINATOR = new Uint8Array([0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed]);

/** First 8 bytes of sha256("account:Config"). */
export const CONFIG_ACCOUNT_DISCRIMINATOR = new Uint8Array([0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82]);

const BONDING_CURVE_CORE_LEN = 81;
const CURVE_OFF_VIRTUAL_TOKEN_RESERVES = 8;
const CURVE_OFF_VIRTUAL_QUOTE_RESERVES = 16;
const CURVE_OFF_REAL_TOKEN_RESERVES = 24;
const CURVE_OFF_REAL_QUOTE_RESERVES = 32;
const CURVE_OFF_TOKEN_TOTAL_SUPPLY = 40;
const CURVE_OFF_COMPLETE = 48;
const CURVE_OFF_CREATOR = 49;

const TOKEN_ACCOUNT_BASE_LEN = 165;
const TOKEN_ACCOUNT_OFF_MINT = 0;
const TOKEN_ACCOUNT_OFF_OWNER = 32;
const TOKEN_ACCOUNT_OFF_AMOUNT = 64;
const TOKEN_ACCOUNT_OFF_STATE = 108;
const TOKEN_ACCOUNT_STATE_INITIALIZED = 1;
const TOKEN_ACCOUNT_STATE_FROZEN = 2;

const LOADER_STATE_BUFFER = 1;
const LOADER_STATE_PROGRAM = 2;
const LOADER_STATE_PROGRAM_DATA = 3;
/** Loader buffer, authority None: u32 disc + Option tag. */
const MIN_BUFFER_NONE_LEN = 5;
/** Loader buffer, authority Some: u32 disc + Option tag + pubkey. */
const MIN_BUFFER_SOME_LEN = 37;
const MIN_PROGRAM_ACCOUNT_LEN = 36;
const MIN_PROGRAMDATA_NONE_LEN = 13;
const MIN_PROGRAMDATA_SOME_LEN = 45;
const OPTION_NONE = 0;
const OPTION_SOME = 1;

const issuedIchorProgramProofs = new WeakSet<object>();
const issuedIchorConfigProofs = new WeakSet<object>();

function reservedIchorProgramIds(): PublicKey[] {
  return [
    PublicKey.default,
    SystemProgram.programId,
    new PublicKey(TOKEN_PROGRAM.id),
    new PublicKey(TOKEN_2022_PROGRAM.id),
    new PublicKey(NATIVE_MINT.id),
    new PublicKey(BPF_LOADER_UPGRADEABLE.id),
    new PublicKey(METEORA_CP_AMM.id),
    ...Object.values(REALMS_INSTANCES).map((instance) => new PublicKey(instance.id)),
    PUMP_PROGRAM,
  ];
}

function asUint8(data: ArrayLike<number>): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

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

function samePubkey(a: PublicKey | null, b: PublicKey | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.equals(b);
}

function pubkeyBytes(key: PublicKey): Uint8Array {
  return Uint8Array.from(key.toBytes());
}

function requireLen(data: Uint8Array, need: number, label: string): void {
  if (data.length < need) {
    throw new ClientValidationError("ACCOUNT_LAYOUT", [`${label} is truncated`]);
  }
}

function u64LeBytes(value: BN, label: string): Uint8Array {
  const amount = requireU64Bn(value, label);
  return Uint8Array.from(amount.toArray("le", 8));
}

function encodeIx(discriminator: Uint8Array, args: readonly { value: BN; label: string }[]): Uint8Array {
  return concatBytes(discriminator, ...args.map((arg) => u64LeBytes(arg.value, arg.label)));
}

export function encodeConvertInstructionData(kekbullAmount: BN, minIchorAmount: BN): Uint8Array {
  return encodeIx(CONVERT_DISCRIMINATOR, [
    { value: kekbullAmount, label: "kekbull_amount" },
    { value: minIchorAmount, label: "min_ichor_amount" },
  ]);
}

export function encodeInitializeInstructionData(
  emissionNumerator: BN,
  emissionDenominator: BN,
  ratioTimelockSecs: BN,
  creatorDecaySecs: BN,
): Uint8Array {
  return encodeIx(INITIALIZE_DISCRIMINATOR, [
    { value: emissionNumerator, label: "emission_numerator" },
    { value: emissionDenominator, label: "emission_denominator" },
    { value: ratioTimelockSecs, label: "ratio_timelock_secs" },
    { value: creatorDecaySecs, label: "creator_decay_secs" },
  ]);
}

export function configPda(programId: PublicKey): { address: PublicKey; bump: number } {
  const [address, bump] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
  return { address, bump };
}

export function withdrawWithheldPda(programId: PublicKey): { address: PublicKey; bump: number } {
  const [address, bump] = PublicKey.findProgramAddressSync([WITHDRAW_WITHHELD_SEED], programId);
  return { address, bump };
}

export function creatorEscrowPda(programId: PublicKey): { address: PublicKey; bump: number } {
  const [address, bump] = PublicKey.findProgramAddressSync([CREATOR_ESCROW_SEED], programId);
  return { address, bump };
}

export function bondingCurvePda(kekbullMint: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [BONDING_CURVE_SEED, pubkeyBytes(kekbullMint)],
    PUMP_PROGRAM,
  );
  return address;
}

export function programDataPda(programId: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [pubkeyBytes(programId)],
    new PublicKey(BPF_LOADER_UPGRADEABLE.id),
  );
  return address;
}

function readPubkey(data: Uint8Array, offset: number, label: string): PublicKey {
  requireLen(data, offset + 32, label);
  return new PublicKey(data.subarray(offset, offset + 32));
}

function readU32(data: Uint8Array, offset: number, label: string): number {
  requireLen(data, offset + 4, label);
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

function readU64(data: Uint8Array, offset: number, label: string): BN {
  requireLen(data, offset + 8, label);
  return new BN(Array.from(data.subarray(offset, offset + 8)), "le");
}

function readI64(data: Uint8Array, offset: number, label: string): BN {
  requireLen(data, offset + 8, label);
  return new BN(Array.from(data.subarray(offset, offset + 8)), "le").fromTwos(64);
}

function readBool(data: Uint8Array, offset: number, label: string): boolean {
  if (data.length <= offset) {
    throw new ClientValidationError("ACCOUNT_LAYOUT", [`${label} is truncated`]);
  }
  const byte = data[offset];
  if (byte === 0) return false;
  if (byte === 1) return true;
  throw new ClientValidationError("INVALID_BOOL", [`${label} is ${String(byte)}, not 0 or 1`]);
}

function readOptionPubkey(
  data: Uint8Array,
  offset: number,
  label: string,
): { value: PublicKey | null; next: number } {
  if (data.length <= offset) {
    throw new ClientValidationError("ACCOUNT_LAYOUT", [`${label} is truncated`]);
  }
  const tag = data[offset];
  if (tag === 0) {
    return { value: null, next: offset + 1 };
  }
  if (tag === 1) {
    return { value: readPubkey(data, offset + 1, label), next: offset + 33 };
  }
  throw new ClientValidationError("INVALID_BOOL", [`${label} option tag is ${String(tag)}`]);
}

export function parseIchorConfigAccount(params: {
  programId: PublicKey;
  config: PublicKey;
  owner: PublicKey;
  data: Uint8Array;
}): IchorConfigSnapshot {
  if (!params.owner.equals(params.programId)) {
    throw new ClientValidationError("CONFIG_OWNER", [
      `config owner ${params.owner.toBase58()} is not program ${params.programId.toBase58()}`,
    ]);
  }
  if (params.data.length < 8 || !bytesEqual(params.data.subarray(0, 8), CONFIG_ACCOUNT_DISCRIMINATOR)) {
    throw new ClientValidationError("CONFIG_DISCRIMINATOR", [
      "config account discriminator is not account:Config",
    ]);
  }

  let o = 8;
  const authority = readPubkey(params.data, o, "config.authority");
  o += 32;
  const pending = readOptionPubkey(params.data, o, "config.pending_authority");
  o = pending.next;
  const kekbullMint = readPubkey(params.data, o, "config.kekbull_mint");
  o += 32;
  const ichorMint = readPubkey(params.data, o, "config.ichor_mint");
  o += 32;
  const kekbullTokenProgram = readPubkey(params.data, o, "config.kekbull_token_program");
  o += 32;
  const ichorTokenProgram = readPubkey(params.data, o, "config.ichor_token_program");
  o += 32;
  const pumpProgram = readPubkey(params.data, o, "config.pump_program");
  o += 32;
  const bondingCurve = readPubkey(params.data, o, "config.bonding_curve");
  o += 32;
  const emissionNumerator = readU64(params.data, o, "config.emission_numerator");
  o += 8;
  const emissionDenominator = readU64(params.data, o, "config.emission_denominator");
  o += 8;
  const pendingEmissionNumerator = readU64(params.data, o, "config.pending_emission_numerator");
  o += 8;
  const pendingEmissionDenominator = readU64(params.data, o, "config.pending_emission_denominator");
  o += 8;
  const pendingRatioUnlockTs = readI64(params.data, o, "config.pending_ratio_unlock_ts");
  o += 8;
  const ratioTimelockSecs = readU64(params.data, o, "config.ratio_timelock_secs");
  o += 8;
  const paused = readBool(params.data, o, "config.paused");
  o += 1;
  const ratioUpdatesFrozen = readBool(params.data, o, "config.ratio_updates_frozen");
  o += 1;
  const hasPendingRatio = readBool(params.data, o, "config.has_pending_ratio");
  o += 1;
  const totalKekbullBurned = readU64(params.data, o, "config.total_kekbull_burned");
  o += 8;
  const totalIchorMinted = readU64(params.data, o, "config.total_ichor_minted");
  o += 8;
  const creatorBeneficiary = readOptionPubkey(params.data, o, "config.creator_beneficiary");
  o = creatorBeneficiary.next;
  const realmsProgram = readOptionPubkey(params.data, o, "config.realms_program");
  o = realmsProgram.next;
  const realmsRealm = readOptionPubkey(params.data, o, "config.realms_realm");
  o = realmsRealm.next;
  const realmsGovernance = readOptionPubkey(params.data, o, "config.realms_governance");
  o = realmsGovernance.next;
  const realmsNativeTreasury = readOptionPubkey(params.data, o, "config.realms_native_treasury");
  o = realmsNativeTreasury.next;
  const feeBeneficiariesBound = readBool(params.data, o, "config.fee_beneficiaries_bound");
  o += 1;
  const transferFeeAuthorityRevoked = readBool(params.data, o, "config.transfer_fee_authority_revoked");
  o += 1;
  if (params.data.length <= o) {
    throw new ClientValidationError("ACCOUNT_LAYOUT", ["config.withdraw_withheld_bump is truncated"]);
  }
  const withdrawWithheldBump = params.data[o];
  o += 1;
  const totalFeesWithdrawn = readU64(params.data, o, "config.total_fees_withdrawn");
  o += 8;
  const totalFeesToCreator = readU64(params.data, o, "config.total_fees_to_creator");
  o += 8;
  const totalFeesToRealms = readU64(params.data, o, "config.total_fees_to_realms");
  o += 8;
  if (params.data.length <= o) {
    throw new ClientValidationError("ACCOUNT_LAYOUT", ["config.creator_escrow_bump is truncated"]);
  }
  const creatorEscrowBump = params.data[o];
  o += 1;
  const lastCreatorClaimTs = readI64(params.data, o, "config.last_creator_claim_ts");
  o += 8;
  const creatorDecaySecs = readU64(params.data, o, "config.creator_decay_secs");
  o += 8;
  const totalCreatorClaimed = readU64(params.data, o, "config.total_creator_claimed");
  o += 8;
  const totalCreatorSwept = readU64(params.data, o, "config.total_creator_swept");
  o += 8;
  if (params.data.length <= o) {
    throw new ClientValidationError("ACCOUNT_LAYOUT", ["config.bump is truncated"]);
  }
  const bump = params.data[o];
  o += 1;
  if (params.data.length < o + 32) {
    throw new ClientValidationError("ACCOUNT_LAYOUT", ["config.reserved is truncated"]);
  }
  const derivedWithdraw = withdrawWithheldPda(params.programId);
  if (withdrawWithheldBump !== derivedWithdraw.bump) {
    throw new ClientValidationError("WITHDRAW_WITHHELD_PDA", [
      `config.withdraw_withheld_bump ${String(withdrawWithheldBump)} is not seeds=["withdraw-withheld"] for ${params.programId.toBase58()}`,
    ]);
  }
  const derivedEscrow = creatorEscrowPda(params.programId);
  if (creatorEscrowBump !== derivedEscrow.bump) {
    throw new ClientValidationError("CREATOR_ESCROW_PDA", [
      `config.creator_escrow_bump ${String(creatorEscrowBump)} is not seeds=["creator-escrow"] for ${params.programId.toBase58()}`,
    ]);
  }
  if (creatorDecaySecs.isZero()) {
    throw new ClientValidationError("CREATOR_DECAY_ZERO", [
      "config.creator_decay_secs is zero; initialize requires a positive decay",
    ]);
  }

  const derived = configPda(params.programId);
  if (!params.config.equals(derived.address) || bump !== derived.bump) {
    throw new ClientValidationError("CONFIG_PDA", [
      `config ${params.config.toBase58()} bump ${String(bump)} is not seeds=["config"] for ${params.programId.toBase58()}`,
    ]);
  }
  if (kekbullMint.equals(ichorMint)) {
    throw new ClientValidationError("MINTS_MUST_DIFFER", ["config KEKBULL and ICHOR mints are identical"]);
  }
  if (!kekbullTokenProgram.equals(new PublicKey(TOKEN_2022_PROGRAM.id))) {
    throw new ClientValidationError("INVALID_TOKEN_PROGRAM", [
      `config.kekbull_token_program ${kekbullTokenProgram.toBase58()} is not Token-2022`,
    ]);
  }
  if (!ichorTokenProgram.equals(new PublicKey(TOKEN_2022_PROGRAM.id))) {
    throw new ClientValidationError("INVALID_TOKEN_PROGRAM", [
      `config.ichor_token_program ${ichorTokenProgram.toBase58()} is not Token-2022`,
    ]);
  }
  if (!pumpProgram.equals(PUMP_PROGRAM)) {
    throw new ClientValidationError("PUMP_PROGRAM", [
      `config.pump_program ${pumpProgram.toBase58()} is not the official pump.fun program`,
    ]);
  }
  const canonicalCurve = bondingCurvePda(kekbullMint);
  if (!bondingCurve.equals(canonicalCurve)) {
    throw new ClientValidationError("INVALID_BONDING_CURVE_ADDRESS", [
      `config.bonding_curve ${bondingCurve.toBase58()} is not the canonical PDA for ${kekbullMint.toBase58()}`,
    ]);
  }
  if (emissionNumerator.isZero() || emissionDenominator.isZero()) {
    throw new ClientValidationError("ZERO_RATIO", ["config emission numerator/denominator is zero"]);
  }
  if (emissionNumerator.gt(emissionDenominator)) {
    throw new ClientValidationError("RATIO_ABOVE_CEILING", [
      "config emission ratio exceeds the 1:1 human-unit ceiling",
    ]);
  }

  return {
    programId: params.programId,
    config: params.config,
    authority,
    pendingAuthority: pending.value,
    kekbullMint,
    ichorMint,
    kekbullTokenProgram,
    ichorTokenProgram,
    pumpProgram,
    bondingCurve,
    emissionNumerator,
    emissionDenominator,
    pendingEmissionNumerator,
    pendingEmissionDenominator,
    pendingRatioUnlockTs,
    ratioTimelockSecs,
    paused,
    ratioUpdatesFrozen,
    hasPendingRatio,
    totalKekbullBurned,
    totalIchorMinted,
    creatorBeneficiary: creatorBeneficiary.value,
    realmsProgram: realmsProgram.value,
    realmsRealm: realmsRealm.value,
    realmsGovernance: realmsGovernance.value,
    realmsNativeTreasury: realmsNativeTreasury.value,
    feeBeneficiariesBound,
    transferFeeAuthorityRevoked,
    withdrawWithheldBump,
    totalFeesWithdrawn,
    totalFeesToCreator,
    totalFeesToRealms,
    creatorEscrowBump,
    lastCreatorClaimTs,
    creatorDecaySecs,
    totalCreatorClaimed,
    totalCreatorSwept,
    bump,
  };
}

export function parseBondingCurveAccount(params: {
  address: PublicKey;
  owner: PublicKey;
  data: Uint8Array;
  expectedMint: PublicKey;
  expectedAddress?: PublicKey;
}): BondingCurveSnapshot {
  const canonical = bondingCurvePda(params.expectedMint);
  if (!params.address.equals(canonical)) {
    throw new ClientValidationError("INVALID_BONDING_CURVE_ADDRESS", [
      `bonding-curve ${params.address.toBase58()} is not seeds=["bonding-curve", mint] on pump.fun`,
    ]);
  }
  if (params.expectedAddress !== undefined && !params.address.equals(params.expectedAddress)) {
    throw new ClientValidationError("INVALID_BONDING_CURVE_ADDRESS", [
      `bonding-curve ${params.address.toBase58()} does not match the stored config PDA`,
    ]);
  }
  if (!params.owner.equals(PUMP_PROGRAM)) {
    throw new ClientValidationError("INVALID_BONDING_CURVE_OWNER", [
      `bonding-curve owner ${params.owner.toBase58()} is not pump.fun`,
    ]);
  }
  if (params.data.length < BONDING_CURVE_CORE_LEN) {
    throw new ClientValidationError("BONDING_CURVE_TOO_SHORT", [
      `bonding-curve is ${params.data.length} bytes; need the 81-byte core`,
    ]);
  }
  if (!bytesEqual(params.data.subarray(0, 8), BONDING_CURVE_DISCRIMINATOR)) {
    throw new ClientValidationError("INVALID_BONDING_CURVE_DISCRIMINATOR", [
      "bonding-curve discriminator is not the pump.fun BondingCurve account",
    ]);
  }
  return {
    address: params.address,
    owner: params.owner,
    virtualTokenReserves: readU64(params.data, CURVE_OFF_VIRTUAL_TOKEN_RESERVES, "virtual_token_reserves"),
    virtualQuoteReserves: readU64(params.data, CURVE_OFF_VIRTUAL_QUOTE_RESERVES, "virtual_quote_reserves"),
    realTokenReserves: readU64(params.data, CURVE_OFF_REAL_TOKEN_RESERVES, "real_token_reserves"),
    realQuoteReserves: readU64(params.data, CURVE_OFF_REAL_QUOTE_RESERVES, "real_quote_reserves"),
    tokenTotalSupply: readU64(params.data, CURVE_OFF_TOKEN_TOTAL_SUPPLY, "token_total_supply"),
    complete: readBool(params.data, CURVE_OFF_COMPLETE, "complete"),
    creator: readPubkey(params.data, CURVE_OFF_CREATOR, "creator"),
    dataLength: params.data.length,
  };
}

export function requireGraduatedCurve(curve: BondingCurveSnapshot): void {
  if (!curve.complete) {
    throw new ClientValidationError("CURVE_NOT_COMPLETE", [
      "bonding curve is not complete; conversion is post-graduation only",
    ]);
  }
  if (!curve.realTokenReserves.isZero()) {
    throw new ClientValidationError("CURVE_STILL_HAS_RESERVES", [
      `bonding curve still holds ${curve.realTokenReserves.toString()} real token reserves`,
    ]);
  }
}

function parseTokenAccount(params: {
  address: PublicKey;
  ownerProgram: PublicKey;
  data: Uint8Array;
  expectedMint: PublicKey;
  expectedOwner?: PublicKey;
  expectedTokenProgram: PublicKey;
  label: string;
}): { mint: PublicKey; owner: PublicKey; amount: BN } {
  if (!params.ownerProgram.equals(params.expectedTokenProgram)) {
    throw new ClientValidationError("INVALID_TOKEN_ACCOUNT_OWNER", [
      `${params.label} owner program ${params.ownerProgram.toBase58()} is not ${params.expectedTokenProgram.toBase58()}`,
    ]);
  }
  if (params.data.length < TOKEN_ACCOUNT_BASE_LEN) {
    throw new ClientValidationError("TOKEN_ACCOUNT_TOO_SHORT", [
      `${params.label} is ${params.data.length} bytes; need the 165-byte base layout`,
    ]);
  }
  const mint = readPubkey(params.data, TOKEN_ACCOUNT_OFF_MINT, `${params.label}.mint`);
  const owner = readPubkey(params.data, TOKEN_ACCOUNT_OFF_OWNER, `${params.label}.owner`);
  const amount = readU64(params.data, TOKEN_ACCOUNT_OFF_AMOUNT, `${params.label}.amount`);
  const state = params.data[TOKEN_ACCOUNT_OFF_STATE];
  if (!mint.equals(params.expectedMint)) {
    throw new ClientValidationError("TOKEN_ACCOUNT_MINT_MISMATCH", [
      `${params.label} mint ${mint.toBase58()} is not ${params.expectedMint.toBase58()}`,
    ]);
  }
  if (params.expectedOwner !== undefined && !owner.equals(params.expectedOwner)) {
    throw new ClientValidationError("TOKEN_ACCOUNT_OWNER_MISMATCH", [
      `${params.label} owner ${owner.toBase58()} is not ${params.expectedOwner.toBase58()}`,
    ]);
  }
  if (state === TOKEN_ACCOUNT_STATE_FROZEN) {
    throw new ClientValidationError("TOKEN_ACCOUNT_FROZEN", [`${params.label} is frozen`]);
  }
  if (state !== TOKEN_ACCOUNT_STATE_INITIALIZED) {
    throw new ClientValidationError("TOKEN_ACCOUNT_UNINITIALIZED", [`${params.label} is not initialized`]);
  }
  return { mint, owner, amount };
}

function requireIchorMintAuthority(ichor: MintSnapshot, config: PublicKey): void {
  if (ichor.mintAuthority === null || !ichor.mintAuthority.equals(config)) {
    throw new ClientValidationError("MINT_AUTHORITY_MISMATCH", [
      `ICHOR mint authority must be config PDA ${config.toBase58()}`,
    ]);
  }
  if (ichor.freezeAuthority !== null) {
    throw new ClientValidationError("FREEZE_AUTHORITY_SET", ["ICHOR freeze authority must be unset"]);
  }
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

function unsignedTx(
  feePayer: PublicKey,
  instructions: TransactionInstruction[],
  requiredSignerPubkeys: PublicKey[],
): UnsignedTransactionBuild {
  const transaction = new Transaction();
  transaction.feePayer = feePayer;
  transaction.add(...instructions);
  return { transaction, instructions, requiredSignerPubkeys };
}

class IssuedVerifiedIchorProgram implements VerifiedIchorProgram {
  readonly verified: VerifiedNetwork;
  readonly programId: PublicKey;
  readonly programData: PublicKey;
  readonly program: ProgramDeploymentProof;
  readonly upgradeAuthority: PublicKey | null;
  readonly deploymentSlot: BN;
  readonly #connection: Connection;
  readonly #verified: VerifiedNetwork;
  readonly #programId: PublicKey;
  readonly #programData: PublicKey;
  readonly #upgradeAuthority: PublicKey | null;
  readonly #deploymentSlot: BN;

  constructor(args: {
    verified: VerifiedNetwork;
    connection: Connection;
    programId: PublicKey;
    programData: PublicKey;
    program: ProgramDeploymentProof;
    upgradeAuthority: PublicKey | null;
    deploymentSlot: BN;
  }) {
    this.verified = args.verified;
    this.programId = args.programId;
    this.programData = args.programData;
    this.program = args.program;
    this.upgradeAuthority = args.upgradeAuthority;
    this.deploymentSlot = args.deploymentSlot;
    this.#connection = args.connection;
    this.#verified = args.verified;
    this.#programId = args.programId;
    this.#programData = args.programData;
    this.#upgradeAuthority = args.upgradeAuthority;
    this.#deploymentSlot = args.deploymentSlot.clone();
  }

  boundTo(connection: Connection, verified: VerifiedNetwork): boolean {
    return connection === this.#connection && verified === this.#verified;
  }

  matchesIssuedFields(): boolean {
    return (
      this.verified === this.#verified &&
      this.programId.equals(this.#programId) &&
      this.programData.equals(this.#programData) &&
      samePubkey(this.upgradeAuthority, this.#upgradeAuthority) &&
      this.deploymentSlot.eq(this.#deploymentSlot)
    );
  }
}

class IssuedVerifiedIchorConfig implements VerifiedIchorConfig {
  readonly verifiedProgram: VerifiedIchorProgram;
  readonly config: IchorConfigSnapshot;
  readonly #verifiedProgram: VerifiedIchorProgram;
  readonly #programId: PublicKey;
  readonly #config: PublicKey;
  readonly #authority: PublicKey;
  readonly #pendingAuthority: PublicKey | null;
  readonly #kekbullMint: PublicKey;
  readonly #ichorMint: PublicKey;
  readonly #kekbullTokenProgram: PublicKey;
  readonly #ichorTokenProgram: PublicKey;
  readonly #pumpProgram: PublicKey;
  readonly #bondingCurve: PublicKey;
  readonly #numerator: BN;
  readonly #denominator: BN;
  readonly #pendingNumerator: BN;
  readonly #pendingDenominator: BN;
  readonly #pendingUnlockTs: BN;
  readonly #ratioTimelockSecs: BN;
  readonly #paused: boolean;
  readonly #ratioUpdatesFrozen: boolean;
  readonly #hasPendingRatio: boolean;
  readonly #totalKekbullBurned: BN;
  readonly #totalIchorMinted: BN;
  readonly #creatorBeneficiary: PublicKey | null;
  readonly #realmsProgram: PublicKey | null;
  readonly #realmsRealm: PublicKey | null;
  readonly #realmsGovernance: PublicKey | null;
  readonly #realmsNativeTreasury: PublicKey | null;
  readonly #feeBeneficiariesBound: boolean;
  readonly #transferFeeAuthorityRevoked: boolean;
  readonly #withdrawWithheldBump: number;
  readonly #totalFeesWithdrawn: BN;
  readonly #totalFeesToCreator: BN;
  readonly #totalFeesToRealms: BN;
  readonly #creatorEscrowBump: number;
  readonly #lastCreatorClaimTs: BN;
  readonly #creatorDecaySecs: BN;
  readonly #totalCreatorClaimed: BN;
  readonly #totalCreatorSwept: BN;
  readonly #bump: number;

  constructor(args: { verifiedProgram: VerifiedIchorProgram; config: IchorConfigSnapshot }) {
    this.verifiedProgram = args.verifiedProgram;
    this.config = args.config;
    this.#verifiedProgram = args.verifiedProgram;
    this.#programId = args.config.programId;
    this.#config = args.config.config;
    this.#authority = args.config.authority;
    this.#pendingAuthority = args.config.pendingAuthority;
    this.#kekbullMint = args.config.kekbullMint;
    this.#ichorMint = args.config.ichorMint;
    this.#kekbullTokenProgram = args.config.kekbullTokenProgram;
    this.#ichorTokenProgram = args.config.ichorTokenProgram;
    this.#pumpProgram = args.config.pumpProgram;
    this.#bondingCurve = args.config.bondingCurve;
    this.#numerator = args.config.emissionNumerator.clone();
    this.#denominator = args.config.emissionDenominator.clone();
    this.#pendingNumerator = args.config.pendingEmissionNumerator.clone();
    this.#pendingDenominator = args.config.pendingEmissionDenominator.clone();
    this.#pendingUnlockTs = args.config.pendingRatioUnlockTs.clone();
    this.#ratioTimelockSecs = args.config.ratioTimelockSecs.clone();
    this.#paused = args.config.paused;
    this.#ratioUpdatesFrozen = args.config.ratioUpdatesFrozen;
    this.#hasPendingRatio = args.config.hasPendingRatio;
    this.#totalKekbullBurned = args.config.totalKekbullBurned.clone();
    this.#totalIchorMinted = args.config.totalIchorMinted.clone();
    this.#creatorBeneficiary = args.config.creatorBeneficiary;
    this.#realmsProgram = args.config.realmsProgram;
    this.#realmsRealm = args.config.realmsRealm;
    this.#realmsGovernance = args.config.realmsGovernance;
    this.#realmsNativeTreasury = args.config.realmsNativeTreasury;
    this.#feeBeneficiariesBound = args.config.feeBeneficiariesBound;
    this.#transferFeeAuthorityRevoked = args.config.transferFeeAuthorityRevoked;
    this.#withdrawWithheldBump = args.config.withdrawWithheldBump;
    this.#totalFeesWithdrawn = args.config.totalFeesWithdrawn.clone();
    this.#totalFeesToCreator = args.config.totalFeesToCreator.clone();
    this.#totalFeesToRealms = args.config.totalFeesToRealms.clone();
    this.#creatorEscrowBump = args.config.creatorEscrowBump;
    this.#lastCreatorClaimTs = args.config.lastCreatorClaimTs.clone();
    this.#creatorDecaySecs = args.config.creatorDecaySecs.clone();
    this.#totalCreatorClaimed = args.config.totalCreatorClaimed.clone();
    this.#totalCreatorSwept = args.config.totalCreatorSwept.clone();
    this.#bump = args.config.bump;
  }

  matchesIssuedFields(): boolean {
    return (
      this.verifiedProgram === this.#verifiedProgram &&
      this.config.programId.equals(this.#programId) &&
      this.config.config.equals(this.#config) &&
      this.config.authority.equals(this.#authority) &&
      samePubkey(this.config.pendingAuthority, this.#pendingAuthority) &&
      this.config.kekbullMint.equals(this.#kekbullMint) &&
      this.config.ichorMint.equals(this.#ichorMint) &&
      this.config.kekbullTokenProgram.equals(this.#kekbullTokenProgram) &&
      this.config.ichorTokenProgram.equals(this.#ichorTokenProgram) &&
      this.config.pumpProgram.equals(this.#pumpProgram) &&
      this.config.bondingCurve.equals(this.#bondingCurve) &&
      this.config.emissionNumerator.eq(this.#numerator) &&
      this.config.emissionDenominator.eq(this.#denominator) &&
      this.config.pendingEmissionNumerator.eq(this.#pendingNumerator) &&
      this.config.pendingEmissionDenominator.eq(this.#pendingDenominator) &&
      this.config.pendingRatioUnlockTs.eq(this.#pendingUnlockTs) &&
      this.config.ratioTimelockSecs.eq(this.#ratioTimelockSecs) &&
      this.config.paused === this.#paused &&
      this.config.ratioUpdatesFrozen === this.#ratioUpdatesFrozen &&
      this.config.hasPendingRatio === this.#hasPendingRatio &&
      this.config.totalKekbullBurned.eq(this.#totalKekbullBurned) &&
      this.config.totalIchorMinted.eq(this.#totalIchorMinted) &&
      samePubkey(this.config.creatorBeneficiary, this.#creatorBeneficiary) &&
      samePubkey(this.config.realmsProgram, this.#realmsProgram) &&
      samePubkey(this.config.realmsRealm, this.#realmsRealm) &&
      samePubkey(this.config.realmsGovernance, this.#realmsGovernance) &&
      samePubkey(this.config.realmsNativeTreasury, this.#realmsNativeTreasury) &&
      this.config.feeBeneficiariesBound === this.#feeBeneficiariesBound &&
      this.config.transferFeeAuthorityRevoked === this.#transferFeeAuthorityRevoked &&
      this.config.withdrawWithheldBump === this.#withdrawWithheldBump &&
      this.config.totalFeesWithdrawn.eq(this.#totalFeesWithdrawn) &&
      this.config.totalFeesToCreator.eq(this.#totalFeesToCreator) &&
      this.config.totalFeesToRealms.eq(this.#totalFeesToRealms) &&
      this.config.creatorEscrowBump === this.#creatorEscrowBump &&
      this.config.lastCreatorClaimTs.eq(this.#lastCreatorClaimTs) &&
      this.config.creatorDecaySecs.eq(this.#creatorDecaySecs) &&
      this.config.totalCreatorClaimed.eq(this.#totalCreatorClaimed) &&
      this.config.totalCreatorSwept.eq(this.#totalCreatorSwept) &&
      this.config.bump === this.#bump
    );
  }
}

function parseUpgradeableProgram(
  network: VerifiedNetwork,
  programId: PublicKey,
  info: {
    executable: boolean;
    owner: PublicKey;
    data: Uint8Array;
  },
): { programData: PublicKey; proof: ProgramDeploymentProof } {
  if (!info.executable) {
    throw new ClientValidationError("PROGRAM_NOT_EXECUTABLE", [
      `ICHOR program ${programId.toBase58()} exists but executable=false`,
    ]);
  }
  if (!info.owner.equals(new PublicKey(BPF_LOADER_UPGRADEABLE.id))) {
    throw new ClientValidationError("PROGRAM_LOADER_UNKNOWN", [
      `ICHOR program owner ${info.owner.toBase58()} is not the BPF upgradeable loader`,
    ]);
  }
  if (info.data.length < MIN_PROGRAM_ACCOUNT_LEN) {
    throw new ClientValidationError("INVALID_LOADER_STATE", [
      `ICHOR program account is ${info.data.length} bytes; need loader Program (36)`,
    ]);
  }
  const disc = readU32(info.data, 0, "program.discriminant");
  if (disc !== LOADER_STATE_PROGRAM) {
    throw new ClientValidationError("INVALID_LOADER_STATE", [
      `ICHOR program loader discriminant is ${String(disc)}, not Program(2)`,
    ]);
  }
  const embedded = readPubkey(info.data, 4, "program.programdata_address");
  const canonical = programDataPda(programId);
  if (!embedded.equals(canonical)) {
    throw new ClientValidationError("PROGRAM_DATA_MISMATCH", [
      `embedded ProgramData ${embedded.toBase58()} is not the loader PDA ${canonical.toBase58()}`,
    ]);
  }
  return {
    programData: canonical,
    proof: {
      cluster: network.network.cluster,
      programId,
      namedId: programId.toBase58(),
      executable: true,
      owner: info.owner,
      loaderId: BPF_LOADER_UPGRADEABLE.id,
      dataLength: info.data.length,
    },
  };
}

/**
 * Loader v3 ProgramData: u32 disc=3, u64 slot, Option tag 0/1, pubkey if Some.
 * Some requires 45 bytes. Tag values other than 0/1 are corrupt.
 */
export function parseUpgradeableProgramData(data: Uint8Array): {
  deploymentSlot: BN;
  upgradeAuthority: PublicKey | null;
} {
  if (data.length < MIN_PROGRAMDATA_NONE_LEN) {
    throw new ClientValidationError("INVALID_LOADER_STATE", [
      `ProgramData is ${data.length} bytes; need at least ${String(MIN_PROGRAMDATA_NONE_LEN)}`,
    ]);
  }
  const disc = readU32(data, 0, "programdata.discriminant");
  if (disc !== LOADER_STATE_PROGRAM_DATA) {
    throw new ClientValidationError("INVALID_LOADER_STATE", [
      `ProgramData discriminant is ${String(disc)}, not ProgramData(3)`,
    ]);
  }
  const deploymentSlot = readU64(data, 4, "programdata.slot");
  const tag = data[12];
  if (tag === OPTION_NONE) {
    return { deploymentSlot, upgradeAuthority: null };
  }
  if (tag === OPTION_SOME) {
    if (data.length < MIN_PROGRAMDATA_SOME_LEN) {
      throw new ClientValidationError("INVALID_LOADER_STATE", [
        `ProgramData Some is ${data.length} bytes; need ${String(MIN_PROGRAMDATA_SOME_LEN)}`,
      ]);
    }
    return {
      deploymentSlot,
      upgradeAuthority: readPubkey(data, 13, "programdata.upgrade_authority"),
    };
  }
  throw new ClientValidationError("INVALID_LOADER_STATE", [
    `ProgramData Option tag is ${String(tag)}; only 0 or 1 are valid`,
  ]);
}

/**
 * Loader v3 buffer state: u32 disc=1, Option tag 0/1, pubkey if Some.
 *
 * Read before staging a DAO upgrade. The loader lets a buffer's authority
 * `Write` fresh bytes and `SetAuthority` to anyone, so a buffer whose authority
 * is still the proposer can be rewritten between the vote passing and the
 * permissionless execute - the DAO approves one ELF and installs another.
 * Once the authority is the Governance PDA, `Write`, `SetAuthority` and `Close`
 * all require a Governance signature, which only another passed proposal
 * produces. That makes the bytes frozen on chain rather than by convention.
 *
 * buffer-freeze check.
 */
export function parseUpgradeableBuffer(data: Uint8Array): {
  authority: PublicKey | null;
} {
  if (data.length < MIN_BUFFER_NONE_LEN) {
    throw new ClientValidationError("INVALID_LOADER_STATE", [
      `buffer is ${data.length} bytes; need at least ${String(MIN_BUFFER_NONE_LEN)}`,
    ]);
  }
  const disc = readU32(data, 0, "buffer.discriminant");
  if (disc !== LOADER_STATE_BUFFER) {
    throw new ClientValidationError("INVALID_LOADER_STATE", [
      `loader discriminant is ${String(disc)}, not the buffer variant (1)`,
    ]);
  }
  const tag = data[4];
  if (tag === OPTION_NONE) {
    return { authority: null };
  }
  if (tag === OPTION_SOME) {
    if (data.length < MIN_BUFFER_SOME_LEN) {
      throw new ClientValidationError("INVALID_LOADER_STATE", [
        `buffer Some is ${data.length} bytes; need ${String(MIN_BUFFER_SOME_LEN)}`,
      ]);
    }
    return { authority: readPubkey(data, 5, "buffer.authority") };
  }
  throw new ClientValidationError("INVALID_LOADER_STATE", [
    `buffer Option tag is ${String(tag)}; only 0 or 1 are valid`,
  ]);
}

/**
 * Only issuer of `VerifiedIchorProgram`. `programId` is deploy-time identity;
 * there is no placeholder. Fail-closed when that address is unset or reserved.
 */
export async function verifyIchorProgramDeployment(
  connection: Connection,
  verified: VerifiedNetwork,
  programId: PublicKey,
  commitment?: AccountReadCommitment,
): Promise<VerifiedIchorProgram> {
  assertBoundConnection(verified, connection);
  const configured = requireConfiguredDeploymentAddress(
    programId,
    "ichorProgramId",
    reservedIchorProgramIds(),
  );
  const readCommitment = resolveAccountReadCommitment(commitment);

  const info = await connection.getAccountInfo(configured, readCommitment);
  if (info === null) {
    throw new ClientValidationError("PROGRAM_NOT_DEPLOYED", [
      `ICHOR program ${configured.toBase58()} has no account; a pubkey is not a deployment proof`,
    ]);
  }
  const parsed = parseUpgradeableProgram(verified, configured, {
    executable: info.executable,
    owner: info.owner,
    data: asUint8(info.data),
  });

  const programDataInfo = await connection.getAccountInfo(parsed.programData, readCommitment);
  if (programDataInfo === null) {
    throw new ClientValidationError("PROGRAM_DATA_MISSING", [
      `ProgramData ${parsed.programData.toBase58()} has no account`,
    ]);
  }
  if (!programDataInfo.owner.equals(new PublicKey(BPF_LOADER_UPGRADEABLE.id))) {
    throw new ClientValidationError("INVALID_LOADER_OWNER", [
      `ProgramData owner ${programDataInfo.owner.toBase58()} is not the BPF upgradeable loader`,
    ]);
  }
  const programData = parseUpgradeableProgramData(asUint8(programDataInfo.data));

  const proof = new IssuedVerifiedIchorProgram({
    verified,
    connection,
    programId: configured,
    programData: parsed.programData,
    program: parsed.proof,
    upgradeAuthority: programData.upgradeAuthority,
    deploymentSlot: programData.deploymentSlot,
  });
  issuedIchorProgramProofs.add(proof);
  return proof;
}

export function assertVerifiedIchorProgram(
  verifiedProgram: VerifiedIchorProgram,
): asserts verifiedProgram is VerifiedIchorProgram {
  if (verifiedProgram === null || typeof verifiedProgram !== "object") {
    throw new ClientValidationError("ICHOR_PROGRAM_PROOF", ["VerifiedIchorProgram is missing"]);
  }
  if (
    !issuedIchorProgramProofs.has(verifiedProgram) ||
    !(verifiedProgram instanceof IssuedVerifiedIchorProgram)
  ) {
    throw new ClientValidationError("ICHOR_PROGRAM_PROOF", [
      "fabricated VerifiedIchorProgram lookalike; only verifyIchorProgramDeployment may issue this proof",
    ]);
  }
  if (!verifiedProgram.matchesIssuedFields()) {
    throw new ClientValidationError("ICHOR_PROGRAM_PROOF", [
      "VerifiedIchorProgram fields were mutated after issuance",
    ]);
  }
  assertVerifiedNetwork(verifiedProgram.verified);
}

export async function verifyIchorConfigDeployment(
  connection: Connection,
  verifiedProgram: VerifiedIchorProgram,
  commitment?: AccountReadCommitment,
): Promise<VerifiedIchorConfig> {
  assertVerifiedIchorProgram(verifiedProgram);
  if (
    !(verifiedProgram instanceof IssuedVerifiedIchorProgram) ||
    !verifiedProgram.boundTo(connection, verifiedProgram.verified)
  ) {
    throw new ClientValidationError("CONNECTION_MISMATCH", [
      "connection is not the exact Connection instance bound to the issued ICHOR program proof",
    ]);
  }
  assertBoundConnection(verifiedProgram.verified, connection);

  const { address } = configPda(verifiedProgram.programId);
  const info = await connection.getAccountInfo(address, resolveAccountReadCommitment(commitment));
  if (info === null) {
    throw new ClientValidationError("CONFIG_NOT_INITIALIZED", [
      `config PDA ${address.toBase58()} has no account; convert is closed until initialize`,
    ]);
  }
  const config = parseIchorConfigAccount({
    programId: verifiedProgram.programId,
    config: address,
    owner: info.owner,
    data: asUint8(info.data),
  });
  const proof = new IssuedVerifiedIchorConfig({ verifiedProgram, config });
  issuedIchorConfigProofs.add(proof);
  return proof;
}

export function assertVerifiedIchorConfig(
  verifiedConfig: VerifiedIchorConfig,
): asserts verifiedConfig is VerifiedIchorConfig {
  if (verifiedConfig === null || typeof verifiedConfig !== "object") {
    throw new ClientValidationError("ICHOR_CONFIG_PROOF", ["VerifiedIchorConfig is missing"]);
  }
  if (
    !issuedIchorConfigProofs.has(verifiedConfig) ||
    !(verifiedConfig instanceof IssuedVerifiedIchorConfig)
  ) {
    throw new ClientValidationError("ICHOR_CONFIG_PROOF", [
      "fabricated VerifiedIchorConfig lookalike; only verifyIchorConfigDeployment may issue this proof",
    ]);
  }
  if (!verifiedConfig.matchesIssuedFields()) {
    throw new ClientValidationError("ICHOR_CONFIG_PROOF", [
      "VerifiedIchorConfig fields were mutated after issuance",
    ]);
  }
  assertVerifiedIchorProgram(verifiedConfig.verifiedProgram);
}

async function fetchCurve(
  connection: Connection,
  mint: PublicKey,
  expectedAddress?: PublicKey,
): Promise<BondingCurveSnapshot> {
  const address = bondingCurvePda(mint);
  const info = await connection.getAccountInfo(address, "confirmed");
  if (info === null) {
    throw new ClientValidationError("BONDING_CURVE_MISSING", [
      `canonical bonding-curve ${address.toBase58()} has no account`,
    ]);
  }
  return parseBondingCurveAccount({
    address,
    owner: info.owner,
    data: asUint8(info.data),
    expectedMint: mint,
    ...(expectedAddress === undefined ? {} : { expectedAddress }),
  });
}

/**
 * Convert instruction shape used by `composeConvertInstructionsFromIssuedConfig`
 * after live mint/curve reads. Offline fixtures call this directly.
 */
export function composeConvertInstruction(params: {
  programId: PublicKey;
  burner: PublicKey;
  config: PublicKey;
  kekbullMint: PublicKey;
  ichorMint: PublicKey;
  kekbullFrom: PublicKey;
  ichorTo: PublicKey;
  bondingCurve: PublicKey;
  kekbullTokenProgram: PublicKey;
  ichorTokenProgram: PublicKey;
  kekbullAmount: BN;
  minIchorAmount: BN;
}): TransactionInstruction {
  return instruction(
    params.programId,
    [
      { pubkey: params.burner, isSigner: true, isWritable: false },
      { pubkey: params.config, isSigner: false, isWritable: true },
      { pubkey: params.kekbullMint, isSigner: false, isWritable: true },
      { pubkey: params.ichorMint, isSigner: false, isWritable: true },
      { pubkey: params.kekbullFrom, isSigner: false, isWritable: true },
      { pubkey: params.ichorTo, isSigner: false, isWritable: true },
      { pubkey: params.bondingCurve, isSigner: false, isWritable: false },
      { pubkey: params.kekbullTokenProgram, isSigner: false, isWritable: false },
      { pubkey: params.ichorTokenProgram, isSigner: false, isWritable: false },
    ],
    encodeConvertInstructionData(params.kekbullAmount, params.minIchorAmount),
  );
}

/**
 * Convert instruction composer used after the public paused precheck, and by
 * the atomic defensive-stake builder after `set_paused(false)` is first in the
 * same message. Does **not** re-check `config.paused`.
 */
export async function composeConvertInstructionsFromIssuedConfig(
  params: BuildConvertParams,
): Promise<ConvertBuild> {
  assertNoSecretMaterial(params, "composeConvertInstructionsFromIssuedConfig");
  assertVerifiedIchorConfig(params.verifiedConfig);
  const { verifiedProgram, config } = params.verifiedConfig;
  if (
    !(verifiedProgram instanceof IssuedVerifiedIchorProgram) ||
    !verifiedProgram.boundTo(params.connection, verifiedProgram.verified)
  ) {
    throw new ClientValidationError("CONNECTION_MISMATCH", [
      "builder Connection is not the exact Connection instance bound to the ICHOR program proof",
    ]);
  }
  assertBoundConnection(verifiedProgram.verified, params.connection);

  const burner = requirePublicKey(params.burner, "burner");
  const recipient = requirePublicKey(params.recipient, "recipient");
  const kekbullAmount = requireU64Bn(requirePositiveBn(params.kekbullAmount, "kekbullAmount"), "kekbullAmount");
  const minIchorAmount = requireU64Bn(params.minIchorAmount, "minIchorAmount");

  const [kekbullMint, ichorMint, bondingCurve] = await Promise.all([
    fetchMintSnapshot(params.connection, verifiedProgram.verified.network, config.kekbullMint),
    fetchMintSnapshot(params.connection, verifiedProgram.verified.network, config.ichorMint),
    fetchCurve(params.connection, config.kekbullMint, config.bondingCurve),
  ]);
  assertMintSnapshot(kekbullMint, "KEKBULL");
  assertMintSnapshot(ichorMint, "ICHOR");
  assertKekbullIsToken2022(kekbullMint);
  assertIchorIsToken2022(ichorMint);
  requireIchorMintAuthority(ichorMint, config.config);
  if (!kekbullMint.ownerProgram.equals(config.kekbullTokenProgram)) {
    throw new ClientValidationError("INVALID_MINT_OWNER", [
      `KEKBULL owner ${kekbullMint.ownerProgram.toBase58()} does not match config`,
    ]);
  }
  if (!ichorMint.ownerProgram.equals(config.ichorTokenProgram)) {
    throw new ClientValidationError("INVALID_MINT_OWNER", [
      `ICHOR owner ${ichorMint.ownerProgram.toBase58()} does not match config`,
    ]);
  }
  requireGraduatedCurve(bondingCurve);

  const expectedIchorAmount = ichorFromKekbull({
    kekbullAmount,
    kekbullDecimals: kekbullMint.decimals,
    ichorDecimals: ichorMint.decimals,
    numerator: config.emissionNumerator,
    denominator: config.emissionDenominator,
  });
  if (expectedIchorAmount.lt(minIchorAmount)) {
    throw new ClientValidationError("BELOW_MIN_ICHOR_AMOUNT", [
      `computed ICHOR ${expectedIchorAmount.toString()} is below min_ichor_amount ${minIchorAmount.toString()}`,
    ]);
  }
  const nextBurned = config.totalKekbullBurned.add(kekbullAmount);
  const nextMinted = config.totalIchorMinted.add(expectedIchorAmount);
  if (nextBurned.gt(U64_MAX) || nextMinted.gt(U64_MAX)) {
    throw new ClientValidationError("ARITHMETIC_OVERFLOW", ["cumulative burn/mint counters would overflow u64"]);
  }

  const kekbullFrom = getAssociatedTokenAddressSync(
    kekbullMint.mint,
    burner,
    false,
    kekbullMint.ownerProgram,
  );
  const ichorTo = getAssociatedTokenAddressSync(
    ichorMint.mint,
    recipient,
    true,
    ichorMint.ownerProgram,
  );

  const [fromInfo, toInfo] = await Promise.all([
    params.connection.getAccountInfo(kekbullFrom, "confirmed"),
    params.connection.getAccountInfo(ichorTo, "confirmed"),
  ]);
  if (fromInfo === null) {
    throw new ClientValidationError("KEKBULL_ATA_MISSING", [
      `canonical KEKBULL ATA ${kekbullFrom.toBase58()} has no account`,
    ]);
  }
  const from = parseTokenAccount({
    address: kekbullFrom,
    ownerProgram: fromInfo.owner,
    data: asUint8(fromInfo.data),
    expectedMint: kekbullMint.mint,
    expectedOwner: burner,
    expectedTokenProgram: kekbullMint.ownerProgram,
    label: "kekbull_from",
  });
  if (from.amount.lt(kekbullAmount)) {
    throw new ClientValidationError("INSUFFICIENT_KEKBULL", [
      `kekbull_from holds ${from.amount.toString()} raw units; convert asks ${kekbullAmount.toString()}`,
    ]);
  }

  const instructions: TransactionInstruction[] = [];
  if (toInfo === null) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        burner,
        ichorTo,
        recipient,
        ichorMint.mint,
        ichorMint.ownerProgram,
      ),
    );
  } else {
    parseTokenAccount({
      address: ichorTo,
      ownerProgram: toInfo.owner,
      data: asUint8(toInfo.data),
      expectedMint: ichorMint.mint,
      expectedOwner: recipient,
      expectedTokenProgram: ichorMint.ownerProgram,
      label: "ichor_to",
    });
  }

  instructions.push(
    composeConvertInstruction({
      programId: verifiedProgram.programId,
      burner,
      config: config.config,
      kekbullMint: kekbullMint.mint,
      ichorMint: ichorMint.mint,
      kekbullFrom,
      ichorTo,
      bondingCurve: bondingCurve.address,
      kekbullTokenProgram: kekbullMint.ownerProgram,
      ichorTokenProgram: ichorMint.ownerProgram,
      kekbullAmount,
      minIchorAmount,
    }),
  );

  return {
    unsigned: unsignedTx(burner, instructions, [burner]),
    programId: verifiedProgram.programId,
    config: config.config,
    kekbullMint,
    ichorMint,
    bondingCurve,
    kekbullFrom,
    ichorTo,
    kekbullAmount,
    minIchorAmount,
    expectedIchorAmount,
  };
}

/**
 * Unsigned convert: Token-2022 BurnChecked(KEKBULL) + Token-2022
 * MintToChecked(ICHOR) in one program instruction. Output is computed from
 * on-chain mint decimals and config ratio before the instruction is encoded.
 * `min_ichor_amount` is included in the signed instruction data.
 *
 * Refuses when the issued config is paused. The atomic defensive-stake
 * composer must not call this; it uses
 * `composeConvertInstructionsFromIssuedConfig` after `set_paused(false)`.
 */
export async function buildConvertTransaction(params: BuildConvertParams): Promise<ConvertBuild> {
  assertNoSecretMaterial(params, "buildConvertTransaction");
  assertVerifiedIchorConfig(params.verifiedConfig);
  if (params.verifiedConfig.config.paused) {
    throw new ClientValidationError("PAUSED", ["ICHOR convert is paused on-chain"]);
  }
  return composeConvertInstructionsFromIssuedConfig(params);
}

export async function buildConvertInstruction(params: BuildConvertParams): Promise<ConvertBuild> {
  return buildConvertTransaction(params);
}

/**
 * Unsigned initialize. Signer must be this program's upgrade authority.
 * Binds existing mints; does not mint ICHOR. Fail-closed until the program
 * account and ProgramData exist on the issued Connection.
 */
export async function buildInitializeTransaction(
  params: BuildInitializeParams,
): Promise<InitializeBuild> {
  assertNoSecretMaterial(params, "buildInitializeTransaction");
  assertVerifiedIchorProgram(params.verifiedProgram);
  if (
    !(params.verifiedProgram instanceof IssuedVerifiedIchorProgram) ||
    !params.verifiedProgram.boundTo(params.connection, params.verifiedProgram.verified)
  ) {
    throw new ClientValidationError("CONNECTION_MISMATCH", [
      "builder Connection is not the exact Connection instance bound to the ICHOR program proof",
    ]);
  }
  assertBoundConnection(params.verifiedProgram.verified, params.connection);

  const authority = requirePublicKey(params.authority, "authority");
  const observedUpgradeAuthority = params.verifiedProgram.upgradeAuthority;
  if (!params.verifiedProgram.matchesIssuedFields()) {
    throw new ClientValidationError("ICHOR_PROGRAM_PROOF", [
      "VerifiedIchorProgram fields were mutated after issuance",
    ]);
  }
  if (observedUpgradeAuthority === null) {
    throw new ClientValidationError("UPGRADE_AUTHORITY_REVOKED", [
      "ProgramData upgrade authority is None; initialize cannot proceed",
    ]);
  }
  if (!authority.equals(observedUpgradeAuthority)) {
    throw new ClientValidationError("NOT_UPGRADE_AUTHORITY", [
      `authority ${authority.toBase58()} is not the observed upgrade authority ${observedUpgradeAuthority.toBase58()}`,
    ]);
  }
  const kekbullMintKey = requirePublicKey(params.kekbullMint, "kekbullMint");
  const ichorMintKey = requirePublicKey(params.ichorMint, "ichorMint");
  if (kekbullMintKey.equals(ichorMintKey)) {
    throw new ClientValidationError("MINTS_MUST_DIFFER", ["KEKBULL and ICHOR mints must be distinct"]);
  }
  const emissionNumerator = requireU64Bn(
    requirePositiveBn(params.emissionNumerator, "emissionNumerator"),
    "emissionNumerator",
  );
  const emissionDenominator = requireU64Bn(
    requirePositiveBn(params.emissionDenominator, "emissionDenominator"),
    "emissionDenominator",
  );
  const ratioTimelockSecs = requireU64Bn(params.ratioTimelockSecs, "ratioTimelockSecs");
  const creatorDecaySecs = requireU64Bn(
    requirePositiveBn(params.creatorDecaySecs, "creatorDecaySecs"),
    "creatorDecaySecs",
  );

  const { address: configAddress } = configPda(params.verifiedProgram.programId);
  const existing = await params.connection.getAccountInfo(configAddress, "confirmed");
  if (existing !== null) {
    throw new ClientValidationError("CONFIG_ALREADY_INITIALIZED", [
      `config PDA ${configAddress.toBase58()} already exists`,
    ]);
  }

  const [kekbullMint, ichorMint, bondingCurve] = await Promise.all([
    fetchMintSnapshot(params.connection, params.verifiedProgram.verified.network, kekbullMintKey),
    fetchMintSnapshot(params.connection, params.verifiedProgram.verified.network, ichorMintKey),
    fetchCurve(params.connection, kekbullMintKey),
  ]);
  assertMintSnapshot(kekbullMint, "KEKBULL");
  assertMintSnapshot(ichorMint, "ICHOR");
  assertKekbullIsToken2022(kekbullMint);
  assertIchorIsToken2022(ichorMint);
  if (!ichorMint.supply.isZero()) {
    throw new ClientValidationError("ICHOR_SUPPLY_MUST_BE_ZERO", [
      `ICHOR supply is ${ichorMint.supply.toString()} at initialize; must be zero`,
    ]);
  }
  requireIchorMintAuthority(ichorMint, configAddress);
  const withdraw = withdrawWithheldPda(params.verifiedProgram.programId);
  const escrow = creatorEscrowPda(params.verifiedProgram.programId);
  const ichorInfo = await params.connection.getAccountInfo(ichorMint.mint, "confirmed");
  if (ichorInfo === null) {
    throw new ClientValidationError("MINT_MISSING", [`ICHOR mint ${ichorMint.mint.toBase58()} has no account`]);
  }
  requireIchorTransferFeeConfig(
    parseIchorTransferFeeConfig(asUint8(ichorInfo.data)),
    configAddress,
    withdraw.address,
  );

  const data = encodeInitializeInstructionData(
    emissionNumerator,
    emissionDenominator,
    ratioTimelockSecs,
    creatorDecaySecs,
  );
  const ix = instruction(
    params.verifiedProgram.programId,
    [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: configAddress, isSigner: false, isWritable: true },
      { pubkey: kekbullMint.mint, isSigner: false, isWritable: false },
      { pubkey: ichorMint.mint, isSigner: false, isWritable: false },
      { pubkey: withdraw.address, isSigner: false, isWritable: false },
      { pubkey: escrow.address, isSigner: false, isWritable: false },
      { pubkey: bondingCurve.address, isSigner: false, isWritable: false },
      { pubkey: params.verifiedProgram.programId, isSigner: false, isWritable: false },
      { pubkey: params.verifiedProgram.programData, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  );

  return {
    unsigned: unsignedTx(authority, [ix], [authority]),
    programId: params.verifiedProgram.programId,
    programData: params.verifiedProgram.programData,
    config: configAddress,
    withdrawWithheldAuthority: withdraw.address,
    creatorEscrowAuthority: escrow.address,
    kekbullMint,
    ichorMint,
    bondingCurve: bondingCurve.address,
    emissionNumerator,
    emissionDenominator,
    ratioTimelockSecs,
    creatorDecaySecs,
  };
}

export async function buildInitializeInstruction(
  params: BuildInitializeParams,
): Promise<InitializeBuild> {
  return buildInitializeTransaction(params);
}
