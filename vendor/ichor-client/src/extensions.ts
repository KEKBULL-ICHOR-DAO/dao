import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { ClientValidationError } from "./types.ts";
import { requirePositiveBn, requireU64Bn, U64_MAX } from "./validation.ts";

/** Pilot / initialize transfer-fee rate. 25 bps = 0.25%. */
export const TRANSFER_FEE_BASIS_POINTS = 25;
/** Pilot / initialize maximum transfer fee. No per-transfer cap. */
export const TRANSFER_FEE_MAXIMUM_FEE = U64_MAX;
/** Harvested-fee split: 25% creator / 75% Realms. */
export const FEE_SPLIT_CREATOR_BPS = 2_500;
export const FEE_SPLIT_REALMS_BPS = 7_500;
export const FEE_SPLIT_BPS_DENOMINATOR = 10_000;

export const TOKEN_2022_ACCOUNT_TYPE_OFFSET = 165;
export const TOKEN_2022_TLV_OFFSET = 166;
export const TOKEN_2022_ACCOUNT_TYPE_UNINITIALIZED = 0;
export const TOKEN_2022_ACCOUNT_TYPE_MINT = 1;
export const TOKEN_2022_ACCOUNT_TYPE_ACCOUNT = 2;

export const EXTENSION_TYPE_UNINITIALIZED = 0;
export const EXTENSION_TYPE_TRANSFER_FEE_CONFIG = 1;
export const EXTENSION_TYPE_TRANSFER_FEE_AMOUNT = 2;
export const EXTENSION_TYPE_TRANSFER_HOOK = 14;

export const TRANSFER_FEE_LEN = 18;
export const TRANSFER_FEE_CONFIG_LEN = 108;
export const TRANSFER_FEE_AMOUNT_LEN = 8;
export const TRANSFER_FEE_OFF_EPOCH = 0;
export const TRANSFER_FEE_OFF_MAXIMUM_FEE = 8;
export const TRANSFER_FEE_OFF_BASIS_POINTS = 16;
export const TRANSFER_FEE_CONFIG_OFF_AUTHORITY = 0;
export const TRANSFER_FEE_CONFIG_OFF_WITHDRAW = 32;
export const TRANSFER_FEE_CONFIG_OFF_WITHHELD = 64;
export const TRANSFER_FEE_CONFIG_OFF_OLDER = 72;
export const TRANSFER_FEE_CONFIG_OFF_NEWER = 90;

/**
 * Token-2022 mint sized for exactly TransferFeeConfig.
 * 165-byte account + 1-byte AccountType + 4-byte TLV header + 108-byte value.
 * `getMintLen([ExtensionType.TransferFeeConfig])` must equal this or the
 * builder fails closed on SDK drift.
 */
export const ICHOR_TRANSFER_FEE_MINT_LEN = 278;

const U128_BITS = 128;
const BPS_CEIL_PAD = new BN(FEE_SPLIT_BPS_DENOMINATOR - 1);

export interface TransferFeeView {
  readonly epoch: BN;
  readonly maximumFee: BN;
  readonly transferFeeBasisPoints: number;
}

export interface TransferFeeConfigView {
  readonly transferFeeConfigAuthority: PublicKey | null;
  readonly withdrawWithheldAuthority: PublicKey | null;
  readonly withheldAmount: BN;
  readonly olderTransferFee: TransferFeeView;
  readonly newerTransferFee: TransferFeeView;
}

export interface TransferFeeAmountView {
  readonly withheldAmount: BN;
}

function requireLen(data: Uint8Array, need: number, label: string): void {
  if (data.length < need) {
    throw new ClientValidationError("ACCOUNT_LAYOUT", [`${label} is truncated`]);
  }
}

function readU16(data: Uint8Array, offset: number, label: string): number {
  requireLen(data, offset + 2, label);
  return data[offset]! | (data[offset + 1]! << 8);
}

function readU64(data: Uint8Array, offset: number, label: string): BN {
  requireLen(data, offset + 8, label);
  return new BN(Array.from(data.subarray(offset, offset + 8)), "le");
}

function readPubkey(data: Uint8Array, offset: number, label: string): PublicKey {
  requireLen(data, offset + 32, label);
  return new PublicKey(data.subarray(offset, offset + 32));
}

function optionalNonzeroPubkey(data: Uint8Array, offset: number, label: string): PublicKey | null {
  const key = readPubkey(data, offset, label);
  return key.equals(PublicKey.default) ? null : key;
}

function requireU128(value: BN, label: string): BN {
  if (value.isNeg() || value.bitLength() > U128_BITS) {
    throw new ClientValidationError("ARITHMETIC_OVERFLOW", [`${label} overflows u128`]);
  }
  return value;
}

export function parseTransferFee(data: Uint8Array, offset: number, label: string): TransferFeeView {
  requireLen(data, offset + TRANSFER_FEE_LEN, label);
  const bps = readU16(data, offset + TRANSFER_FEE_OFF_BASIS_POINTS, `${label}.bps`);
  if (bps > FEE_SPLIT_BPS_DENOMINATOR) {
    throw new ClientValidationError("INVALID_TRANSFER_FEE_CONFIG", [
      `${label} basis points ${String(bps)} exceed 10_000`,
    ]);
  }
  return {
    epoch: readU64(data, offset + TRANSFER_FEE_OFF_EPOCH, `${label}.epoch`),
    maximumFee: readU64(data, offset + TRANSFER_FEE_OFF_MAXIMUM_FEE, `${label}.maximum_fee`),
    transferFeeBasisPoints: bps,
  };
}

export function parseTransferFeeConfigValue(data: Uint8Array): TransferFeeConfigView {
  if (data.length !== TRANSFER_FEE_CONFIG_LEN) {
    throw new ClientValidationError("INVALID_TRANSFER_FEE_CONFIG", [
      `TransferFeeConfig value is ${String(data.length)} bytes, not ${String(TRANSFER_FEE_CONFIG_LEN)}`,
    ]);
  }
  return {
    transferFeeConfigAuthority: optionalNonzeroPubkey(
      data,
      TRANSFER_FEE_CONFIG_OFF_AUTHORITY,
      "transfer_fee_config_authority",
    ),
    withdrawWithheldAuthority: optionalNonzeroPubkey(
      data,
      TRANSFER_FEE_CONFIG_OFF_WITHDRAW,
      "withdraw_withheld_authority",
    ),
    withheldAmount: readU64(data, TRANSFER_FEE_CONFIG_OFF_WITHHELD, "withheld_amount"),
    olderTransferFee: parseTransferFee(data, TRANSFER_FEE_CONFIG_OFF_OLDER, "older_transfer_fee"),
    newerTransferFee: parseTransferFee(data, TRANSFER_FEE_CONFIG_OFF_NEWER, "newer_transfer_fee"),
  };
}

function walkTlv(
  data: Uint8Array,
  expectedAccountType: number,
  label: string,
): { type: number; value: Uint8Array }[] {
  if (data.length < TOKEN_2022_TLV_OFFSET) {
    throw new ClientValidationError("TRANSFER_FEE_CONFIG_MISSING", [
      `${label} is shorter than the Token-2022 TLV mint/account layout`,
    ]);
  }
  if (data[TOKEN_2022_ACCOUNT_TYPE_OFFSET] !== expectedAccountType) {
    throw new ClientValidationError("INVALID_MINT_ACCOUNT_TYPE", [
      `${label} AccountType is ${String(data[TOKEN_2022_ACCOUNT_TYPE_OFFSET])}, not ${String(expectedAccountType)}`,
    ]);
  }

  // Mint accounts pad bytes [82, 165) with zeros. Token accounts use that
  // range as live base-layout fields (delegate, state at 108, is_native, …).
  if (expectedAccountType === TOKEN_2022_ACCOUNT_TYPE_MINT) {
    if (data.subarray(82, TOKEN_2022_ACCOUNT_TYPE_OFFSET).some((byte) => byte !== 0)) {
      throw new ClientValidationError("INVALID_MINT_EXTENSION_LAYOUT", [
        `${label} has nonzero padding before AccountType`,
      ]);
    }
  }

  const tlv = data.subarray(TOKEN_2022_TLV_OFFSET);
  const found: { type: number; value: Uint8Array }[] = [];
  let offset = 0;
  while (offset < tlv.length) {
    if (tlv.length - offset < 4) {
      if (tlv.subarray(offset).every((byte) => byte === 0)) {
        break;
      }
      throw new ClientValidationError("INVALID_MINT_EXTENSION_LAYOUT", [
        `${label} TLV trailer is truncated`,
      ]);
    }
    const extType = readU16(tlv, offset, `${label}.ext_type`);
    const extLen = readU16(tlv, offset + 2, `${label}.ext_len`);
    if (extType === EXTENSION_TYPE_UNINITIALIZED) {
      break;
    }
    const valueStart = offset + 4;
    const valueEnd = valueStart + extLen;
    if (valueEnd > tlv.length) {
      throw new ClientValidationError("INVALID_MINT_EXTENSION_LAYOUT", [
        `${label} TLV value overruns the account`,
      ]);
    }
    found.push({ type: extType, value: tlv.subarray(valueStart, valueEnd) });
    offset = valueEnd;
  }
  return found;
}

/**
 * Walk a Token-2022 mint TLV. The only accepted initialized extension is
 * TransferFeeConfig. TransferHook and every other type fail closed.
 */
export function parseIchorTransferFeeConfig(data: Uint8Array): TransferFeeConfigView {
  const extensions = walkTlv(data, TOKEN_2022_ACCOUNT_TYPE_MINT, "ICHOR mint");
  let found: TransferFeeConfigView | null = null;
  for (const ext of extensions) {
    if (ext.type === EXTENSION_TYPE_TRANSFER_HOOK) {
      throw new ClientValidationError("TRANSFER_HOOK_ACTIVE", [
        "ICHOR mint carries an active TransferHook; that extension is never accepted",
      ]);
    }
    if (ext.type !== EXTENSION_TYPE_TRANSFER_FEE_CONFIG) {
      throw new ClientValidationError("UNEXPECTED_MINT_EXTENSION", [
        `ICHOR mint carries extension type ${String(ext.type)}; only TransferFeeConfig is approved`,
      ]);
    }
    if (found !== null) {
      throw new ClientValidationError("UNEXPECTED_MINT_EXTENSION", [
        "ICHOR mint carries more than one TransferFeeConfig",
      ]);
    }
    found = parseTransferFeeConfigValue(ext.value);
  }
  if (found === null) {
    throw new ClientValidationError("TRANSFER_FEE_CONFIG_MISSING", [
      "ICHOR mint has no TransferFeeConfig",
    ]);
  }
  return found;
}

export function mintHasTransferHook(data: Uint8Array): boolean {
  if (data.length < TOKEN_2022_TLV_OFFSET) {
    return false;
  }
  if (data[TOKEN_2022_ACCOUNT_TYPE_OFFSET] !== TOKEN_2022_ACCOUNT_TYPE_MINT) {
    return false;
  }
  try {
    return walkTlv(data, TOKEN_2022_ACCOUNT_TYPE_MINT, "mint").some(
      (ext) => ext.type === EXTENSION_TYPE_TRANSFER_HOOK,
    );
  } catch {
    return false;
  }
}

export function requireApprovedTransferFee(fee: TransferFeeView, label: string): void {
  if (fee.transferFeeBasisPoints !== TRANSFER_FEE_BASIS_POINTS || !fee.maximumFee.eq(TRANSFER_FEE_MAXIMUM_FEE)) {
    throw new ClientValidationError("TRANSFER_FEE_RATE_MISMATCH", [
      `${label} is ${String(fee.transferFeeBasisPoints)} bps / ${fee.maximumFee.toString()}, not ${String(TRANSFER_FEE_BASIS_POINTS)} / u64::MAX`,
    ]);
  }
}

export function requireIchorTransferFeeConfig(
  config: TransferFeeConfigView,
  feeAuthority: PublicKey,
  withdrawAuthority: PublicKey,
): void {
  if (config.transferFeeConfigAuthority === null || !config.transferFeeConfigAuthority.equals(feeAuthority)) {
    throw new ClientValidationError("TRANSFER_FEE_AUTHORITY_MISMATCH", [
      `TransferFeeConfig authority is not config PDA ${feeAuthority.toBase58()}`,
    ]);
  }
  if (
    config.withdrawWithheldAuthority === null ||
    !config.withdrawWithheldAuthority.equals(withdrawAuthority)
  ) {
    throw new ClientValidationError("WITHDRAW_WITHHELD_AUTHORITY_MISMATCH", [
      `withdraw-withheld authority is not PDA ${withdrawAuthority.toBase58()}`,
    ]);
  }
  requireApprovedTransferFee(config.olderTransferFee, "older_transfer_fee");
  requireApprovedTransferFee(config.newerTransferFee, "newer_transfer_fee");
}

export function requirePilotTransferFee(basisPoints: number, maximumFee: BN): void {
  if (
    !Number.isInteger(basisPoints) ||
    basisPoints !== TRANSFER_FEE_BASIS_POINTS
  ) {
    throw new ClientValidationError("TRANSFER_FEE_EXCEEDS_PILOT_CAP", [
      `transfer_fee_basis_points ${String(basisPoints)} must remain fixed at 25 bps`,
    ]);
  }
  if (!maximumFee.eq(TRANSFER_FEE_MAXIMUM_FEE)) {
    throw new ClientValidationError("TRANSFER_FEE_EXCEEDS_PILOT_CAP", [
      `maximum_fee ${maximumFee.toString()} must remain fixed at u64::MAX`,
    ]);
  }
}

/**
 * Token-2022 `TransferFee::calculate_fee`: ceiling of `amount * bps / 10_000`,
 * capped at `maximumFee`. Same identity as `spl_token_2022` 8.0.1.
 */
export function calculateToken2022TransferFee(params: {
  preFeeAmount: BN;
  transferFeeBasisPoints: number;
  maximumFee: BN;
}): BN {
  const amount = requireU64Bn(params.preFeeAmount, "preFeeAmount");
  const maximumFee = requireU64Bn(params.maximumFee, "maximumFee");
  if (
    !Number.isInteger(params.transferFeeBasisPoints) ||
    params.transferFeeBasisPoints < 0 ||
    params.transferFeeBasisPoints > FEE_SPLIT_BPS_DENOMINATOR
  ) {
    throw new ClientValidationError("INVALID_BPS", [
      `transferFeeBasisPoints ${String(params.transferFeeBasisPoints)} is not 0-10000`,
    ]);
  }
  if (amount.isZero() || params.transferFeeBasisPoints === 0) {
    return new BN(0);
  }
  const numerator = requireU128(
    amount.mul(new BN(params.transferFeeBasisPoints)),
    "amount*bps",
  );
  const raw = requireU128(numerator.add(BPS_CEIL_PAD), "amount*bps+9999").div(
    new BN(FEE_SPLIT_BPS_DENOMINATOR),
  );
  return raw.gt(maximumFee) ? maximumFee : requireU64Bn(raw, "transferFee");
}

/** `TransferFeeConfig::get_epoch_fee`: newer when `currentEpoch >= newer.epoch`. */
export function epochTransferFee(
  config: TransferFeeConfigView,
  currentEpoch: BN,
): TransferFeeView {
  const epoch = requireU64Bn(currentEpoch, "currentEpoch");
  return epoch.gte(config.newerTransferFee.epoch) ? config.newerTransferFee : config.olderTransferFee;
}

export function getCurrentMintFee(params: {
  config: TransferFeeConfigView;
  currentEpoch: BN;
  preFeeAmount: BN;
}): BN {
  const schedule = epochTransferFee(params.config, params.currentEpoch);
  return calculateToken2022TransferFee({
    preFeeAmount: params.preFeeAmount,
    transferFeeBasisPoints: schedule.transferFeeBasisPoints,
    maximumFee: schedule.maximumFee,
  });
}

/**
 * Minimal gross transfer whose post-fee credit is at least `targetNet`.
 * Binary search is monotone over the full u64 range and handles capped fees
 * without floating point or a guessed closed form.
 */
export function grossUpToken2022Transfer(params: {
  config: TransferFeeConfigView;
  currentEpoch: BN;
  targetNet: BN;
}): { grossAmount: BN; expectedFee: BN; expectedNet: BN } {
  const target = requireU64Bn(requirePositiveBn(params.targetNet, "targetNet"), "targetNet");
  let low = target.clone();
  let high = U64_MAX.clone();
  const netAt = (gross: BN): { fee: BN; net: BN } => {
    const fee = getCurrentMintFee({
      config: params.config,
      currentEpoch: params.currentEpoch,
      preFeeAmount: gross,
    });
    return { fee, net: gross.sub(fee) };
  };
  if (netAt(high).net.lt(target)) {
    throw new ClientValidationError("TRANSFER_FEE_GROSS_UP_UNREACHABLE", [
      `no u64 gross transfer can credit target net ${target.toString()}`,
    ]);
  }
  while (low.lt(high)) {
    const mid = low.add(high).shrn(1);
    if (netAt(mid).net.gte(target)) {
      high = mid;
    } else {
      low = mid.addn(1);
    }
  }
  const result = netAt(low);
  return {
    grossAmount: low,
    expectedFee: result.fee,
    expectedNet: result.net,
  };
}

/**
 * Split harvested base units 2500 / 7500 bps. Remainder after the floored
 * creator share is paid to Realms so `creator + realms == amount`.
 */
export function splitHarvestedFees(amount: BN): { creatorAmount: BN; realmsAmount: BN } {
  const total = requireU64Bn(amount, "harvestedAmount");
  const creator = requireU64Bn(
    requireU128(total.mul(new BN(FEE_SPLIT_CREATOR_BPS)), "amount*2500").div(
      new BN(FEE_SPLIT_BPS_DENOMINATOR),
    ),
    "creatorShare",
  );
  const realms = requireU64Bn(total.sub(creator), "realmsShare");
  return { creatorAmount: creator, realmsAmount: realms };
}

export interface SecondHopFeePreview {
  readonly transferAmount: BN;
  readonly expectedFee: BN;
  readonly expectedNet: BN;
}

export interface DistributeFeePreview {
  readonly vaultDistributed: BN;
  readonly creatorTransferAmount: BN;
  readonly realmsTransferAmount: BN;
  readonly creatorSecondHop: SecondHopFeePreview;
  readonly realmsSecondHop: SecondHopFeePreview;
  /** Withheld generated by the two destination transfers; next harvest input. */
  readonly recycledWithheld: BN;
}

export function secondHopAfterTransfer(params: {
  transferAmount: BN;
  config: TransferFeeConfigView;
  currentEpoch: BN;
}): SecondHopFeePreview {
  const transferAmount = requireU64Bn(params.transferAmount, "transferAmount");
  const expectedFee = getCurrentMintFee({
    config: params.config,
    currentEpoch: params.currentEpoch,
    preFeeAmount: transferAmount,
  });
  return {
    transferAmount,
    expectedFee,
    expectedNet: requireU64Bn(transferAmount.sub(expectedFee), "expectedNet"),
  };
}

export function previewDistributeTransferFees(params: {
  vaultDistributed: BN;
  config: TransferFeeConfigView;
  currentEpoch: BN;
}): DistributeFeePreview {
  const vaultDistributed = requireU64Bn(params.vaultDistributed, "vaultDistributed");
  const { creatorAmount, realmsAmount } = splitHarvestedFees(vaultDistributed);
  const creatorSecondHop = secondHopAfterTransfer({
    transferAmount: creatorAmount,
    config: params.config,
    currentEpoch: params.currentEpoch,
  });
  const realmsSecondHop = secondHopAfterTransfer({
    transferAmount: realmsAmount,
    config: params.config,
    currentEpoch: params.currentEpoch,
  });
  return {
    vaultDistributed,
    creatorTransferAmount: creatorAmount,
    realmsTransferAmount: realmsAmount,
    creatorSecondHop,
    realmsSecondHop,
    recycledWithheld: requireU64Bn(
      creatorSecondHop.expectedFee.add(realmsSecondHop.expectedFee),
      "recycledWithheld",
    ),
  };
}

/**
 * Recurse one harvest cycle on recycled second-hop withheld. Used by tests to
 * prove the next split is applied to the withheld, not to destination nets.
 */
export function previewNextHarvestFromRecycled(preview: DistributeFeePreview): {
  creatorAmount: BN;
  realmsAmount: BN;
} {
  return splitHarvestedFees(preview.recycledWithheld);
}

export function parseTransferFeeAmount(data: Uint8Array): TransferFeeAmountView {
  if (data.length !== TRANSFER_FEE_AMOUNT_LEN) {
    throw new ClientValidationError("INVALID_TRANSFER_FEE_AMOUNT", [
      `TransferFeeAmount value is ${String(data.length)} bytes, not ${String(TRANSFER_FEE_AMOUNT_LEN)}`,
    ]);
  }
  return { withheldAmount: readU64(data, 0, "transfer_fee_amount") };
}

/**
 * Token-2022 token-account TLV. Requires TransferFeeAmount. TransferHook on
 * the account side is not an ICHOR harvest source.
 */
export function parseIchorTransferFeeAmount(data: Uint8Array): TransferFeeAmountView {
  const extensions = walkTlv(data, TOKEN_2022_ACCOUNT_TYPE_ACCOUNT, "token account");
  let found: TransferFeeAmountView | null = null;
  for (const ext of extensions) {
    if (ext.type === EXTENSION_TYPE_TRANSFER_HOOK) {
      throw new ClientValidationError("TRANSFER_HOOK_ACTIVE", [
        "token account carries TransferHook; harvest sources must be TransferFeeAmount only",
      ]);
    }
    if (ext.type === EXTENSION_TYPE_TRANSFER_FEE_AMOUNT) {
      if (found !== null) {
        throw new ClientValidationError("UNEXPECTED_MINT_EXTENSION", [
          "token account carries more than one TransferFeeAmount",
        ]);
      }
      found = parseTransferFeeAmount(ext.value);
    }
  }
  if (found === null) {
    throw new ClientValidationError("TRANSFER_FEE_AMOUNT_MISSING", [
      "token account has no TransferFeeAmount extension",
    ]);
  }
  return found;
}
