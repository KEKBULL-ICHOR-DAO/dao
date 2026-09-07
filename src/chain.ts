import {
  ClientValidationError,
  assertBoundConnection,
  communityGoverningTokenHoldingAddress,
  fetchMintSnapshot,
  getCurrentMintFee,
  parseIchorTransferFeeAmount,
  parseIchorTransferFeeConfig,
  readCommunityGoverningTokenDeposit,
  parseBondingCurveAccount,
  requirePublicKey,
  verifyPermanentLock,
  readLockedDammPoolTokens,
  readCanonicalPumpSwapPoolSnapshot,
  type CanonicalPumpSwapReserves,
  type CommunityGoverningTokenDeposit,
  type LockedDammPoolTokens,
  type MintSnapshot,
  type PermanentLockVerification,
  type VerifiedGovernanceIdentity,
  type VerifiedIchorConfig,
  type VerifiedNetwork,
  type VerifiedRealm,
} from "@kekbull/ichor-client";
import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import { parsePositiveDecimalIntegerString } from "./format.ts";

export interface TokenAccountRead {
  readonly ata: PublicKey;
  readonly present: boolean;
  readonly amount: BN | null;
  readonly decimals: number | null;
  readonly mintDecimals: number;
  readonly authority: PublicKey | null;
  /** Token-2022 TransferFeeAmount. Null when the account is absent or the mint is not ICHOR. */
  readonly withheldAmount: BN | null;
}

export interface WalletLiveState {
  readonly owner: PublicKey;
  readonly solLamports: BN;
  readonly nativeMintDecimals: number;
  readonly ichor: TokenAccountRead | null;
}

export interface TreasuryLiveState {
  readonly treasury: PublicKey;
  readonly solLamports: BN;
  readonly nativeMintDecimals: number;
  readonly ichor: TokenAccountRead | null;
  /**
   * KEKBULL held by the treasury. Bought on the public curve by the dedicated
   * bundle wallet, not granted. Large on mainnet and typically zero on devnet,
   * so a zero here is a real balance and not a failed read.
   */
  readonly kekbull: TokenAccountRead | null;
  readonly realmDeposit: TokenAccountRead | null;
  readonly mintWithheld: BN | null;
}

/**
 * Mint accounts (decimals, supply, authorities) do not move on every render.
 * LiveState, Burn, TransferFees, Treasury, and Proposals each called
 * fetchMintSnapshot for ICHOR on arrival; official-devnet HTTP 429'd
 * `DFh21oYa…` and the page printed a raw getAccountInfo failure.
 * Share one in-flight read and reuse it for 15s. A confirmed signature
 * clears the cache so the next refresh is live.
 */
export const LIVE_MINT_SNAPSHOT_TTL_MS = 15_000;

type MintSnapshotCacheEntry = {
  readonly snapshot: MintSnapshot;
  readonly at: number;
};

const mintSnapshots = new Map<string, MintSnapshotCacheEntry>();
const mintSnapshotInflight = new Map<string, Promise<MintSnapshot>>();

function mintSnapshotCacheKey(connection: Connection, mint: PublicKey): string {
  return `${connection.rpcEndpoint}:${mint.toBase58()}`;
}

export function invalidateLiveMintCache(): void {
  mintSnapshots.clear();
}

export async function fetchBoundMintSnapshot(
  connection: Connection,
  verified: VerifiedNetwork,
  mint: PublicKey,
): Promise<MintSnapshot> {
  assertBoundConnection(verified, connection);
  const key = mintSnapshotCacheKey(connection, mint);
  const hit = mintSnapshots.get(key);
  if (hit && Date.now() - hit.at < LIVE_MINT_SNAPSHOT_TTL_MS) {
    return hit.snapshot;
  }
  const pending = mintSnapshotInflight.get(key);
  if (pending) {
    return pending;
  }
  const load = fetchMintSnapshot(connection, verified.network, mint)
    .then((snapshot) => {
      mintSnapshots.set(key, { snapshot, at: Date.now() });
      mintSnapshotInflight.delete(key);
      return snapshot;
    })
    .catch((err: unknown) => {
      mintSnapshotInflight.delete(key);
      throw err;
    });
  mintSnapshotInflight.set(key, load);
  return load;
}

/**
 * Read lamports as a BN from the JSON-RPC body so the integer is not coerced
 * through a JavaScript number first.
 */
export async function readLamportsBn(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  pubkey: PublicKey;
}): Promise<BN> {
  assertBoundConnection(params.verified, params.connection);
  const response = await fetch(params.connection.rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [params.pubkey.toBase58(), { commitment: "confirmed" }],
    }),
  });
  if (!response.ok) {
    throw new Error(`getBalance HTTP ${String(response.status)} for ${params.pubkey.toBase58()}`);
  }
  const raw = await response.text();
  const match = raw.match(/"result"\s*:\s*\{[\s\S]*?"value"\s*:\s*(\d+)/);
  if (!match?.[1]) {
    throw new Error(`getBalance did not return an integer value for ${params.pubkey.toBase58()}`);
  }
  return new BN(match[1], 10);
}

async function readTokenAccount(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  owner: PublicKey;
  mint: MintSnapshot;
  allowOwnerOffCurve: boolean;
  readWithheld: boolean;
  /** When set, read this token account instead of deriving the owner ATA. */
  account?: PublicKey;
}): Promise<TokenAccountRead> {
  assertBoundConnection(params.verified, params.connection);
  const ata =
    params.account ??
    getAssociatedTokenAddressSync(
      params.mint.mint,
      params.owner,
      params.allowOwnerOffCurve,
      params.mint.ownerProgram,
    );
  const info = await params.connection.getAccountInfo(ata, "confirmed");
  if (info === null) {
    return {
      ata,
      present: false,
      amount: null,
      decimals: null,
      mintDecimals: params.mint.decimals,
      authority: null,
      withheldAmount: null,
    };
  }
  const account = unpackAccount(ata, info, params.mint.ownerProgram);
  if (!info.owner.equals(params.mint.ownerProgram)) {
    throw new ClientValidationError("TOKEN_ACCOUNT_PROGRAM", [
      `ATA ${ata.toBase58()} owner program ${info.owner.toBase58()} is not mint program ${params.mint.ownerProgram.toBase58()}`,
    ]);
  }
  if (!account.mint.equals(params.mint.mint)) {
    throw new ClientValidationError("TOKEN_ACCOUNT_MINT", [
      `ATA ${ata.toBase58()} mint ${account.mint.toBase58()} is not ${params.mint.mint.toBase58()}`,
    ]);
  }
  if (!account.owner.equals(params.owner)) {
    throw new ClientValidationError("TOKEN_ACCOUNT_AUTHORITY", [
      `ATA ${ata.toBase58()} authority ${account.owner.toBase58()} is not ${params.owner.toBase58()}`,
    ]);
  }
  const withheldAmount = params.readWithheld
    ? parseIchorTransferFeeAmount(
        info.data instanceof Uint8Array ? info.data : new Uint8Array(info.data),
      ).withheldAmount
    : null;
  return {
    ata,
    present: true,
    amount: new BN(account.amount.toString()),
    decimals: params.mint.decimals,
    mintDecimals: params.mint.decimals,
    authority: account.owner,
    withheldAmount,
  };
}

export async function readWalletLiveState(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  owner: PublicKey;
  ichorMint: string | null;
}): Promise<WalletLiveState> {
  assertBoundConnection(params.verified, params.connection);
  const nativeMint = await fetchBoundMintSnapshot(
    params.connection,
    params.verified,
    params.verified.network.nativeMint,
  );
  const solLamports = await readLamportsBn({
    connection: params.connection,
    verified: params.verified,
    pubkey: params.owner,
  });
  let ichor: TokenAccountRead | null = null;
  if (params.ichorMint) {
    const mint = await fetchBoundMintSnapshot(
      params.connection,
      params.verified,
      requirePublicKey(params.ichorMint, "ichorMint"),
    );
    ichor = await readTokenAccount({
      connection: params.connection,
      verified: params.verified,
      owner: params.owner,
      mint,
      allowOwnerOffCurve: false,
      readWithheld: true,
    });
  }
  return {
    owner: params.owner,
    solLamports,
    nativeMintDecimals: nativeMint.decimals,
    ichor,
  };
}

export async function readTreasuryLiveState(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  treasury: string;
  ichorMint: string | null;
  kekbullMint: string | null;
  verifiedRealm: VerifiedRealm | null;
}): Promise<TreasuryLiveState> {
  assertBoundConnection(params.verified, params.connection);
  const treasury = requirePublicKey(params.treasury, "nativeTreasury");
  const nativeMint = await fetchBoundMintSnapshot(
    params.connection,
    params.verified,
    params.verified.network.nativeMint,
  );
  const solLamports = await readLamportsBn({
    connection: params.connection,
    verified: params.verified,
    pubkey: treasury,
  });
  let ichor: TokenAccountRead | null = null;
  let kekbull: TokenAccountRead | null = null;
  let realmDeposit: TokenAccountRead | null = null;
  let mintWithheld: BN | null = null;
  if (params.kekbullMint) {
    kekbull = await readTokenAccount({
      connection: params.connection,
      verified: params.verified,
      owner: treasury,
      mint: await fetchBoundMintSnapshot(
        params.connection,
        params.verified,
        requirePublicKey(params.kekbullMint, "kekbullMint"),
      ),
      allowOwnerOffCurve: true,
      readWithheld: false,
    });
  }
  if (params.ichorMint) {
    const mint = await fetchBoundMintSnapshot(
      params.connection,
      params.verified,
      requirePublicKey(params.ichorMint, "ichorMint"),
    );
    const mintInfo = await params.connection.getAccountInfo(mint.mint, "confirmed");
    if (mintInfo === null) {
      throw new ClientValidationError("MINT_MISSING", [
        `ICHOR mint ${mint.mint.toBase58()} has no account`,
      ]);
    }
    mintWithheld = parseIchorTransferFeeConfig(
      mintInfo.data instanceof Uint8Array ? mintInfo.data : new Uint8Array(mintInfo.data),
    ).withheldAmount;
    ichor = await readTokenAccount({
      connection: params.connection,
      verified: params.verified,
      owner: treasury,
      mint,
      allowOwnerOffCurve: true,
      readWithheld: true,
    });
    if (params.verifiedRealm) {
      if (!params.verifiedRealm.communityMint.equals(mint.mint)) {
        throw new ClientValidationError("REALM_MINT_MISMATCH", [
          `Realm community mint ${params.verifiedRealm.communityMint.toBase58()} is not ICHOR ${mint.mint.toBase58()}`,
        ]);
      }
      const holding = await communityGoverningTokenHoldingAddress(params.verifiedRealm);
      realmDeposit = await readTokenAccount({
        connection: params.connection,
        verified: params.verified,
        owner: params.verifiedRealm.realm,
        mint,
        allowOwnerOffCurve: true,
        readWithheld: true,
        account: holding,
      });
    }
  }
  return {
    treasury,
    solLamports,
    nativeMintDecimals: nativeMint.decimals,
    ichor,
    kekbull,
    realmDeposit,
    mintWithheld,
  };
}

export async function readIchorMint(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  ichorMint: string;
}): Promise<MintSnapshot> {
  assertBoundConnection(params.verified, params.connection);
  return fetchBoundMintSnapshot(
    params.connection,
    params.verified,
    requirePublicKey(params.ichorMint, "ichorMint"),
  );
}

export async function readPermanentLock(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  position: string;
  expectedLockedLiquidityBaseUnits: string;
}): Promise<PermanentLockVerification> {
  assertBoundConnection(params.verified, params.connection);
  return verifyPermanentLock({
    connection: params.connection,
    verified: params.verified,
    position: requirePublicKey(params.position, "meteoraPosition"),
    expectedLiquidity: parsePositiveDecimalIntegerString(
      params.expectedLockedLiquidityBaseUnits,
      "expectedLockedLiquidityBaseUnits",
    ),
  });
}

export async function readLockedDammReserves(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  verifiedGovernance: VerifiedGovernanceIdentity;
  position: string;
  positionNftMint: string;
  expectedLockedLiquidityBaseUnits: string;
  ichorMint: string;
}): Promise<LockedDammPoolTokens> {
  assertBoundConnection(params.verified, params.connection);
  return readLockedDammPoolTokens({
    connection: params.connection,
    verified: params.verified,
    verifiedGovernance: params.verifiedGovernance,
    position: requirePublicKey(params.position, "meteoraPosition"),
    positionNftMint: requirePublicKey(params.positionNftMint, "meteoraPositionNftMint"),
    expectedLiquidity: parsePositiveDecimalIntegerString(
      params.expectedLockedLiquidityBaseUnits,
      "expectedLockedLiquidityBaseUnits",
    ),
    ichorMint: requirePublicKey(params.ichorMint, "ichorMint"),
  });
}

export async function readSourceAmmReserves(params: {
  connection: Connection;
  verifiedConfig: VerifiedIchorConfig;
}): Promise<CanonicalPumpSwapReserves | null> {
  assertBoundConnection(params.verifiedConfig.verifiedProgram.verified, params.connection);
  try {
    return await readCanonicalPumpSwapPoolSnapshot({
      connection: params.connection,
      verifiedConfig: params.verifiedConfig,
    });
  } catch (err) {
    if (
      (err instanceof ClientValidationError && err.code === "PUMPSWAP_POOL_MISSING") ||
      (typeof err === "object" &&
        err !== null &&
        (err as { code?: unknown }).code === "PUMPSWAP_POOL_MISSING")
    ) {
      return null;
    }
    throw err;
  }
}

export interface MintDisplayName {
  readonly name: string;
  readonly symbol: string;
}

export interface BurnLiveState {
  readonly kekbullMint: MintSnapshot | null;
  readonly ichorMint: MintSnapshot | null;
  readonly sourceMintName: MintDisplayName | null;
  readonly walletKekbull: TokenAccountRead | null;
  readonly walletIchor: TokenAccountRead | null;
  readonly treasuryKekbull: TokenAccountRead | null;
  readonly treasuryIchor: TokenAccountRead | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Token-2022 TokenMetadata on the mint account. Name/symbol are what Phantom
 * shows (this throwaway is apple / core). Convert keys off Config kekbullMint,
 * not the ticker.
 */
export async function readToken2022MintDisplayName(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  mint: PublicKey;
}): Promise<MintDisplayName | null> {
  assertBoundConnection(params.verified, params.connection);
  const parsed = await params.connection.getParsedAccountInfo(params.mint, "confirmed");
  const data = parsed.value?.data;
  if (!data || typeof data !== "object" || !("parsed" in data)) {
    return null;
  }
  const info = asRecord((data.parsed as { info?: unknown }).info);
  const extensions = info?.extensions;
  if (!Array.isArray(extensions)) {
    return null;
  }
  for (const entry of extensions) {
    const ext = asRecord(entry);
    if (ext?.extension !== "tokenMetadata") {
      continue;
    }
    const state = asRecord(ext.state);
    const name = state?.name;
    const symbol = state?.symbol;
    if (typeof name === "string" && name.length > 0 && typeof symbol === "string" && symbol.length > 0) {
      return { name, symbol };
    }
  }
  return null;
}

/**
 * Live KEKBULL / ICHOR mint snapshots and token-account balances for the
 * configured identities. Empty config fields are not treated as zero and are
 * not read. Program Config cumulative counters are not decoded here: the
 * local client does not export a config reader.
 */
export async function readBurnLiveState(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  owner: PublicKey | null;
  kekbullMint: string | null;
  ichorMint: string | null;
  treasury: string | null;
}): Promise<BurnLiveState> {
  assertBoundConnection(params.verified, params.connection);
  const kekbullMint = params.kekbullMint
    ? await fetchBoundMintSnapshot(
        params.connection,
        params.verified,
        requirePublicKey(params.kekbullMint, "kekbullMint"),
      )
    : null;
  const ichorMint = params.ichorMint
    ? await fetchBoundMintSnapshot(
        params.connection,
        params.verified,
        requirePublicKey(params.ichorMint, "ichorMint"),
      )
    : null;

  async function tokenFor(
    owner: PublicKey,
    mint: MintSnapshot | null,
    allowOwnerOffCurve: boolean,
    readWithheld: boolean,
  ): Promise<TokenAccountRead | null> {
    if (!mint) {
      return null;
    }
    return readTokenAccount({
      connection: params.connection,
      verified: params.verified,
      owner,
      mint,
      allowOwnerOffCurve,
      readWithheld,
    });
  }

  const walletKekbull = params.owner ? await tokenFor(params.owner, kekbullMint, false, false) : null;
  const walletIchor = params.owner ? await tokenFor(params.owner, ichorMint, false, true) : null;
  let treasuryKekbull: TokenAccountRead | null = null;
  let treasuryIchor: TokenAccountRead | null = null;
  if (params.treasury) {
    const treasury = requirePublicKey(params.treasury, "nativeTreasury");
    treasuryKekbull = await tokenFor(treasury, kekbullMint, true, false);
    treasuryIchor = await tokenFor(treasury, ichorMint, true, true);
  }
  const sourceMintName = kekbullMint
    ? await readToken2022MintDisplayName({
        connection: params.connection,
        verified: params.verified,
        mint: kekbullMint.mint,
      })
    : null;
  return {
    kekbullMint,
    ichorMint,
    sourceMintName,
    walletKekbull,
    walletIchor,
    treasuryKekbull,
    treasuryIchor,
  };
}

export interface TransferFeePreview {
  readonly amount: BN;
  readonly fee: BN;
  readonly net: BN;
  readonly basisPoints: number;
}

export interface HolderVoteBalances {
  readonly walletIchor: TokenAccountRead;
  readonly deposit: CommunityGoverningTokenDeposit;
  readonly decimals: number;
  readonly depositQuote: TransferFeePreview | null;
  readonly withdrawQuote: TransferFeePreview | null;
}

async function liveMintTransferQuote(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  mint: PublicKey;
  amount: BN;
}): Promise<TransferFeePreview> {
  assertBoundConnection(params.verified, params.connection);
  const info = await params.connection.getAccountInfo(params.mint, "confirmed");
  if (info === null) {
    throw new ClientValidationError("MINT_MISSING", [
      `ICHOR mint ${params.mint.toBase58()} has no account`,
    ]);
  }
  const feeConfig = parseIchorTransferFeeConfig(
    info.data instanceof Uint8Array ? info.data : new Uint8Array(info.data),
  );
  const epochInfo = await params.connection.getEpochInfo("confirmed");
  if (!Number.isSafeInteger(epochInfo.epoch) || epochInfo.epoch < 0) {
    throw new ClientValidationError("EPOCH_UNAVAILABLE", [
      "confirmed epoch is not a safe non-negative integer",
    ]);
  }
  const currentEpoch = new BN(epochInfo.epoch);
  const schedule = currentEpoch.gte(feeConfig.newerTransferFee.epoch)
    ? feeConfig.newerTransferFee
    : feeConfig.olderTransferFee;
  const fee = getCurrentMintFee({
    config: feeConfig,
    currentEpoch,
    preFeeAmount: params.amount,
  });
  return {
    amount: params.amount,
    fee,
    net: params.amount.sub(fee),
    basisPoints: schedule.transferFeeBasisPoints,
  };
}

/**
 * Wallet ICHOR (what you can deposit) and the Realms TokenOwnerRecord deposit
 * (what you can withdraw after relinquishing). Withdraw quote is the post-fee
 * wallet receipt from the live mint fee, not the raw voting weight.
 */
export async function readHolderVoteBalances(params: {
  connection: Connection;
  verifiedRealm: VerifiedRealm;
  owner: PublicKey;
}): Promise<HolderVoteBalances> {
  assertBoundConnection(params.verifiedRealm.verified, params.connection);
  const mint = await fetchBoundMintSnapshot(
    params.connection,
    params.verifiedRealm.verified,
    params.verifiedRealm.communityMint,
  );
  const walletIchor = await readTokenAccount({
    connection: params.connection,
    verified: params.verifiedRealm.verified,
    owner: params.owner,
    mint,
    allowOwnerOffCurve: false,
    readWithheld: true,
  });
  const deposit = await readCommunityGoverningTokenDeposit({
    connection: params.connection,
    verifiedRealm: params.verifiedRealm,
    governingTokenOwner: params.owner,
  });
  const depositAmount = walletIchor.amount ?? new BN(0);
  const depositQuote =
    depositAmount.gt(new BN(0))
      ? await liveMintTransferQuote({
          connection: params.connection,
          verified: params.verifiedRealm.verified,
          mint: mint.mint,
          amount: depositAmount,
        })
      : null;
  const withdrawQuote =
    deposit.amount.gt(new BN(0))
      ? await liveMintTransferQuote({
          connection: params.connection,
          verified: params.verifiedRealm.verified,
          mint: mint.mint,
          amount: deposit.amount,
        })
      : null;
  return { walletIchor, deposit, decimals: mint.decimals, depositQuote, withdrawQuote };
}

/**
 * Bonding-curve `complete`, read from chain.
 *
 * Returns null when the curve cannot be read or does not parse. Null means
 * "unknown", and `resolveDaoState` treats unknown as not-yet-graduated: a page
 * that has not read the curve must never claim the coin graduated.
 */
export async function readCurveComplete(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  kekbullMint: PublicKey;
  bondingCurve: PublicKey;
}): Promise<boolean | null> {
  assertBoundConnection(params.verified, params.connection);
  const info = await params.connection.getAccountInfo(params.bondingCurve, "confirmed");
  if (!info) {
    return null;
  }
  try {
    return parseBondingCurveAccount({
      address: params.bondingCurve,
      owner: info.owner,
      data: info.data,
      expectedMint: params.kekbullMint,
      expectedAddress: params.bondingCurve,
    }).complete;
  } catch {
    // A curve that does not parse is not a graduated curve. Fail backwards.
    return null;
  }
}
