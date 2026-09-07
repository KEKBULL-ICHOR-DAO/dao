import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import { PUMP_PROGRAM, assertVerifiedIchorConfig } from "./burn.ts";
import {
  grossUpToken2022Transfer,
  parseIchorTransferFeeConfig,
} from "./extensions.ts";
import { fetchMintSnapshot } from "./mint.ts";
import { NATIVE_MINT, PUMP_SWAP } from "./network.ts";
import { assertBoundConnection } from "./preflight.ts";
import type {
  CanonicalPumpSwapReserves,
  IchorSolSeedPlan,
  IntegerRoundingDirection,
  KekbullEmissionInterval,
  PlanIchorSolSeedParams,
  PumpSwapPoolSnapshot,
  VerifiedIchorConfig,
} from "./types.ts";
import { ClientValidationError } from "./types.ts";
import {
  assertIchorIsToken2022,
  assertKekbullIsToken2022,
  assertMintSnapshot,
  assertNoSecretMaterial,
  ichorFromKekbull,
  requirePositiveBn,
  requirePublicKey,
  requireU64Bn,
  tenPowU8,
} from "./validation.ts";

const utf8 = new TextEncoder();

/** `PDA(["pool-authority", base_mint], PUMP)` - hyphen, on the pump program. */
export const POOL_AUTHORITY_SEED = utf8.encode("pool-authority");

/** `PDA(["pool", 0u16, pool_authority, base_mint, WSOL], PumpSwap)` - hyphen. */
export const POOL_SEED = utf8.encode("pool");

/** Canonical pump.fun migration index. Measured 0 on every checked graduate. */
export const CANONICAL_POOL_INDEX = 0;

/**
 * Measured PumpSwap pool offsets from `src/pumpswap/pool.rs`.
 * Lengths of 300 and 301 both occur; never dispatch on length.
 */
export const OFF_CREATOR = 11;
export const OFF_BASE_MINT = 43;
export const OFF_QUOTE_MINT = 75;
export const OFF_BASE_VAULT = 139;
export const OFF_QUOTE_VAULT = 171;
export const OFF_COIN_CREATOR = 211;
export const OFF_IS_MAYHEM = 243;
export const OFF_IS_CASHBACK = 244;
export const OFF_VIRTUAL_QUOTE = 245;
export const VIRTUAL_QUOTE_LEN = 16;
export const MIN_POOL_LEN = OFF_VIRTUAL_QUOTE;
export const PUMPSWAP_POOL_DISCRIMINATOR = new Uint8Array([
  241, 154, 109, 4, 17, 177, 109, 188,
]);

const TOKEN_ACCOUNT_BASE_LEN = 165;
const TOKEN_ACCOUNT_OFF_MINT = 0;
const TOKEN_ACCOUNT_OFF_OWNER = 32;
const TOKEN_ACCOUNT_OFF_AMOUNT = 64;
const TOKEN_ACCOUNT_OFF_STATE = 108;
const TOKEN_ACCOUNT_STATE_INITIALIZED = 1;
const TOKEN_ACCOUNT_STATE_FROZEN = 2;

const U128_BITS = 128;
const BPS_DENOM = 10_000;
const ADJUSTMENT_BPS_MIN = -10_000;
const ADJUSTMENT_BPS_MAX = 0;

const issuedSeedPlans = new WeakMap<
  object,
  { connection: Connection; verifiedConfig: VerifiedIchorConfig; fingerprint: string }
>();

function seedPlanFingerprint(plan: IchorSolSeedPlan): string {
  return [
    plan.verifiedConfig.config.config.toBase58(),
    plan.ichorAmount.toString(10),
    plan.ichorGrossAmount.toString(10),
    plan.ichorExpectedTransferFee.toString(10),
    plan.ichorNetAmount.toString(10),
    plan.transferFeeEpoch.toString(10),
    plan.adjustmentBps,
    plan.adjustedSolLamports.toString(10),
    plan.adjustedSolFloorLamports.toString(10),
    plan.adjustedSolCeilingLamports.toString(10),
    plan.ichorMint.mint.toBase58(),
    plan.seedOwner.toBase58(),
    plan.pool.address.toBase58(),
    plan.pool.baseVaultAmount.toString(10),
    plan.pool.effectiveQuoteLamports.toString(10),
  ].join("|");
}

export function assertIchorSolSeedPlan(
  plan: IchorSolSeedPlan,
  connection: Connection,
): void {
  if (plan === null || typeof plan !== "object") {
    throw new ClientValidationError("SEED_PLAN_PROOF", ["IchorSolSeedPlan is missing"]);
  }
  const issued = issuedSeedPlans.get(plan);
  if (!issued) {
    throw new ClientValidationError("SEED_PLAN_PROOF", [
      "fabricated seed plan; only planIchorSolSeed may issue one",
    ]);
  }
  if (
    issued.connection !== connection ||
    issued.verifiedConfig !== plan.verifiedConfig ||
    seedPlanFingerprint(plan) !== issued.fingerprint
  ) {
    throw new ClientValidationError("SEED_PLAN_PROOF", [
      "seed plan connection, proof, or economic fields changed after issuance",
    ]);
  }
  assertBoundIchorConnection(plan.verifiedConfig, connection);
}

function asUint8(data: ArrayLike<number>): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function pubkeyBytes(key: PublicKey): Uint8Array {
  return Uint8Array.from(key.toBytes());
}

export function u16LeBytes(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new ClientValidationError("INVALID_INT", [
      `u16 ${String(value)} is not an unsigned 16-bit integer`,
    ]);
  }
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

export function poolAuthoritySeeds(baseMint: PublicKey): Uint8Array[] {
  return [POOL_AUTHORITY_SEED, pubkeyBytes(baseMint)];
}

export function canonicalPoolSeeds(
  poolAuthority: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
): Uint8Array[] {
  return [
    POOL_SEED,
    u16LeBytes(CANONICAL_POOL_INDEX),
    pubkeyBytes(poolAuthority),
    pubkeyBytes(baseMint),
    pubkeyBytes(quoteMint),
  ];
}

export function poolAuthorityPda(baseMint: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(poolAuthoritySeeds(baseMint), PUMP_PROGRAM);
  return address;
}

export function canonicalPumpSwapPoolPda(baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  const authority = poolAuthorityPda(baseMint);
  const [address] = PublicKey.findProgramAddressSync(
    canonicalPoolSeeds(authority, baseMint, quoteMint),
    new PublicKey(PUMP_SWAP.id),
  );
  return address;
}

function requireLen(data: Uint8Array, need: number, label: string): void {
  if (data.length < need) {
    throw new ClientValidationError("ACCOUNT_LAYOUT", [
      `${label} is ${data.length} bytes; need at least ${String(need)}`,
    ]);
  }
}

function readPubkey(data: Uint8Array, offset: number, label: string): PublicKey {
  requireLen(data, offset + 32, label);
  return new PublicKey(data.subarray(offset, offset + 32));
}

function readU16(data: Uint8Array, offset: number, label: string): number {
  requireLen(data, offset + 2, label);
  return data[offset]! | (data[offset + 1]! << 8);
}

function readU64(data: Uint8Array, offset: number, label: string): BN {
  requireLen(data, offset + 8, label);
  return new BN(Array.from(data.subarray(offset, offset + 8)), "le");
}

function readI128(data: Uint8Array, offset: number, label: string): BN {
  requireLen(data, offset + VIRTUAL_QUOTE_LEN, label);
  return new BN(Array.from(data.subarray(offset, offset + VIRTUAL_QUOTE_LEN)), "le").fromTwos(128);
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

function requireU128(value: BN, label: string): BN {
  if (value.isNeg() || value.bitLength() > U128_BITS) {
    throw new ClientValidationError("ARITHMETIC_OVERFLOW", [`${label} overflows u128`]);
  }
  return value;
}

function requireKnownTokenProgram(
  owner: PublicKey,
  tokenProgramId: PublicKey,
  token2022ProgramId: PublicKey,
  label: string,
): PublicKey {
  if (owner.equals(tokenProgramId) || owner.equals(token2022ProgramId)) {
    return owner;
  }
  throw new ClientValidationError("TOKEN_PROGRAM_UNKNOWN", [
    `${label} owner ${owner.toBase58()} is not the named legacy SPL or Token-2022 program`,
  ]);
}

function parseTokenAccount(params: {
  ownerProgram: PublicKey;
  data: Uint8Array;
  expectedMint: PublicKey;
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
  if (state === TOKEN_ACCOUNT_STATE_FROZEN) {
    throw new ClientValidationError("TOKEN_ACCOUNT_FROZEN", [`${params.label} is frozen`]);
  }
  if (state !== TOKEN_ACCOUNT_STATE_INITIALIZED) {
    throw new ClientValidationError("TOKEN_ACCOUNT_UNINITIALIZED", [`${params.label} is not initialized`]);
  }
  return { mint, owner, amount };
}

export function requireAdjustmentBps(value: unknown): number {
  if (value === undefined || value === null) {
    throw new ClientValidationError("ADJUSTMENT_BPS_REQUIRED", [
      "adjustmentBps is required; the planner does not default it",
    ]);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new ClientValidationError("INVALID_BPS", ["adjustmentBps must be a safe integer"]);
  }
  if (value < ADJUSTMENT_BPS_MIN || value > ADJUSTMENT_BPS_MAX) {
    throw new ClientValidationError("INVALID_BPS", [
      `adjustmentBps ${String(value)} is outside [${String(ADJUSTMENT_BPS_MIN)}, ${String(ADJUSTMENT_BPS_MAX)}]`,
    ]);
  }
  return value;
}

/**
 * Vault quote plus signed virtual quote. Absence of the 16-byte field is
 * measured zero, not unknown. Non-positive totals are rejected.
 */
export function effectiveQuoteLamports(quoteVaultAmount: BN, virtualQuoteReserves: BN): BN {
  const vault = requireU64Bn(quoteVaultAmount, "quoteVaultAmount");
  const total = vault.add(virtualQuoteReserves);
  if (total.lte(new BN(0))) {
    throw new ClientValidationError("EFFECTIVE_QUOTE_NON_POSITIVE", [
      `effective quote vault=${vault.toString()} virtual=${virtualQuoteReserves.toString()} is not positive`,
    ]);
  }
  return requireU128(total, "effectiveQuote");
}

export function parsePumpSwapPoolLayout(data: Uint8Array): {
  index: number;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  coinCreator: PublicKey;
  isMayhem: boolean;
  isCashback: boolean;
  virtualQuoteReserves: BN;
  virtualQuotePresent: boolean;
  dataLength: number;
} {
  if (data.length < MIN_POOL_LEN) {
    throw new ClientValidationError("POOL_LAYOUT", [
      `pool account is ${data.length} bytes, shorter than the measured ${String(MIN_POOL_LEN)}-byte layout`,
    ]);
  }
  if (
    !data
      .subarray(0, PUMPSWAP_POOL_DISCRIMINATOR.length)
      .every((byte, index) => byte === PUMPSWAP_POOL_DISCRIMINATOR[index])
  ) {
    throw new ClientValidationError("POOL_DISCRIMINATOR", [
      "account discriminator is not PumpSwap account:Pool",
    ]);
  }
  const index = readU16(data, 9, "pool.index");
  const virtualQuotePresent = data.length >= OFF_VIRTUAL_QUOTE + VIRTUAL_QUOTE_LEN;
  const virtualQuoteReserves = virtualQuotePresent
    ? readI128(data, OFF_VIRTUAL_QUOTE, "virtual_quote_reserves")
    : new BN(0);
  return {
    index,
    creator: readPubkey(data, OFF_CREATOR, "pool.creator"),
    baseMint: readPubkey(data, OFF_BASE_MINT, "pool.base_mint"),
    quoteMint: readPubkey(data, OFF_QUOTE_MINT, "pool.quote_mint"),
    baseVault: readPubkey(data, OFF_BASE_VAULT, "pool.base_vault"),
    quoteVault: readPubkey(data, OFF_QUOTE_VAULT, "pool.quote_vault"),
    coinCreator: readPubkey(data, OFF_COIN_CREATOR, "pool.coin_creator"),
    isMayhem: readBool(data, OFF_IS_MAYHEM, "pool.is_mayhem"),
    isCashback: readBool(data, OFF_IS_CASHBACK, "pool.is_cashback"),
    virtualQuoteReserves,
    virtualQuotePresent,
    dataLength: data.length,
  };
}

function emissionScale(kekbullDecimals: number, ichorDecimals: number): { scaleUp: BN; scaleDown: BN } {
  if (!Number.isInteger(kekbullDecimals) || kekbullDecimals < 0 || kekbullDecimals > 255) {
    throw new ClientValidationError("MINT_DECIMALS", [
      `KEKBULL decimals ${String(kekbullDecimals)} are not a valid u8`,
    ]);
  }
  if (!Number.isInteger(ichorDecimals) || ichorDecimals < 0 || ichorDecimals > 255) {
    throw new ClientValidationError("MINT_DECIMALS", [
      `ICHOR decimals ${String(ichorDecimals)} are not a valid u8`,
    ]);
  }
  if (ichorDecimals > kekbullDecimals) {
    return { scaleUp: tenPowU8(ichorDecimals - kekbullDecimals), scaleDown: new BN(1) };
  }
  if (ichorDecimals < kekbullDecimals) {
    return { scaleUp: new BN(1), scaleDown: tenPowU8(kekbullDecimals - ichorDecimals) };
  }
  return { scaleUp: new BN(1), scaleDown: new BN(1) };
}

function ceilDiv(num: BN, den: BN, label: string): BN {
  if (den.isZero()) {
    throw new ClientValidationError("ARITHMETIC_OVERFLOW", [`${label} divides by zero`]);
  }
  const sum = requireU128(num.add(den).sub(new BN(1)), `${label} ceil numerator`);
  return sum.div(den);
}

/**
 * Inverse of `ichorFromKekbull` floor math. Returns the closed raw-KEKBULL
 * interval that mints exactly `ichorAmount`. Unreachable images are rejected.
 */
export function kekbullIntervalForTargetIchor(params: {
  ichorAmount: BN;
  kekbullDecimals: number;
  ichorDecimals: number;
  numerator: BN;
  denominator: BN;
}): KekbullEmissionInterval {
  const ichorAmount = requireU64Bn(requirePositiveBn(params.ichorAmount, "ichorAmount"), "ichorAmount");
  const numerator = requirePositiveBn(params.numerator, "emissionNumerator");
  const denominator = requirePositiveBn(params.denominator, "emissionDenominator");
  if (numerator.gt(denominator)) {
    throw new ClientValidationError("RATIO_ABOVE_CEILING", [
      "emission ratio exceeds the 1:1 human-unit ceiling (numerator <= denominator)",
    ]);
  }
  const { scaleUp, scaleDown } = emissionScale(params.kekbullDecimals, params.ichorDecimals);
  const A = requireU128(numerator.mul(scaleUp), "numerator*scaleUp");
  const B = requireU128(denominator.mul(scaleDown), "denominator*scaleDown");
  const minRaw = requireU64Bn(
    ceilDiv(requireU128(ichorAmount.mul(B), "ichor*B"), A, "kekbullMin"),
    "kekbullInterval.minRaw",
  );
  const nextIchor = ichorAmount.add(new BN(1));
  const maxNum = requireU128(nextIchor.mul(B), "(ichor+1)*B").sub(new BN(1));
  if (maxNum.isNeg()) {
    throw new ClientValidationError("ICHOR_NOT_IN_EMISSION_IMAGE", [
      `target ICHOR ${ichorAmount.toString()} is not reachable under floor emission`,
    ]);
  }
  const maxRaw = requireU64Bn(maxNum.div(A), "kekbullInterval.maxRaw");
  if (minRaw.isZero() || maxRaw.lt(minRaw)) {
    throw new ClientValidationError("ICHOR_NOT_IN_EMISSION_IMAGE", [
      `target ICHOR ${ichorAmount.toString()} is not reachable under floor emission`,
    ]);
  }
  const mintedMin = ichorFromKekbull({
    kekbullAmount: minRaw,
    kekbullDecimals: params.kekbullDecimals,
    ichorDecimals: params.ichorDecimals,
    numerator,
    denominator,
  });
  const mintedMax = ichorFromKekbull({
    kekbullAmount: maxRaw,
    kekbullDecimals: params.kekbullDecimals,
    ichorDecimals: params.ichorDecimals,
    numerator,
    denominator,
  });
  if (!mintedMin.eq(ichorAmount) || !mintedMax.eq(ichorAmount)) {
    throw new ClientValidationError("ICHOR_NOT_IN_EMISSION_IMAGE", [
      `floor image at [${minRaw.toString()}, ${maxRaw.toString()}] is ${mintedMin.toString()}..${mintedMax.toString()}, not ${ichorAmount.toString()}`,
    ]);
  }
  return { minRaw, maxRaw };
}

export function solParityFromReserves(params: {
  kekbullAmount: BN;
  effectiveQuote: BN;
  baseReserves: BN;
  rounding: IntegerRoundingDirection;
}): BN {
  const kek = requireU64Bn(requirePositiveBn(params.kekbullAmount, "kekbullAmount"), "kekbullAmount");
  const quote = requirePositiveBn(params.effectiveQuote, "effectiveQuote");
  const base = requirePositiveBn(params.baseReserves, "baseReserves");
  const product = requireU128(kek.mul(quote), "kekbull*effectiveQuote");
  if (params.rounding === "floor") {
    return requireU64Bn(product.div(base), "parityFloor");
  }
  if (params.rounding === "ceiling") {
    return requireU64Bn(ceilDiv(product, base, "parityCeiling"), "parityCeiling");
  }
  throw new ClientValidationError("INVALID_ROUNDING", [
    `rounding ${String(params.rounding)} is not floor or ceiling`,
  ]);
}

export function applyAdjustmentBps(params: {
  amount: BN;
  adjustmentBps: number;
  rounding: IntegerRoundingDirection;
}): BN {
  const amount = requireU64Bn(requirePositiveBn(params.amount, "amount"), "amount");
  const bps = requireAdjustmentBps(params.adjustmentBps);
  const factor = new BN(BPS_DENOM + bps);
  if (factor.lte(new BN(0))) {
    throw new ClientValidationError("ADJUSTMENT_NON_POSITIVE", [
      `adjustmentBps ${String(bps)} zeroes or inverts the SOL amount`,
    ]);
  }
  const product = requireU128(amount.mul(factor), "amount*(10000+bps)");
  const denom = new BN(BPS_DENOM);
  const adjusted =
    params.rounding === "ceiling" ? ceilDiv(product, denom, "adjustedCeiling") : product.div(denom);
  return requireU64Bn(requirePositiveBn(adjusted, "adjustedSol"), "adjustedSol");
}

function assertBoundIchorConnection(verifiedConfig: VerifiedIchorConfig, connection: Connection): void {
  assertVerifiedIchorConfig(verifiedConfig);
  assertBoundConnection(verifiedConfig.verifiedProgram.verified, connection);
}

/**
 * Browser-safe ICHOR/SOL seed planner. Reads the canonical PumpSwap KEKBULL/wSOL
 * pool, inverts floor emission, and prices SOL from live effective reserves.
 * Does not send, sign, or invent amounts.
 */
export async function planIchorSolSeed(params: PlanIchorSolSeedParams): Promise<IchorSolSeedPlan> {
  assertNoSecretMaterial(params, "planIchorSolSeed");
  assertBoundIchorConnection(params.verifiedConfig, params.connection);
  const ichorAmount = requireU64Bn(requirePositiveBn(params.ichorAmount, "ichorAmount"), "ichorAmount");
  const adjustmentBps = requireAdjustmentBps(params.adjustmentBps);
  const seedOwner = requirePublicKey(params.seedOwner, "seedOwner");
  if (seedOwner.equals(PublicKey.default)) {
    throw new ClientValidationError("DEFAULT_PUBKEY", [
      "seedOwner must not be the default/System Program address",
    ]);
  }

  const { verifiedProgram, config } = params.verifiedConfig;
  const verified = verifiedProgram.verified;
  const network = verified.network;
  if (!config.pumpProgram.equals(PUMP_PROGRAM)) {
    throw new ClientValidationError("PUMP_PROGRAM", [
      `config.pumpProgram ${config.pumpProgram.toBase58()} is not the named pump.fun program`,
    ]);
  }

  const nativeMintKey = network.nativeMint;
  if (!nativeMintKey.equals(new PublicKey(NATIVE_MINT.id))) {
    throw new ClientValidationError("NATIVE_MINT", [
      `network.nativeMint ${nativeMintKey.toBase58()} is not the named wSOL mint`,
    ]);
  }

  const [kekbullMint, ichorMint, nativeMint] = await Promise.all([
    fetchMintSnapshot(params.connection, network, config.kekbullMint),
    fetchMintSnapshot(params.connection, network, config.ichorMint),
    fetchMintSnapshot(params.connection, network, nativeMintKey),
  ]);
  assertMintSnapshot(kekbullMint, "KEKBULL");
  assertMintSnapshot(ichorMint, "ICHOR");
  assertMintSnapshot(nativeMint, "wSOL");
  assertKekbullIsToken2022(kekbullMint);
  assertIchorIsToken2022(ichorMint);
  if (!kekbullMint.ownerProgram.equals(config.kekbullTokenProgram)) {
    throw new ClientValidationError("KEKBULL_TOKEN_PROGRAM", [
      `KEKBULL mint owner ${kekbullMint.ownerProgram.toBase58()} is not config.kekbullTokenProgram`,
    ]);
  }
  if (!ichorMint.ownerProgram.equals(config.ichorTokenProgram)) {
    throw new ClientValidationError("ICHOR_TOKEN_PROGRAM", [
      `ICHOR mint owner ${ichorMint.ownerProgram.toBase58()} is not config.ichorTokenProgram`,
    ]);
  }
  const [ichorMintInfo, epochInfo] = await Promise.all([
    params.connection.getAccountInfo(ichorMint.mint, "confirmed"),
    params.connection.getEpochInfo("confirmed"),
  ]);
  if (ichorMintInfo === null) {
    throw new ClientValidationError("ICHOR_MINT_MISSING", [
      `ICHOR mint ${ichorMint.mint.toBase58()} has no account`,
    ]);
  }
  if (!Number.isSafeInteger(epochInfo.epoch) || epochInfo.epoch < 0) {
    throw new ClientValidationError("EPOCH_UNAVAILABLE", [
      "confirmed epoch is not a safe non-negative integer",
    ]);
  }
  const transferFeeEpoch = new BN(epochInfo.epoch);
  const transfer = grossUpToken2022Transfer({
    config: parseIchorTransferFeeConfig(asUint8(ichorMintInfo.data)),
    currentEpoch: transferFeeEpoch,
    targetNet: ichorAmount,
  });

  const poolAuthority = poolAuthorityPda(kekbullMint.mint);
  const poolAddress = canonicalPumpSwapPoolPda(kekbullMint.mint, nativeMint.mint);
  const poolInfo = await params.connection.getAccountInfo(poolAddress, "confirmed");
  if (poolInfo === null) {
    throw new ClientValidationError("PUMPSWAP_POOL_MISSING", [
      `canonical PumpSwap pool ${poolAddress.toBase58()} has no account`,
    ]);
  }
  const pumpSwapProgram = new PublicKey(PUMP_SWAP.id);
  if (!poolInfo.owner.equals(pumpSwapProgram)) {
    throw new ClientValidationError("PUMPSWAP_OWNER", [
      `${poolAddress.toBase58()} is owned by ${poolInfo.owner.toBase58()}, not PumpSwap`,
    ]);
  }

  const parsed = parsePumpSwapPoolLayout(asUint8(poolInfo.data));
  if (parsed.index !== CANONICAL_POOL_INDEX) {
    throw new ClientValidationError("POOL_INDEX_NONCANONICAL", [
      `pool index ${String(parsed.index)} is not the canonical ${String(CANONICAL_POOL_INDEX)}`,
    ]);
  }
  if (!parsed.creator.equals(poolAuthority)) {
    throw new ClientValidationError("POOL_AUTHORITY_MISMATCH", [
      `pool creator ${parsed.creator.toBase58()} is not pool-authority ${poolAuthority.toBase58()}`,
    ]);
  }
  if (!parsed.baseMint.equals(kekbullMint.mint)) {
    throw new ClientValidationError("POOL_BASE_MINT", [
      `pool base mint ${parsed.baseMint.toBase58()} is not config KEKBULL ${kekbullMint.mint.toBase58()}`,
    ]);
  }
  if (!parsed.quoteMint.equals(nativeMint.mint)) {
    throw new ClientValidationError("POOL_QUOTE_MINT", [
      `pool quote mint ${parsed.quoteMint.toBase58()} is not wSOL ${nativeMint.mint.toBase58()}`,
    ]);
  }

  const [baseVaultInfo, quoteVaultInfo] = await Promise.all([
    params.connection.getAccountInfo(parsed.baseVault, "confirmed"),
    params.connection.getAccountInfo(parsed.quoteVault, "confirmed"),
  ]);
  if (baseVaultInfo === null) {
    throw new ClientValidationError("VAULT_MISSING", [
      `base vault ${parsed.baseVault.toBase58()} has no account`,
    ]);
  }
  if (quoteVaultInfo === null) {
    throw new ClientValidationError("VAULT_MISSING", [
      `quote vault ${parsed.quoteVault.toBase58()} has no account`,
    ]);
  }
  const baseTokenProgram = requireKnownTokenProgram(
    baseVaultInfo.owner,
    network.tokenProgramId,
    network.token2022ProgramId,
    "baseVault",
  );
  const quoteTokenProgram = requireKnownTokenProgram(
    quoteVaultInfo.owner,
    network.tokenProgramId,
    network.token2022ProgramId,
    "quoteVault",
  );
  if (!baseTokenProgram.equals(kekbullMint.ownerProgram)) {
    throw new ClientValidationError("VAULT_TOKEN_PROGRAM", [
      `base vault program ${baseTokenProgram.toBase58()} is not the KEKBULL mint owner`,
    ]);
  }
  if (!quoteTokenProgram.equals(nativeMint.ownerProgram)) {
    throw new ClientValidationError("VAULT_TOKEN_PROGRAM", [
      `quote vault program ${quoteTokenProgram.toBase58()} is not the wSOL mint owner`,
    ]);
  }
  const baseVault = parseTokenAccount({
    ownerProgram: baseVaultInfo.owner,
    data: asUint8(baseVaultInfo.data),
    expectedMint: kekbullMint.mint,
    expectedTokenProgram: baseTokenProgram,
    label: "baseVault",
  });
  const quoteVault = parseTokenAccount({
    ownerProgram: quoteVaultInfo.owner,
    data: asUint8(quoteVaultInfo.data),
    expectedMint: nativeMint.mint,
    expectedTokenProgram: quoteTokenProgram,
    label: "quoteVault",
  });
  if (baseVault.amount.isZero()) {
    throw new ClientValidationError("BASE_RESERVES_ZERO", ["base vault amount is zero; cannot price"]);
  }
  const effectiveQuote = effectiveQuoteLamports(quoteVault.amount, parsed.virtualQuoteReserves);

  const kekbullInterval = kekbullIntervalForTargetIchor({
    ichorAmount: transfer.expectedNet,
    kekbullDecimals: kekbullMint.decimals,
    ichorDecimals: ichorMint.decimals,
    numerator: config.emissionNumerator,
    denominator: config.emissionDenominator,
  });
  const rawParityFloorLamports = solParityFromReserves({
    kekbullAmount: kekbullInterval.minRaw,
    effectiveQuote,
    baseReserves: baseVault.amount,
    rounding: "floor",
  });
  const rawParityCeilingLamports = solParityFromReserves({
    // Economic burn parity uses the cheapest KEKBULL input that can mint the
    // target ICHOR. maxRaw is dust that still floors to the same output, not a
    // rational arbitrage cost and must not justify overpricing the pool.
    kekbullAmount: kekbullInterval.minRaw,
    effectiveQuote,
    baseReserves: baseVault.amount,
    rounding: "ceiling",
  });
  if (rawParityCeilingLamports.lt(rawParityFloorLamports)) {
    throw new ClientValidationError("PARITY_INTERVAL_EMPTY", [
      `parity ceiling ${rawParityCeilingLamports.toString()} is below floor ${rawParityFloorLamports.toString()}`,
    ]);
  }
  const adjustedSolFloorLamports = applyAdjustmentBps({
    amount: rawParityFloorLamports,
    adjustmentBps,
    rounding: "floor",
  });
  const adjustedSolCeilingLamports = applyAdjustmentBps({
    amount: rawParityCeilingLamports,
    adjustmentBps,
    rounding: "ceiling",
  });
  const adjustedSolLamports = adjustedSolFloorLamports;

  const ichorAta = getAssociatedTokenAddressSync(
    ichorMint.mint,
    seedOwner,
    true,
    ichorMint.ownerProgram,
  );
  const [ichorAtaInfo, solLamportsNumber] = await Promise.all([
    params.connection.getAccountInfo(ichorAta, "confirmed"),
    params.connection.getBalance(seedOwner, "confirmed"),
  ]);
  if (ichorAtaInfo === null) {
    throw new ClientValidationError("ICHOR_ATA_MISSING", [
      `canonical ICHOR ATA ${ichorAta.toBase58()} has no account`,
    ]);
  }
  const ichorHolding = parseTokenAccount({
    ownerProgram: ichorAtaInfo.owner,
    data: asUint8(ichorAtaInfo.data),
    expectedMint: ichorMint.mint,
    expectedTokenProgram: ichorMint.ownerProgram,
    label: "ichorAta",
  });
  if (!ichorHolding.owner.equals(seedOwner)) {
    throw new ClientValidationError("TOKEN_ACCOUNT_OWNER_MISMATCH", [
      `ICHOR ATA owner ${ichorHolding.owner.toBase58()} is not seedOwner`,
    ]);
  }
  if (ichorHolding.amount.lt(transfer.grossAmount)) {
    throw new ClientValidationError("ICHOR_BALANCE_INSUFFICIENT", [
      `ICHOR ATA holds ${ichorHolding.amount.toString()}, need gross ${transfer.grossAmount.toString()}`,
    ]);
  }
  if (!Number.isSafeInteger(solLamportsNumber) || solLamportsNumber < 0) {
    throw new ClientValidationError("SOL_BALANCE_UNSAFE_INTEGER", [
      "RPC SOL balance cannot be represented exactly as a JavaScript integer",
    ]);
  }
  const solLamports = new BN(solLamportsNumber.toString());
  if (solLamports.lt(adjustedSolLamports)) {
    throw new ClientValidationError("SOL_BALANCE_INSUFFICIENT", [
      `seed owner holds ${solLamports.toString()} lamports, need ${adjustedSolLamports.toString()}`,
    ]);
  }

  const pool: PumpSwapPoolSnapshot = {
    address: poolAddress,
    owner: poolInfo.owner,
    creator: parsed.creator,
    poolAuthority,
    baseMint: parsed.baseMint,
    quoteMint: parsed.quoteMint,
    baseVault: parsed.baseVault,
    quoteVault: parsed.quoteVault,
    coinCreator: parsed.coinCreator,
    isMayhem: parsed.isMayhem,
    isCashback: parsed.isCashback,
    dataLength: parsed.dataLength,
    virtualQuoteReserves: parsed.virtualQuoteReserves,
    virtualQuotePresent: parsed.virtualQuotePresent,
    baseVaultAmount: baseVault.amount,
    quoteVaultAmount: quoteVault.amount,
    baseTokenProgram,
    quoteTokenProgram,
    effectiveQuoteLamports: effectiveQuote,
  };

  const plan: IchorSolSeedPlan = {
    verifiedConfig: params.verifiedConfig,
    ichorAmount,
    ichorGrossAmount: transfer.grossAmount,
    ichorExpectedTransferFee: transfer.expectedFee,
    ichorNetAmount: transfer.expectedNet,
    transferFeeEpoch,
    adjustmentBps,
    kekbullMint,
    ichorMint,
    nativeMint,
    emissionNumerator: config.emissionNumerator,
    emissionDenominator: config.emissionDenominator,
    kekbullInterval,
    pool,
    rawParityFloorLamports,
    rawParityCeilingLamports,
    adjustedSolFloorLamports,
    adjustedSolCeilingLamports,
    adjustedSolLamports,
    rounding: {
      emissionImage: "floor",
      parityFloor: "floor",
      parityCeiling: "ceiling",
      adjustmentFloor: "floor",
      adjustmentCeiling: "ceiling",
    },
    seedOwner,
    ichorAta,
    ichorAtaAmount: ichorHolding.amount,
    solLamports,
    sources: {
      ichorProgram: verifiedProgram.programId,
      config: config.config,
      kekbullMint: kekbullMint.mint,
      ichorMint: ichorMint.mint,
      pumpProgram: config.pumpProgram,
      pumpSwapProgram,
      pool: poolAddress,
      poolAuthority,
      baseVault: parsed.baseVault,
      quoteVault: parsed.quoteVault,
      seedOwner,
      ichorAta,
      nativeMint: nativeMint.mint,
    },
  };
  issuedSeedPlans.set(plan, {
    connection: params.connection,
    verifiedConfig: params.verifiedConfig,
    fingerprint: seedPlanFingerprint(plan),
  });
  return plan;
}

/**
 * Read-only canonical PumpSwap source/wSOL pool. Does not require a seed
 * owner or ICHOR balance. Missing pool throws PUMPSWAP_POOL_MISSING.
 */
export async function readCanonicalPumpSwapPoolSnapshot(params: {
  connection: Connection;
  verifiedConfig: VerifiedIchorConfig;
}): Promise<CanonicalPumpSwapReserves> {
  assertNoSecretMaterial(params, "readCanonicalPumpSwapPoolSnapshot");
  assertBoundIchorConnection(params.verifiedConfig, params.connection);
  const { config } = params.verifiedConfig;
  const verified = params.verifiedConfig.verifiedProgram.verified;
  const network = verified.network;
  const nativeMintKey = network.nativeMint;
  if (!nativeMintKey.equals(new PublicKey(NATIVE_MINT.id))) {
    throw new ClientValidationError("NATIVE_MINT", [
      `network.nativeMint ${nativeMintKey.toBase58()} is not the named wSOL mint`,
    ]);
  }
  const [baseMint, quoteMint] = await Promise.all([
    fetchMintSnapshot(params.connection, network, config.kekbullMint),
    fetchMintSnapshot(params.connection, network, nativeMintKey),
  ]);
  assertMintSnapshot(baseMint, "source");
  assertMintSnapshot(quoteMint, "wSOL");
  const poolAuthority = poolAuthorityPda(baseMint.mint);
  const poolAddress = canonicalPumpSwapPoolPda(baseMint.mint, quoteMint.mint);
  const poolInfo = await params.connection.getAccountInfo(poolAddress, "confirmed");
  if (poolInfo === null) {
    throw new ClientValidationError("PUMPSWAP_POOL_MISSING", [
      `canonical PumpSwap pool ${poolAddress.toBase58()} has no account`,
    ]);
  }
  const pumpSwapProgram = new PublicKey(PUMP_SWAP.id);
  if (!poolInfo.owner.equals(pumpSwapProgram)) {
    throw new ClientValidationError("PUMPSWAP_OWNER", [
      `${poolAddress.toBase58()} is owned by ${poolInfo.owner.toBase58()}, not PumpSwap`,
    ]);
  }
  const parsed = parsePumpSwapPoolLayout(asUint8(poolInfo.data));
  if (parsed.index !== CANONICAL_POOL_INDEX) {
    throw new ClientValidationError("POOL_INDEX_NONCANONICAL", [
      `pool index ${String(parsed.index)} is not the canonical ${String(CANONICAL_POOL_INDEX)}`,
    ]);
  }
  if (!parsed.baseMint.equals(baseMint.mint)) {
    throw new ClientValidationError("POOL_BASE_MINT", [
      `pool base mint ${parsed.baseMint.toBase58()} is not config source ${baseMint.mint.toBase58()}`,
    ]);
  }
  if (!parsed.quoteMint.equals(quoteMint.mint)) {
    throw new ClientValidationError("POOL_QUOTE_MINT", [
      `pool quote mint ${parsed.quoteMint.toBase58()} is not wSOL ${quoteMint.mint.toBase58()}`,
    ]);
  }
  const [baseVaultInfo, quoteVaultInfo] = await Promise.all([
    params.connection.getAccountInfo(parsed.baseVault, "confirmed"),
    params.connection.getAccountInfo(parsed.quoteVault, "confirmed"),
  ]);
  if (baseVaultInfo === null) {
    throw new ClientValidationError("VAULT_MISSING", [
      `base vault ${parsed.baseVault.toBase58()} has no account`,
    ]);
  }
  if (quoteVaultInfo === null) {
    throw new ClientValidationError("VAULT_MISSING", [
      `quote vault ${parsed.quoteVault.toBase58()} has no account`,
    ]);
  }
  const baseTokenProgram = requireKnownTokenProgram(
    baseVaultInfo.owner,
    network.tokenProgramId,
    network.token2022ProgramId,
    "baseVault",
  );
  const quoteTokenProgram = requireKnownTokenProgram(
    quoteVaultInfo.owner,
    network.tokenProgramId,
    network.token2022ProgramId,
    "quoteVault",
  );
  const baseVault = parseTokenAccount({
    ownerProgram: baseVaultInfo.owner,
    data: asUint8(baseVaultInfo.data),
    expectedMint: baseMint.mint,
    expectedTokenProgram: baseTokenProgram,
    label: "baseVault",
  });
  const quoteVault = parseTokenAccount({
    ownerProgram: quoteVaultInfo.owner,
    data: asUint8(quoteVaultInfo.data),
    expectedMint: quoteMint.mint,
    expectedTokenProgram: quoteTokenProgram,
    label: "quoteVault",
  });
  const effectiveQuote = effectiveQuoteLamports(quoteVault.amount, parsed.virtualQuoteReserves);
  return {
    pool: {
      address: poolAddress,
      owner: poolInfo.owner,
      creator: parsed.creator,
      poolAuthority,
      baseMint: parsed.baseMint,
      quoteMint: parsed.quoteMint,
      baseVault: parsed.baseVault,
      quoteVault: parsed.quoteVault,
      coinCreator: parsed.coinCreator,
      isMayhem: parsed.isMayhem,
      isCashback: parsed.isCashback,
      dataLength: parsed.dataLength,
      virtualQuoteReserves: parsed.virtualQuoteReserves,
      virtualQuotePresent: parsed.virtualQuotePresent,
      baseVaultAmount: baseVault.amount,
      quoteVaultAmount: quoteVault.amount,
      baseTokenProgram,
      quoteTokenProgram,
      effectiveQuoteLamports: effectiveQuote,
    },
    baseMint,
    quoteMint,
  };
}
