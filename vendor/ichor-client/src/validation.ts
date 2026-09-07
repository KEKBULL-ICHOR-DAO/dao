import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  ClientValidationError,
  type BootstrapCouncilConfig,
  type CommunityActivationConfig,
  type CommunityMintMaxVoteWeightSource,
  type IchorSolSeedAmounts,
  type MeteoraFeePlan,
  type MintSnapshot,
  type NetworkConfig,
} from "./types.ts";
import { REALMS_PROGRAM_VERSION } from "./network.ts";

const FORBIDDEN_KEY_FIELDS = [
  "secretKey",
  "privateKey",
  "privateKeyBase58",
  "seedPhrase",
  "mnemonic",
  "secret",
] as const;

/** Mint decimals are a u8. Scaling is operation-specific checked BN math, not a client cap. */
const U8_MAX = 255;
const MAX_BPS = 10_000;
/** Community cannot create proposals during bootstrap. Same value as u64 max. */
export const COMMUNITY_PROPOSAL_DISABLED = new BN("18446744073709551615");
export const U64_MAX = COMMUNITY_PROPOSAL_DISABLED;
/** u128 max bit width used by on-chain emission math. */
const U128_BITS = 128;

function isConnectionLike(value: object): boolean {
  return (
    typeof (value as { getAccountInfo?: unknown }).getAccountInfo === "function" &&
    typeof (value as { rpcEndpoint?: unknown }).rpcEndpoint === "string"
  );
}

export function collectForbiddenKeyFields(
  value: unknown,
  path = "",
  seen: WeakSet<object> = new WeakSet(),
): string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);
  // Vite's production bundle can load two @solana/web3.js copies. instanceof
  // Connection then fails and a walk of Connection internals is circular
  // (`_rpcWebSocket` → connection) - Maximum call stack size exceeded on
  // every client read that takes `{ connection }`. Duck-type plus a cycle
  // guard; do not rely on instanceof alone.
  // bn.js isBN reads num.constructor.wordSize and throws on null-prototype
  // objects (web3 Connection internals). instanceof is enough for our BNs.
  if (
    value instanceof PublicKey ||
    value instanceof BN ||
    value instanceof Uint8Array ||
    value instanceof Connection ||
    isConnectionLike(value)
  ) {
    return [];
  }
  if (Object.getPrototypeOf(value) === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => collectForbiddenKeyFields(item, `${path}[${i}]`, seen));
  }
  const record = value as Record<string, unknown>;
  const hits: string[] = [];
  for (const key of Object.keys(record)) {
    const next = path ? `${path}.${key}` : key;
    if ((FORBIDDEN_KEY_FIELDS as readonly string[]).includes(key)) {
      hits.push(next);
    }
    hits.push(...collectForbiddenKeyFields(record[key], next, seen));
  }
  return hits;
}

export function assertNoSecretMaterial(value: unknown, label: string): void {
  const hits = collectForbiddenKeyFields(value);
  if (hits.length > 0) {
    throw new ClientValidationError("SECRET_MATERIAL_REJECTED", [
      `${label} contains forbidden key fields: ${hits.join(", ")}`,
    ]);
  }
}

export function requirePublicKey(value: unknown, label: string): PublicKey {
  if (value instanceof PublicKey) {
    return value;
  }
  if (typeof value === "string") {
    try {
      return new PublicKey(value);
    } catch {
      throw new ClientValidationError("INVALID_PUBKEY", [`${label} is not a valid PublicKey`]);
    }
  }
  // @realms-today/spl-governance (and some @solana/spl-token builds) can return
  // a PublicKey from a different @solana/web3.js copy. instanceof then fails
  // even though toBase58() is the same 32-byte identity.
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  ) {
    return requirePublicKey((value as { toBase58: () => string }).toBase58(), label);
  }
  throw new ClientValidationError("INVALID_PUBKEY", [`${label} must be a PublicKey or base58 string`]);
}

export function requireBn(value: unknown, label: string): BN {
  if (typeof value === "number" || typeof value === "bigint") {
    throw new ClientValidationError("AMOUNT_MUST_BE_BN", [
      `${label} must be a BN. JavaScript number/bigint conversions are rejected.`,
    ]);
  }
  if (!BN.isBN(value)) {
    throw new ClientValidationError("AMOUNT_MUST_BE_BN", [`${label} must be a BN`]);
  }
  return value;
}

export function requirePositiveBn(value: unknown, label: string): BN {
  const amount = requireBn(value, label);
  if (amount.lte(new BN(0))) {
    throw new ClientValidationError("AMOUNT_NOT_POSITIVE", [`${label} must be > 0`]);
  }
  return amount;
}

export function requireNonNegativeBn(value: unknown, label: string): BN {
  const amount = requireBn(value, label);
  if (amount.isNeg()) {
    throw new ClientValidationError("AMOUNT_NEGATIVE", [`${label} must be >= 0`]);
  }
  return amount;
}

/** Non-negative integer that fits in a Solana/Anchor u64. */
export function requireU64Bn(value: unknown, label: string): BN {
  const amount = requireNonNegativeBn(value, label);
  if (amount.gt(U64_MAX)) {
    throw new ClientValidationError("AMOUNT_EXCEEDS_U64", [`${label} exceeds u64`]);
  }
  return amount;
}

/**
 * Deploy-time program identity. There is no placeholder ID. Default, System,
 * and other reserved protocol addresses are not a configured ICHOR program.
 */
export function requireConfiguredDeploymentAddress(
  value: unknown,
  label: string,
  reserved: readonly PublicKey[],
): PublicKey {
  if (value === undefined || value === null || value === "") {
    throw new ClientValidationError("PROGRAM_ID_UNCONFIGURED", [
      `${label} is unset; ICHOR program identity is deploy-time only`,
    ]);
  }
  const key = requirePublicKey(value, label);
  if (key.equals(PublicKey.default)) {
    throw new ClientValidationError("PROGRAM_ID_UNCONFIGURED", [
      `${label} is the default pubkey; ICHOR program identity is not configured`,
    ]);
  }
  for (const blocked of reserved) {
    if (key.equals(blocked)) {
      throw new ClientValidationError("PROGRAM_ID_RESERVED", [
        `${label} ${key.toBase58()} is a reserved protocol address, not the ICHOR program`,
      ]);
    }
  }
  return key;
}

/** `10^exp` with the same u128 overflow as `kekbull_ichor::math::ten_pow`. */
export function tenPowU8(exp: number): BN {
  if (!Number.isInteger(exp) || exp < 0 || exp > U8_MAX) {
    throw new ClientValidationError("MINT_DECIMALS", [
      `decimal exponent ${String(exp)} is not a valid u8`,
    ]);
  }
  let v = new BN(1);
  const ten = new BN(10);
  for (let i = 0; i < exp; i++) {
    v = requireU128(v.mul(ten), "10^decimals");
  }
  return v;
}

function requireU128(value: BN, label: string): BN {
  if (value.isNeg() || value.bitLength() > U128_BITS) {
    throw new ClientValidationError("ARITHMETIC_OVERFLOW", [`${label} overflows u128`]);
  }
  return value;
}

/**
 * Raw ICHOR from raw KEKBULL. Same integer identity as
 * `kekbull_ichor::math::ichor_from_kekbull`. Decimals are caller-supplied
 * from mint accounts - never assumed.
 */
export function ichorFromKekbull(params: {
  kekbullAmount: BN;
  kekbullDecimals: number;
  ichorDecimals: number;
  numerator: BN;
  denominator: BN;
}): BN {
  const kekbullAmount = requirePositiveBn(params.kekbullAmount, "kekbullAmount");
  const numerator = requirePositiveBn(params.numerator, "emissionNumerator");
  const denominator = requirePositiveBn(params.denominator, "emissionDenominator");
  if (numerator.gt(denominator)) {
    throw new ClientValidationError("RATIO_ABOVE_CEILING", [
      "emission ratio exceeds the 1:1 human-unit ceiling (numerator <= denominator)",
    ]);
  }
  if (
    !Number.isInteger(params.kekbullDecimals) ||
    params.kekbullDecimals < 0 ||
    params.kekbullDecimals > U8_MAX
  ) {
    throw new ClientValidationError("MINT_DECIMALS", [
      `KEKBULL decimals ${String(params.kekbullDecimals)} are not a valid u8`,
    ]);
  }
  if (
    !Number.isInteger(params.ichorDecimals) ||
    params.ichorDecimals < 0 ||
    params.ichorDecimals > U8_MAX
  ) {
    throw new ClientValidationError("MINT_DECIMALS", [
      `ICHOR decimals ${String(params.ichorDecimals)} are not a valid u8`,
    ]);
  }

  let scaleUp = new BN(1);
  let scaleDown = new BN(1);
  if (params.ichorDecimals > params.kekbullDecimals) {
    scaleUp = tenPowU8(params.ichorDecimals - params.kekbullDecimals);
  } else if (params.ichorDecimals < params.kekbullDecimals) {
    scaleDown = tenPowU8(params.kekbullDecimals - params.ichorDecimals);
  }

  const num = requireU128(
    requireU128(kekbullAmount.mul(numerator), "kekbull*numerator").mul(scaleUp),
    "kekbull*numerator*scaleUp",
  );
  const den = requireU128(denominator.mul(scaleDown), "denominator*scaleDown");
  const minted = num.div(den);
  if (minted.isZero()) {
    throw new ClientValidationError("CONVERSION_FLOORS_TO_ZERO", [
      "conversion would mint zero ICHOR after integer normalization",
    ]);
  }
  if (minted.gt(U64_MAX)) {
    throw new ClientValidationError("ARITHMETIC_OVERFLOW", ["minted ICHOR exceeds u64"]);
  }
  return minted;
}

export function assertKekbullIsToken2022(kekbull: MintSnapshot): void {
  if (kekbull.tokenProgramKind !== "token-2022") {
    throw new ClientValidationError("KEKBULL_TOKEN_PROGRAM", [
      `KEKBULL must be Token-2022; on-chain owner is ${kekbull.ownerProgram.toBase58()}`,
    ]);
  }
}

export function requireNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new ClientValidationError("INVALID_INT", [`${label} must be a non-negative safe integer`]);
  }
  return value;
}

export function requirePositiveInt(value: unknown, label: string): number {
  const n = requireNonNegativeInt(value, label);
  if (n === 0) {
    throw new ClientValidationError("INVALID_INT", [`${label} must be > 0`]);
  }
  return n;
}

export function requireBps(value: unknown, label: string): number {
  const n = requireNonNegativeInt(value, label);
  if (n > MAX_BPS) {
    throw new ClientValidationError("INVALID_BPS", [`${label} exceeds ${MAX_BPS}`]);
  }
  return n;
}

export function requirePercent(value: unknown, label: string): number {
  const n = requireNonNegativeInt(value, label);
  if (n > 100) {
    throw new ClientValidationError("INVALID_PERCENT", [`${label} must be 0-100`]);
  }
  return n;
}

/**
 * YesVotePercentage encoding range. SPL Governance rejects YesVotePercentage(0);
 * Disabled is a separate threshold type, not a zero percent.
 */
export function requireYesVotePercent(value: unknown, label: string): number {
  const n = requirePercent(value, label);
  if (n === 0) {
    throw new ClientValidationError("INVALID_YES_VOTE_PERCENT", [
      `${label} must be 1-100; YesVotePercentage(0) is rejected by SPL Governance - use Disabled for a disabled threshold`,
    ]);
  }
  return n;
}

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClientValidationError("INVALID_STRING", [`${label} must be a non-empty string`]);
  }
  return value;
}

export function assertNetworkConfig(network: NetworkConfig): void {
  if (network.programVersion !== REALMS_PROGRAM_VERSION) {
    throw new ClientValidationError("PROGRAM_VERSION", [
      `programVersion must be ${REALMS_PROGRAM_VERSION}; got ${String(network.programVersion)}`,
    ]);
  }
  requirePublicKey(network.realmsProgramId, "network.realmsProgramId");
  requirePublicKey(network.meteoraCpAmmProgramId, "network.meteoraCpAmmProgramId");
  if (
    network.cluster !== "devnet" &&
    network.cluster !== "mainnet-beta" &&
    network.cluster !== "localnet"
  ) {
    throw new ClientValidationError("UNKNOWN_CLUSTER", [`cluster ${String(network.cluster)} is not named`]);
  }
}

export function assertMintSnapshot(mint: MintSnapshot, label: string): void {
  if (!mint.isInitialized) {
    throw new ClientValidationError("MINT_UNINITIALIZED", [`${label} is not initialized`]);
  }
  if (!Number.isInteger(mint.decimals) || mint.decimals < 0 || mint.decimals > U8_MAX) {
    throw new ClientValidationError("MINT_DECIMALS", [
      `${label} decimals ${String(mint.decimals)} are not a valid u8`,
    ]);
  }
  if (mint.tokenProgramKind !== "legacy-spl" && mint.tokenProgramKind !== "token-2022") {
    throw new ClientValidationError("MINT_OWNER", [`${label} owner is not a known token program`]);
  }
}

export function assertIchorIsToken2022(ichor: MintSnapshot): void {
  if (ichor.tokenProgramKind !== "token-2022") {
    throw new ClientValidationError("ICHOR_TOKEN_PROGRAM", [
      `ICHOR must be Token-2022; on-chain owner is ${ichor.ownerProgram.toBase58()}`,
    ]);
  }
}

export function assertLegacySplMint(mint: MintSnapshot, label: string): void {
  if (mint.tokenProgramKind !== "legacy-spl") {
    throw new ClientValidationError("INVALID_TOKEN_PROGRAM", [
      `${label} must be legacy SPL; on-chain owner is ${mint.ownerProgram.toBase58()}`,
    ]);
  }
}

export function assertSeedAmounts(amounts: IchorSolSeedAmounts): void {
  requirePositiveBn(amounts.ichorAmount, "amounts.ichorAmount");
  requirePositiveBn(amounts.solAmount, "amounts.solAmount");
}

export function assertFeePlan(fee: MeteoraFeePlan): void {
  requireBps(fee.startingFeeBps, "fee.startingFeeBps");
  requireBps(fee.endingFeeBps, "fee.endingFeeBps");
  requireNonNegativeInt(fee.numberOfPeriod, "fee.numberOfPeriod");
  requireNonNegativeInt(fee.totalDuration, "fee.totalDuration");
  if (fee.scheduler !== "linear" && fee.scheduler !== "exponential") {
    throw new ClientValidationError("FEE_SCHEDULER", [
      "fee.scheduler must be linear or exponential; RateLimiter is rejected for new pools",
    ]);
  }
  if (fee.endingFeeBps > fee.startingFeeBps) {
    throw new ClientValidationError("FEE_PLAN_SHAPE", [
      "fee.endingFeeBps must be <= fee.startingFeeBps; refuse to invent a decay",
    ]);
  }
  const flat = fee.startingFeeBps === fee.endingFeeBps;
  if (flat) {
    if (fee.numberOfPeriod !== 0 || fee.totalDuration !== 0) {
      throw new ClientValidationError("FEE_PLAN_SHAPE", [
        "flat fee plan (startingFeeBps === endingFeeBps) requires numberOfPeriod === 0 and totalDuration === 0; SDK getFeeTimeSchedulerParams throws otherwise",
      ]);
    }
  } else {
    if (fee.numberOfPeriod <= 0 || fee.totalDuration <= 0) {
      throw new ClientValidationError("FEE_PLAN_SHAPE", [
        "decaying fee plan requires numberOfPeriod > 0 and totalDuration > 0",
      ]);
    }
    // SDK: periodFrequency = new BN(totalDuration / numberOfPeriod) - JS division
    // truncates before BN; 300/46 → 6 so on-chain duration is 276s, not 300s.
    if (fee.totalDuration % fee.numberOfPeriod !== 0) {
      throw new ClientValidationError("FEE_PLAN_PERIOD_FREQUENCY", [
        `fee.totalDuration (${String(fee.totalDuration)}) must be divisible by fee.numberOfPeriod (${String(fee.numberOfPeriod)}); SDK truncates totalDuration/numberOfPeriod silently`,
      ]);
    }
  }
  if (fee.dynamicFeeBaseBps !== undefined) {
    requireBps(fee.dynamicFeeBaseBps, "fee.dynamicFeeBaseBps");
  }
}

const COMMUNITY_MINT_MAX_VOTE_WEIGHT_SOURCE_KEYS = ["type", "value"] as const;

/**
 * Required community max voter-weight source. No default.
 * `fullSupplyFractionValue` is the SDK FULL_SUPPLY constant the caller read -
 * this function does not invent that number. SupplyFraction equal to that
 * constant is UNREACHABLE_QUORUM_DENOMINATOR.
 */
export function requireReachableMintMaxVoteWeightSource(
  value: unknown,
  fullSupplyFractionValue: BN,
  label = "communityMintMaxVoteWeightSource",
): CommunityMintMaxVoteWeightSource {
  const fullSupply = requirePositiveBn(fullSupplyFractionValue, "FULL_SUPPLY_FRACTION.value");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ClientValidationError("INVALID_MINT_MAX_VOTE_WEIGHT_SOURCE", [
      `${label} must be { type: "absolute"|"supply-fraction", value: BN }`,
    ]);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => !(COMMUNITY_MINT_MAX_VOTE_WEIGHT_SOURCE_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new ClientValidationError("INVALID_MINT_MAX_VOTE_WEIGHT_SOURCE", [
      `${label} has unknown field(s): ${unknown.sort().join(", ")}`,
    ]);
  }
  for (const key of COMMUNITY_MINT_MAX_VOTE_WEIGHT_SOURCE_KEYS) {
    if (!(key in record)) {
      throw new ClientValidationError("INVALID_MINT_MAX_VOTE_WEIGHT_SOURCE", [
        `${label} missing required field ${key}`,
      ]);
    }
  }
  if (record.type !== "absolute" && record.type !== "supply-fraction") {
    throw new ClientValidationError("INVALID_MINT_MAX_VOTE_WEIGHT_SOURCE", [
      `${label}.type must be "absolute" or "supply-fraction"`,
    ]);
  }
  const amount = requirePositiveBn(record.value, `${label}.value`);
  if (record.type === "supply-fraction") {
    if (amount.gte(fullSupply)) {
      throw new ClientValidationError("UNREACHABLE_QUORUM_DENOMINATOR", [
        `${label} must not be FULL_SUPPLY_FRACTION; locked LP and treasury ICHOR cannot vote`,
      ]);
    }
  }
  return { type: record.type, value: amount };
}

export function assertBootstrapCouncil(council: BootstrapCouncilConfig): void {
  requirePublicKey(council.councilMint, "council.councilMint");
  if ("communityVoteThresholdPercent" in council || "minCommunityTokensToCreateProposal" in council) {
    throw new ClientValidationError("BOOTSTRAP_COMMUNITY_LOCKED", [
      "bootstrap council config cannot set community vote threshold or community proposal minimum; community is Disabled / u64-max until activation",
    ]);
  }
  requireYesVotePercent(council.councilVoteThresholdPercent, "council.councilVoteThresholdPercent");
  requireYesVotePercent(
    council.councilVetoVoteThresholdPercent,
    "council.councilVetoVoteThresholdPercent",
  );
  requirePositiveBn(council.minCouncilTokensToCreateProposal, "council.minCouncilTokensToCreateProposal");
  requirePositiveBn(council.minCommunityWeightToCreateGovernance, "council.minCommunityWeightToCreateGovernance");
  requirePositiveInt(council.baseVotingTime, "council.baseVotingTime");
  requirePositiveInt(council.minInstructionHoldUpTime, "council.minInstructionHoldUpTime");
  requireNonNegativeInt(council.votingCoolOffTime, "council.votingCoolOffTime");
  requireNonNegativeInt(council.depositExemptProposalCount, "council.depositExemptProposalCount");
}

export function assertCommunityActivation(config: CommunityActivationConfig): void {
  requireYesVotePercent(
    config.communityVoteThresholdPercent,
    "activation.communityVoteThresholdPercent",
  );
  requirePositiveBn(config.minCommunityTokensToCreateProposal, "activation.minCommunityTokensToCreateProposal");
  if (config.minCommunityTokensToCreateProposal.eq(COMMUNITY_PROPOSAL_DISABLED)) {
    throw new ClientValidationError("COMMUNITY_ACTIVATION", [
      "community enablement cannot keep proposal creation at u64 max",
    ]);
  }
  if (config.councilVoteThresholdPercent !== undefined) {
    requireYesVotePercent(config.councilVoteThresholdPercent, "activation.councilVoteThresholdPercent");
  }
  if (config.councilVetoVoteThresholdPercent !== undefined) {
    requireYesVotePercent(
      config.councilVetoVoteThresholdPercent,
      "activation.councilVetoVoteThresholdPercent",
    );
  }
  requirePositiveBn(config.minCouncilTokensToCreateProposal, "activation.minCouncilTokensToCreateProposal");
  requirePositiveInt(config.baseVotingTime, "activation.baseVotingTime");
  requirePositiveInt(config.minInstructionHoldUpTime, "activation.minInstructionHoldUpTime");
  requireNonNegativeInt(config.votingCoolOffTime, "activation.votingCoolOffTime");
  requireNonNegativeInt(config.depositExemptProposalCount, "activation.depositExemptProposalCount");
}

export function assertExpectedLock(params: {
  permanentLockedLiquidity: BN;
  unlockedLiquidity: BN;
  expectedLiquidity: BN;
}): true {
  requireBn(params.permanentLockedLiquidity, "permanentLockedLiquidity");
  requireBn(params.unlockedLiquidity, "unlockedLiquidity");
  requirePositiveBn(params.expectedLiquidity, "expectedLiquidity");
  if (
    !params.permanentLockedLiquidity.eq(params.expectedLiquidity) ||
    !params.unlockedLiquidity.isZero()
  ) {
    throw new ClientValidationError("LOCK_MISMATCH", [
      `permanentLockedLiquidity ${params.permanentLockedLiquidity.toString()} unlockedLiquidity ${params.unlockedLiquidity.toString()} expectedLiquidity ${params.expectedLiquidity.toString()}; expected a full permanent lock and zero unlocked`,
    ]);
  }
  return true;
}
