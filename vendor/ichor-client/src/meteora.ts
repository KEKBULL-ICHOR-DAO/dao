import {
  ActivationType,
  BaseFeeMode,
  calculateTransferFeeExcludedAmount,
  CollectFeeMode,
  CpAmm,
  CP_AMM_PROGRAM_ID,
  derivePositionAddress,
  derivePositionNftAccount,
  getBaseFeeParams,
  getDynamicFeeParams,
  hasTransferHookExtension,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  validateNoTransferHook,
} from "@meteora-ag/cp-amm-sdk";
import { getNativeTreasuryAddress } from "@realms-today/spl-governance";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { Transaction, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { fetchMintSnapshot } from "./mint.ts";
import { METEORA_CP_AMM, TOKEN_2022_PROGRAM } from "./network.ts";
import { assertBoundConnection } from "./preflight.ts";
import { assertIchorSolSeedPlan } from "./pricing.ts";
import { assertIssuedIdentityMatchesCommittedDaoDestination } from "./fees.ts";
import { assertVerifiedGovernanceIdentity } from "./realms.ts";
import type {
  BuildIchorSolPoolParams,
  ClaimFeesToTreasuryBuild,
  ClaimFeesToTreasuryParams,
  IchorSolPoolBootstrap,
  MeteoraFeePlan,
  LockedDammPoolTokens,
  PermanentLockVerification,
  UnsignedTransactionBuild,
  VerifiedGovernanceIdentity,
  VerifiedIchorConfig,
  VerifiedNetwork,
} from "./types.ts";
import { ClientValidationError } from "./types.ts";
import {
  assertExpectedLock,
  assertFeePlan,
  assertIchorIsToken2022,
  assertNoSecretMaterial,
  assertSeedAmounts,
  requirePublicKey,
} from "./validation.ts";
import {
  mintHasTransferHook,
  parseIchorTransferFeeConfig,
} from "./extensions.ts";

/** Official DAMM v2 position NFT: decimals 0, supply 1. Transfer amount is this live supply. */
const POSITION_NFT_SUPPLY = new BN(1);

const CALLER_TREASURY_FIELDS = ["realmsTreasury", "treasury", "nativeTreasury"] as const;
const CALLER_CLAIM_OWNER_FIELDS = ["owner", "positionNftAccount", ...CALLER_TREASURY_FIELDS] as const;

/**
 * Transfer-affecting Token-2022 mint extensions that remain unsupported on
 * the DAMM v2 position NFT. ICHOR's approved TransferFeeConfig is handled
 * separately and is never rejected here.
 */
const UNSUPPORTED_POSITION_NFT_EXTENSIONS: ReadonlyMap<ExtensionType, string> = new Map([
  [ExtensionType.TransferFeeConfig, "TransferFeeConfig"],
  [ExtensionType.ConfidentialTransferMint, "ConfidentialTransferMint"],
  [ExtensionType.DefaultAccountState, "DefaultAccountState"],
  [ExtensionType.NonTransferable, "NonTransferable"],
  [ExtensionType.TransferHook, "TransferHook"],
]);

function requireSdkBn(value: unknown, label: string): BN {
  if (BN.isBN(value)) {
    return value;
  }
  throw new ClientValidationError("CHAIN_VALUE_NOT_BN", [
    `${label} is missing or not a BN on the position account`,
  ]);
}

function collectFeeModeFromNumber(mode: 0 | 1): CollectFeeMode {
  if (mode === 0) return CollectFeeMode.BothToken;
  return CollectFeeMode.OnlyB;
}

function assertMeteoraProgramId(verified: VerifiedNetwork, connection: Connection): void {
  assertBoundConnection(verified, connection);
  const named = verified.network.meteoraCpAmmProgramId;
  if (!named.equals(CP_AMM_PROGRAM_ID) || named.toBase58() !== METEORA_CP_AMM.id) {
    throw new ClientValidationError("PROGRAM_ID_MISMATCH", [
      `SDK CP_AMM_PROGRAM_ID ${CP_AMM_PROGRAM_ID.toBase58()} / network ${named.toBase58()} is not named ${METEORA_CP_AMM.id}`,
    ]);
  }
}

function assertNoCallerTreasurySubstitution(
  params: object,
  label: string,
  fields: readonly string[] = CALLER_TREASURY_FIELDS,
): void {
  const hits = fields.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError("CALLER_TREASURY", [
      `${label} derives the Realms native treasury from issued VerifiedGovernance; ${hits.join(", ")} cannot substitute`,
    ]);
  }
}

function requireIssuedGovernance(params: {
  connection: Connection;
  verifiedGovernance: VerifiedGovernanceIdentity;
}): VerifiedNetwork {
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  const verified = params.verifiedGovernance.verifiedRealm.verified;
  assertMeteoraProgramId(verified, params.connection);
  return verified;
}

/**
 * Realms native treasury PDA from an issued VerifiedGovernance. The caller
 * cannot pass a substitute treasury address.
 */
export async function deriveVerifiedNativeTreasury(
  verifiedGovernance: VerifiedGovernanceIdentity,
): Promise<PublicKey> {
  assertNoSecretMaterial(verifiedGovernance, "deriveVerifiedNativeTreasury");
  assertVerifiedGovernanceIdentity(verifiedGovernance);
  return getNativeTreasuryAddress(
    verifiedGovernance.verifiedRealm.verified.network.realmsProgramId,
    verifiedGovernance.governance,
  );
}

function canonicalAta(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}

function rejectPositionNftTransferExtensions(tlvData: ReturnType<typeof unpackMint>["tlvData"]): void {
  const types = getExtensionTypes(tlvData);
  const hits = types
    .filter((type) => UNSUPPORTED_POSITION_NFT_EXTENSIONS.has(type))
    .map((type) => UNSUPPORTED_POSITION_NFT_EXTENSIONS.get(type) ?? String(type));
  if (hits.length > 0) {
    throw new ClientValidationError("UNSUPPORTED_TOKEN_EXTENSION", [
      `position NFT mint carries ${hits.join(", ")}; TransferChecked extra accounts/amounts will not be guessed`,
    ]);
  }
}

async function requireNoActiveTransferHook(connection: Connection, mint: PublicKey, label: string): Promise<void> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (info === null) {
    throw new ClientValidationError("MINT_MISSING", [`${label} ${mint.toBase58()} has no account`]);
  }
  const data = info.data instanceof Uint8Array ? info.data : new Uint8Array(info.data);
  if (mintHasTransferHook(data)) {
    throw new ClientValidationError("TRANSFER_HOOK_ACTIVE", [
      `${label} carries an active TransferHook; DAMM v2 pool creation cannot satisfy hook extra accounts`,
    ]);
  }
  const sdk = await hasTransferHookExtension(connection, mint);
  if (sdk.hasTransferHook) {
    throw new ClientValidationError("TRANSFER_HOOK_ACTIVE", [
      `${label} SDK hasTransferHookExtension reported an active TransferHook`,
    ]);
  }
}

async function fetchPositionNftMint(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  positionNftMint: PublicKey;
}): Promise<{
  mint: PublicKey;
  ownerProgram: PublicKey;
  decimals: number;
  supply: BN;
}> {
  const snapshot = await fetchMintSnapshot(
    params.connection,
    params.verified.network,
    params.positionNftMint,
  );
  if (snapshot.tokenProgramKind !== "token-2022" || snapshot.ownerProgram.toBase58() !== TOKEN_2022_PROGRAM.id) {
    throw new ClientValidationError("POSITION_NFT_TOKEN_PROGRAM", [
      `DAMM v2 position NFTs are Token-2022; mint owner ${snapshot.ownerProgram.toBase58()} is not ${TOKEN_2022_PROGRAM.id}`,
    ]);
  }
  if (snapshot.decimals !== 0) {
    throw new ClientValidationError("POSITION_NFT_DECIMALS", [
      `position NFT mint decimals ${String(snapshot.decimals)} are not the documented 0`,
    ]);
  }
  if (!snapshot.supply.eq(POSITION_NFT_SUPPLY)) {
    throw new ClientValidationError("POSITION_NFT_SUPPLY", [
      `position NFT mint supply ${snapshot.supply.toString()} is not the documented 1`,
    ]);
  }
  const info = await params.connection.getAccountInfo(snapshot.mint, "confirmed");
  if (info === null) {
    throw new ClientValidationError("MINT_MISSING", [`mint ${snapshot.mint.toBase58()} has no account`]);
  }
  if (!info.owner.equals(snapshot.ownerProgram)) {
    throw new ClientValidationError("POSITION_NFT_TOKEN_PROGRAM", [
      `mint owner ${info.owner.toBase58()} changed from snapshot ${snapshot.ownerProgram.toBase58()}`,
    ]);
  }
  const parsed = unpackMint(snapshot.mint, info, snapshot.ownerProgram);
  if (parsed.decimals !== snapshot.decimals) {
    throw new ClientValidationError("POSITION_NFT_DECIMALS", [
      `re-read mint decimals ${String(parsed.decimals)} do not match snapshot ${String(snapshot.decimals)}`,
    ]);
  }
  if (!new BN(parsed.supply.toString()).eq(snapshot.supply)) {
    throw new ClientValidationError("POSITION_NFT_SUPPLY", [
      `re-read mint supply ${parsed.supply.toString()} does not match snapshot ${snapshot.supply.toString()}`,
    ]);
  }
  rejectPositionNftTransferExtensions(parsed.tlvData);
  return {
    mint: snapshot.mint,
    ownerProgram: snapshot.ownerProgram,
    decimals: snapshot.decimals,
    supply: snapshot.supply,
  };
}

function parseTokenAccount(params: {
  address: PublicKey;
  info: NonNullable<Awaited<ReturnType<Connection["getAccountInfo"]>>>;
  expectedMint: PublicKey;
  expectedOwner: PublicKey;
  expectedTokenProgram: PublicKey;
  label: string;
}): { mint: PublicKey; owner: PublicKey; amount: BN } {
  if (!params.info.owner.equals(params.expectedTokenProgram)) {
    throw new ClientValidationError("INVALID_TOKEN_ACCOUNT_OWNER", [
      `${params.label} owner program ${params.info.owner.toBase58()} is not ${params.expectedTokenProgram.toBase58()}`,
    ]);
  }
  const parsed = unpackAccount(params.address, params.info, params.expectedTokenProgram);
  if (!parsed.mint.equals(params.expectedMint)) {
    throw new ClientValidationError("TOKEN_ACCOUNT_MINT_MISMATCH", [
      `${params.label} mint ${parsed.mint.toBase58()} is not ${params.expectedMint.toBase58()}`,
    ]);
  }
  if (!parsed.owner.equals(params.expectedOwner)) {
    throw new ClientValidationError("TOKEN_ACCOUNT_OWNER_MISMATCH", [
      `${params.label} owner ${parsed.owner.toBase58()} is not ${params.expectedOwner.toBase58()}`,
    ]);
  }
  if (parsed.isFrozen) {
    throw new ClientValidationError("TOKEN_ACCOUNT_FROZEN", [`${params.label} is frozen`]);
  }
  return {
    mint: parsed.mint,
    owner: parsed.owner,
    amount: new BN(parsed.amount.toString()),
  };
}

async function readTokenAccount(params: {
  connection: Connection;
  address: PublicKey;
  expectedMint: PublicKey;
  expectedOwner: PublicKey;
  expectedTokenProgram: PublicKey;
  label: string;
  allowMissing: boolean;
  missingCode: string;
}): Promise<{ mint: PublicKey; owner: PublicKey; amount: BN } | null> {
  const info = await params.connection.getAccountInfo(params.address, "confirmed");
  if (info === null) {
    if (params.allowMissing) {
      return null;
    }
    throw new ClientValidationError(params.missingCode, [
      `${params.label} ${params.address.toBase58()} has no account`,
    ]);
  }
  return parseTokenAccount({
    address: params.address,
    info,
    expectedMint: params.expectedMint,
    expectedOwner: params.expectedOwner,
    expectedTokenProgram: params.expectedTokenProgram,
    label: params.label,
  });
}

async function readVaultTokenAmount(params: {
  connection: Connection;
  address: PublicKey;
  expectedMint: PublicKey;
  expectedTokenProgram: PublicKey;
  label: string;
}): Promise<BN> {
  const info = await params.connection.getAccountInfo(params.address, "confirmed");
  if (info === null) {
    throw new ClientValidationError("VAULT_MISSING", [
      `${params.label} ${params.address.toBase58()} has no account`,
    ]);
  }
  if (!info.owner.equals(params.expectedTokenProgram)) {
    throw new ClientValidationError("INVALID_TOKEN_ACCOUNT_OWNER", [
      `${params.label} owner program ${info.owner.toBase58()} is not ${params.expectedTokenProgram.toBase58()}`,
    ]);
  }
  const parsed = unpackAccount(params.address, info, params.expectedTokenProgram);
  if (!parsed.mint.equals(params.expectedMint)) {
    throw new ClientValidationError("TOKEN_ACCOUNT_MINT_MISMATCH", [
      `${params.label} mint ${parsed.mint.toBase58()} is not ${params.expectedMint.toBase58()}`,
    ]);
  }
  if (parsed.isFrozen) {
    throw new ClientValidationError("TOKEN_ACCOUNT_FROZEN", [`${params.label} is frozen`]);
  }
  return new BN(parsed.amount.toString());
}

/**
 * 1.4.6 `getBaseFeeParams` takes a single object. RateLimiter is rejected for
 * new pools. Docs pages still show the removed tokenBDecimal/activationType
 * arguments - do not call that form.
 */
export function encodePoolFees(fee: MeteoraFeePlan): {
  baseFee: ReturnType<typeof getBaseFeeParams>;
  compoundingFeeBps: number;
  padding: number;
  dynamicFee: ReturnType<typeof getDynamicFeeParams> | null;
} {
  assertFeePlan(fee);
  const baseFeeMode =
    fee.scheduler === "exponential"
      ? BaseFeeMode.FeeTimeSchedulerExponential
      : BaseFeeMode.FeeTimeSchedulerLinear;
  const baseFee = getBaseFeeParams({
    baseFeeMode,
    feeTimeSchedulerParam: {
      startingFeeBps: fee.startingFeeBps,
      endingFeeBps: fee.endingFeeBps,
      numberOfPeriod: fee.numberOfPeriod,
      totalDuration: fee.totalDuration,
    },
  });
  return {
    baseFee,
    compoundingFeeBps: 0,
    padding: 0,
    dynamicFee:
      fee.dynamicFeeBaseBps === undefined ? null : getDynamicFeeParams(fee.dynamicFeeBaseBps),
  };
}

/**
 * Unsigned ICHOR/SOL DAMM v2 custom pool. Token A is ICHOR, token B is the
 * live native mint. Amounts and mint metadata are required; nothing is priced
 * here. `isLockLiquidity` is always true.
 */
export async function buildIchorSolPool(params: BuildIchorSolPoolParams): Promise<IchorSolPoolBootstrap> {
  assertNoSecretMaterial(params, "buildIchorSolPool");
  assertIchorSolSeedPlan(params.seedPlan, params.connection);
  const verified = params.seedPlan.verifiedConfig.verifiedProgram.verified;
  const amounts = {
    ichorAmount: params.seedPlan.ichorGrossAmount,
    solAmount: params.seedPlan.adjustedSolLamports,
  };
  assertMeteoraProgramId(verified, params.connection);
  assertSeedAmounts(amounts);
  assertFeePlan(params.fee);
  requirePublicKey(params.payer, "payer");
  requirePublicKey(params.creator, "creator");
  requirePublicKey(params.positionNftMint, "positionNftMint");
  requirePublicKey(params.seedPlan.ichorMint.mint, "ichorMint");
  if (!params.creator.equals(params.payer)) {
    throw new ClientValidationError("CREATOR_PAYER_MISMATCH", [
      "atomic permanent-lock bootstrap requires creator==payer (approved bootstrap wallet)",
    ]);
  }

  if (params.activationType !== 0 && params.activationType !== 1) {
    throw new ClientValidationError("ACTIVATION_TYPE", ["activationType must be 0 (slot) or 1 (timestamp)"]);
  }
  if (params.collectFeeMode !== 0 && params.collectFeeMode !== 1) {
    throw new ClientValidationError("COLLECT_FEE_MODE", [
      "collectFeeMode must be 0 (BothToken) or 1 (OnlyB); mode 2 (Compounding) is refused because encodePoolFees hardcodes compoundingFeeBps: 0 and SDK validateCompoundingFee requires compoundingFeeBps > 0 for Compounding",
    ]);
  }

  const [ichorMint, solMint] = await Promise.all([
    fetchMintSnapshot(params.connection, verified.network, params.seedPlan.ichorMint.mint),
    fetchMintSnapshot(params.connection, verified.network, NATIVE_MINT),
  ]);
  assertIchorIsToken2022(ichorMint);
  if (!solMint.mint.equals(verified.network.nativeMint) && !solMint.mint.equals(NATIVE_MINT)) {
    throw new ClientValidationError("SOL_MINT", [
      `native mint ${solMint.mint.toBase58()} is not the named wrapped-SOL mint`,
    ]);
  }
  await requireNoActiveTransferHook(params.connection, ichorMint.mint, "ICHOR");
  await requireNoActiveTransferHook(params.connection, solMint.mint, "wSOL");
  await validateNoTransferHook(params.connection, ichorMint.mint, solMint.mint);

  const ichorInfo = await params.connection.getAccountInfo(ichorMint.mint, "confirmed");
  if (ichorInfo === null) {
    throw new ClientValidationError("MINT_MISSING", [`ICHOR mint ${ichorMint.mint.toBase58()} has no account`]);
  }
  const ichorBytes = ichorInfo.data instanceof Uint8Array ? ichorInfo.data : new Uint8Array(ichorInfo.data);
  parseIchorTransferFeeConfig(ichorBytes);
  const epochInfo = await params.connection.getEpochInfo("confirmed");
  if (!Number.isSafeInteger(epochInfo.epoch) || epochInfo.epoch < 0) {
    throw new ClientValidationError("EPOCH_UNAVAILABLE", [
      "confirmed epoch is not a safe non-negative integer",
    ]);
  }
  const tokenAMintAccount = unpackMint(ichorMint.mint, ichorInfo, TOKEN_2022_PROGRAM_ID);
  const tokenAFee = calculateTransferFeeExcludedAmount(
    amounts.ichorAmount,
    tokenAMintAccount,
    epochInfo.epoch,
  );
  if (!BN.isBN(tokenAFee.amount) || !BN.isBN(tokenAFee.transferFee)) {
    throw new ClientValidationError("TRANSFER_FEE", [
      "calculateTransferFeeExcludedAmount did not return BN amount and transferFee",
    ]);
  }
  if (
    !tokenAFee.transferFee.eq(params.seedPlan.ichorExpectedTransferFee) ||
    !tokenAFee.amount.eq(params.seedPlan.ichorNetAmount)
  ) {
    throw new ClientValidationError("SEED_PLAN_FEE_DRIFT", [
      "live epoch transfer fee no longer matches the issued seed plan; rebuild pricing before pool creation",
    ]);
  }

  const collectFeeMode = collectFeeModeFromNumber(params.collectFeeMode);
  const cpAmm = new CpAmm(params.connection);
  const prepared = cpAmm.preparePoolCreationParams({
    tokenAAmount: amounts.ichorAmount,
    tokenBAmount: amounts.solAmount,
    minSqrtPrice: MIN_SQRT_PRICE,
    maxSqrtPrice: MAX_SQRT_PRICE,
    tokenAInfo: {
      mint: tokenAMintAccount,
      currentEpoch: epochInfo.epoch,
    },
    collectFeeMode,
  });
  if (!BN.isBN(prepared.initSqrtPrice) || !BN.isBN(prepared.liquidityDelta)) {
    throw new ClientValidationError("PREPARE_POOL", [
      "preparePoolCreationParams did not return BN initSqrtPrice and liquidityDelta",
    ]);
  }
  if (prepared.liquidityDelta.lte(new BN(0))) {
    throw new ClientValidationError("PREPARE_POOL", ["preparePoolCreationParams returned non-positive liquidity"]);
  }

  const poolFees = encodePoolFees(params.fee);
  const created = await cpAmm.createCustomPool({
    payer: params.payer,
    creator: params.creator,
    positionNft: params.positionNftMint,
    tokenAMint: ichorMint.mint,
    tokenBMint: NATIVE_MINT,
    tokenAAmount: amounts.ichorAmount,
    tokenBAmount: amounts.solAmount,
    sqrtMinPrice: MIN_SQRT_PRICE,
    sqrtMaxPrice: MAX_SQRT_PRICE,
    initSqrtPrice: prepared.initSqrtPrice,
    liquidityDelta: prepared.liquidityDelta,
    poolFees,
    hasAlphaVault: false,
    activationType: params.activationType,
    collectFeeMode: params.collectFeeMode,
    activationPoint: params.activationPoint,
    tokenAProgram: ichorMint.ownerProgram,
    tokenBProgram: solMint.ownerProgram,
    isLockLiquidity: true,
  });

  return {
    unsigned: {
      transaction: created.tx,
      instructions: created.tx.instructions,
      requiredSignerPubkeys: [params.payer, params.positionNftMint],
    },
    pool: created.pool,
    position: created.position,
    positionNftMint: params.positionNftMint,
    tokenAMint: ichorMint.mint,
    tokenBMint: NATIVE_MINT,
    tokenAProgram: ichorMint.ownerProgram,
    tokenBProgram: solMint.ownerProgram,
    ichorMint,
    solMint,
    initSqrtPrice: prepared.initSqrtPrice,
    liquidityDelta: prepared.liquidityDelta,
    isLockLiquidity: true,
    tokenAGrossAmount: amounts.ichorAmount,
    tokenAExpectedFee: tokenAFee.transferFee,
    tokenANetAmount: tokenAFee.amount,
  };
}

export function expectedPositionAddress(positionNftMint: PublicKey): PublicKey {
  return derivePositionAddress(positionNftMint);
}

export function expectedPositionNftAccount(positionNftMint: PublicKey): PublicKey {
  return derivePositionNftAccount(positionNftMint);
}

/** Canonical Token-2022 ATA for a treasury-held DAMM v2 position NFT. */
export function expectedTreasuryPositionNftAta(
  positionNftMint: PublicKey,
  treasury: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  return canonicalAta(positionNftMint, treasury, tokenProgram);
}

/**
 * Read the lock from Meteora position state. Scanner icons are not used.
 * `expectedLiquidity` must be the BN returned at bootstrap (`liquidityDelta`).
 */
export async function verifyPermanentLock(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  position: PublicKey;
  expectedLiquidity: BN;
}): Promise<PermanentLockVerification> {
  assertNoSecretMaterial(params, "verifyPermanentLock");
  assertMeteoraProgramId(params.verified, params.connection);
  requirePublicKey(params.position, "position");
  const cpAmm = new CpAmm(params.connection);
  const state = await cpAmm.fetchPositionState(params.position);
  const unlockedLiquidity = requireSdkBn(state.unlockedLiquidity, "position.unlockedLiquidity");
  const vestedLiquidity = requireSdkBn(state.vestedLiquidity, "position.vestedLiquidity");
  const permanentLockedLiquidity = requireSdkBn(
    state.permanentLockedLiquidity,
    "position.permanentLockedLiquidity",
  );
  if (!vestedLiquidity.isZero()) {
    throw new ClientValidationError("LOCK_MISMATCH", [
      `position has ${vestedLiquidity.toString()} vested liquidity; expected zero for a permanent lock`,
    ]);
  }
  const liquidity = unlockedLiquidity.add(vestedLiquidity).add(permanentLockedLiquidity);
  assertExpectedLock({
    permanentLockedLiquidity,
    unlockedLiquidity,
    expectedLiquidity: params.expectedLiquidity,
  });
  return {
    position: params.position,
    pool: state.pool,
    liquidity,
    unlockedLiquidity,
    vestedLiquidity,
    permanentLockedLiquidity,
    expectedLiquidity: params.expectedLiquidity,
    isFullyPermanentlyLocked: true,
  };
}

function requireProtocolFeePercent(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : BN.isBN(value)
        ? value.toNumber()
        : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    throw new ClientValidationError("PROTOCOL_FEE_PERCENT", [
      `poolFees.protocolFeePercent ${String(value)} is not an integer 0-100`,
    ]);
  }
  return n;
}

/**
 * Token amounts sitting in the DAMM vaults behind a verified permanent lock.
 * These are account balances, not liquidityDelta. Token A must be ICHOR and
 * token B must be wSOL - the product pool shape. The derived treasury ATA
 * must hold exactly one position NFT, and the position address must be
 * `derivePositionAddress(positionNftMint)`.
 */
export async function readLockedDammPoolTokens(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  verifiedGovernance: VerifiedGovernanceIdentity;
  position: PublicKey;
  positionNftMint: PublicKey;
  expectedLiquidity: BN;
  ichorMint: PublicKey;
}): Promise<LockedDammPoolTokens> {
  assertNoSecretMaterial(params, "readLockedDammPoolTokens");
  assertNoCallerTreasurySubstitution(params, "readLockedDammPoolTokens");
  const verified = requireIssuedGovernance({
    connection: params.connection,
    verifiedGovernance: params.verifiedGovernance,
  });
  if (verified.rpcEndpoint !== params.verified.rpcEndpoint) {
    throw new ClientValidationError("VERIFIED_NETWORK_MISMATCH", [
      "verifiedGovernance network is not the same issued network as verified",
    ]);
  }
  const lock = await verifyPermanentLock({
    connection: params.connection,
    verified: params.verified,
    position: params.position,
    expectedLiquidity: params.expectedLiquidity,
  });
  const ichorMint = requirePublicKey(params.ichorMint, "ichorMint");
  requirePublicKey(params.positionNftMint, "positionNftMint");
  const cpAmm = new CpAmm(params.connection);
  const poolState = await cpAmm.fetchPoolState(lock.pool);
  if (!poolState.tokenAMint.equals(ichorMint)) {
    throw new ClientValidationError("POOL_TOKEN_A", [
      `DAMM token A ${poolState.tokenAMint.toBase58()} is not ICHOR ${ichorMint.toBase58()}`,
    ]);
  }
  if (!poolState.tokenBMint.equals(NATIVE_MINT)) {
    throw new ClientValidationError("POOL_TOKEN_B", [
      `DAMM token B ${poolState.tokenBMint.toBase58()} is not wSOL ${NATIVE_MINT.toBase58()}`,
    ]);
  }
  const protocolFeePercent = requireProtocolFeePercent(poolState.poolFees.protocolFeePercent);
  const nft = await fetchPositionNftMint({
    connection: params.connection,
    verified: params.verified,
    positionNftMint: params.positionNftMint,
  });
  const expectedPosition = derivePositionAddress(nft.mint);
  if (!params.position.equals(expectedPosition)) {
    throw new ClientValidationError("POSITION_ADDRESS", [
      `position ${params.position.toBase58()} is not derivePositionAddress(${nft.mint.toBase58()}) = ${expectedPosition.toBase58()}`,
    ]);
  }
  const treasury = await deriveVerifiedNativeTreasury(params.verifiedGovernance);
  const treasuryAta = canonicalAta(nft.mint, treasury, nft.ownerProgram);
  const treasuryAccount = await readTokenAccount({
    connection: params.connection,
    address: treasuryAta,
    expectedMint: nft.mint,
    expectedOwner: treasury,
    expectedTokenProgram: nft.ownerProgram,
    label: "treasury position NFT ATA",
    allowMissing: false,
    missingCode: "TREASURY_POSITION_NFT_MISSING",
  });
  if (treasuryAccount === null || !treasuryAccount.amount.eq(POSITION_NFT_SUPPLY)) {
    throw new ClientValidationError("TREASURY_POSITION_NFT_AMOUNT", [
      `treasury ATA ${treasuryAta.toBase58()} holds ${treasuryAccount?.amount.toString() ?? "nothing"}; required exactly 1`,
    ]);
  }
  const [ichorSnap, solSnap] = await Promise.all([
    fetchMintSnapshot(params.connection, params.verified.network, poolState.tokenAMint),
    fetchMintSnapshot(params.connection, params.verified.network, poolState.tokenBMint),
  ]);
  const [ichorAmount, solAmount] = await Promise.all([
    readVaultTokenAmount({
      connection: params.connection,
      address: poolState.tokenAVault,
      expectedMint: poolState.tokenAMint,
      expectedTokenProgram: ichorSnap.ownerProgram,
      label: "dammIchorVault",
    }),
    readVaultTokenAmount({
      connection: params.connection,
      address: poolState.tokenBVault,
      expectedMint: poolState.tokenBMint,
      expectedTokenProgram: solSnap.ownerProgram,
      label: "dammSolVault",
    }),
  ]);
  const poolLiquidity = requireSdkBn(poolState.liquidity, "pool.liquidity");
  return {
    lock,
    ichorMint: poolState.tokenAMint,
    solMint: poolState.tokenBMint,
    ichorVault: poolState.tokenAVault,
    solVault: poolState.tokenBVault,
    ichorAmount,
    solAmount,
    ichorDecimals: ichorSnap.decimals,
    solDecimals: solSnap.decimals,
    poolLiquidity,
    positionOwnsFullPool: poolLiquidity.eq(lock.permanentLockedLiquidity),
    protocolFeePercent,
    positionNftMint: nft.mint,
    treasuryPositionNftAta: treasuryAta,
    treasuryHoldsPositionNft: true,
  };
}

/**
 * Unsigned handoff of DAMM v2 position/fee control: idempotent treasury ATA
 * create plus TransferChecked of the live position-NFT supply (must be 1)
 * from Meteora's canonical `position_nft_account` PDA to the derived Realms
 * native-treasury ATA. The PDA token account's authority must be currentOwner.
 * Official docs: transferring the Token-2022 position NFT transfers control.
 */
export async function buildHandoffPositionRightsToTreasury(params: {
  connection: Connection;
  verifiedConfig: VerifiedIchorConfig;
  verifiedGovernance: VerifiedGovernanceIdentity;
  positionNftMint: PublicKey;
  position: PublicKey;
  pool: PublicKey;
  currentOwner: PublicKey;
  payer: PublicKey;
}): Promise<{
  unsigned: UnsignedTransactionBuild;
  treasury: PublicKey;
  sourcePositionNftAccount: PublicKey;
  treasuryAta: PublicKey;
  positionNftMint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  supply: BN;
}> {
  assertNoSecretMaterial(params, "buildHandoffPositionRightsToTreasury");
  assertNoCallerTreasurySubstitution(params, "buildHandoffPositionRightsToTreasury");
  await assertIssuedIdentityMatchesCommittedDaoDestination({
    verifiedConfig: params.verifiedConfig,
    verifiedGovernance: params.verifiedGovernance,
  });
  const verified = requireIssuedGovernance(params);
  requirePublicKey(params.positionNftMint, "positionNftMint");
  requirePublicKey(params.position, "position");
  requirePublicKey(params.pool, "pool");
  requirePublicKey(params.currentOwner, "currentOwner");
  requirePublicKey(params.payer, "payer");

  const treasury = await deriveVerifiedNativeTreasury(params.verifiedGovernance);
  const nft = await fetchPositionNftMint({
    connection: params.connection,
    verified,
    positionNftMint: params.positionNftMint,
  });
  const expectedPosition = derivePositionAddress(nft.mint);
  if (!params.position.equals(expectedPosition)) {
    throw new ClientValidationError("POSITION_ADDRESS", [
      `position ${params.position.toBase58()} is not derivePositionAddress(${nft.mint.toBase58()}) = ${expectedPosition.toBase58()}`,
    ]);
  }
  const positionState = await new CpAmm(params.connection).fetchPositionState(params.position);
  if (!positionState.pool.equals(params.pool)) {
    throw new ClientValidationError("POSITION_POOL", [
      `position.pool ${positionState.pool.toBase58()} is not expected pool ${params.pool.toBase58()}`,
    ]);
  }
  const sourcePositionNftAccount = derivePositionNftAccount(nft.mint);
  const treasuryAta = canonicalAta(nft.mint, treasury, nft.ownerProgram);
  const source = await readTokenAccount({
    connection: params.connection,
    address: sourcePositionNftAccount,
    expectedMint: nft.mint,
    expectedOwner: params.currentOwner,
    expectedTokenProgram: nft.ownerProgram,
    label: "Meteora position_nft_account",
    allowMissing: false,
    missingCode: "SOURCE_POSITION_NFT_ACCOUNT_MISSING",
  });
  if (source === null || !source.amount.eq(nft.supply)) {
    throw new ClientValidationError("SOURCE_POSITION_NFT_AMOUNT", [
      `Meteora position_nft_account ${sourcePositionNftAccount.toBase58()} holds ${source?.amount.toString() ?? "nothing"}; live mint supply is ${nft.supply.toString()}`,
    ]);
  }

  const instructions: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      params.payer,
      treasuryAta,
      treasury,
      nft.mint,
      nft.ownerProgram,
    ),
    createTransferCheckedInstruction(
      sourcePositionNftAccount,
      nft.mint,
      treasuryAta,
      params.currentOwner,
      BigInt(nft.supply.toString()),
      nft.decimals,
      [],
      nft.ownerProgram,
    ),
  ];
  const transaction = new Transaction();
  for (const instruction of instructions) {
    transaction.add(instruction);
  }
  const requiredSignerPubkeys = params.payer.equals(params.currentOwner)
    ? [params.currentOwner]
    : [params.payer, params.currentOwner];
  return {
    unsigned: {
      transaction,
      instructions,
      requiredSignerPubkeys,
    },
    treasury,
    sourcePositionNftAccount,
    treasuryAta,
    positionNftMint: nft.mint,
    tokenProgram: nft.ownerProgram,
    decimals: nft.decimals,
    supply: nft.supply,
  };
}

/**
 * Live proof that the derived treasury ATA holds exactly the position NFT
 * and the previous owner ATA no longer holds it.
 */
export async function verifyPositionRightsHandoff(params: {
  connection: Connection;
  verifiedConfig: VerifiedIchorConfig;
  verifiedGovernance: VerifiedGovernanceIdentity;
  positionNftMint: PublicKey;
  position: PublicKey;
  pool: PublicKey;
  previousOwner: PublicKey;
}): Promise<{
  treasury: PublicKey;
  treasuryAta: PublicKey;
  sourcePositionNftAccount: PublicKey;
  treasuryAmount: BN;
  sourceAmount: BN;
  handedOff: true;
}> {
  assertNoSecretMaterial(params, "verifyPositionRightsHandoff");
  assertNoCallerTreasurySubstitution(params, "verifyPositionRightsHandoff");
  await assertIssuedIdentityMatchesCommittedDaoDestination({
    verifiedConfig: params.verifiedConfig,
    verifiedGovernance: params.verifiedGovernance,
  });
  const verified = requireIssuedGovernance(params);
  requirePublicKey(params.positionNftMint, "positionNftMint");
  requirePublicKey(params.position, "position");
  requirePublicKey(params.pool, "pool");
  requirePublicKey(params.previousOwner, "previousOwner");

  const treasury = await deriveVerifiedNativeTreasury(params.verifiedGovernance);
  const nft = await fetchPositionNftMint({
    connection: params.connection,
    verified,
    positionNftMint: params.positionNftMint,
  });
  const expectedPosition = derivePositionAddress(nft.mint);
  if (!params.position.equals(expectedPosition)) {
    throw new ClientValidationError("POSITION_ADDRESS", [
      `position ${params.position.toBase58()} is not derivePositionAddress(${nft.mint.toBase58()}) = ${expectedPosition.toBase58()}`,
    ]);
  }
  const positionState = await new CpAmm(params.connection).fetchPositionState(params.position);
  if (!positionState.pool.equals(params.pool)) {
    throw new ClientValidationError("POSITION_POOL", [
      `position.pool ${positionState.pool.toBase58()} is not expected pool ${params.pool.toBase58()}`,
    ]);
  }
  const sourcePositionNftAccount = derivePositionNftAccount(nft.mint);
  const treasuryAta = canonicalAta(nft.mint, treasury, nft.ownerProgram);
  const treasuryAccount = await readTokenAccount({
    connection: params.connection,
    address: treasuryAta,
    expectedMint: nft.mint,
    expectedOwner: treasury,
    expectedTokenProgram: nft.ownerProgram,
    label: "treasury position NFT ATA",
    allowMissing: false,
    missingCode: "HANDOFF_TREASURY_ATA_MISSING",
  });
  if (treasuryAccount === null || !treasuryAccount.amount.eq(POSITION_NFT_SUPPLY)) {
    throw new ClientValidationError("HANDOFF_TREASURY_AMOUNT", [
      `treasury ATA ${treasuryAta.toBase58()} holds ${treasuryAccount?.amount.toString() ?? "nothing"}; required exactly 1`,
    ]);
  }
  const sourceAccount = await readTokenAccount({
    connection: params.connection,
    address: sourcePositionNftAccount,
    expectedMint: nft.mint,
    expectedOwner: params.previousOwner,
    expectedTokenProgram: nft.ownerProgram,
    label: "Meteora position_nft_account",
    allowMissing: true,
    missingCode: "HANDOFF_SOURCE_ATA_MISSING",
  });
  const sourceAmount = sourceAccount === null ? new BN(0) : sourceAccount.amount;
  if (!sourceAmount.isZero()) {
    throw new ClientValidationError("HANDOFF_SOURCE_STILL_HOLDS", [
      `Meteora position_nft_account ${sourcePositionNftAccount.toBase58()} still holds ${sourceAmount.toString()}`,
    ]);
  }
  return {
    treasury,
    treasuryAta,
    sourcePositionNftAccount,
    treasuryAmount: treasuryAccount.amount,
    sourceAmount,
    handedOff: true,
  };
}

function isAssociatedTokenCreateIx(instruction: TransactionInstruction): boolean {
  return instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID);
}

function transactionFromInstructions(
  instructions: readonly TransactionInstruction[],
  feePayer: PublicKey,
): Transaction {
  const transaction = new Transaction();
  transaction.feePayer = feePayer;
  for (const instruction of instructions) {
    transaction.add(instruction);
  }
  return transaction;
}

/**
 * Split `claimPositionFee2` into the measured §5b two-insert form.
 * Insert 0 = Associated Token creates (treasury payer/signer).
 * Insert 1 = ClaimPositionFee + Tokenkeg CloseAccount unwrap.
 * The full 4-ix SDK tx is kept as `transaction` fallback only (1573 > 1232).
 */
function splitClaimPositionFee2Inserts(
  transaction: Transaction,
  treasury: PublicKey,
): { insert0: Transaction; insert1: Transaction } {
  const instructions = transaction.instructions;
  const ataCreates = instructions.filter(isAssociatedTokenCreateIx);
  const remainder = instructions.filter((ix) => !isAssociatedTokenCreateIx(ix));
  const hasClaim = remainder.some((ix) => ix.programId.equals(CP_AMM_PROGRAM_ID));
  const hasUnwrap = remainder.some((ix) => ix.programId.equals(TOKEN_PROGRAM_ID));
  if (ataCreates.length < 2 || !hasClaim || !hasUnwrap) {
    throw new ClientValidationError("CLAIM_POSITION_FEE2_SHAPE", [
      `claimPositionFee2 must emit ≥2 Associated Token creates plus ClaimPositionFee + CloseAccount unwrap for the two-insert proposal form (measured §5b; one insert overflows 1573 > 1232); got ${String(ataCreates.length)} ATA create(s), ${String(remainder.length)} other ix(s), claim=${String(hasClaim)} unwrap=${String(hasUnwrap)}`,
    ]);
  }
  for (let i = 0; i < ataCreates.length; i++) {
    const ix = ataCreates[i]!;
    if (!ix.keys.some((meta) => meta.isSigner && meta.pubkey.equals(treasury))) {
      throw new ClientValidationError("CLAIM_INSERT0_PAYER", [
        `insert 0 ATA create[${String(i)}] does not mark the native treasury as signer; feePayer must be the treasury PDA`,
      ]);
    }
  }
  return {
    insert0: transactionFromInstructions(ataCreates, treasury),
    insert1: transactionFromInstructions(remainder, treasury),
  };
}

/**
 * Two-insert unsigned fee-claim. Receiver and position owner are the
 * derived Realms native treasury. Uses `claimPositionFee2` because 1.4.6
 * requires an explicit receiver. `feePayer` is always the treasury so ATA
 * creates take the insert-0 signer shape. The position NFT account is the
 * canonical treasury ATA derived here; callers cannot pass it.
 */
export async function buildClaimPositionFeeToTreasury(
  params: ClaimFeesToTreasuryParams,
): Promise<ClaimFeesToTreasuryBuild> {
  assertNoSecretMaterial(params, "buildClaimPositionFeeToTreasury");
  assertNoCallerTreasurySubstitution(params, "buildClaimPositionFeeToTreasury", CALLER_CLAIM_OWNER_FIELDS);
  const verified = requireIssuedGovernance(params);
  requirePublicKey(params.pool, "pool");
  requirePublicKey(params.position, "position");
  requirePublicKey(params.positionNftMint, "positionNftMint");

  const treasury = await deriveVerifiedNativeTreasury(params.verifiedGovernance);
  const nft = await fetchPositionNftMint({
    connection: params.connection,
    verified,
    positionNftMint: params.positionNftMint,
  });
  const treasuryAta = expectedTreasuryPositionNftAta(nft.mint, treasury, nft.ownerProgram);
  const treasuryPosition = await readTokenAccount({
    connection: params.connection,
    address: treasuryAta,
    expectedMint: nft.mint,
    expectedOwner: treasury,
    expectedTokenProgram: nft.ownerProgram,
    label: "treasury position NFT ATA",
    allowMissing: false,
    missingCode: "TREASURY_POSITION_NFT_MISSING",
  });
  if (treasuryPosition === null || !treasuryPosition.amount.eq(POSITION_NFT_SUPPLY)) {
    throw new ClientValidationError("TREASURY_POSITION_NFT_AMOUNT", [
      `treasury ATA ${treasuryAta.toBase58()} must hold exactly 1 position NFT before a fee claim`,
    ]);
  }
  const expectedPosition = derivePositionAddress(params.positionNftMint);
  if (!params.position.equals(expectedPosition)) {
    throw new ClientValidationError("POSITION_ADDRESS", [
      `position ${params.position.toBase58()} is not derivePositionAddress(${params.positionNftMint.toBase58()}) = ${expectedPosition.toBase58()}`,
    ]);
  }

  const cpAmm = new CpAmm(params.connection);
  const poolState = await cpAmm.fetchPoolState(params.pool);
  const tokenAProgram = await fetchMintSnapshot(params.connection, verified.network, poolState.tokenAMint);
  const tokenBProgram = await fetchMintSnapshot(params.connection, verified.network, poolState.tokenBMint);

  const claim = {
    owner: treasury,
    position: params.position,
    pool: params.pool,
    positionNftAccount: treasuryAta,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: tokenAProgram.ownerProgram,
    tokenBProgram: tokenBProgram.ownerProgram,
    receiver: treasury,
    feePayer: treasury,
  };

  const transaction = await cpAmm.claimPositionFee2(claim);
  if (!(transaction instanceof Transaction)) {
    throw new ClientValidationError("CLAIM_POSITION_FEE2_SHAPE", [
      "claimPositionFee2 did not return a legacy Transaction",
    ]);
  }
  const { insert0, insert1 } = splitClaimPositionFee2Inserts(transaction, treasury);
  return {
    insert0,
    insert1,
    transaction,
    pool: params.pool,
    receiver: treasury,
    owner: treasury,
    positionNftAccount: treasuryAta,
  };
}

export { ActivationType, CollectFeeMode, MAX_SQRT_PRICE, MIN_SQRT_PRICE };
