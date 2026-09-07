import {
  createAssociatedTokenAccountIdempotentInstruction,
  createHarvestWithheldTokensToMintInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { getTokenHoldingAddress } from "@realms-today/spl-governance";
import {
  PublicKey,
  TransactionInstruction,
  type AccountMeta,
  type Connection,
} from "@solana/web3.js";
import BN from "bn.js";
import { assertVerifiedIchorConfig, configPda, creatorEscrowPda, withdrawWithheldPda } from "./burn.ts";
import {
  getCurrentMintFee,
  parseIchorTransferFeeAmount,
  parseIchorTransferFeeConfig,
  previewDistributeTransferFees,
  requirePilotTransferFee,
  secondHopAfterTransfer,
  TRANSFER_FEE_BASIS_POINTS,
  TRANSFER_FEE_MAXIMUM_FEE,
} from "./extensions.ts";
import { fetchMintSnapshot } from "./mint.ts";
import { TOKEN_2022_PROGRAM, REALMS_INSTANCES, assertMainnetKekbullGovernance } from "./network.ts";
import { assertBoundConnection } from "./preflight.ts";
import type {
  BuildClaimCreatorFeesParams,
  BuildCollectTransferFeesParams,
  BuildDistributeTransferFeesParams,
  BuildHarvestWithheldTokensToMintParams,
  CollectTransferFeesBuild,
  BuildRevokeTransferFeeAuthorityParams,
  BuildSetCreatorBeneficiaryParams,
  BuildCommitDaoDestinationParams,
  BuildSetFeeDistributionParams,
  CommittedDaoDestination,
  DaoDestinationIdentity,
  BuildSetTransferFeeParams,
  BuildSweepUnclaimedCreatorFeesParams,
  ClaimCreatorFeesBuild,
  DistributeTransferFeesBuild,
  HarvestWithheldTokensToMintBuild,
  SweepUnclaimedCreatorFeesBuild,
  IchorConfigSnapshot,
  UnsignedInstructionBuild,
  VerifiedGovernanceIdentity,
  VerifiedIchorConfig,
  VerifiedIchorProgram,
} from "./types.ts";
import { ClientValidationError } from "./types.ts";
import {
  assertIchorIsToken2022,
  assertNoSecretMaterial,
  requirePublicKey,
  requireU64Bn,
} from "./validation.ts";

/**
 * Anchor 0.32 sighash: first 8 bytes of sha256("global:<name>").
 * Pinned so this module stays browser-safe. Tests recompute each hash.
 */
export const COMMIT_DAO_DESTINATION_DISCRIMINATOR = new Uint8Array([
  0xe5, 0x13, 0xa4, 0x25, 0x6a, 0x00, 0xbd, 0x38,
]);
export const SET_FEE_DISTRIBUTION_DISCRIMINATOR = new Uint8Array([
  0xdc, 0xb7, 0xdc, 0x5a, 0x7a, 0x20, 0xa6, 0x03,
]);
export const DISTRIBUTE_TRANSFER_FEES_DISCRIMINATOR = new Uint8Array([
  0x38, 0x1f, 0x46, 0x17, 0x77, 0xc4, 0x48, 0xf4,
]);
export const SET_TRANSFER_FEE_DISCRIMINATOR = new Uint8Array([
  0x3a, 0x95, 0x25, 0x03, 0xe6, 0x4e, 0xb5, 0xb4,
]);
export const REVOKE_TRANSFER_FEE_AUTHORITY_DISCRIMINATOR = new Uint8Array([
  0x5c, 0x2c, 0xa4, 0x95, 0xcc, 0xba, 0x28, 0xb1,
]);
export const CLAIM_CREATOR_FEES_DISCRIMINATOR = new Uint8Array([
  0x00, 0x17, 0x7d, 0xea, 0x9c, 0x76, 0x86, 0x59,
]);
export const SWEEP_UNCLAIMED_CREATOR_FEES_DISCRIMINATOR = new Uint8Array([
  0x65, 0xc4, 0x5f, 0xa7, 0x97, 0xae, 0x5c, 0xa3,
]);
export const SET_CREATOR_BENEFICIARY_DISCRIMINATOR = new Uint8Array([
  0xcc, 0x3c, 0x7c, 0x2c, 0x76, 0xef, 0xdf, 0xd5,
]);

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

const CALLER_SPLIT_FIELDS = [
  "creatorBps",
  "realmsBps",
  "split",
  "feeSplit",
  "creatorShare",
  "realmsShare",
] as const;

const CALLER_TREASURY_FIELDS = [
  "realmsTreasury",
  "treasury",
  "nativeTreasury",
  "realmsProgram",
  "governance",
] as const;

const CALLER_HARVEST_DISCOVERY_FIELDS = [
  "discover",
  "scan",
  "getProgramAccounts",
  "getTokenAccountsByOwner",
  "getTokenLargestAccounts",
] as const;

const TOKEN_ACCOUNT_BASE_LEN = 165;
const TOKEN_ACCOUNT_OFF_MINT = 0;
const TOKEN_ACCOUNT_OFF_OWNER = 32;
const TOKEN_ACCOUNT_OFF_AMOUNT = 64;
const TOKEN_ACCOUNT_OFF_STATE = 108;
const TOKEN_ACCOUNT_STATE_INITIALIZED = 1;
const TOKEN_ACCOUNT_STATE_FROZEN = 2;

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

function asUint8(data: ArrayLike<number>): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function pubkeyBytes(key: PublicKey): Uint8Array {
  return Uint8Array.from(key.toBytes());
}

function u16LeBytes(value: number, label: string): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new ClientValidationError("INVALID_INT", [
      `${label} ${String(value)} is not an unsigned 16-bit integer`,
    ]);
  }
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

function u64LeBytes(value: BN, label: string): Uint8Array {
  return Uint8Array.from(requireU64Bn(value, label).toArray("le", 8));
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

function assertNoCallerFields(params: object, fields: readonly string[], label: string, code: string): void {
  const hits = fields.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError(code, [
      `${label} rejects ${hits.join(", ")}`,
    ]);
  }
}

function requireIssuedConfig(
  params: { connection: Connection; verifiedConfig: VerifiedIchorConfig },
  label: string,
): { verifiedProgram: VerifiedIchorProgram; config: IchorConfigSnapshot; configAddress: PublicKey } {
  assertNoSecretMaterial(params, label);
  assertNoCallerFields(params, CALLER_PROGRAM_OR_CONFIG_FIELDS, label, "CALLER_PROGRAM_OR_CONFIG");
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

function requireMatchingAuthority(
  params: { connection: Connection; verifiedConfig: VerifiedIchorConfig; authority: PublicKey },
  label: string,
): {
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

function parseTokenAccount(params: {
  ownerProgram: PublicKey;
  data: Uint8Array;
  expectedMint: PublicKey;
  expectedOwner: PublicKey;
  expectedTokenProgram: PublicKey;
  label: string;
}): { amount: BN } {
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
  const mint = new PublicKey(params.data.subarray(TOKEN_ACCOUNT_OFF_MINT, TOKEN_ACCOUNT_OFF_MINT + 32));
  const owner = new PublicKey(params.data.subarray(TOKEN_ACCOUNT_OFF_OWNER, TOKEN_ACCOUNT_OFF_OWNER + 32));
  const amount = new BN(Array.from(params.data.subarray(TOKEN_ACCOUNT_OFF_AMOUNT, TOKEN_ACCOUNT_OFF_AMOUNT + 8)), "le");
  const state = params.data[TOKEN_ACCOUNT_OFF_STATE];
  if (!mint.equals(params.expectedMint)) {
    throw new ClientValidationError("TOKEN_ACCOUNT_MINT_MISMATCH", [
      `${params.label} mint ${mint.toBase58()} is not ${params.expectedMint.toBase58()}`,
    ]);
  }
  if (!owner.equals(params.expectedOwner)) {
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
  return { amount };
}

async function fetchConfirmedEpoch(connection: Connection): Promise<BN> {
  const info = await connection.getEpochInfo("confirmed");
  if (!Number.isSafeInteger(info.epoch) || info.epoch < 0) {
    throw new ClientValidationError("EPOCH_UNAVAILABLE", [
      "confirmed epoch is not a safe non-negative integer",
    ]);
  }
  return new BN(info.epoch);
}

async function fetchIchorFeeConfig(params: {
  connection: Connection;
  verifiedProgram: VerifiedIchorProgram;
  ichorMint: PublicKey;
}): Promise<{
  mint: PublicKey;
  data: Uint8Array;
  fee: ReturnType<typeof parseIchorTransferFeeConfig>;
  decimals: number;
}> {
  const snapshot = await fetchMintSnapshot(
    params.connection,
    params.verifiedProgram.verified.network,
    params.ichorMint,
  );
  assertIchorIsToken2022(snapshot);
  const info = await params.connection.getAccountInfo(snapshot.mint, "confirmed");
  if (info === null) {
    throw new ClientValidationError("MINT_MISSING", [`ICHOR mint ${snapshot.mint.toBase58()} has no account`]);
  }
  const data = asUint8(info.data);
  return {
    mint: snapshot.mint,
    data,
    fee: parseIchorTransferFeeConfig(data),
    decimals: snapshot.decimals,
  };
}

const GOVER5_REALMS_PROGRAM = REALMS_INSTANCES["default-shared"].id;
const GTEST_REALMS_PROGRAM = REALMS_INSTANCES.test.id;
const ACCOUNT_GOVERNANCE_SEED = new TextEncoder().encode("account-governance");
const NATIVE_TREASURY_SEED = new TextEncoder().encode("native-treasury");

/** Same PDA as @realms-today/spl-governance getNativeTreasuryAddress. */
async function getNativeTreasuryAddress(
  realmsProgram: PublicKey,
  governance: PublicKey,
): Promise<PublicKey> {
  return PublicKey.findProgramAddressSync(
    [NATIVE_TREASURY_SEED, requirePublicKey(governance, "governance").toBytes()],
    requirePublicKey(realmsProgram, "realmsProgram"),
  )[0];
}

export function deriveAccountGovernanceAddress(
  realmsProgram: PublicKey,
  realm: PublicKey,
  governedAccount: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      ACCOUNT_GOVERNANCE_SEED,
      requirePublicKey(realm, "realm").toBytes(),
      requirePublicKey(governedAccount, "governedAccount").toBytes(),
    ],
    requirePublicKey(realmsProgram, "realmsProgram"),
  )[0];
}

export async function deriveNativeTreasuryAddress(
  realmsProgram: PublicKey,
  governance: PublicKey,
): Promise<PublicKey> {
  return getNativeTreasuryAddress(
    requirePublicKey(realmsProgram, "realmsProgram"),
    requirePublicKey(governance, "governance"),
  );
}

function requireNamedPubkey(key: PublicKey | null, label: string): PublicKey {
  if (key === null) {
    throw new ClientValidationError("DAO_DESTINATION_UNCOMMITTED", [
      `${label} is missing`,
    ]);
  }
  const pk = requirePublicKey(key, label);
  if (pk.equals(PublicKey.default)) {
    throw new ClientValidationError("DAO_DESTINATION_UNCOMMITTED", [
      `${label} is the default pubkey`,
    ]);
  }
  return pk;
}

/**
 * Read the on-chain DAO destination from Config. Missing or default fields
 * fail closed - deployment JSON cannot invent a destination.
 */
export function readCommittedDaoDestination(
  config: Pick<
    IchorConfigSnapshot,
    "realmsRealm" | "realmsProgram" | "realmsGovernance" | "realmsNativeTreasury"
  >,
): CommittedDaoDestination {
  const commitment = {
    realm: requireNamedPubkey(config.realmsRealm, "config.realmsRealm"),
    realmsProgram: requireNamedPubkey(config.realmsProgram, "config.realmsProgram"),
    governance: requireNamedPubkey(config.realmsGovernance, "config.realmsGovernance"),
    nativeTreasury: requireNamedPubkey(config.realmsNativeTreasury, "config.realmsNativeTreasury"),
  };
  requireCommitmentRealmsProgram(commitment.realmsProgram, "config.realmsProgram");
  return commitment;
}

function refuseGtestRealmsProgram(program: PublicKey, label: string): void {
  if (program.toBase58() === GTEST_REALMS_PROGRAM) {
    throw new ClientValidationError("GTEST_REFUSED", [
      `${label} is GTesT; GTesT is not GovER5 and is never default-shared / mainnet proof`,
    ]);
  }
}

function requireCommitmentRealmsProgram(program: PublicKey, label: string): void {
  refuseGtestRealmsProgram(program, label);
  const id = program.toBase58();
  if (id === GOVER5_REALMS_PROGRAM) {
    return;
  }
  const kekbull = REALMS_INSTANCES.kekbull?.id;
  if (kekbull && id === kekbull) {
    return;
  }
  throw new ClientValidationError("INVALID_REALMS_PROGRAM", [
    `${label} ${id} is neither GovER5 ${GOVER5_REALMS_PROGRAM} nor kekbull ${kekbull ?? "(unset)"}`,
  ]);
}

/**
 * Exact-match gate. Commitment and identity must both be GovER5. Rejects a
 * consistent GTesT tuple, GovER5↔GTesT substitution, and any substituted
 * realm / Governance / treasury. Community mint must equal ICHOR.
 */
export function assertDaoDestinationMatchesCommitment(params: {
  readonly commitment: CommittedDaoDestination;
  readonly identity: DaoDestinationIdentity;
  readonly ichorMint: PublicKey;
}): void {
  const ichorMint = requirePublicKey(params.ichorMint, "ichorMint");
  const commitment = params.commitment;
  const identity = params.identity;
  if (ichorMint.equals(PublicKey.default)) {
    throw new ClientValidationError("INVALID_ICHOR_MINT", ["ichorMint is the default pubkey"]);
  }
  if (!identity.communityMint.equals(ichorMint)) {
    throw new ClientValidationError("COMMUNITY_MINT_MISMATCH", [
      `realm community mint ${identity.communityMint.toBase58()} !== ICHOR ${ichorMint.toBase58()}`,
    ]);
  }
  requireCommitmentRealmsProgram(commitment.realmsProgram, "committed realms program");
  requireCommitmentRealmsProgram(identity.realmsProgram, "identity realms program");
  if (!identity.realm.equals(commitment.realm)) {
    throw new ClientValidationError("DAO_DESTINATION_MISMATCH", [
      `realm ${identity.realm.toBase58()} !== committed ${commitment.realm.toBase58()}`,
    ]);
  }
  if (!identity.governance.equals(commitment.governance)) {
    throw new ClientValidationError("DAO_DESTINATION_MISMATCH", [
      `governance ${identity.governance.toBase58()} !== committed ${commitment.governance.toBase58()}`,
    ]);
  }
  if (!identity.realmsProgram.equals(commitment.realmsProgram)) {
    throw new ClientValidationError("DAO_DESTINATION_MISMATCH", [
      `realms program ${identity.realmsProgram.toBase58()} !== committed ${commitment.realmsProgram.toBase58()}`,
    ]);
  }
  if (!identity.nativeTreasury.equals(commitment.nativeTreasury)) {
    throw new ClientValidationError("DAO_DESTINATION_MISMATCH", [
      `native treasury ${identity.nativeTreasury.toBase58()} !== committed ${commitment.nativeTreasury.toBase58()}`,
    ]);
  }
}

/** Bind / position-rights handoff stay disabled until commitment matches. */
export function daoDestinationActionsEnabled(params: {
  readonly committed: CommittedDaoDestination | null;
  readonly identity: DaoDestinationIdentity | null;
  readonly ichorMint: PublicKey | null;
}): boolean {
  if (params.committed === null || params.identity === null || params.ichorMint === null) {
    return false;
  }
  try {
    assertDaoDestinationMatchesCommitment({
      commitment: params.committed,
      identity: params.identity,
      ichorMint: params.ichorMint,
    });
    return true;
  } catch {
    return false;
  }
}

export async function daoDestinationIdentityFromIssuedGovernance(
  verifiedGovernance: VerifiedGovernanceIdentity,
): Promise<DaoDestinationIdentity> {
  const { assertVerifiedGovernanceIdentity } = await import("./realms.ts");
  assertVerifiedGovernanceIdentity(verifiedGovernance);
  const realmsProgram = verifiedGovernance.verifiedRealm.verified.network.realmsProgramId;
  const nativeTreasury = await getNativeTreasuryAddress(
    realmsProgram,
    verifiedGovernance.governance,
  );
  return {
    realm: verifiedGovernance.realm,
    governance: verifiedGovernance.governance,
    realmsProgram,
    nativeTreasury,
    communityMint: verifiedGovernance.communityMint,
  };
}

export async function assertIssuedIdentityMatchesCommittedDaoDestination(params: {
  readonly verifiedConfig: VerifiedIchorConfig;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
}): Promise<CommittedDaoDestination> {
  const commitment = readCommittedDaoDestination(params.verifiedConfig.config);
  const identity = await daoDestinationIdentityFromIssuedGovernance(params.verifiedGovernance);
  assertDaoDestinationMatchesCommitment({
    commitment,
    identity,
    ichorMint: params.verifiedConfig.config.ichorMint,
  });
  return commitment;
}

export function encodeCommitDaoDestinationInstructionData(): Uint8Array {
  return Uint8Array.from(COMMIT_DAO_DESTINATION_DISCRIMINATOR);
}

/**
 * Unsigned `commit_dao_destination`. Writes realm / Governance / treasury
 * before fee bind. Caller cannot pass a substitute treasury.
 */
export async function buildCommitDaoDestination(
  params: BuildCommitDaoDestinationParams,
): Promise<UnsignedInstructionBuild> {
  assertNoCallerFields(params, CALLER_TREASURY_FIELDS, "buildCommitDaoDestination", "CALLER_TREASURY");
  const { verifiedProgram, config, configAddress, authority } = requireMatchingAuthority(
    params,
    "buildCommitDaoDestination",
  );
  if (config.feeBeneficiariesBound) {
    throw new ClientValidationError("FEE_BENEFICIARIES_ALREADY_BOUND", [
      "fee beneficiaries are already permanently bound",
    ]);
  }
  if (
    config.realmsProgram !== null ||
    config.realmsRealm !== null ||
    config.realmsGovernance !== null ||
    config.realmsNativeTreasury !== null
  ) {
    throw new ClientValidationError("DAO_DESTINATION_ALREADY_COMMITTED", [
      "DAO destination is already committed on Config",
    ]);
  }
  const { assertVerifiedGovernanceIdentity } = await import("./realms.ts");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  if (params.verifiedGovernance.verifiedRealm.verified !== verifiedProgram.verified) {
    throw new ClientValidationError("NETWORK_PROOF", [
      "VerifiedGovernance is not bound to the same issued network as VerifiedIchorConfig",
    ]);
  }
  if (!params.verifiedGovernance.communityMint.equals(config.ichorMint)) {
    throw new ClientValidationError("COMMUNITY_MINT_MISMATCH", [
      `realm community mint ${params.verifiedGovernance.communityMint.toBase58()} !== ICHOR ${config.ichorMint.toBase58()}`,
    ]);
  }
  const identity = await daoDestinationIdentityFromIssuedGovernance(params.verifiedGovernance);
  assertMainnetKekbullGovernance(verifiedProgram.verified.network);
  requireCommitmentRealmsProgram(identity.realmsProgram, "commit realms program");
  return unsignedIx(
    instruction(
      verifiedProgram.programId,
      [
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: configAddress, isSigner: false, isWritable: true },
        { pubkey: identity.realmsProgram, isSigner: false, isWritable: false },
        { pubkey: identity.realm, isSigner: false, isWritable: false },
        { pubkey: identity.governance, isSigner: false, isWritable: false },
        { pubkey: identity.nativeTreasury, isSigner: false, isWritable: false },
      ],
      encodeCommitDaoDestinationInstructionData(),
    ),
    {
      programId: verifiedProgram.programId,
      config: configAddress,
      authority,
      realmsProgram: identity.realmsProgram,
      realm: identity.realm,
      governance: identity.governance,
      nativeTreasury: identity.nativeTreasury,
    },
  );
}

export function encodeSetFeeDistributionInstructionData(creatorBeneficiary: PublicKey): Uint8Array {
  const key = requirePublicKey(creatorBeneficiary, "creatorBeneficiary");
  if (key.equals(PublicKey.default)) {
    throw new ClientValidationError("INVALID_FEE_BENEFICIARY", [
      "creatorBeneficiary cannot be the default pubkey",
    ]);
  }
  return concatBytes(SET_FEE_DISTRIBUTION_DISCRIMINATOR, pubkeyBytes(key));
}

export function encodeDistributeTransferFeesInstructionData(): Uint8Array {
  return Uint8Array.from(DISTRIBUTE_TRANSFER_FEES_DISCRIMINATOR);
}

export function encodeSetTransferFeeInstructionData(
  transferFeeBasisPoints: number,
  maximumFee: BN,
): Uint8Array {
  requirePilotTransferFee(transferFeeBasisPoints, maximumFee);
  return concatBytes(
    SET_TRANSFER_FEE_DISCRIMINATOR,
    u16LeBytes(transferFeeBasisPoints, "transferFeeBasisPoints"),
    u64LeBytes(maximumFee, "maximumFee"),
  );
}

export function encodeRevokeTransferFeeAuthorityInstructionData(): Uint8Array {
  return Uint8Array.from(REVOKE_TRANSFER_FEE_AUTHORITY_DISCRIMINATOR);
}

export function encodeClaimCreatorFeesInstructionData(): Uint8Array {
  return Uint8Array.from(CLAIM_CREATOR_FEES_DISCRIMINATOR);
}

export function encodeSweepUnclaimedCreatorFeesInstructionData(): Uint8Array {
  return Uint8Array.from(SWEEP_UNCLAIMED_CREATOR_FEES_DISCRIMINATOR);
}

export function encodeSetCreatorBeneficiaryInstructionData(newBeneficiary: PublicKey): Uint8Array {
  const key = requirePublicKey(newBeneficiary, "newBeneficiary");
  if (key.equals(PublicKey.default)) {
    throw new ClientValidationError("INVALID_FEE_BENEFICIARY", [
      "newBeneficiary cannot be the default pubkey",
    ]);
  }
  return concatBytes(SET_CREATOR_BENEFICIARY_DISCRIMINATOR, pubkeyBytes(key));
}

/**
 * Unsigned `set_fee_distribution`. Split weights are program constants
 * 2500/7500. Destination accounts come from the on-chain commitment; the
 * issued governance proof must match it. Deployment JSON cannot pick them.
 */
export async function buildSetFeeDistribution(
  params: BuildSetFeeDistributionParams,
): Promise<UnsignedInstructionBuild> {
  assertNoCallerFields(params, CALLER_SPLIT_FIELDS, "buildSetFeeDistribution", "CALLER_SPLIT");
  assertNoCallerFields(params, CALLER_TREASURY_FIELDS, "buildSetFeeDistribution", "CALLER_TREASURY");
  const { verifiedProgram, config, configAddress, authority } = requireMatchingAuthority(
    params,
    "buildSetFeeDistribution",
  );
  if (config.feeBeneficiariesBound) {
    throw new ClientValidationError("FEE_BENEFICIARIES_ALREADY_BOUND", [
      "fee beneficiaries are already permanently bound",
    ]);
  }
  const commitment = readCommittedDaoDestination(config);
  const { assertVerifiedGovernanceIdentity } = await import("./realms.ts");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  if (params.verifiedGovernance.verifiedRealm.verified !== verifiedProgram.verified) {
    throw new ClientValidationError("NETWORK_PROOF", [
      "VerifiedGovernance is not bound to the same issued network as VerifiedIchorConfig",
    ]);
  }
  const identity = await daoDestinationIdentityFromIssuedGovernance(params.verifiedGovernance);
  assertDaoDestinationMatchesCommitment({
    commitment,
    identity,
    ichorMint: config.ichorMint,
  });
  const creatorBeneficiary = requirePublicKey(params.creatorBeneficiary, "creatorBeneficiary");
  if (creatorBeneficiary.equals(PublicKey.default)) {
    throw new ClientValidationError("INVALID_FEE_BENEFICIARY", [
      "creatorBeneficiary cannot be the default pubkey",
    ]);
  }
  if (!PublicKey.isOnCurve(creatorBeneficiary.toBytes())) {
    throw new ClientValidationError("INVALID_FEE_BENEFICIARY", [
      "creatorBeneficiary must be an on-curve wallet pubkey; a PDA cannot receive the 25% creator cut",
    ]);
  }
  const withdrawAuthority = withdrawWithheldPda(verifiedProgram.programId).address;
  if (
    [
      config.ichorMint,
      withdrawAuthority,
      commitment.realmsProgram,
      commitment.realm,
      commitment.governance,
      commitment.nativeTreasury,
    ].some((key) => creatorBeneficiary.equals(key))
  ) {
    throw new ClientValidationError("INVALID_FEE_BENEFICIARY", [
      "creatorBeneficiary cannot be an ICHOR mint, program PDA, Realm, Governance, or treasury address",
    ]);
  }
  const data = encodeSetFeeDistributionInstructionData(creatorBeneficiary);
  return unsignedIx(
    instruction(
      verifiedProgram.programId,
      [
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: configAddress, isSigner: false, isWritable: true },
        { pubkey: commitment.realmsProgram, isSigner: false, isWritable: false },
        { pubkey: commitment.realm, isSigner: false, isWritable: false },
        { pubkey: commitment.governance, isSigner: false, isWritable: false },
        { pubkey: commitment.nativeTreasury, isSigner: false, isWritable: false },
      ],
      data,
    ),
    {
      programId: verifiedProgram.programId,
      config: configAddress,
      authority,
      creatorBeneficiary,
      realmsProgram: commitment.realmsProgram,
      realm: commitment.realm,
      governance: commitment.governance,
      nativeTreasury: commitment.nativeTreasury,
    },
  );
}

/**
 * Unsigned permissionless `distribute_transfer_fees`. Split is the program
 * 2500/7500 constant. Destinations are the bound creator and proof-derived
 * Realms treasury ATAs. Reports gross withdrawn, second-hop expected fee, and
 * expected destination nets as distinct fields.
 */
export async function buildDistributeTransferFees(
  params: BuildDistributeTransferFeesParams,
): Promise<DistributeTransferFeesBuild> {
  assertNoCallerFields(params, CALLER_SPLIT_FIELDS, "buildDistributeTransferFees", "CALLER_SPLIT");
  assertNoCallerFields(params, CALLER_TREASURY_FIELDS, "buildDistributeTransferFees", "CALLER_TREASURY");
  const { verifiedProgram, config, configAddress } = requireIssuedConfig(
    params,
    "buildDistributeTransferFees",
  );
  const caller = requirePublicKey(params.caller, "caller");
  if (caller.equals(PublicKey.default)) {
    throw new ClientValidationError("DEFAULT_PUBKEY", ["caller cannot be the default pubkey"]);
  }
  if (!config.feeBeneficiariesBound) {
    throw new ClientValidationError("FEE_BENEFICIARIES_UNBOUND", [
      "fee beneficiaries have not been bound",
    ]);
  }
  if (
    config.creatorBeneficiary === null ||
    config.realmsNativeTreasury === null ||
    config.realmsProgram === null
  ) {
    throw new ClientValidationError("FEE_BENEFICIARIES_UNBOUND", [
      "bound creator or Realms treasury is missing from config",
    ]);
  }
  const token2022 = new PublicKey(TOKEN_2022_PROGRAM.id);
  if (!config.ichorTokenProgram.equals(token2022)) {
    throw new ClientValidationError("ICHOR_TOKEN_PROGRAM", [
      "config.ichor_token_program is not Token-2022",
    ]);
  }
  const withdraw = withdrawWithheldPda(verifiedProgram.programId);
  if (config.withdrawWithheldBump !== withdraw.bump) {
    throw new ClientValidationError("WITHDRAW_WITHHELD_PDA", [
      "config.withdraw_withheld_bump is not seeds=[\"withdraw-withheld\"]",
    ]);
  }

  const [ichor, epoch] = await Promise.all([
    fetchIchorFeeConfig({
      connection: params.connection,
      verifiedProgram,
      ichorMint: config.ichorMint,
    }),
    fetchConfirmedEpoch(params.connection),
  ]);
  const feeVault = getAssociatedTokenAddressSync(ichor.mint, withdraw.address, true, token2022);
  const creatorDestination = getAssociatedTokenAddressSync(
    ichor.mint,
    config.creatorBeneficiary,
    true,
    token2022,
  );
  const realmsDestination = getAssociatedTokenAddressSync(
    ichor.mint,
    config.realmsNativeTreasury,
    true,
    token2022,
  );

  const [vaultInfo, creatorInfo, realmsInfo] = await Promise.all([
    params.connection.getAccountInfo(feeVault, "confirmed"),
    params.connection.getAccountInfo(creatorDestination, "confirmed"),
    params.connection.getAccountInfo(realmsDestination, "confirmed"),
  ]);
  const vault =
    vaultInfo === null
      ? { amount: new BN(0) }
      : parseTokenAccount({
          ownerProgram: vaultInfo.owner,
          data: asUint8(vaultInfo.data),
          expectedMint: ichor.mint,
          expectedOwner: withdraw.address,
          expectedTokenProgram: token2022,
          label: "fee_vault",
        });
  if (creatorInfo !== null) {
    parseTokenAccount({
      ownerProgram: creatorInfo.owner,
      data: asUint8(creatorInfo.data),
      expectedMint: ichor.mint,
      expectedOwner: config.creatorBeneficiary,
      expectedTokenProgram: token2022,
      label: "creator_destination",
    });
  }
  if (realmsInfo !== null) {
    parseTokenAccount({
      ownerProgram: realmsInfo.owner,
      data: asUint8(realmsInfo.data),
      expectedMint: ichor.mint,
      expectedOwner: config.realmsNativeTreasury,
      expectedTokenProgram: token2022,
      label: "realms_destination",
    });
  }

  const withheldBefore = ichor.fee.withheldAmount;
  const expectedGrossWithdrawn = withheldBefore;
  const expectedVaultDistributed = requireU64Bn(vault.amount.add(withheldBefore), "vaultDistributed");
  const preview = previewDistributeTransferFees({
    vaultDistributed: expectedVaultDistributed,
    config: ichor.fee,
    currentEpoch: epoch,
  });

  const data = encodeDistributeTransferFeesInstructionData();
  const distributeInstruction = instruction(
      verifiedProgram.programId,
      [
        { pubkey: caller, isSigner: true, isWritable: false },
        { pubkey: configAddress, isSigner: false, isWritable: true },
        { pubkey: ichor.mint, isSigner: false, isWritable: true },
        { pubkey: withdraw.address, isSigner: false, isWritable: false },
        { pubkey: feeVault, isSigner: false, isWritable: true },
        { pubkey: creatorDestination, isSigner: false, isWritable: true },
        { pubkey: realmsDestination, isSigner: false, isWritable: true },
        { pubkey: token2022, isSigner: false, isWritable: false },
      ],
      data,
    );
  const derivedAddresses = {
      programId: verifiedProgram.programId,
      config: configAddress,
      caller,
      feeVault,
      creatorDestination,
      realmsDestination,
      withdrawWithheldAuthority: withdraw.address,
    };
  const unsigned: UnsignedInstructionBuild = {
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(
        caller,
        feeVault,
        withdraw.address,
        ichor.mint,
        token2022,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        caller,
        creatorDestination,
        config.creatorBeneficiary,
        ichor.mint,
        token2022,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        caller,
        realmsDestination,
        config.realmsNativeTreasury,
        ichor.mint,
        token2022,
      ),
      distributeInstruction,
    ],
    derivedAddresses,
  };
  return {
    unsigned,
    withheldBefore,
    expectedGrossWithdrawn,
    expectedVaultDistributed,
    creatorSecondHop: preview.creatorSecondHop,
    realmsSecondHop: preview.realmsSecondHop,
    expectedCreatorNet: preview.creatorSecondHop.expectedNet,
    expectedRealmsNet: preview.realmsSecondHop.expectedNet,
    feeVault,
    creatorDestination,
    realmsDestination,
    withdrawWithheldAuthority: withdraw.address,
  };
}

async function measureWithheldIfPresent(
  connection: Connection,
  address: PublicKey,
  mint: PublicKey,
  token2022: PublicKey,
): Promise<BN | null> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (info === null || !info.owner.equals(token2022)) {
    return null;
  }
  const data = asUint8(info.data);
  const accountMint = new PublicKey(data.subarray(TOKEN_ACCOUNT_OFF_MINT, TOKEN_ACCOUNT_OFF_MINT + 32));
  if (!accountMint.equals(mint)) {
    return null;
  }
  try {
    return parseIchorTransferFeeAmount(data).withheldAmount;
  } catch {
    return null;
  }
}

/**
 * Derived Token-2022 sinks that can hold withheld ICHOR. Not a wallet scan.
 * Vote vault, creator ATA, escrow ATA, treasury ATA, fee vault.
 */
export async function measureCanonicalHarvestSources(params: {
  connection: Connection;
  verifiedConfig: VerifiedIchorConfig;
  extraSources?: readonly PublicKey[];
}): Promise<{ candidates: PublicKey[]; sources: PublicKey[]; withheldBySource: BN[]; totalWithheld: BN }> {
  assertNoCallerFields(
    params,
    CALLER_HARVEST_DISCOVERY_FIELDS,
    "measureCanonicalHarvestSources",
    "CALLER_ACCOUNT_DISCOVERY",
  );
  const { verifiedProgram, config } = requireIssuedConfig(params, "measureCanonicalHarvestSources");
  const token2022 = new PublicKey(TOKEN_2022_PROGRAM.id);
  const withdraw = withdrawWithheldPda(verifiedProgram.programId);
  const escrow = creatorEscrowPda(verifiedProgram.programId);
  const candidates: PublicKey[] = [
    getAssociatedTokenAddressSync(config.ichorMint, withdraw.address, true, token2022),
  ];
  if (config.creatorBeneficiary !== null) {
    candidates.push(
      getAssociatedTokenAddressSync(config.ichorMint, config.creatorBeneficiary, true, token2022),
    );
  }
  candidates.push(getAssociatedTokenAddressSync(config.ichorMint, escrow.address, true, token2022));
  if (config.realmsNativeTreasury !== null) {
    candidates.push(
      getAssociatedTokenAddressSync(config.ichorMint, config.realmsNativeTreasury, true, token2022),
    );
  }
  if (config.realmsProgram !== null && config.realmsRealm !== null) {
    const holding = await getTokenHoldingAddress(
      config.realmsProgram,
      config.realmsRealm,
      config.ichorMint,
    );
    candidates.push(requirePublicKey(holding.toBase58(), "realmsVoteVault"));
  }
  for (const extra of params.extraSources ?? []) {
    candidates.push(requirePublicKey(extra, "extraSources"));
  }
  const seen = new Set<string>();
  const sources: PublicKey[] = [];
  const withheldBySource: BN[] = [];
  let totalWithheld = new BN(0);
  for (const address of candidates) {
    const normalized = requirePublicKey(address.toBase58(), "canonicalHarvestSource");
    const key = normalized.toBase58();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const withheld = await measureWithheldIfPresent(
      params.connection,
      normalized,
      config.ichorMint,
      token2022,
    );
    if (withheld === null || withheld.isZero()) {
      continue;
    }
    sources.push(normalized);
    withheldBySource.push(withheld);
    totalWithheld = requireU64Bn(totalWithheld.add(withheld), "canonicalHarvestWithheld");
  }
  return { candidates, sources, withheldBySource, totalWithheld };
}

/**
 * One permissionless transaction: harvest withheld on derived sinks, then
 * push 25% to the creator wallet and 75% to the Realms treasury.
 */
export async function buildCollectTransferFees(
  params: BuildCollectTransferFeesParams,
): Promise<CollectTransferFeesBuild> {
  assertNoCallerFields(params, CALLER_SPLIT_FIELDS, "buildCollectTransferFees", "CALLER_SPLIT");
  assertNoCallerFields(params, CALLER_TREASURY_FIELDS, "buildCollectTransferFees", "CALLER_TREASURY");
  assertNoCallerFields(
    params,
    CALLER_HARVEST_DISCOVERY_FIELDS,
    "buildCollectTransferFees",
    "CALLER_ACCOUNT_DISCOVERY",
  );
  const measured = await measureCanonicalHarvestSources({
    connection: params.connection,
    verifiedConfig: params.verifiedConfig,
    ...(params.extraSources === undefined ? {} : { extraSources: params.extraSources }),
  });
  const distribute = await buildDistributeTransferFees({
    connection: params.connection,
    verifiedConfig: params.verifiedConfig,
    caller: params.caller,
  });
  const { verifiedProgram, config } = requireIssuedConfig(params, "buildCollectTransferFees");
  const harvestable = measured.totalWithheld;
  const pending = requireU64Bn(
    harvestable.add(distribute.expectedVaultDistributed),
    "collectableFees",
  );
  if (pending.isZero()) {
    throw new ClientValidationError("NOTHING_TO_COLLECT", [
      "no withheld ICHOR on the derived sinks and the mint accumulator is empty",
    ]);
  }
  const [ichor, epoch] = await Promise.all([
    fetchIchorFeeConfig({
      connection: params.connection,
      verifiedProgram,
      ichorMint: config.ichorMint,
    }),
    fetchConfirmedEpoch(params.connection),
  ]);
  const preview = previewDistributeTransferFees({
    vaultDistributed: pending,
    config: ichor.fee,
    currentEpoch: epoch,
  });
  const instructions: TransactionInstruction[] = [];
  if (measured.sources.length > 0) {
    const harvest = await buildHarvestWithheldTokensToMint({
      connection: params.connection,
      verifiedConfig: params.verifiedConfig,
      sources: measured.sources,
    });
    instructions.push(...harvest.unsigned.instructions);
  }
  instructions.push(...distribute.unsigned.instructions);
  return {
    ...distribute,
    withheldBefore: requireU64Bn(
      distribute.withheldBefore.add(measured.totalWithheld),
      "collectWithheldBefore",
    ),
    expectedGrossWithdrawn: requireU64Bn(
      distribute.expectedGrossWithdrawn.add(measured.totalWithheld),
      "collectGrossWithdrawn",
    ),
    expectedVaultDistributed: pending,
    creatorSecondHop: preview.creatorSecondHop,
    realmsSecondHop: preview.realmsSecondHop,
    expectedCreatorNet: preview.creatorSecondHop.expectedNet,
    expectedRealmsNet: preview.realmsSecondHop.expectedNet,
    unsigned: {
      instructions,
      derivedAddresses: distribute.unsigned.derivedAddresses,
    },
    harvestedSources: measured.sources,
    harvestedWithheld: measured.totalWithheld,
  };
}

/**
 * Unsigned pilot-only `set_transfer_fee`. Can only reassert 25 bps / u64::MAX.
 * Fails after revoke.
 */
export async function buildSetTransferFee(
  params: BuildSetTransferFeeParams,
): Promise<UnsignedInstructionBuild> {
  const { verifiedProgram, config, configAddress, authority } = requireMatchingAuthority(
    params,
    "buildSetTransferFee",
  );
  if (config.transferFeeAuthorityRevoked) {
    throw new ClientValidationError("FEE_AUTHORITY_REVOKED", [
      "transfer-fee setting authority has been permanently revoked",
    ]);
  }
  requirePilotTransferFee(params.transferFeeBasisPoints, params.maximumFee);
  const token2022 = new PublicKey(TOKEN_2022_PROGRAM.id);
  await fetchIchorFeeConfig({
    connection: params.connection,
    verifiedProgram,
    ichorMint: config.ichorMint,
  });
  const data = encodeSetTransferFeeInstructionData(params.transferFeeBasisPoints, params.maximumFee);
  return unsignedIx(
    instruction(
      verifiedProgram.programId,
      [
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: configAddress, isSigner: false, isWritable: true },
        { pubkey: config.ichorMint, isSigner: false, isWritable: true },
        { pubkey: token2022, isSigner: false, isWritable: false },
      ],
      data,
    ),
    { programId: verifiedProgram.programId, config: configAddress, authority, ichorMint: config.ichorMint },
  );
}

/**
 * Unsigned irreversible `revoke_transfer_fee_authority`.
 */
export async function buildRevokeTransferFeeAuthority(
  params: BuildRevokeTransferFeeAuthorityParams,
): Promise<UnsignedInstructionBuild> {
  const { verifiedProgram, config, configAddress, authority } = requireMatchingAuthority(
    params,
    "buildRevokeTransferFeeAuthority",
  );
  if (config.transferFeeAuthorityRevoked) {
    throw new ClientValidationError("FEE_AUTHORITY_REVOKED", [
      "transfer-fee setting authority has already been revoked",
    ]);
  }
  const token2022 = new PublicKey(TOKEN_2022_PROGRAM.id);
  await fetchIchorFeeConfig({
    connection: params.connection,
    verifiedProgram,
    ichorMint: config.ichorMint,
  });
  const data = encodeRevokeTransferFeeAuthorityInstructionData();
  return unsignedIx(
    instruction(
      verifiedProgram.programId,
      [
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: configAddress, isSigner: false, isWritable: true },
        { pubkey: config.ichorMint, isSigner: false, isWritable: true },
        { pubkey: token2022, isSigner: false, isWritable: false },
      ],
      data,
    ),
    { programId: verifiedProgram.programId, config: configAddress, authority, ichorMint: config.ichorMint },
  );
}

/**
 * Permissionless Token-2022 harvest-to-mint. Sources are caller-supplied;
 * each live account must be Token-2022 ICHOR with TransferFeeAmount.
 * Account discovery is rejected.
 */
export async function buildHarvestWithheldTokensToMint(
  params: BuildHarvestWithheldTokensToMintParams,
): Promise<HarvestWithheldTokensToMintBuild> {
  assertNoCallerFields(
    params,
    CALLER_HARVEST_DISCOVERY_FIELDS,
    "buildHarvestWithheldTokensToMint",
    "CALLER_ACCOUNT_DISCOVERY",
  );
  const { verifiedProgram, config } = requireIssuedConfig(params, "buildHarvestWithheldTokensToMint");
  if (!Array.isArray(params.sources) || params.sources.length === 0) {
    throw new ClientValidationError("HARVEST_SOURCES_EMPTY", [
      "harvest requires a nonempty caller-supplied token-account list",
    ]);
  }
  const token2022 = new PublicKey(TOKEN_2022_PROGRAM.id);
  const ichor = await fetchIchorFeeConfig({
    connection: params.connection,
    verifiedProgram,
    ichorMint: config.ichorMint,
  });
  const seen = new Set<string>();
  const sources: PublicKey[] = [];
  const withheldBySource: BN[] = [];
  let totalWithheld = new BN(0);
  for (let i = 0; i < params.sources.length; i += 1) {
    const source = requirePublicKey(params.sources[i], `sources[${String(i)}]`);
    if (source.equals(PublicKey.default) || source.equals(ichor.mint)) {
      throw new ClientValidationError("INVALID_HARVEST_SOURCE", [
        `sources[${String(i)}] cannot be the default pubkey or the ICHOR mint`,
      ]);
    }
    const key = source.toBase58();
    if (seen.has(key)) {
      throw new ClientValidationError("DUPLICATE_HARVEST_SOURCE", [
        `source ${key} appears more than once`,
      ]);
    }
    seen.add(key);
    const info = await params.connection.getAccountInfo(source, "confirmed");
    if (info === null) {
      throw new ClientValidationError("HARVEST_SOURCE_MISSING", [
        `source ${key} has no account; harvest does not discover substitutes`,
      ]);
    }
    if (!info.owner.equals(token2022)) {
      throw new ClientValidationError("INVALID_TOKEN_ACCOUNT_OWNER", [
        `source ${key} is not owned by Token-2022`,
      ]);
    }
    const data = asUint8(info.data);
    parseTokenAccount({
      ownerProgram: info.owner,
      data,
      expectedMint: ichor.mint,
      expectedOwner: new PublicKey(data.subarray(TOKEN_ACCOUNT_OFF_OWNER, TOKEN_ACCOUNT_OFF_OWNER + 32)),
      expectedTokenProgram: token2022,
      label: `sources[${String(i)}]`,
    });
    const amount = parseIchorTransferFeeAmount(data);
    sources.push(source);
    withheldBySource.push(amount.withheldAmount);
    totalWithheld = requireU64Bn(totalWithheld.add(amount.withheldAmount), "totalWithheld");
  }

  const ix = createHarvestWithheldTokensToMintInstruction(ichor.mint, sources, token2022);
  return {
    unsigned: { instructions: [ix], derivedAddresses: { mint: ichor.mint } },
    mint: ichor.mint,
    sources,
    withheldBySource,
    totalWithheld,
  };
}


function requireBoundCreator(config: IchorConfigSnapshot, label: string): PublicKey {
  if (
    !config.feeBeneficiariesBound ||
    config.creatorBeneficiary === null ||
    config.realmsNativeTreasury === null
  ) {
    throw new ClientValidationError("FEE_BENEFICIARIES_UNBOUND", [
      `${label} requires bound creator and Realms treasury identities`,
    ]);
  }
  return config.creatorBeneficiary;
}

/**
 * Strict `now - last > decay`. Fail-closed on zero decay, negatives, or clock inversion.
 * Tests CALL this helper.
 */
export function creatorDecayHasElapsed(now: BN, lastClaimTs: BN, decaySecs: BN): boolean {
  const decay = requireU64Bn(decaySecs, "creatorDecaySecs");
  if (decay.isZero()) {
    throw new ClientValidationError("CREATOR_DECAY_ZERO", [
      "creator_decay_secs must be greater than zero",
    ]);
  }
  if (now.isNeg() || lastClaimTs.isNeg() || now.lt(lastClaimTs)) {
    throw new ClientValidationError("CLOCK_INVERSION", [
      `clock inversion: now=${now.toString(10)} lastClaimTs=${lastClaimTs.toString(10)}`,
    ]);
  }
  return now.sub(lastClaimTs).gt(decay);
}

/** Signer must equal the bound creator beneficiary. Tests CALL this helper. */
export function assertCreatorBeneficiarySigner(
  config: IchorConfigSnapshot,
  signer: PublicKey,
  label: string,
): PublicKey {
  const creator = requireBoundCreator(config, label);
  const key = requirePublicKey(signer, "creatorBeneficiary");
  if (!key.equals(creator)) {
    throw new ClientValidationError("UNAUTHORIZED_CREATOR_CLAIM", [
      `${label} signer ${key.toBase58()} is not creator_beneficiary ${creator.toBase58()}`,
    ]);
  }
  return key;
}

function requireOnCurveWallet(key: PublicKey, label: string): PublicKey {
  if (key.equals(PublicKey.default)) {
    throw new ClientValidationError("INVALID_FEE_BENEFICIARY", [
      `${label} cannot be the default/system pubkey`,
    ]);
  }
  if (!PublicKey.isOnCurve(key.toBytes())) {
    throw new ClientValidationError("INVALID_FEE_BENEFICIARY", [
      `${label} must be an on-curve wallet pubkey`,
    ]);
  }
  return key;
}

async function fetchConfirmedUnixTs(connection: Connection): Promise<BN> {
  const slot = await connection.getSlot("confirmed");
  const ts = await connection.getBlockTime(slot);
  if (ts === null || !Number.isSafeInteger(ts)) {
    throw new ClientValidationError("CLOCK_UNAVAILABLE", [
      "confirmed block time is unavailable",
    ]);
  }
  return new BN(ts);
}

function deriveCreatorEscrowAta(
  config: IchorConfigSnapshot,
  verifiedProgram: VerifiedIchorProgram,
  mint: PublicKey,
  token2022: PublicKey,
): { escrowAuthority: PublicKey; creatorEscrow: PublicKey } {
  const escrow = creatorEscrowPda(verifiedProgram.programId);
  if (config.creatorEscrowBump !== escrow.bump) {
    throw new ClientValidationError("CREATOR_ESCROW_PDA", [
      'config.creator_escrow_bump is not seeds=["creator-escrow"]',
    ]);
  }
  return {
    escrowAuthority: escrow.address,
    creatorEscrow: getAssociatedTokenAddressSync(mint, escrow.address, true, token2022),
  };
}

/**
 * Unsigned `claim_creator_fees`. Signer must be the bound creator beneficiary.
 * Moves the full escrow amount to the beneficiary's canonical Token-2022 ATA.
 */
export async function buildClaimCreatorFees(
  params: BuildClaimCreatorFeesParams,
): Promise<ClaimCreatorFeesBuild> {
  const { verifiedProgram, config, configAddress } = requireIssuedConfig(
    params,
    "buildClaimCreatorFees",
  );
  const creator = assertCreatorBeneficiarySigner(
    config,
    params.creatorBeneficiary,
    "buildClaimCreatorFees",
  );
  const now = await fetchConfirmedUnixTs(params.connection);
  if (now.lt(config.lastCreatorClaimTs)) {
    throw new ClientValidationError("CLOCK_INVERSION", [
      "confirmed clock is before last_creator_claim_ts",
    ]);
  }
  const token2022 = new PublicKey(TOKEN_2022_PROGRAM.id);
  const [ichor, epoch] = await Promise.all([
    fetchIchorFeeConfig({
      connection: params.connection,
      verifiedProgram,
      ichorMint: config.ichorMint,
    }),
    fetchConfirmedEpoch(params.connection),
  ]);
  const { escrowAuthority, creatorEscrow } = deriveCreatorEscrowAta(
    config,
    verifiedProgram,
    ichor.mint,
    token2022,
  );
  const creatorDestination = getAssociatedTokenAddressSync(
    ichor.mint,
    creator,
    true,
    token2022,
  );
  const escrowInfo = await params.connection.getAccountInfo(creatorEscrow, "confirmed");
  if (escrowInfo === null) {
    throw new ClientValidationError("ESCROW_ACCOUNT_MISSING", [
      "creator escrow ATA is missing; distribute must land first",
    ]);
  }
  const parsed = parseTokenAccount({
    ownerProgram: escrowInfo.owner,
    data: asUint8(escrowInfo.data),
    expectedMint: ichor.mint,
    expectedOwner: escrowAuthority,
    expectedTokenProgram: token2022,
    label: "creator_escrow",
  });
  if (parsed.amount.isZero()) {
    throw new ClientValidationError("ZERO_AMOUNT", ["creator escrow is empty"]);
  }
  const hop = secondHopAfterTransfer({
    transferAmount: parsed.amount,
    config: ichor.fee,
    currentEpoch: epoch,
  });
  const destInfo = await params.connection.getAccountInfo(creatorDestination, "confirmed");
  if (destInfo !== null) {
    parseTokenAccount({
      ownerProgram: destInfo.owner,
      data: asUint8(destInfo.data),
      expectedMint: ichor.mint,
      expectedOwner: creator,
      expectedTokenProgram: token2022,
      label: "creator_destination",
    });
  }
  const ix = instruction(
    verifiedProgram.programId,
    [
      { pubkey: creator, isSigner: true, isWritable: false },
      { pubkey: configAddress, isSigner: false, isWritable: true },
      { pubkey: ichor.mint, isSigner: false, isWritable: true },
      { pubkey: escrowAuthority, isSigner: false, isWritable: false },
      { pubkey: creatorEscrow, isSigner: false, isWritable: true },
      { pubkey: creatorDestination, isSigner: false, isWritable: true },
      { pubkey: token2022, isSigner: false, isWritable: false },
    ],
    encodeClaimCreatorFeesInstructionData(),
  );
  const instructions = [];
  if (destInfo === null) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        creator,
        creatorDestination,
        creator,
        ichor.mint,
        token2022,
      ),
    );
  }
  instructions.push(ix);
  return {
    unsigned: {
      instructions,
      derivedAddresses: {
        programId: verifiedProgram.programId,
        config: configAddress,
        creatorEscrow,
        creatorDestination,
        creatorEscrowAuthority: escrowAuthority,
        creatorBeneficiary: creator,
      },
    },
    escrowAmount: parsed.amount,
    expectedNet: hop.expectedNet,
    creatorEscrow,
    creatorDestination,
  };
}

/**
 * Unsigned permissionless `sweep_unclaimed_creator_fees`. Valid only after decay.
 * Moves escrow to the bound Realms native-treasury ATA. Does not rotate beneficiary.
 */
export async function buildSweepUnclaimedCreatorFees(
  params: BuildSweepUnclaimedCreatorFeesParams,
): Promise<SweepUnclaimedCreatorFeesBuild> {
  const { verifiedProgram, config, configAddress } = requireIssuedConfig(
    params,
    "buildSweepUnclaimedCreatorFees",
  );
  const caller = requirePublicKey(params.caller, "caller");
  if (caller.equals(PublicKey.default)) {
    throw new ClientValidationError("DEFAULT_PUBKEY", ["caller cannot be the default pubkey"]);
  }
  requireBoundCreator(config, "buildSweepUnclaimedCreatorFees");
  const now = await fetchConfirmedUnixTs(params.connection);
  if (!creatorDecayHasElapsed(now, config.lastCreatorClaimTs, config.creatorDecaySecs)) {
    throw new ClientValidationError("CREATOR_DECAY_NOT_ELAPSED", [
      "creator decay has not elapsed; sweep is closed",
    ]);
  }
  const token2022 = new PublicKey(TOKEN_2022_PROGRAM.id);
  const [ichor, epoch] = await Promise.all([
    fetchIchorFeeConfig({
      connection: params.connection,
      verifiedProgram,
      ichorMint: config.ichorMint,
    }),
    fetchConfirmedEpoch(params.connection),
  ]);
  const { escrowAuthority, creatorEscrow } = deriveCreatorEscrowAta(
    config,
    verifiedProgram,
    ichor.mint,
    token2022,
  );
  const realmsDestination = getAssociatedTokenAddressSync(
    ichor.mint,
    config.realmsNativeTreasury!,
    true,
    token2022,
  );
  const escrowInfo = await params.connection.getAccountInfo(creatorEscrow, "confirmed");
  if (escrowInfo === null) {
    throw new ClientValidationError("ESCROW_ACCOUNT_MISSING", [
      "creator escrow ATA is missing; nothing to sweep",
    ]);
  }
  const parsed = parseTokenAccount({
    ownerProgram: escrowInfo.owner,
    data: asUint8(escrowInfo.data),
    expectedMint: ichor.mint,
    expectedOwner: escrowAuthority,
    expectedTokenProgram: token2022,
    label: "creator_escrow",
  });
  if (parsed.amount.isZero()) {
    throw new ClientValidationError("ZERO_AMOUNT", ["creator escrow is empty"]);
  }
  const hop = secondHopAfterTransfer({
    transferAmount: parsed.amount,
    config: ichor.fee,
    currentEpoch: epoch,
  });
  const realmsInfo = await params.connection.getAccountInfo(realmsDestination, "confirmed");
  if (realmsInfo !== null) {
    parseTokenAccount({
      ownerProgram: realmsInfo.owner,
      data: asUint8(realmsInfo.data),
      expectedMint: ichor.mint,
      expectedOwner: config.realmsNativeTreasury!,
      expectedTokenProgram: token2022,
      label: "realms_destination",
    });
  }
  const ix = instruction(
    verifiedProgram.programId,
    [
      { pubkey: caller, isSigner: true, isWritable: false },
      { pubkey: configAddress, isSigner: false, isWritable: true },
      { pubkey: ichor.mint, isSigner: false, isWritable: true },
      { pubkey: escrowAuthority, isSigner: false, isWritable: false },
      { pubkey: creatorEscrow, isSigner: false, isWritable: true },
      { pubkey: realmsDestination, isSigner: false, isWritable: true },
      { pubkey: token2022, isSigner: false, isWritable: false },
    ],
    encodeSweepUnclaimedCreatorFeesInstructionData(),
  );
  const instructions = [];
  if (realmsInfo === null) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        caller,
        realmsDestination,
        config.realmsNativeTreasury!,
        ichor.mint,
        token2022,
      ),
    );
  }
  instructions.push(ix);
  return {
    unsigned: {
      instructions,
      derivedAddresses: {
        programId: verifiedProgram.programId,
        config: configAddress,
        caller,
        creatorEscrow,
        realmsDestination,
        creatorEscrowAuthority: escrowAuthority,
      },
    },
    escrowAmount: parsed.amount,
    expectedNet: hop.expectedNet,
    creatorEscrow,
    realmsDestination,
  };
}

/**
 * Unsigned `set_creator_beneficiary`. Signer is the current beneficiary only.
 * Config authority is never a signer. Rotation stamps liveness.
 */
export async function buildSetCreatorBeneficiary(
  params: BuildSetCreatorBeneficiaryParams,
): Promise<UnsignedInstructionBuild> {
  const { verifiedProgram, config, configAddress } = requireIssuedConfig(
    params,
    "buildSetCreatorBeneficiary",
  );
  const creator = assertCreatorBeneficiarySigner(
    config,
    params.creatorBeneficiary,
    "buildSetCreatorBeneficiary",
  );
  const newBeneficiary = requireOnCurveWallet(
    requirePublicKey(params.newBeneficiary, "newBeneficiary"),
    "newBeneficiary",
  );
  const now = await fetchConfirmedUnixTs(params.connection);
  if (now.lt(config.lastCreatorClaimTs)) {
    throw new ClientValidationError("CLOCK_INVERSION", [
      "confirmed clock is before last_creator_claim_ts",
    ]);
  }
  const withdraw = withdrawWithheldPda(verifiedProgram.programId);
  const escrow = creatorEscrowPda(verifiedProgram.programId);
  const blocked = [
    config.ichorMint,
    withdraw.address,
    escrow.address,
    config.realmsProgram,
    config.realmsGovernance,
    config.realmsNativeTreasury,
  ].filter((key): key is PublicKey => key !== null);
  if (blocked.some((key) => newBeneficiary.equals(key))) {
    throw new ClientValidationError("INVALID_FEE_BENEFICIARY", [
      "newBeneficiary cannot be an ICHOR mint, program PDA, Realm, Governance, or treasury address",
    ]);
  }
  const data = encodeSetCreatorBeneficiaryInstructionData(newBeneficiary);
  const ix = instruction(
    verifiedProgram.programId,
    [
      { pubkey: creator, isSigner: true, isWritable: false },
      { pubkey: configAddress, isSigner: false, isWritable: true },
    ],
    data,
  );
  return {
    instructions: [ix],
    derivedAddresses: {
      programId: verifiedProgram.programId,
      config: configAddress,
      creatorBeneficiary: creator,
      newBeneficiary,
    },
  };
}

export {
  TRANSFER_FEE_BASIS_POINTS,
  TRANSFER_FEE_MAXIMUM_FEE,
  getCurrentMintFee,
};
