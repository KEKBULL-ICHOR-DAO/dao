/**
 * Permissionless Pump `distribute_creator_fees` builders for the holder page.
 *
 * Sources, in this order:
 *   * `docs/idl/pump.json` - discriminators, named accounts, return types
 *   * `src/pumpfun/fee_sharing.rs` - measured SharingConfig / curve offsets,
 *     remaining-account layout for current shareholders
 *
 * This is not ICHOR Collect. Collect harvests Token-2022 transfer fees.
 * This pushes Pump curve / PumpSwap creator fees. After fee-sharing, AMM
 * fees sit in the coin-creator wSOL ATA until `transfer_creator_fees_to_pump`
 * (**[MEASURED]** official-devnet ZBT `3SJSD4fe…`). Then
 * `distribute_creator_fees` pays the live shareholders (`5y4utazF…`).
 * Anyone can send both. The connected wallet is only the fee payer
 * (v1 has no instruction signer; v2's only signer is rent).
 *
 * Prefer v1 when the bonding-curve quote mint is the default pubkey
 * (native SOL). Use v2 only when the quote mint is a real token mint.
 * `transfer_creator_fees_to_pump_v2` exists in the AMM IDL (quote-token
 * hop) and is not built - KEKBULL and ZBT are SOL.
 * Call `get_minimum_distributable_fee` before building distribute - sending
 * under the threshold wastes a transaction fee. Official-devnet get_minimum
 * also needs current shareholders as remaining accounts (IDL omits them).
 */

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountMeta,
  type Connection,
} from "@solana/web3.js";
import BN from "bn.js";

export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const PUMP_AMM_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const WSOL_MINT = NATIVE_MINT;

export const IX_DISTRIBUTE_CREATOR_FEES = Uint8Array.from([165, 114, 103, 0, 121, 206, 247, 81]);
export const IX_DISTRIBUTE_CREATOR_FEES_V2 = Uint8Array.from([255, 203, 19, 79, 244, 68, 8, 159]);
export const IX_GET_MINIMUM_DISTRIBUTABLE_FEE = Uint8Array.from([117, 225, 127, 202, 134, 95, 68, 35]);
/** `docs/idl/pump_amm.json` `transfer_creator_fees_to_pump`. Landed ZBT `3SJSD4fe…`. */
export const IX_TRANSFER_CREATOR_FEES_TO_PUMP = Uint8Array.from([139, 52, 134, 85, 228, 229, 108, 241]);
/** Legacy SPL Token account size. Rent is fetched live; this is only the length. */
export const SPL_TOKEN_ACCOUNT_LEN = 165;

export const ACCOUNT_SHARING_CONFIG = Uint8Array.from([216, 74, 9, 0, 56, 140, 93, 75]);
export const ACCOUNT_BONDING_CURVE = Uint8Array.from([23, 183, 248, 55, 96, 216, 172, 96]);

export const SHARE_BPS_TOTAL = 10_000;
export const MAX_SHAREHOLDERS = 10;
export const KEKBULL_TREASURY_BPS = 7_500;
export const KEKBULL_OPERATOR_BPS = 2_500;

export const BONDING_CURVE_COMPLETE_OFFSET = 48;
export const BONDING_CURVE_CREATOR_OFFSET = 49;
export const BONDING_CURVE_QUOTE_MINT_OFFSET = 83;

export interface Shareholder {
  readonly address: PublicKey;
  readonly shareBps: number;
}

export interface SharingConfig {
  readonly bump: number;
  readonly version: number;
  readonly status: "Paused" | "Active";
  readonly mint: PublicKey;
  readonly admin: PublicKey;
  readonly adminRevoked: boolean;
  readonly shareholders: readonly Shareholder[];
}

export interface BondingCurveHead {
  readonly complete: boolean;
  readonly creator: PublicKey;
  /** Live field. The all-zero pubkey means native SOL, not wrapped SOL. */
  readonly quoteMintRaw: PublicKey;
  /** `quoteMintRaw` with the zero pubkey substituted to wrapped SOL. */
  readonly quoteMint: PublicKey;
}

export interface MinimumDistributableFee {
  readonly minimumRequired: BN;
  readonly distributableFees: BN;
  readonly canDistribute: boolean;
}

export interface PumpCreatorFeeLive {
  readonly mint: PublicKey;
  readonly sharingConfigAddress: PublicKey;
  readonly bondingCurve: PublicKey;
  readonly creatorVault: PublicKey;
  readonly sharing: SharingConfig;
  readonly curve: BondingCurveHead;
  readonly vaultLamports: BN;
  readonly quoteTokenProgram: PublicKey | null;
  readonly minimum: MinimumDistributableFee;
  readonly variant: "v1" | "v2";
  readonly ammVaultAta: PublicKey;
  readonly ammTokenAmount: BN;
  readonly tokenAccountRent: BN;
  /** AMM wSOL is at/above Token-account rent so transfer will not skip. v1 only. */
  readonly transferEligible: boolean;
}

function requirePubkey(value: PublicKey, label: string): PublicKey {
  if (value.equals(PublicKey.default)) {
    throw new Error(`${label} must not be the default pubkey`);
  }
  return value;
}

export function sharingConfigAddress(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sharing-config"), mint.toBuffer()],
    PUMP_FEE_PROGRAM,
  )[0];
}

export function bondingCurveAddress(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM,
  )[0];
}

export function creatorVaultAddress(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creator.toBuffer()],
    PUMP_PROGRAM,
  )[0];
}

export function pumpEventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM)[0];
}

export function ammEventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_AMM_PROGRAM)[0];
}

/** AMM coin-creator vault authority. Seed is `creator_vault` (underscore). */
export function ammCreatorVaultAuthority(coinCreator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), coinCreator.toBuffer()],
    PUMP_AMM_PROGRAM,
  )[0];
}

export function ammCreatorVaultAta(coinCreator: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    WSOL_MINT,
    ammCreatorVaultAuthority(coinCreator),
    true,
    TOKEN_PROGRAM_ID,
  );
}

export function parseSplTokenAmount(data: Uint8Array): BN {
  if (data.length < 72) {
    throw new Error(`token account is ${String(data.length)} bytes; amount lives at offset 64`);
  }
  return new BN(data.subarray(64, 72), "le");
}

/**
 * Typical official-devnet send fee (ZBT `5y4utazF…` payer −5,001).
 * `can_distribute` is true at distributable 0 when shareholders already
 * hold rent - it is not a "there is money" signal. Refuse unless every
 * shareholder receives at least 1 lamport and the total clears this fee.
 */
export const PUMP_DISTRIBUTE_MIN_PAYOUT_LAMPORTS = 5_000;

export function pumpVaultCanPay(
  minimum: MinimumDistributableFee,
  shareholderCount: number,
): boolean {
  if (shareholderCount < 1) {
    return false;
  }
  const perShare = minimum.distributableFees.divn(shareholderCount);
  return (
    perShare.gtn(0) &&
    minimum.distributableFees.gte(new BN(PUMP_DISTRIBUTE_MIN_PAYOUT_LAMPORTS))
  );
}

export function ammTransferCanUnlock(live: Pick<
  PumpCreatorFeeLive,
  "variant" | "transferEligible" | "vaultLamports" | "ammTokenAmount" | "minimum" | "tokenAccountRent"
>): boolean {
  const eligible =
    live.variant === "v1" && live.ammTokenAmount.gte(live.tokenAccountRent);
  return (
    eligible &&
    live.vaultLamports.add(live.ammTokenAmount).gte(live.minimum.minimumRequired)
  );
}

export function pumpDistributeReady(live: PumpCreatorFeeLive): boolean {
  return pumpVaultCanPay(live.minimum, live.sharing.shareholders.length) || ammTransferCanUnlock(live);
}

export function decodeShareholders(data: Uint8Array): {
  readonly shareholders: Shareholder[];
  readonly consumed: number;
} {
  if (data.length < 4) {
    throw new Error("shareholder vec is truncated (need a 4-byte length)");
  }
  const n = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
  if (n > MAX_SHAREHOLDERS) {
    throw new Error(`shareholder vec claims ${String(n)} entries, max ${String(MAX_SHAREHOLDERS)}`);
  }
  const need = 4 + n * 34;
  if (data.length < need) {
    throw new Error(`shareholder vec is truncated (${String(n)} entries need ${String(need)} bytes)`);
  }
  const shareholders: Shareholder[] = [];
  let off = 4;
  for (let i = 0; i < n; i += 1) {
    shareholders.push({
      address: new PublicKey(data.subarray(off, off + 32)),
      shareBps: new DataView(data.buffer, data.byteOffset + off + 32, 2).getUint16(0, true),
    });
    off += 34;
  }
  return { shareholders, consumed: off };
}

export function parseSharingConfig(owner: PublicKey, data: Uint8Array): SharingConfig {
  if (!owner.equals(PUMP_FEE_PROGRAM)) {
    throw new Error(
      `sharing config owner is ${owner.toBase58()}, expected the fee program ${PUMP_FEE_PROGRAM.toBase58()}`,
    );
  }
  if (data.length < 8 + 1 + 1 + 1 + 32 + 32 + 1 + 4) {
    throw new Error(`sharing config is truncated (${String(data.length)} bytes)`);
  }
  for (let i = 0; i < 8; i += 1) {
    if (data[i] !== ACCOUNT_SHARING_CONFIG[i]) {
      throw new Error("account discriminator is not SharingConfig");
    }
  }
  const statusTag = data[10];
  const status = statusTag === 0 ? "Paused" : statusTag === 1 ? "Active" : null;
  if (status === null) {
    throw new Error(`unknown SharingConfig status tag ${String(statusTag)}`);
  }
  const revoked = data[75];
  if (revoked !== 0 && revoked !== 1) {
    throw new Error(`admin_revoked is not a bool (got ${String(revoked)})`);
  }
  const { shareholders } = decodeShareholders(data.subarray(76));
  return {
    bump: data[8] ?? 0,
    version: data[9] ?? 0,
    status,
    mint: new PublicKey(data.subarray(11, 43)),
    admin: new PublicKey(data.subarray(43, 75)),
    adminRevoked: revoked === 1,
    shareholders,
  };
}

export function parseBondingCurveHead(data: Uint8Array): BondingCurveHead {
  if (data.length < ACCOUNT_BONDING_CURVE.length) {
    throw new Error(`bonding curve is ${String(data.length)} bytes; the Anchor discriminator is 8 bytes`);
  }
  for (let i = 0; i < 8; i += 1) {
    if (data[i] !== ACCOUNT_BONDING_CURVE[i]) {
      throw new Error("account discriminator is not BondingCurve");
    }
  }
  const creatorEnd = BONDING_CURVE_CREATOR_OFFSET + 32;
  const quoteEnd = BONDING_CURVE_QUOTE_MINT_OFFSET + 32;
  if (data.length < quoteEnd) {
    throw new Error(
      `bonding curve is ${String(data.length)} bytes; quote mint lives at offset ${String(BONDING_CURVE_QUOTE_MINT_OFFSET)}`,
    );
  }
  const completeTag = data[BONDING_CURVE_COMPLETE_OFFSET];
  if (completeTag !== 0 && completeTag !== 1) {
    throw new Error(`bonding_curve.complete is ${String(completeTag)}, not a bool`);
  }
  const quoteMintRaw = new PublicKey(data.subarray(BONDING_CURVE_QUOTE_MINT_OFFSET, quoteEnd));
  return {
    complete: completeTag === 1,
    creator: new PublicKey(data.subarray(BONDING_CURVE_CREATOR_OFFSET, creatorEnd)),
    quoteMintRaw,
    quoteMint: quoteMintRaw.equals(PublicKey.default) ? WSOL_MINT : quoteMintRaw,
  };
}

export function parseMinimumDistributableFee(data: Uint8Array): MinimumDistributableFee {
  const body = data.length === 25 ? data.subarray(8) : data;
  if (body.length < 17) {
    throw new Error(
      `MinimumDistributableFee return data is ${String(data.length)} bytes; need 17 or 25`,
    );
  }
  const view = new DataView(body.buffer, body.byteOffset, 17);
  const flag = view.getUint8(16);
  if (flag !== 0 && flag !== 1) {
    throw new Error(`can_distribute is not a bool (got ${String(flag)})`);
  }
  return {
    minimumRequired: new BN(body.subarray(0, 8), "le"),
    distributableFees: new BN(body.subarray(8, 16), "le"),
    canDistribute: flag === 1,
  };
}

/** Native SOL (curve quote field is the default pubkey) uses v1. Anything else is v2. */
export function distributeVariant(quoteMintRaw: PublicKey): "v1" | "v2" {
  return quoteMintRaw.equals(PublicKey.default) ? "v1" : "v2";
}

export function remainingAccountsForCurrentShareholders(
  current: readonly PublicKey[],
  quoteMint: PublicKey,
  quoteTokenProgram: PublicKey,
): AccountMeta[] {
  if (current.length === 0) {
    throw new Error(
      "current shareholders are required remaining accounts. Read them from SharingConfig",
    );
  }
  if (current.some((pubkey) => pubkey.equals(PublicKey.default))) {
    throw new Error("current shareholder list contains the default pubkey");
  }
  if (!quoteTokenProgram.equals(TOKEN_PROGRAM_ID) && !quoteTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(
      `quote mint owner ${quoteTokenProgram.toBase58()} is not SPL Token or Token-2022`,
    );
  }
  if (quoteMint.equals(PublicKey.default)) {
    throw new Error("quote mint must be the live mint (wrapped SOL if the curve field is zero)");
  }
  const out: AccountMeta[] = current.map((pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: true,
  }));
  if (!quoteMint.equals(WSOL_MINT)) {
    for (const owner of current) {
      out.push({
        pubkey: getAssociatedTokenAddressSync(quoteMint, owner, true, quoteTokenProgram),
        isSigner: false,
        isWritable: true,
      });
    }
  }
  return out;
}

function namedDistributeAccounts(mint: PublicKey, curveCreator: PublicKey): AccountMeta[] {
  requirePubkey(mint, "mint");
  requirePubkey(curveCreator, "bonding_curve.creator");
  return [
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurveAddress(mint), isSigner: false, isWritable: false },
    { pubkey: sharingConfigAddress(mint), isSigner: false, isWritable: false },
    { pubkey: creatorVaultAddress(curveCreator), isSigner: false, isWritable: true },
  ];
}

export function buildGetMinimumDistributableFee(params: {
  readonly mint: PublicKey;
  readonly curveCreator: PublicKey;
  readonly currentShareholders: readonly PublicKey[];
}): TransactionInstruction {
  // Official-devnet get_minimum at distribute_creator_fees.rs:143 requires the
  // current shareholder remaining accounts. The IDL still lists only the four
  // named keys. Same remaining as v1 distribute (shareholder pubkeys).
  const remaining = remainingAccountsForCurrentShareholders(
    params.currentShareholders,
    WSOL_MINT,
    TOKEN_PROGRAM_ID,
  );
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [...namedDistributeAccounts(params.mint, params.curveCreator), ...remaining],
    data: Buffer.from(IX_GET_MINIMUM_DISTRIBUTABLE_FEE),
  });
}

export function buildTransferCreatorFeesToPump(coinCreator: PublicKey): TransactionInstruction {
  requirePubkey(coinCreator, "coin_creator");
  const vaultAuth = ammCreatorVaultAuthority(coinCreator);
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM,
    keys: [
      { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: coinCreator, isSigner: false, isWritable: false },
      { pubkey: vaultAuth, isSigner: false, isWritable: true },
      { pubkey: ammCreatorVaultAta(coinCreator), isSigner: false, isWritable: true },
      { pubkey: creatorVaultAddress(coinCreator), isSigner: false, isWritable: true },
      { pubkey: ammEventAuthority(), isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX_TRANSFER_CREATOR_FEES_TO_PUMP),
  });
}

export function buildDistributeCreatorFees(params: {
  readonly mint: PublicKey;
  readonly curveCreator: PublicKey;
  readonly currentShareholders: readonly PublicKey[];
}): TransactionInstruction {
  const remaining = remainingAccountsForCurrentShareholders(
    params.currentShareholders,
    WSOL_MINT,
    TOKEN_PROGRAM_ID,
  );
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      ...namedDistributeAccounts(params.mint, params.curveCreator),
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: pumpEventAuthority(), isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
      ...remaining,
    ],
    data: Buffer.from(IX_DISTRIBUTE_CREATOR_FEES),
  });
}

export function buildDistributeCreatorFeesV2(params: {
  readonly payer: PublicKey;
  readonly mint: PublicKey;
  readonly curveCreator: PublicKey;
  readonly quoteMint: PublicKey;
  readonly quoteTokenProgram: PublicKey;
  readonly currentShareholders: readonly PublicKey[];
  readonly initializeAta: boolean;
}): TransactionInstruction {
  requirePubkey(params.payer, "payer");
  requirePubkey(params.quoteMint, "quote mint");
  if (params.quoteMint.equals(PublicKey.default)) {
    throw new Error("v2 quote mint must be the live mint, not the default pubkey");
  }
  const vault = creatorVaultAddress(params.curveCreator);
  const vaultAta = getAssociatedTokenAddressSync(
    params.quoteMint,
    vault,
    true,
    params.quoteTokenProgram,
  );
  const remaining = remainingAccountsForCurrentShareholders(
    params.currentShareholders,
    params.quoteMint,
    params.quoteTokenProgram,
  );
  const data = Buffer.alloc(9);
  data.set(IX_DISTRIBUTE_CREATOR_FEES_V2, 0);
  data[8] = params.initializeAta ? 1 : 0;
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      ...namedDistributeAccounts(params.mint, params.curveCreator),
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: pumpEventAuthority(), isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: params.quoteMint, isSigner: false, isWritable: false },
      { pubkey: params.quoteTokenProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...remaining,
    ],
    data,
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((byte, index) => byte === right[index]);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function extractSimulateReturnData(
  returnData: { programId: string; data: readonly [string, string] } | null | undefined,
  logs: readonly string[] | null | undefined,
): Uint8Array {
  if (returnData && bytesEqual(new PublicKey(returnData.programId).toBytes(), PUMP_PROGRAM.toBytes())) {
    const [payload, encoding] = returnData.data;
    if (encoding !== "base64") {
      throw new Error(`simulate returnData encoding is ${encoding}, expected base64`);
    }
    return decodeBase64(payload);
  }
  const prefix = `Program return: ${PUMP_PROGRAM.toBase58()} `;
  for (const line of logs ?? []) {
    if (line.startsWith(prefix)) {
      return decodeBase64(line.slice(prefix.length).trim());
    }
  }
  throw new Error("get_minimum_distributable_fee simulation returned no program data");
}

export async function readQuoteTokenProgram(
  connection: Connection,
  quoteMint: PublicKey,
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(quoteMint, "confirmed");
  if (info === null) {
    throw new Error(`quote mint ${quoteMint.toBase58()} has no account`);
  }
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(
      `quote mint owner ${info.owner.toBase58()} is not SPL Token or Token-2022`,
    );
  }
  return info.owner;
}

async function simulateMinimumFee(
  connection: Connection,
  mint: PublicKey,
  curveCreator: PublicKey,
  currentShareholders: readonly PublicKey[],
): Promise<MinimumDistributableFee> {
  const message = new TransactionMessage({
    payerKey: PublicKey.unique(),
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [
      buildGetMinimumDistributableFee({ mint, curveCreator, currentShareholders }),
    ],
  }).compileToV0Message();
  const simulated = await connection.simulateTransaction(new VersionedTransaction(message), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  if (simulated.value.err !== null) {
    const logs = simulated.value.logs?.join("\n") ?? "no logs";
    throw new Error(`get_minimum_distributable_fee simulation failed: ${JSON.stringify(simulated.value.err)}\n${logs}`);
  }
  return parseMinimumDistributableFee(
    extractSimulateReturnData(simulated.value.returnData ?? null, simulated.value.logs),
  );
}

export async function measurePumpCreatorFees(
  connection: Connection,
  mint: PublicKey,
): Promise<PumpCreatorFeeLive | { readonly missing: "sharing-config" | "bonding-curve"; readonly mint: PublicKey }> {
  requirePubkey(mint, "mint");
  const sharingAddress = sharingConfigAddress(mint);
  const curveAddress = bondingCurveAddress(mint);
  const infos = await connection.getMultipleAccountsInfo(
    [sharingAddress, curveAddress],
    "confirmed",
  );
  const sharingInfo = infos[0];
  const curveInfo = infos[1];
  if (curveInfo == null) {
    return { missing: "bonding-curve", mint };
  }
  if (sharingInfo == null) {
    return { missing: "sharing-config", mint };
  }
  const sharing = parseSharingConfig(sharingInfo.owner, Uint8Array.from(sharingInfo.data));
  if (!sharing.mint.equals(mint)) {
    throw new Error(
      `SharingConfig mint ${sharing.mint.toBase58()} does not match ${mint.toBase58()}`,
    );
  }
  const curve = parseBondingCurveHead(Uint8Array.from(curveInfo.data));
  const creatorVault = creatorVaultAddress(curve.creator);
  const ammVaultAta = ammCreatorVaultAta(curve.creator);
  const variant = distributeVariant(curve.quoteMintRaw);
  const [vaultInfo, ammVaultInfo, tokenAccountRent, quoteTokenProgram] = await Promise.all([
    connection.getAccountInfo(creatorVault, "confirmed"),
    connection.getAccountInfo(ammVaultAta, "confirmed"),
    connection.getMinimumBalanceForRentExemption(SPL_TOKEN_ACCOUNT_LEN, "confirmed"),
    variant === "v2" ? readQuoteTokenProgram(connection, curve.quoteMint) : Promise.resolve(null),
  ]);
  const minimum = await simulateMinimumFee(
    connection,
    mint,
    curve.creator,
    sharing.shareholders.map((row) => row.address),
  );
  const ammTokenAmount =
    ammVaultInfo === null ? new BN(0) : parseSplTokenAmount(Uint8Array.from(ammVaultInfo.data));
  const rent = new BN(tokenAccountRent);
  return {
    mint,
    sharingConfigAddress: sharingAddress,
    bondingCurve: curveAddress,
    creatorVault,
    sharing,
    curve,
    vaultLamports: new BN(vaultInfo?.lamports ?? 0),
    quoteTokenProgram,
    minimum,
    variant,
    ammVaultAta,
    ammTokenAmount,
    tokenAccountRent: rent,
    transferEligible: variant === "v1" && ammTokenAmount.gte(rent),
  };
}

export async function buildPumpDistribute(params: {
  readonly connection: Connection;
  readonly mint: PublicKey;
  readonly payer: PublicKey;
  readonly live: PumpCreatorFeeLive;
}): Promise<{
  readonly instructions: TransactionInstruction[];
  readonly variant: "v1" | "v2";
  readonly initializeAta: boolean;
  readonly includesTransfer: boolean;
}> {
  if (params.live.sharing.status !== "Active") {
    throw new Error("SharingConfig is not Active");
  }
  const payNow = pumpVaultCanPay(params.live.minimum, params.live.sharing.shareholders.length);
  const transferFirst = ammTransferCanUnlock(params.live);
  if (!payNow && !transferFirst) {
    throw new Error(
      `nothing to send: pump vault ${params.live.minimum.distributableFees.toString(10)} of ${params.live.minimum.minimumRequired.toString(10)}, AMM wSOL ${params.live.ammTokenAmount.toString(10)} (rent ${params.live.tokenAccountRent.toString(10)})`,
    );
  }
  const currentShareholders = params.live.sharing.shareholders.map((row) => row.address);
  const prefix = transferFirst
    ? [buildTransferCreatorFeesToPump(params.live.curve.creator)]
    : [];
  if (params.live.variant === "v1") {
    return {
      instructions: [
        ...prefix,
        buildDistributeCreatorFees({
          mint: params.mint,
          curveCreator: params.live.curve.creator,
          currentShareholders,
        }),
      ],
      variant: "v1",
      initializeAta: false,
      includesTransfer: transferFirst,
    };
  }
  const quoteTokenProgram = params.live.quoteTokenProgram;
  if (quoteTokenProgram === null) {
    throw new Error("v2 distribute needs the quote mint's token program, read from chain");
  }
  const vaultAta = getAssociatedTokenAddressSync(
    params.live.curve.quoteMint,
    params.live.creatorVault,
    true,
    quoteTokenProgram,
  );
  const remainingAtas = remainingAccountsForCurrentShareholders(
    currentShareholders,
    params.live.curve.quoteMint,
    quoteTokenProgram,
  )
    .filter((meta) => !currentShareholders.some((owner) => owner.equals(meta.pubkey)))
    .map((meta) => meta.pubkey);
  const needed = [vaultAta, ...remainingAtas];
  const accounts = await params.connection.getMultipleAccountsInfo(needed, "confirmed");
  const initializeAta = accounts.some((info) => info === null);
  return {
    instructions: [
      ...prefix,
      buildDistributeCreatorFeesV2({
        payer: params.payer,
        mint: params.mint,
        curveCreator: params.live.curve.creator,
        quoteMint: params.live.curve.quoteMint,
        quoteTokenProgram,
        currentShareholders,
        initializeAta,
      }),
    ],
    variant: "v2",
    initializeAta,
    includesTransfer: transferFirst,
  };
}

export function sharesMatchKekbullPolicy(
  shareholders: readonly Shareholder[],
  expectedTreasury: PublicKey,
  expectedOperator: PublicKey,
): boolean {
  if (shareholders.length !== 2) {
    return false;
  }
  if (expectedTreasury.equals(PublicKey.default) || expectedOperator.equals(PublicKey.default)) {
    return false;
  }
  if (expectedTreasury.equals(expectedOperator)) {
    return false;
  }
  const treasury = shareholders.find((row) => row.address.equals(expectedTreasury));
  const operator = shareholders.find((row) => row.address.equals(expectedOperator));
  return (
    treasury !== undefined &&
    operator !== undefined &&
    treasury.shareBps === KEKBULL_TREASURY_BPS &&
    operator.shareBps === KEKBULL_OPERATOR_BPS
  );
}
