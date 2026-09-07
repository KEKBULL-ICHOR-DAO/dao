import {
  AccountMetaData,
  Governance,
  GovernanceConfig,
  GoverningTokenConfigAccountArgs,
  GoverningTokenType,
  InstructionData,
  MintMaxVoteWeightSource,
  MintMaxVoteWeightSourceType,
  ProposalState,
  ProposalTransaction,
  VoteRecord,
  VoteThreshold,
  VoteThresholdType,
  Vote,
  VoteTipping,
  VoteType,
  YesNoVote,
  createSetGovernanceConfig,
  getGovernance,
  getGovernanceAccount,
  getGovernanceAccounts,
  getNativeTreasuryAddress,
  getProposal,
  getProposalsByGovernance,
  getProposalTransactionAddress,
  getRealm,
  getRealmConfigAddress,
  getTokenHoldingAddress,
  getTokenOwnerRecordAddress,
  getTokenOwnerRecord,
  getVoteRecordAddress,
  getVoteRecordsByVoter,
  pubkeyFilter,
  tryGetRealmConfig,
  withCastVote,
  withCreateGovernance,
  withCreateNativeTreasury,
  withCreateProposal,
  withCreateRealm,
  withCreateTokenOwnerRecord,
  withDepositGoverningTokens,
  withExecuteTransaction,
  withFinalizeVote,
  withInsertTransaction,
  withRelinquishVote,
  withSignOffProposal,
  withSetRealmAuthority,
  withSetRealmConfig,
  withWithdrawGoverningTokens,
  SetRealmAuthorityAction,
} from "@realms-today/spl-governance";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import BN from "bn.js";
import { assertVerifiedIchorConfig } from "./burn.ts";
import { getCurrentMintFee, parseIchorTransferFeeConfig } from "./extensions.ts";
import { fetchMintSnapshot, resolveAccountReadCommitment } from "./mint.ts";
import {
  REALMS_PROGRAM_VERSION,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  assertMainnetKekbullGovernance,
} from "./network.ts";
import { assertBoundConnection, assertVerifiedNetwork } from "./preflight.ts";
import type {
  BootstrapCouncilConfig,
  BuildCommunityProposalParams,
  BuildCreateGovernanceParams,
  BuildNativeTreasuryParams,
  BuildProposalParams,
  BuildRealmParams,
  BuildRemoveCouncilParams,
  BuildSignOffProposalParams,
  BuildTransferRealmAuthorityParams,
  BuildTreasuryTokenAccountParams,
  CastCommunityVoteParams,
  CastCouncilVoteParams,
  CommunityActivationConfig,
  DepositIchorVoteParams,
  DepositCouncilVoteParams,
  DepositIchorVotesBuild,
  WithdrawIchorVotesBuild,
  ExecuteProposalTransactionParams,
  InsertProposalTransactionBuild,
  InsertProposalTransactionParams,
  RecoveredProposalTransaction,
  RecoverProposalTransactionParams,
  RelinquishCommunityVoteParams,
  RelinquishCouncilVoteParams,
  RelinquishStandingCommunityVotesParams,
  RelinquishStandingCommunityVotesBuild,
  StandingCommunityVote,
  ListStandingCommunityVotesParams,
  ListUnrelinquishedVotesOnProposalParams,
  UnrelinquishedVoteOnProposal,
  ReleaseVotesOnClosedProposalParams,
  ReleaseVotesOnClosedProposalBuild,
  FinalizeVoteParams,
  FinalizeVoteBuild,
  ReleaseStandingAndWithdrawIchorParams,
  ReleaseStandingAndWithdrawIchorBuild,
  ReadCommunityGoverningTokenDepositParams,
  CommunityGoverningTokenDeposit,
  ReadCommunityProposalParams,
  CommunityProposalSnapshot,
  ListCommunityProposalsParams,
  CommunityProposalListItem,
  BuildTreasuryIchorTransferParams,
  TreasuryIchorTransferBuild,
  BuildTreasurySolTransferParams,
  TreasurySolTransferBuild,
  SetRealmConfigCouncilMintParams,
  BuildSetRealmConfigEmergencyBrakeParams,
  BuildRestoreRealmConfigVoteWeightSourceParams,
  CommunityMintMaxVoteWeightSource,
  LiveRealmConfigSnapshot,
  AccountReadCommitment,
  StagedProposalActions,
  UnsignedInstructionBuild,
  VerifiedGovernance,
  VerifiedGovernanceIdentity,
  VerifiedNetwork,
  VerifiedRealm,
  WithdrawIchorVotesParams,
  WithdrawCouncilVotesParams,
} from "./types.ts";
import { ClientValidationError } from "./types.ts";
import {
  assertBootstrapCouncil,
  assertCommunityActivation,
  assertNoSecretMaterial,
  assertIchorIsToken2022,
  assertLegacySplMint,
  COMMUNITY_PROPOSAL_DISABLED,
  U64_MAX,
  requireNonEmptyString,
  requirePercent,
  requirePositiveBn,
  requirePublicKey,
  requireReachableMintMaxVoteWeightSource,
  requireU64Bn,
} from "./validation.ts";
import {
  assertMainnetCommunityActivation,
  assertMainnetVoteWeightSource,
} from "./mainnet-governance.ts";

function asUint8(data: ArrayLike<number>): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function legacyTokenProgram(): PublicKey {
  const named = new PublicKey(TOKEN_PROGRAM.id);
  if (!TOKEN_PROGRAM_ID.equals(named)) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `@solana/spl-token TOKEN_PROGRAM_ID drifted from named ${TOKEN_PROGRAM.id}`,
    ]);
  }
  return named;
}

function token2022Program(): PublicKey {
  const named = new PublicKey(TOKEN_2022_PROGRAM.id);
  if (!TOKEN_2022_PROGRAM_ID.equals(named)) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `@solana/spl-token TOKEN_2022_PROGRAM_ID drifted from named ${TOKEN_2022_PROGRAM.id}`,
    ]);
  }
  return named;
}

function requireInstructionKey(
  keys: TransactionInstruction["keys"],
  index: number,
  expected: PublicKey,
  label: string,
): void {
  const key = keys[index];
  if (key === undefined || !key.pubkey.equals(expected)) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `${label} key[${String(index)}] is not ${expected.toBase58()}; 0.3.33 helper layout drifted from the v3.1.2 processor`,
    ]);
  }
}

/**
 * 0.3.33 `withDepositGoverningTokens` hardcodes legacy TOKEN_PROGRAM at key 8
 * and omits the mint. v3.1.2 subtracts `get_current_mint_fee` only when the
 * mint is account 10. Replace key 8, then append ICHOR at 10.
 */
/**
 * Patch 0.3.33 `withDepositGoverningTokens` onto the v3.1.2 Token-2022 layout.
 * Exported so offline defensive-stake fixtures use the same helper as
 * `buildDepositIchorVotes`.
 */
export function applyIchorDepositToken2022Patch(
  instruction: TransactionInstruction,
  communityMint: PublicKey,
  realmConfig: PublicKey,
): void {
  patchDepositGoverningTokenKeys(instruction, communityMint, realmConfig);
}

function patchDepositGoverningTokenKeys(
  instruction: TransactionInstruction,
  communityMint: PublicKey,
  realmConfig: PublicKey,
): void {
  if (instruction.keys.length !== 10) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `deposit helper produced ${String(instruction.keys.length)} keys; expected 10 (0-8 + RealmConfig)`,
    ]);
  }
  requireInstructionKey(instruction.keys, 8, legacyTokenProgram(), "deposit");
  requireInstructionKey(instruction.keys, 9, realmConfig, "deposit");
  instruction.keys[8] = { pubkey: token2022Program(), isSigner: false, isWritable: false };
  instruction.keys.push({ pubkey: communityMint, isSigner: false, isWritable: false });
  if (!instruction.keys[10]?.pubkey.equals(communityMint)) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "deposit mint was not appended at processor account 10",
    ]);
  }
}

/**
 * 0.3.33 `withWithdrawGoverningTokens` hardcodes legacy TOKEN_PROGRAM at key 5
 * and omits the mint. v3.1.2 subtracts `get_current_mint_fee` only when the
 * mint is account 7. Replace key 5, then append ICHOR at 7.
 */
function patchWithdrawGoverningTokenKeys(
  instruction: TransactionInstruction,
  communityMint: PublicKey,
  realmConfig: PublicKey,
): void {
  if (instruction.keys.length !== 7) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `withdraw helper produced ${String(instruction.keys.length)} keys; expected 7 (0-5 + RealmConfig)`,
    ]);
  }
  requireInstructionKey(instruction.keys, 5, legacyTokenProgram(), "withdraw");
  requireInstructionKey(instruction.keys, 6, realmConfig, "withdraw");
  instruction.keys[5] = { pubkey: token2022Program(), isSigner: false, isWritable: false };
  instruction.keys.push({ pubkey: communityMint, isSigner: false, isWritable: false });
  if (!instruction.keys[7]?.pubkey.equals(communityMint)) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "withdraw mint was not appended at processor account 7",
    ]);
  }
}

/**
 * 0.3.33 `withCreateRealm` hardcodes legacy TOKEN_PROGRAM at community key 6
 * and, with a council mint, appends RealmConfig at 10. Replace key 6 with
 * Token-2022 and insert the legacy council token program at 10 before
 * RealmConfig. Council remains legacy.
 */
function patchCreateRealmKeys(
  instruction: TransactionInstruction,
  councilMint: PublicKey,
  realmConfig: PublicKey,
): void {
  if (instruction.keys.length !== 11) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `createRealm helper produced ${String(instruction.keys.length)} keys; expected 11 with council + RealmConfig`,
    ]);
  }
  requireInstructionKey(instruction.keys, 6, legacyTokenProgram(), "createRealm");
  requireInstructionKey(instruction.keys, 8, councilMint, "createRealm");
  requireInstructionKey(instruction.keys, 10, realmConfig, "createRealm");
  instruction.keys[6] = { pubkey: token2022Program(), isSigner: false, isWritable: false };
  instruction.keys.splice(10, 0, {
    pubkey: legacyTokenProgram(),
    isSigner: false,
    isWritable: false,
  });
  if (
    !instruction.keys[6]?.pubkey.equals(token2022Program()) ||
    !instruction.keys[10]?.pubkey.equals(legacyTokenProgram()) ||
    !instruction.keys[11]?.pubkey.equals(realmConfig)
  ) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "createRealm community Token-2022 / council legacy insert did not land at indexes 6 and 10",
    ]);
  }
}

async function liveIchorMintFee(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  ichorMint: PublicKey;
  amount: BN;
}): Promise<{ expectedMintFee: BN; expectedNet: BN }> {
  const snapshot = await fetchMintSnapshot(params.connection, params.verified.network, params.ichorMint);
  assertIchorIsToken2022(snapshot);
  const info = await params.connection.getAccountInfo(params.ichorMint, "confirmed");
  if (info === null) {
    throw new ClientValidationError("MINT_MISSING", [
      `ICHOR mint ${params.ichorMint.toBase58()} has no account`,
    ]);
  }
  const feeConfig = parseIchorTransferFeeConfig(asUint8(info.data));
  const epochInfo = await params.connection.getEpochInfo("confirmed");
  if (!Number.isSafeInteger(epochInfo.epoch) || epochInfo.epoch < 0) {
    throw new ClientValidationError("EPOCH_UNAVAILABLE", [
      "confirmed epoch is not a safe non-negative integer",
    ]);
  }
  const expectedMintFee = getCurrentMintFee({
    config: feeConfig,
    currentEpoch: new BN(epochInfo.epoch),
    preFeeAmount: params.amount,
  });
  return {
    expectedMintFee,
    expectedNet: params.amount.sub(expectedMintFee),
  };
}

function yesPercent(value: number): VoteThreshold {
  return new VoteThreshold({
    type: VoteThresholdType.YesVotePercentage,
    value,
  });
}

function disabledThreshold(): VoteThreshold {
  return new VoteThreshold({
    type: VoteThresholdType.Disabled,
  });
}

function linearDepositedTokenConfig(): GoverningTokenConfigAccountArgs {
  return new GoverningTokenConfigAccountArgs({
    voterWeightAddin: undefined,
    maxVoterWeightAddin: undefined,
    tokenType: GoverningTokenType.Liquid,
  });
}

const PLUGIN_WEIGHT_FIELDS = [
  "voterWeightRecord",
  "maxVoterWeightRecord",
  "voterWeightAddin",
  "maxVoterWeightAddin",
] as const;

function assertLinearDefaultVoting(params: object, label: string): void {
  const hits = PLUGIN_WEIGHT_FIELDS.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError("PLUGIN_WEIGHT_REJECTED", [
      `${label} is linear deposited ICHOR; ${hits.join(", ")} are not accepted`,
    ]);
  }
}

function yesNoVoteFromChoice(choice: unknown): YesNoVote {
  if (choice === "yes") {
    return YesNoVote.Yes;
  }
  if (choice === "no") {
    return YesNoVote.No;
  }
  throw new ClientValidationError("VOTE_CHOICE", [
    "vote choice must be yes or no",
  ]);
}

function requireUnsignedIntegerInRange(
  value: unknown,
  label: string,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  ) {
    throw new ClientValidationError("INTEGER_RANGE", [
      `${label} must be an integer from 0 through ${String(max)}`,
    ]);
  }
  return value;
}

const CALLER_REALM_OR_MINT_FIELDS = ["realm", "ichorMint", "governingTokenMint"] as const;

function assertNoCallerRealmOrMint(params: object, label: string): void {
  const hits = CALLER_REALM_OR_MINT_FIELDS.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError("CALLER_REALM_OR_MINT", [
      `${label} must use verifiedRealm.realm / verifiedRealm.communityMint; ${hits.join(", ")} cannot substitute a council mint`,
    ]);
  }
}

function assertCommunityTokenConfig(
  config: {
    voterWeightAddin?: PublicKey | undefined;
    maxVoterWeightAddin?: PublicKey | undefined;
    tokenType: (typeof GoverningTokenType)[keyof typeof GoverningTokenType];
  },
  label: string,
): void {
  if (config.voterWeightAddin !== undefined || config.maxVoterWeightAddin !== undefined) {
    throw new ClientValidationError("PLUGIN_WEIGHT_REJECTED", [
      `${label} has a voter/max-weight add-in; linear default voting is required`,
    ]);
  }
  if (config.tokenType !== GoverningTokenType.Liquid) {
    throw new ClientValidationError("REALM_TOKEN_TYPE", [
      `${label} tokenType is not Liquid`,
    ]);
  }
}

/** Only `verifyRealmDeployment` may add. Not exported. */
const issuedRealmProofs = new WeakSet<object>();

/**
 * Runtime-unforgeable realm proof. Not exported - a structural lookalike or
 * a mutated communityMint is not accepted.
 */
class IssuedVerifiedRealm implements VerifiedRealm {
  readonly verified: VerifiedNetwork;
  readonly realm: PublicKey;
  readonly communityMint: PublicKey;
  readonly councilMint: PublicKey | null;
  readonly #verified: VerifiedNetwork;
  readonly #connection: Connection;
  readonly #realm: PublicKey;
  readonly #communityMint: PublicKey;
  readonly #councilMint: PublicKey | null;

  constructor(args: {
    verified: VerifiedNetwork;
    connection: Connection;
    realm: PublicKey;
    communityMint: PublicKey;
    councilMint: PublicKey | null;
  }) {
    this.verified = args.verified;
    this.realm = args.realm;
    this.communityMint = args.communityMint;
    this.councilMint = args.councilMint;
    this.#verified = args.verified;
    this.#connection = args.connection;
    this.#realm = args.realm;
    this.#communityMint = args.communityMint;
    this.#councilMint = args.councilMint;
  }

  matchesIssuedFields(): boolean {
    return (
      this.verified === this.#verified &&
      this.realm.equals(this.#realm) &&
      this.communityMint.equals(this.#communityMint) &&
      ((this.councilMint === null && this.#councilMint === null) ||
        (this.councilMint !== null &&
          this.#councilMint !== null &&
          this.councilMint.equals(this.#councilMint)))
    );
  }

  boundTo(connection: Connection, verified: VerifiedNetwork): boolean {
    return connection === this.#connection && verified === this.#verified;
  }
}

/**
 * Live branded realm proof. Requires the exact issued Connection, raw realm
 * owner == Realms program, `getRealm` communityMint == expectedIchorMint,
 * that mint owner Token-2022 (Q3b dummy Tokenkeg community mint refused),
 * and linear Liquid community config with no plugins.
 */
export async function verifyRealmDeployment(
  connection: Connection,
  verified: VerifiedNetwork,
  realm: PublicKey,
  expectedIchorMint: PublicKey,
  commitment?: AccountReadCommitment,
): Promise<VerifiedRealm> {
  assertBoundConnection(verified, connection);
  requirePublicKey(realm, "realm");
  requirePublicKey(expectedIchorMint, "expectedIchorMint");
  const readCommitment = resolveAccountReadCommitment(commitment);

  const raw = await connection.getAccountInfo(realm, readCommitment);
  if (raw === null) {
    throw new ClientValidationError("REALM_NOT_DEPLOYED", [
      `realm ${realm.toBase58()} has no account; a pubkey is not a realm proof`,
    ]);
  }
  if (!raw.owner.equals(verified.network.realmsProgramId)) {
    throw new ClientValidationError("REALM_OWNER", [
      `realm ${realm.toBase58()} owner ${raw.owner.toBase58()} is not ${verified.network.realmsProgramId.toBase58()}`,
    ]);
  }

  const parsed = await getRealm(connection, realm);
  if (!parsed.pubkey.equals(realm)) {
    throw new ClientValidationError("REALM_PUBKEY", [
      `getRealm returned ${parsed.pubkey.toBase58()} but the requested realm is ${realm.toBase58()}`,
    ]);
  }
  if (!parsed.account.communityMint.equals(expectedIchorMint)) {
    throw new ClientValidationError("COMMUNITY_MINT_MISMATCH", [
      `realm communityMint ${parsed.account.communityMint.toBase58()} is not expected ICHOR ${expectedIchorMint.toBase58()}`,
    ]);
  }
  const communityMintSnapshot = await fetchMintSnapshot(
    connection,
    verified.network,
    parsed.account.communityMint,
    readCommitment,
  );
  assertIchorIsToken2022(communityMintSnapshot);
  const councilMint = parsed.account.config.councilMint;
  if (councilMint !== undefined && expectedIchorMint.equals(councilMint)) {
    throw new ClientValidationError("COMMUNITY_MINT_IS_COUNCIL", [
      "expectedIchorMint equals the realm council mint",
    ]);
  }
  if (councilMint !== undefined && parsed.account.communityMint.equals(councilMint)) {
    throw new ClientValidationError("COMMUNITY_MINT_IS_COUNCIL", [
      "on-chain communityMint equals the realm council mint",
    ]);
  }
  if (parsed.account.config.useCommunityVoterWeightAddin || parsed.account.config.useMaxCommunityVoterWeightAddin) {
    throw new ClientValidationError("PLUGIN_WEIGHT_REJECTED", [
      "realm.config enables a community voter/max-weight add-in",
    ]);
  }

  const realmConfig = await tryGetRealmConfig(connection, verified.network.realmsProgramId, realm);
  if (realmConfig === undefined) {
    throw new ClientValidationError("REALM_CONFIG_MISSING", [
      "RealmConfig is required to prove Liquid community voting with no plugins",
    ]);
  }
  const expectedConfig = await getRealmConfigAddress(verified.network.realmsProgramId, realm);
  if (!realmConfig.pubkey.equals(expectedConfig)) {
    throw new ClientValidationError("REALM_CONFIG_PDA", [
      `tryGetRealmConfig returned ${realmConfig.pubkey.toBase58()} but PDA is ${expectedConfig.toBase58()}`,
    ]);
  }
  const configRaw = await connection.getAccountInfo(realmConfig.pubkey, readCommitment);
  if (configRaw === null) {
    throw new ClientValidationError("REALM_CONFIG_MISSING", [
      `RealmConfig ${realmConfig.pubkey.toBase58()} has no account`,
    ]);
  }
  if (!configRaw.owner.equals(verified.network.realmsProgramId)) {
    throw new ClientValidationError("REALM_CONFIG_OWNER", [
      `RealmConfig owner ${configRaw.owner.toBase58()} is not ${verified.network.realmsProgramId.toBase58()}`,
    ]);
  }
  assertCommunityTokenConfig(realmConfig.account.communityTokenConfig, "communityTokenConfig");
  assertMainnetKekbullGovernance(verified.network);
  {
    const liveSource = parsed.account.config.communityMintMaxVoteWeightSource;
    assertMainnetVoteWeightSource({
      cluster: verified.network.cluster,
      source: {
        type:
          liveSource.type === MintMaxVoteWeightSourceType.Absolute
            ? "absolute"
            : "supply-fraction",
        value: liveSource.value,
      },
      fullSupplyFractionValue: MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value,
    });
  }
  if (
    realmConfig.account.councilTokenConfig.voterWeightAddin !== undefined ||
    realmConfig.account.councilTokenConfig.maxVoterWeightAddin !== undefined
  ) {
    throw new ClientValidationError("PLUGIN_WEIGHT_REJECTED", [
      "councilTokenConfig has a voter/max-weight add-in",
    ]);
  }

  const proof = new IssuedVerifiedRealm({
    verified,
    connection,
    realm,
    communityMint: parsed.account.communityMint,
    councilMint: councilMint ?? null,
  });
  issuedRealmProofs.add(proof);
  return proof;
}

export function assertVerifiedRealm(verifiedRealm: VerifiedRealm): asserts verifiedRealm is VerifiedRealm {
  if (verifiedRealm === null || typeof verifiedRealm !== "object") {
    throw new ClientValidationError("REALM_PROOF", ["VerifiedRealm is missing"]);
  }
  if (!issuedRealmProofs.has(verifiedRealm) || !(verifiedRealm instanceof IssuedVerifiedRealm)) {
    throw new ClientValidationError("REALM_PROOF", [
      "fabricated VerifiedRealm lookalike; only verifyRealmDeployment may issue this proof",
    ]);
  }
  if (!verifiedRealm.matchesIssuedFields()) {
    throw new ClientValidationError("REALM_PROOF", [
      "VerifiedRealm fields were mutated after issuance",
    ]);
  }
  assertVerifiedNetwork(verifiedRealm.verified);
}

const issuedGovernanceIdentityProofs = new WeakSet<object>();
const issuedGovernanceProofs = new WeakSet<object>();

function governanceConfigFingerprint(config: VerifiedGovernanceIdentity["config"]): string {
  return [
    config.communityVoteThresholdType,
    config.communityVoteThresholdValue ?? "none",
    config.minCommunityTokensToCreateProposal.toString(10),
    config.communityVoteTipping,
    config.minInstructionHoldUpTime,
    config.baseVotingTime,
    config.votingCoolOffTime,
    config.depositExemptProposalCount,
    config.minCouncilTokensToCreateProposal.toString(10),
    config.councilVoteThresholdType,
    config.councilVoteThresholdValue ?? "none",
    config.councilVetoVoteThresholdType,
    config.councilVetoVoteThresholdValue ?? "none",
    config.communityVetoVoteThresholdType,
    config.communityVetoVoteThresholdValue ?? "none",
    config.councilVoteTipping,
  ].join("|");
}

class IssuedVerifiedGovernanceIdentity implements VerifiedGovernanceIdentity {
  readonly verifiedRealm: VerifiedRealm;
  readonly governance: PublicKey;
  readonly realm: PublicKey;
  readonly communityMint: PublicKey;
  readonly config: VerifiedGovernanceIdentity["config"];
  readonly #verifiedRealm: VerifiedRealm;
  readonly #connection: Connection;
  readonly #governance: PublicKey;
  readonly #realm: PublicKey;
  readonly #communityMint: PublicKey;
  readonly #configFingerprint: string;

  constructor(args: {
    verifiedRealm: VerifiedRealm;
    connection: Connection;
    governance: PublicKey;
    realm: PublicKey;
    communityMint: PublicKey;
    config: VerifiedGovernanceIdentity["config"];
  }) {
    this.verifiedRealm = args.verifiedRealm;
    this.governance = args.governance;
    this.realm = args.realm;
    this.communityMint = args.communityMint;
    this.config = args.config;
    this.#verifiedRealm = args.verifiedRealm;
    this.#connection = args.connection;
    this.#governance = args.governance;
    this.#realm = args.realm;
    this.#communityMint = args.communityMint;
    this.#configFingerprint = governanceConfigFingerprint(args.config);
  }

  matchesIssuedFields(): boolean {
    return (
      this.verifiedRealm === this.#verifiedRealm &&
      this.governance.equals(this.#governance) &&
      this.realm.equals(this.#realm) &&
      this.communityMint.equals(this.#communityMint) &&
      governanceConfigFingerprint(this.config) === this.#configFingerprint
    );
  }

  boundTo(connection: Connection, verifiedRealm: VerifiedRealm): boolean {
    return connection === this.#connection && verifiedRealm === this.#verifiedRealm;
  }
}

class IssuedVerifiedGovernance
  extends IssuedVerifiedGovernanceIdentity
  implements VerifiedGovernance {}

/**
 * Live branded Governance identity. Valid during council-only bootstrap:
 * this proves the account and Realm relationship but does not claim community
 * proposal/vote activation.
 */
export async function verifyGovernanceIdentity(
  connection: Connection,
  verifiedRealm: VerifiedRealm,
  governance: PublicKey,
  commitment?: AccountReadCommitment,
): Promise<VerifiedGovernanceIdentity> {
  assertVerifiedRealm(verifiedRealm);
  if (!(verifiedRealm instanceof IssuedVerifiedRealm) || !verifiedRealm.boundTo(connection, verifiedRealm.verified)) {
    throw new ClientValidationError("CONNECTION_MISMATCH", [
      "connection is not the exact Connection instance bound to the issued VerifiedRealm",
    ]);
  }
  const verified = verifiedRealm.verified;
  assertBoundConnection(verified, connection);
  requirePublicKey(governance, "governance");
  const readCommitment = resolveAccountReadCommitment(commitment);

  const raw = await connection.getAccountInfo(governance, readCommitment);
  if (raw === null) {
    throw new ClientValidationError("GOVERNANCE_NOT_DEPLOYED", [
      `governance ${governance.toBase58()} has no account; a pubkey is not a governance proof`,
    ]);
  }
  if (!raw.owner.equals(verified.network.realmsProgramId)) {
    throw new ClientValidationError("GOVERNANCE_OWNER", [
      `governance ${governance.toBase58()} owner ${raw.owner.toBase58()} is not ${verified.network.realmsProgramId.toBase58()}`,
    ]);
  }

  const parsed = await getGovernanceAccount(connection, governance, Governance);
  if (!parsed.pubkey.equals(governance)) {
    throw new ClientValidationError("GOVERNANCE_PUBKEY", [
      `getGovernanceAccount returned ${parsed.pubkey.toBase58()} but the requested governance is ${governance.toBase58()}`,
    ]);
  }
  if (!parsed.account.realm.equals(verifiedRealm.realm)) {
    throw new ClientValidationError("GOVERNANCE_REALM", [
      `governance.realm ${parsed.account.realm.toBase58()} is not verifiedRealm.realm ${verifiedRealm.realm.toBase58()}`,
    ]);
  }

  const cfg = parsed.account.config;
  const thresholdValue =
    cfg.communityVoteThreshold.value === undefined
      ? undefined
      : requirePercent(cfg.communityVoteThreshold.value, "communityVoteThreshold.value");
  const proof = new IssuedVerifiedGovernanceIdentity({
    verifiedRealm,
    connection,
    governance,
    realm: verifiedRealm.realm,
    communityMint: verifiedRealm.communityMint,
    config: {
      communityVoteThresholdType: cfg.communityVoteThreshold.type,
      communityVoteThresholdValue: thresholdValue,
      minCommunityTokensToCreateProposal: cfg.minCommunityTokensToCreateProposal,
      communityVoteTipping: cfg.communityVoteTipping,
      minInstructionHoldUpTime: cfg.minInstructionHoldUpTime,
      baseVotingTime: cfg.baseVotingTime,
      votingCoolOffTime: cfg.votingCoolOffTime,
      depositExemptProposalCount: cfg.depositExemptProposalCount,
      minCouncilTokensToCreateProposal: cfg.minCouncilTokensToCreateProposal,
      councilVoteThresholdType: cfg.councilVoteThreshold.type,
      councilVoteThresholdValue: cfg.councilVoteThreshold.value,
      councilVetoVoteThresholdType: cfg.councilVetoVoteThreshold.type,
      councilVetoVoteThresholdValue: cfg.councilVetoVoteThreshold.value,
      communityVetoVoteThresholdType: cfg.communityVetoVoteThreshold.type,
      communityVetoVoteThresholdValue: cfg.communityVetoVoteThreshold.value,
      councilVoteTipping: cfg.councilVoteTipping,
    },
  });
  issuedGovernanceIdentityProofs.add(proof);
  return proof;
}

export function assertVerifiedGovernanceIdentity(
  identity: VerifiedGovernanceIdentity,
): asserts identity is VerifiedGovernanceIdentity {
  if (identity === null || typeof identity !== "object") {
    throw new ClientValidationError("GOVERNANCE_IDENTITY_PROOF", [
      "VerifiedGovernanceIdentity is missing",
    ]);
  }
  if (
    !issuedGovernanceIdentityProofs.has(identity) ||
    !(identity instanceof IssuedVerifiedGovernanceIdentity)
  ) {
    throw new ClientValidationError("GOVERNANCE_IDENTITY_PROOF", [
      "fabricated governance identity; only verifyGovernanceIdentity may issue this proof",
    ]);
  }
  if (!identity.matchesIssuedFields()) {
    throw new ClientValidationError("GOVERNANCE_IDENTITY_PROOF", [
      "governance identity fields were mutated after issuance",
    ]);
  }
  assertVerifiedRealm(identity.verifiedRealm);
}

/**
 * Active community-governance proof. Identity may exist during bootstrap;
 * this stronger proof is issued only after community proposal/voting fields
 * are enabled on-chain.
 */
export async function verifyGovernanceDeployment(
  connection: Connection,
  verifiedRealm: VerifiedRealm,
  governance: PublicKey,
  commitment?: AccountReadCommitment,
): Promise<VerifiedGovernance> {
  const identity = await verifyGovernanceIdentity(connection, verifiedRealm, governance, commitment);
  const cfg = identity.config;
  if (cfg.communityVoteThresholdType === VoteThresholdType.Disabled) {
    throw new ClientValidationError("GOVERNANCE_COMMUNITY_DISABLED", [
      "communityVoteThreshold is Disabled; community propose/cast require an enabled governance",
    ]);
  }
  if (
    cfg.communityVoteThresholdValue === undefined ||
    cfg.communityVoteThresholdValue === 0
  ) {
    throw new ClientValidationError("GOVERNANCE_COMMUNITY_THRESHOLD", [
      "communityVoteThreshold.value is missing or zero",
    ]);
  }
  if (cfg.minCommunityTokensToCreateProposal.eq(COMMUNITY_PROPOSAL_DISABLED)) {
    throw new ClientValidationError("GOVERNANCE_COMMUNITY_PROPOSAL_DISABLED", [
      "minCommunityTokensToCreateProposal is u64 max; community proposal creation is still disabled",
    ]);
  }
  requirePositiveBn(
    cfg.minCommunityTokensToCreateProposal,
    "minCommunityTokensToCreateProposal",
  );
  // VoteTipping.Disabled means "never tip early" - not "voting off". Product
  // Realms ship Disabled on purpose (avoids Strict FinalizeVote landmines).
  // Do not refuse community propose/cast on that enum.

  const proof = new IssuedVerifiedGovernance({
    verifiedRealm: identity.verifiedRealm,
    connection,
    governance: identity.governance,
    realm: identity.realm,
    communityMint: identity.communityMint,
    config: identity.config,
  });
  issuedGovernanceIdentityProofs.add(proof);
  issuedGovernanceProofs.add(proof);
  return proof;
}

export function assertVerifiedGovernance(
  verifiedGovernance: VerifiedGovernance,
): asserts verifiedGovernance is VerifiedGovernance {
  if (verifiedGovernance === null || typeof verifiedGovernance !== "object") {
    throw new ClientValidationError("GOVERNANCE_PROOF", ["VerifiedGovernance is missing"]);
  }
  if (
    !issuedGovernanceProofs.has(verifiedGovernance) ||
    !(verifiedGovernance instanceof IssuedVerifiedGovernance)
  ) {
    throw new ClientValidationError("GOVERNANCE_PROOF", [
      "fabricated VerifiedGovernance lookalike; only verifyGovernanceDeployment may issue this proof",
    ]);
  }
  if (!verifiedGovernance.matchesIssuedFields()) {
    throw new ClientValidationError("GOVERNANCE_PROOF", [
      "VerifiedGovernance fields were mutated after issuance",
    ]);
  }
  assertVerifiedGovernanceIdentity(verifiedGovernance);
  if (verifiedGovernance.config.communityVoteThresholdType === VoteThresholdType.Disabled) {
    throw new ClientValidationError("GOVERNANCE_COMMUNITY_DISABLED", [
      "issued governance proof communityVoteThreshold is Disabled",
    ]);
  }
  if (
    verifiedGovernance.config.communityVoteThresholdValue === undefined ||
    verifiedGovernance.config.communityVoteThresholdValue === 0 ||
    verifiedGovernance.config.minCommunityTokensToCreateProposal.eq(COMMUNITY_PROPOSAL_DISABLED)
  ) {
    throw new ClientValidationError("GOVERNANCE_PROOF", [
      "issued governance proof no longer shows enabled community voting",
    ]);
  }
}

const CALLER_GOVERNANCE_FIELDS = ["governance", "verifiedRealm", ...CALLER_REALM_OR_MINT_FIELDS] as const;
const CALLER_IDENTITY_SUBSTITUTION_FIELDS = ["verified", "governance", "realm", "verifiedRealm"] as const;

function assertNoCallerGovernanceOrMint(params: object, label: string): void {
  const hits = CALLER_GOVERNANCE_FIELDS.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError("CALLER_GOVERNANCE_OR_MINT", [
      `${label} must use verifiedGovernance.governance / verifiedRealm derived from that proof; ${hits.join(", ")} cannot substitute`,
    ]);
  }
}

function assertNoCallerFields(params: object, fields: readonly string[], label: string): void {
  const hits = fields.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError("CALLER_GOVERNANCE_OR_MINT", [
      `${label} must use verifiedGovernance identity; ${hits.join(", ")} cannot substitute`,
    ]);
  }
}

function assertIdentityBoundLifecycle(
  params: object,
  identity: VerifiedGovernanceIdentity,
  label: string,
  extraFields: readonly string[] = [],
): void {
  assertNoSecretMaterial(params, label);
  assertVerifiedGovernanceIdentity(identity);
  assertLinearDefaultVoting(params, label);
  assertNoCallerFields(params, [...CALLER_IDENTITY_SUBSTITUTION_FIELDS, ...extraFields], label);
}

function assertCommunityBuilder(params: object, verifiedRealm: VerifiedRealm, label: string): void {
  assertNoSecretMaterial(params, label);
  assertVerifiedRealm(verifiedRealm);
  assertLinearDefaultVoting(params, label);
  assertNoCallerRealmOrMint(params, label);
}

function assertCommunityGovernanceBuilder(
  params: object,
  verifiedGovernance: VerifiedGovernance,
  label: string,
): void {
  assertNoSecretMaterial(params, label);
  assertVerifiedGovernance(verifiedGovernance);
  assertLinearDefaultVoting(params, label);
  assertNoCallerGovernanceOrMint(params, label);
}

export function toInstructionData(ix: TransactionInstruction): InstructionData {
  return new InstructionData({
    programId: ix.programId,
    accounts: ix.keys.map(
      (key) =>
        new AccountMetaData({
          pubkey: key.pubkey,
          isSigner: key.isSigner,
          isWritable: key.isWritable,
        }),
    ),
    data: Uint8Array.from(ix.data),
  });
}

function fromInstructionData(ix: InstructionData): TransactionInstruction {
  return new TransactionInstruction({
    programId: ix.programId,
    keys: ix.accounts.map((key) => ({
      pubkey: key.pubkey,
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Uint8Array.from(ix.data) as TransactionInstruction["data"],
  });
}

function bytesToHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function cloneInnerInstructions(
  instructions: readonly TransactionInstruction[],
): TransactionInstruction[] {
  return instructions.map((ix) => ({
    programId: ix.programId,
    keys: ix.keys.map((key) => ({
      pubkey: key.pubkey,
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Uint8Array.from(ix.data) as TransactionInstruction["data"],
  }));
}

/**
 * Exact inner-instruction fingerprint: program id, key order/flags, data bytes.
 * Used so execute cannot trust a mutated caller claim.
 */
export function fingerprintInnerInstructions(
  instructions: readonly TransactionInstruction[],
): string {
  return instructions
    .map((ix) => {
      const keys = ix.keys
        .map((key) => `${key.pubkey.toBase58()}:${key.isSigner ? "1" : "0"}:${key.isWritable ? "1" : "0"}`)
        .join(",");
      return `${ix.programId.toBase58()};${keys};${bytesToHex(Uint8Array.from(ix.data))}`;
    })
    .join("|");
}

export function assertInnerInstructionsMatch(
  expected: readonly TransactionInstruction[],
  claimed: readonly TransactionInstruction[],
): void {
  if (expected.length !== claimed.length) {
    throw new ClientValidationError("INNER_INSTRUCTION_MISMATCH", [
      `claimed ${String(claimed.length)} inner instructions; inserted staged actions have ${String(expected.length)}`,
    ]);
  }
  if (fingerprintInnerInstructions(expected) !== fingerprintInnerInstructions(claimed)) {
    throw new ClientValidationError("INNER_INSTRUCTION_MISMATCH", [
      "claimed inner instructions do not match the exact inserted staged actions",
    ]);
  }
}

const issuedStagedProposalActions = new WeakSet<object>();

class IssuedStagedProposalActions implements StagedProposalActions {
  readonly transactionAddress: PublicKey;
  readonly proposal: PublicKey;
  readonly optionIndex: number;
  readonly index: number;
  readonly #identity: VerifiedGovernanceIdentity;
  readonly #transactionAddress: PublicKey;
  readonly #proposal: PublicKey;
  readonly #optionIndex: number;
  readonly #index: number;
  readonly #inner: readonly TransactionInstruction[];
  readonly #fingerprint: string;

  constructor(args: {
    identity: VerifiedGovernanceIdentity;
    transactionAddress: PublicKey;
    proposal: PublicKey;
    optionIndex: number;
    index: number;
    inner: readonly TransactionInstruction[];
  }) {
    this.transactionAddress = args.transactionAddress;
    this.proposal = args.proposal;
    this.optionIndex = args.optionIndex;
    this.index = args.index;
    this.#identity = args.identity;
    this.#transactionAddress = args.transactionAddress;
    this.#proposal = args.proposal;
    this.#optionIndex = args.optionIndex;
    this.#index = args.index;
    this.#inner = args.inner;
    this.#fingerprint = fingerprintInnerInstructions(args.inner);
  }

  matchesIssuedFields(): boolean {
    return (
      this.transactionAddress.equals(this.#transactionAddress) &&
      this.proposal.equals(this.#proposal) &&
      this.optionIndex === this.#optionIndex &&
      this.index === this.#index &&
      fingerprintInnerInstructions(this.#inner) === this.#fingerprint
    );
  }

  boundTo(identity: VerifiedGovernanceIdentity): boolean {
    return identity === this.#identity;
  }

  cloneInnerInstructions(): TransactionInstruction[] {
    return cloneInnerInstructions(this.#inner);
  }

  innerFingerprint(): string {
    return this.#fingerprint;
  }
}

export function assertStagedProposalActions(
  staged: StagedProposalActions,
): asserts staged is StagedProposalActions {
  if (staged === null || typeof staged !== "object") {
    throw new ClientValidationError("STAGED_PROPOSAL_ACTIONS", [
      "StagedProposalActions is missing",
    ]);
  }
  if (
    !issuedStagedProposalActions.has(staged) ||
    !(staged instanceof IssuedStagedProposalActions)
  ) {
    throw new ClientValidationError("STAGED_PROPOSAL_ACTIONS", [
      "fabricated staged proposal actions; only buildInsertProposalTransaction may issue this receipt",
    ]);
  }
  if (!staged.matchesIssuedFields()) {
    throw new ClientValidationError("STAGED_PROPOSAL_ACTIONS", [
      "staged proposal action fields were mutated after issuance",
    ]);
  }
}

export function bootstrapGovernanceConfig(council: BootstrapCouncilConfig): GovernanceConfig {
  assertBootstrapCouncil(council);
  return new GovernanceConfig({
    communityVoteThreshold: disabledThreshold(),
    minCommunityTokensToCreateProposal: COMMUNITY_PROPOSAL_DISABLED,
    minInstructionHoldUpTime: council.minInstructionHoldUpTime,
    baseVotingTime: council.baseVotingTime,
    communityVoteTipping: VoteTipping.Disabled,
    councilVoteThreshold: yesPercent(council.councilVoteThresholdPercent),
    councilVetoVoteThreshold: yesPercent(council.councilVetoVoteThresholdPercent),
    minCouncilTokensToCreateProposal: council.minCouncilTokensToCreateProposal,
    councilVoteTipping: VoteTipping.Early,
    communityVetoVoteThreshold: disabledThreshold(),
    votingCoolOffTime: council.votingCoolOffTime,
    depositExemptProposalCount: council.depositExemptProposalCount,
  });
}

export function communityActivationGovernanceConfig(
  config: CommunityActivationConfig,
): GovernanceConfig {
  assertCommunityActivation(config);
  return new GovernanceConfig({
    communityVoteThreshold: yesPercent(config.communityVoteThresholdPercent),
    minCommunityTokensToCreateProposal: config.minCommunityTokensToCreateProposal,
    minInstructionHoldUpTime: config.minInstructionHoldUpTime,
    baseVotingTime: config.baseVotingTime,
    communityVoteTipping: VoteTipping.Disabled, // MAINNET_COMMUNITY_VOTE_TIPPING [OPERATOR 2026-08-26]
    councilVoteThreshold: disabledThreshold(),
    councilVetoVoteThreshold: disabledThreshold(),
    minCouncilTokensToCreateProposal: config.minCouncilTokensToCreateProposal,
    councilVoteTipping: VoteTipping.Disabled,
    communityVetoVoteThreshold: disabledThreshold(),
    votingCoolOffTime: config.votingCoolOffTime,
    depositExemptProposalCount: config.depositExemptProposalCount,
  });
}

/**
 * Same accounts as SDK `createSetGovernanceConfig`. When `baseVotingTime` is
 * under the SDK's JS-only 3600s floor, build with a floored config then rewrite
 * the unique u32 little-endian slot that held 3600. On-chain GovER5 accepts
 * shorter windows (this throwaway was created at 30s). Prefer >= 3600 for
 * production. Governance PDA remains the required signer (proposal Execute).
 */
function createSetGovernanceConfigWire(
  programId: PublicKey,
  programVersion: number,
  governance: PublicKey,
  governanceConfig: GovernanceConfig,
): TransactionInstruction {
  const requested = governanceConfig.baseVotingTime;
  if (typeof requested !== "number" || requested < 1) {
    throw new ClientValidationError("GOVERNANCE_CONFIG", [
      "baseVotingTime must be a positive second count",
    ]);
  }
  if (requested >= 3600) {
    return createSetGovernanceConfig(programId, programVersion, governance, governanceConfig);
  }
  // SDK createSetGovernanceConfig refuses < 3600 in JS only. Build at the floor,
  // then patch the wire bytes back to the requested window.
  const floored = new GovernanceConfig({
    communityVoteThreshold: governanceConfig.communityVoteThreshold,
    minCommunityTokensToCreateProposal: governanceConfig.minCommunityTokensToCreateProposal,
    minInstructionHoldUpTime: governanceConfig.minInstructionHoldUpTime,
    baseVotingTime: 3600,
    communityVoteTipping: governanceConfig.communityVoteTipping,
    councilVoteThreshold: governanceConfig.councilVoteThreshold,
    councilVetoVoteThreshold: governanceConfig.councilVetoVoteThreshold,
    minCouncilTokensToCreateProposal: governanceConfig.minCouncilTokensToCreateProposal,
    councilVoteTipping: governanceConfig.councilVoteTipping,
    communityVetoVoteThreshold: governanceConfig.communityVetoVoteThreshold,
    votingCoolOffTime: governanceConfig.votingCoolOffTime,
    depositExemptProposalCount: governanceConfig.depositExemptProposalCount,
  });
  const built = createSetGovernanceConfig(programId, programVersion, governance, floored);
  const data = Uint8Array.from(built.data);
  let offset = -1;
  for (let i = 0; i <= data.length - 4; i += 1) {
    const value =
      data[i]! |
      (data[i + 1]! << 8) |
      (data[i + 2]! << 16) |
      (data[i + 3]! << 24);
    if (value === 3600) {
      if (offset !== -1) {
        throw new ClientValidationError("GOVERNANCE_CONFIG", [
          "ambiguous 3600 u32 in SetGovernanceConfig wire; refusing to patch baseVotingTime",
        ]);
      }
      offset = i;
    }
  }
  if (offset < 0) {
    throw new ClientValidationError("GOVERNANCE_CONFIG", [
      "could not locate floored baseVotingTime u32 in SetGovernanceConfig wire",
    ]);
  }
  data[offset] = requested & 0xff;
  data[offset + 1] = (requested >>> 8) & 0xff;
  data[offset + 2] = (requested >>> 16) & 0xff;
  data[offset + 3] = (requested >>> 24) & 0xff;
  return new TransactionInstruction({
    keys: built.keys,
    programId: built.programId,
    data,
  });
}

/**
 * Builds SetGovernanceConfig for community enablement or later threshold
 * changes. On Realms 3.1.x this instruction requires the Governance PDA to
 * sign - insert via `buildInsertProposalTransaction` and Execute. A direct
 * "recovery window" wallet send cannot satisfy the PDA signer.
 */
export function buildCommunityActivationInstruction(params: {
  verifiedGovernance: VerifiedGovernanceIdentity;
  config: CommunityActivationConfig;
  /** Required on mainnet-beta so the 10_000 ICHOR proposal floor scales from the live mint. */
  ichorDecimals?: number;
}): UnsignedInstructionBuild {
  assertIdentityBoundLifecycle(
    params,
    params.verifiedGovernance,
    "buildCommunityActivationInstruction",
    ["ichorMint", "governingTokenMint"],
  );
  const { governance, verifiedRealm } = params.verifiedGovernance;
  const verified = verifiedRealm.verified;
  assertMainnetCommunityActivation({
    cluster: verified.network.cluster,
    config: params.config,
    ichorDecimals: params.ichorDecimals,
  });
  const instruction = createSetGovernanceConfigWire(
    verified.network.realmsProgramId,
    verified.network.programVersion,
    governance,
    communityActivationGovernanceConfig(params.config),
  );
  return {
    instructions: [instruction],
    derivedAddresses: { governance },
  };
}

/**
 * Realm + community ICHOR mint. Voting is linear deposited ICHOR: Liquid token
 * type, no voter-weight add-in. Council mint is required for bootstrap.
 * communityMintMaxVoteWeightSource is required; FULL_SUPPLY is refused.
 */
export async function buildCreateRealm(params: BuildRealmParams): Promise<UnsignedInstructionBuild> {
  assertNoSecretMaterial(params, "buildCreateRealm");
  assertVerifiedIchorConfig(params.verifiedConfig);
  const councilMint = requirePublicKey(params.councilMint, "councilMint");
  requirePositiveBn(
    params.minCommunityWeightToCreateGovernance,
    "minCommunityWeightToCreateGovernance",
  );
  const verified = params.verifiedConfig.verifiedProgram.verified;
  assertMainnetKekbullGovernance(verified.network);
  const ichorMint = params.verifiedConfig.config.ichorMint;
  const name = requireNonEmptyString(params.realmName, "realmName");
  if (verified.network.programVersion !== REALMS_PROGRAM_VERSION) {
    throw new ClientValidationError("PROGRAM_VERSION", ["buildCreateRealm requires programVersion=3"]);
  }
  const reachableSource = requireReachableMintMaxVoteWeightSource(
    params.communityMintMaxVoteWeightSource,
    MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value,
  );
  assertMainnetVoteWeightSource({
    cluster: verified.network.cluster,
    source: reachableSource,
    fullSupplyFractionValue: MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value,
  });
  const communityMintMaxVoteWeightSource = new MintMaxVoteWeightSource({
    type:
      reachableSource.type === "absolute"
        ? MintMaxVoteWeightSourceType.Absolute
        : MintMaxVoteWeightSourceType.SupplyFraction,
    value: reachableSource.value,
  });
  if (communityMintMaxVoteWeightSource.isFullSupply()) {
    throw new ClientValidationError("UNREACHABLE_QUORUM_DENOMINATOR", [
      "communityMintMaxVoteWeightSource must not be FULL_SUPPLY_FRACTION; locked LP and treasury ICHOR cannot vote",
    ]);
  }

  const instructions: TransactionInstruction[] = [];
  const realmAddress = await withCreateRealm(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    name,
    params.realmAuthority,
    ichorMint,
    params.payer,
    councilMint,
    communityMintMaxVoteWeightSource,
    params.minCommunityWeightToCreateGovernance,
    linearDepositedTokenConfig(),
    linearDepositedTokenConfig(),
  );
  if (instructions.length !== 1) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `createRealm helper produced ${String(instructions.length)} instructions; expected 1`,
    ]);
  }
  const realmConfig = await getRealmConfigAddress(verified.network.realmsProgramId, realmAddress);
  patchCreateRealmKeys(instructions[0]!, councilMint, realmConfig);

  return {
    instructions,
    derivedAddresses: {
      realm: realmAddress,
      communityMint: ichorMint,
      councilMint,
      realmConfig,
    },
  };
}

export async function buildCreateTokenOwnerRecord(params: {
  verified: VerifiedNetwork;
  realm: PublicKey;
  owner: PublicKey;
  governingTokenMint: PublicKey;
  payer: PublicKey;
}): Promise<UnsignedInstructionBuild> {
  assertNoSecretMaterial(params, "buildCreateTokenOwnerRecord");
  assertVerifiedNetwork(params.verified);
  const instructions: TransactionInstruction[] = [];
  const tokenOwnerRecord = await withCreateTokenOwnerRecord(
    instructions,
    params.verified.network.realmsProgramId,
    params.verified.network.programVersion,
    params.realm,
    params.owner,
    params.governingTokenMint,
    params.payer,
  );
  return {
    instructions,
    derivedAddresses: { tokenOwnerRecord },
  };
}

export async function buildCreateGovernance(
  params: BuildCreateGovernanceParams,
): Promise<UnsignedInstructionBuild> {
  assertNoSecretMaterial(params, "buildCreateGovernance");
  assertVerifiedRealm(params.verifiedRealm);
  const { verified, realm, councilMint } = params.verifiedRealm;
  if (councilMint === null) {
    throw new ClientValidationError("COUNCIL_MINT_MISSING", [
      "verified Realm has no council mint; zero-supply council mint is required at create",
    ]);
  }
  assertMainnetCommunityActivation({
    cluster: verified.network.cluster,
    config: params.config,
    ichorDecimals: params.ichorDecimals,
  });
  const instructions: TransactionInstruction[] = [];
  const governance = await withCreateGovernance(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    params.governedAccount,
    communityActivationGovernanceConfig(params.config),
    params.tokenOwnerRecord,
    params.payer,
    params.createAuthority,
  );
  return {
    instructions,
    derivedAddresses: { governance },
  };
}

export async function buildCreateNativeTreasury(
  params: BuildNativeTreasuryParams,
): Promise<UnsignedInstructionBuild> {
  assertNoSecretMaterial(params, "buildCreateNativeTreasury");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  requirePublicKey(params.payer, "payer");
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const verified = verifiedRealm.verified;
  const instructions: TransactionInstruction[] = [];
  const treasury = await withCreateNativeTreasury(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    governance,
    params.payer,
  );
  const derived = await getNativeTreasuryAddress(
    verified.network.realmsProgramId,
    governance,
  );
  if (!treasury.equals(derived)) {
    throw new ClientValidationError("TREASURY_PDA", [
      `withCreateNativeTreasury returned ${treasury.toBase58()} but getNativeTreasuryAddress derived ${derived.toBase58()}`,
    ]);
  }
  return {
    instructions,
    derivedAddresses: { treasury, governance },
  };
}

/**
 * ATA for a treasury-held mint. Token program is discovered from the mint owner.
 */
export async function buildTreasuryTokenAccount(
  params: BuildTreasuryTokenAccountParams,
): Promise<UnsignedInstructionBuild> {
  assertNoSecretMaterial(params, "buildTreasuryTokenAccount");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  requirePublicKey(params.payer, "payer");
  requirePublicKey(params.mint, "mint");
  const verified = params.verifiedGovernance.verifiedRealm.verified;
  assertBoundConnection(verified, params.connection);
  const treasury = await getNativeTreasuryAddress(
    verified.network.realmsProgramId,
    params.verifiedGovernance.governance,
  );
  const mint = await fetchMintSnapshot(params.connection, verified.network, params.mint);
  const ata = getAssociatedTokenAddressSync(
    mint.mint,
    treasury,
    true,
    mint.ownerProgram,
  );
  const instruction = createAssociatedTokenAccountIdempotentInstruction(
    params.payer,
    ata,
    treasury,
    mint.mint,
    mint.ownerProgram,
  );
  return {
    instructions: [instruction],
    derivedAddresses: {
      ata,
      mint: mint.mint,
      treasury,
      tokenProgram: mint.ownerProgram,
    },
  };
}

/**
 * DepositGoverningTokens + Token-2022 mint patch. Used by
 * `buildDepositIchorVotes` after issued-realm and fee reads, and by offline
 * defensive-stake fixtures that cannot hold live proofs.
 */
export async function composeDepositIchorVotesInstruction(params: {
  realmsProgramId: PublicKey;
  programVersion: 3;
  realm: PublicKey;
  tokenSourceAccount: PublicKey;
  communityMint: PublicKey;
  tokenOwner: PublicKey;
  sourceAuthority: PublicKey;
  payer: PublicKey;
  amount: BN;
}): Promise<{
  instruction: TransactionInstruction;
  tokenOwnerRecord: PublicKey;
  realmConfig: PublicKey;
}> {
  requirePositiveBn(params.amount, "amount");
  requirePublicKey(params.realmsProgramId, "realmsProgramId");
  requirePublicKey(params.realm, "realm");
  requirePublicKey(params.tokenSourceAccount, "tokenSourceAccount");
  requirePublicKey(params.communityMint, "communityMint");
  requirePublicKey(params.tokenOwner, "tokenOwner");
  requirePublicKey(params.sourceAuthority, "sourceAuthority");
  requirePublicKey(params.payer, "payer");
  const instructions: TransactionInstruction[] = [];
  const tokenOwnerRecord = await withDepositGoverningTokens(
    instructions,
    params.realmsProgramId,
    params.programVersion,
    params.realm,
    params.tokenSourceAccount,
    params.communityMint,
    params.tokenOwner,
    params.sourceAuthority,
    params.payer,
    params.amount,
  );
  const expected = await getTokenOwnerRecordAddress(
    params.realmsProgramId,
    params.realm,
    params.communityMint,
    params.tokenOwner,
  );
  if (!tokenOwnerRecord.equals(expected)) {
    throw new ClientValidationError("TOKEN_OWNER_RECORD", [
      `deposit returned ${tokenOwnerRecord.toBase58()} but PDA is ${expected.toBase58()}`,
    ]);
  }
  if (instructions.length !== 1) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `deposit helper produced ${String(instructions.length)} instructions; expected 1`,
    ]);
  }
  const realmConfig = await getRealmConfigAddress(params.realmsProgramId, params.realm);
  applyIchorDepositToken2022Patch(instructions[0]!, params.communityMint, realmConfig);
  return {
    instruction: instructions[0]!,
    tokenOwnerRecord,
    realmConfig,
  };
}

/**
 * Deposit ICHOR into the realm. Weight is the deposited amount, not wallet
 * balance and not a square-root plugin.
 */
export async function buildDepositIchorVotes(
  params: DepositIchorVoteParams,
): Promise<DepositIchorVotesBuild> {
  assertCommunityBuilder(params, params.verifiedRealm, "buildDepositIchorVotes");
  assertBoundConnection(params.verifiedRealm.verified, params.connection);
  requirePositiveBn(params.amount, "amount");
  requirePublicKey(params.tokenSourceAccount, "tokenSourceAccount");
  requirePublicKey(params.tokenOwner, "tokenOwner");
  requirePublicKey(params.sourceAuthority, "sourceAuthority");
  requirePublicKey(params.payer, "payer");
  const { verified, realm, communityMint } = params.verifiedRealm;
  const transfer = await liveIchorMintFee({
    connection: params.connection,
    verified,
    ichorMint: communityMint,
    amount: params.amount,
  });
  const composed = await composeDepositIchorVotesInstruction({
    realmsProgramId: verified.network.realmsProgramId,
    programVersion: verified.network.programVersion,
    realm,
    tokenSourceAccount: params.tokenSourceAccount,
    communityMint,
    tokenOwner: params.tokenOwner,
    sourceAuthority: params.sourceAuthority,
    payer: params.payer,
    amount: params.amount,
  });
  return {
    instructions: [composed.instruction],
    derivedAddresses: {
      tokenOwnerRecord: composed.tokenOwnerRecord,
      realmConfig: composed.realmConfig,
    },
    transfer: {
      amount: params.amount,
      expectedMintFee: transfer.expectedMintFee,
      expectedNet: transfer.expectedNet,
    },
  };
}

/** Deposit fixed-supply legacy council tokens during bootstrap. */
export async function buildDepositCouncilVotes(
  params: DepositCouncilVoteParams,
): Promise<UnsignedInstructionBuild> {
  assertNoSecretMaterial(params, "buildDepositCouncilVotes");
  assertVerifiedRealm(params.verifiedRealm);
  assertLinearDefaultVoting(params, "buildDepositCouncilVotes");
  assertNoCallerRealmOrMint(params, "buildDepositCouncilVotes");
  requirePositiveBn(params.amount, "amount");
  requirePublicKey(params.tokenSourceAccount, "tokenSourceAccount");
  requirePublicKey(params.tokenOwner, "tokenOwner");
  requirePublicKey(params.sourceAuthority, "sourceAuthority");
  requirePublicKey(params.payer, "payer");
  const { verified, realm, councilMint } = params.verifiedRealm;
  if (councilMint === null) {
    throw new ClientValidationError("COUNCIL_MINT_MISSING", [
      "verified Realm has no council mint",
    ]);
  }
  const instructions: TransactionInstruction[] = [];
  const tokenOwnerRecord = await withDepositGoverningTokens(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    params.tokenSourceAccount,
    councilMint,
    params.tokenOwner,
    params.sourceAuthority,
    params.payer,
    params.amount,
  );
  const expected = await getTokenOwnerRecordAddress(
    verified.network.realmsProgramId,
    realm,
    councilMint,
    params.tokenOwner,
  );
  if (!tokenOwnerRecord.equals(expected)) {
    throw new ClientValidationError("TOKEN_OWNER_RECORD", [
      `council deposit returned ${tokenOwnerRecord.toBase58()} but PDA is ${expected.toBase58()}`,
    ]);
  }
  return {
    instructions,
    derivedAddresses: { tokenOwnerRecord, councilMint },
  };
}

/**
 * Direct bootstrap handoff: transfers live Realm authority from the current
 * bootstrap signer to the verified Governance PDA via
 * `withSetRealmAuthority(..., SetRealmAuthorityAction.SetChecked)`.
 * Destination is only `verifiedGovernance.governance` - never caller input.
 * Returns unsigned instructions only.
 */
export async function buildTransferRealmAuthorityToGovernance(
  params: BuildTransferRealmAuthorityParams,
): Promise<UnsignedInstructionBuild> {
  assertIdentityBoundLifecycle(
    params,
    params.verifiedGovernance,
    "buildTransferRealmAuthorityToGovernance",
    [
      "ichorMint",
      "governingTokenMint",
      "newRealmAuthority",
      "newAuthority",
      "destination",
      "action",
    ],
  );
  const identity = params.verifiedGovernance;
  if (
    !(identity instanceof IssuedVerifiedGovernanceIdentity) ||
    !identity.boundTo(params.connection, identity.verifiedRealm)
  ) {
    throw new ClientValidationError("CONNECTION_MISMATCH", [
      "connection is not the exact Connection instance bound to the issued VerifiedGovernanceIdentity",
    ]);
  }
  const currentAuthority = requirePublicKey(params.currentAuthority, "currentAuthority");
  if (currentAuthority.equals(PublicKey.default)) {
    throw new ClientValidationError("AUTHORITY_DEFAULT", [
      "currentAuthority is the default pubkey",
    ]);
  }
  const { verifiedRealm, governance } = identity;
  const { verified, realm, communityMint } = verifiedRealm;
  if (verified.network.programVersion !== REALMS_PROGRAM_VERSION) {
    throw new ClientValidationError("PROGRAM_VERSION", [
      "buildTransferRealmAuthorityToGovernance requires programVersion=3",
    ]);
  }
  if (currentAuthority.equals(governance)) {
    throw new ClientValidationError("AUTHORITY_ALREADY_GOVERNANCE", [
      "currentAuthority is already the verified Governance PDA; bootstrap handoff is complete",
    ]);
  }

  const parsed = await getRealm(params.connection, realm);
  if (!parsed.pubkey.equals(realm) || !parsed.account.communityMint.equals(communityMint)) {
    throw new ClientValidationError("REALM_IDENTITY", [
      "live Realm identity changed after verification",
    ]);
  }
  if (parsed.account.authority === undefined) {
    throw new ClientValidationError("REALM_AUTHORITY", [
      "live Realm has no authority; cannot transfer from an empty authority",
    ]);
  }
  if (!parsed.account.authority.equals(currentAuthority)) {
    throw new ClientValidationError("REALM_AUTHORITY", [
      `live Realm authority ${parsed.account.authority.toBase58()} is not currentAuthority ${currentAuthority.toBase58()}`,
    ]);
  }
  if (parsed.account.authority.equals(governance)) {
    throw new ClientValidationError("AUTHORITY_ALREADY_GOVERNANCE", [
      "live Realm authority is already the verified Governance PDA",
    ]);
  }

  const instructions: TransactionInstruction[] = [];
  withSetRealmAuthority(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    currentAuthority,
    governance,
    SetRealmAuthorityAction.SetChecked,
  );
  if (instructions.length !== 1) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `setRealmAuthority helper produced ${String(instructions.length)} instructions; expected 1`,
    ]);
  }
  const ix = instructions[0]!;
  if (!ix.programId.equals(verified.network.realmsProgramId)) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `setRealmAuthority programId ${ix.programId.toBase58()} is not ${verified.network.realmsProgramId.toBase58()}`,
    ]);
  }
  if (ix.keys.length !== 3) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `setRealmAuthority helper produced ${String(ix.keys.length)} keys; expected 3 for v3 SetChecked (realm, authority, newAuthority)`,
    ]);
  }
  requireInstructionKey(ix.keys, 0, realm, "setRealmAuthority");
  if (ix.keys[0]!.isWritable !== true || ix.keys[0]!.isSigner !== false) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "setRealmAuthority key[0] realm must be writable non-signer",
    ]);
  }
  requireInstructionKey(ix.keys, 1, currentAuthority, "setRealmAuthority");
  if (ix.keys[1]!.isSigner !== true || ix.keys[1]!.isWritable !== false) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "setRealmAuthority key[1] currentAuthority must be a non-writable signer",
    ]);
  }
  requireInstructionKey(ix.keys, 2, governance, "setRealmAuthority");
  if (ix.keys[2]!.isSigner !== false || ix.keys[2]!.isWritable !== false) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "setRealmAuthority key[2] Governance must be a non-signer non-writable account",
    ]);
  }

  return {
    instructions,
    derivedAddresses: {
      realm,
      governance,
      currentAuthority,
      newRealmAuthority: governance,
    },
  };
}

/**
 * Inner SetRealmConfig instruction that permanently removes the council mint.
 * Proposal-only payload - insert via `buildInsertProposalTransaction`.
 * Governance must already be Realm authority. All council deposits must be
 * withdrawn first because Realms cannot withdraw them after council removal.
 */
export async function buildRemoveCouncilInstruction(
  params: BuildRemoveCouncilParams,
): Promise<UnsignedInstructionBuild> {
  assertIdentityBoundLifecycle(
    params,
    params.verifiedGovernance,
    "buildRemoveCouncilInstruction",
    ["ichorMint", "governingTokenMint", "councilMint", "newRealmAuthority", "destination"],
  );
  const identity = params.verifiedGovernance;
  if (
    !(identity instanceof IssuedVerifiedGovernanceIdentity) ||
    !identity.boundTo(params.connection, identity.verifiedRealm)
  ) {
    throw new ClientValidationError("CONNECTION_MISMATCH", [
      "connection is not the exact Connection instance bound to the issued VerifiedGovernanceIdentity",
    ]);
  }
  const { verifiedRealm, governance } = identity;
  const { verified, realm, councilMint, communityMint } = verifiedRealm;
  if (verified.network.programVersion !== REALMS_PROGRAM_VERSION) {
    throw new ClientValidationError("PROGRAM_VERSION", [
      "buildRemoveCouncilInstruction requires programVersion=3",
    ]);
  }
  if (councilMint === null) {
    throw new ClientValidationError("COUNCIL_MINT_MISSING", [
      "verified Realm has no council mint to remove",
    ]);
  }
  const parsed = await getRealm(params.connection, realm);
  if (!parsed.pubkey.equals(realm) || !parsed.account.communityMint.equals(communityMint)) {
    throw new ClientValidationError("REALM_IDENTITY", [
      "live Realm identity changed after verification",
    ]);
  }
  if (parsed.account.authority === undefined || !parsed.account.authority.equals(governance)) {
    throw new ClientValidationError("REALM_AUTHORITY", [
      "Governance must be the live Realm authority before council removal can be proposed",
    ]);
  }
  if (
    parsed.account.config.councilMint === undefined ||
    !parsed.account.config.councilMint.equals(councilMint)
  ) {
    throw new ClientValidationError("COUNCIL_MINT_MISMATCH", [
      "live Realm council mint changed after verification",
    ]);
  }
  const councilSnapshot = await fetchMintSnapshot(
    params.connection,
    verified.network,
    councilMint,
  );
  assertLegacySplMint(councilSnapshot, "council mint");
  const councilHolding = await getTokenHoldingAddress(
    verified.network.realmsProgramId,
    realm,
    councilMint,
  );
  const holdingInfo = await params.connection.getAccountInfo(councilHolding, "confirmed");
  if (holdingInfo === null) {
    throw new ClientValidationError("COUNCIL_HOLDING_MISSING", [
      `council holding ${councilHolding.toBase58()} has no account`,
    ]);
  }
  const holding = unpackAccount(councilHolding, holdingInfo, TOKEN_PROGRAM_ID);
  if (!holding.mint.equals(councilMint) || !holding.owner.equals(realm)) {
    throw new ClientValidationError("COUNCIL_HOLDING_IDENTITY", [
      "council holding mint or Realm owner is wrong",
    ]);
  }
  if (holding.amount !== 0n) {
    throw new ClientValidationError("COUNCIL_DEPOSITS_REMAIN", [
      `council holding still contains ${holding.amount.toString()} base units; withdraw every council deposit before removal`,
    ]);
  }

  const instructions: TransactionInstruction[] = [];
  await withSetRealmConfig(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    governance,
    undefined,
    parsed.account.config.communityMintMaxVoteWeightSource,
    parsed.account.config.minCommunityTokensToCreateGovernance,
    linearDepositedTokenConfig(),
    undefined,
    undefined,
  );
  if (instructions.length !== 1) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `setRealmConfig helper produced ${String(instructions.length)} instructions; expected 1`,
    ]);
  }
  const ix = instructions[0]!;
  if (!ix.programId.equals(verified.network.realmsProgramId)) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `setRealmConfig programId ${ix.programId.toBase58()} is not ${verified.network.realmsProgramId.toBase58()}`,
    ]);
  }
  // v3 remove-council (useCouncilMint=false, no plugins, no payer): realm,
  // Governance signer, SystemProgram, RealmConfig - processor skips mint/holding.
  if (ix.keys.length !== 4) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `setRealmConfig helper produced ${String(ix.keys.length)} keys; expected 4 for v3 council removal without plugins`,
    ]);
  }
  const realmConfig = await getRealmConfigAddress(verified.network.realmsProgramId, realm);
  requireInstructionKey(ix.keys, 0, realm, "setRealmConfig");
  if (ix.keys[0]!.isWritable !== true || ix.keys[0]!.isSigner !== false) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "setRealmConfig key[0] realm must be writable non-signer",
    ]);
  }
  requireInstructionKey(ix.keys, 1, governance, "setRealmConfig");
  if (ix.keys[1]!.isWritable !== false || ix.keys[1]!.isSigner !== true) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "setRealmConfig key[1] Governance must be a readonly signer",
    ]);
  }
  requireInstructionKey(ix.keys, 2, SystemProgram.programId, "setRealmConfig");
  if (ix.keys[2]!.isWritable !== false || ix.keys[2]!.isSigner !== false) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "setRealmConfig key[2] SystemProgram must be readonly non-signer",
    ]);
  }
  requireInstructionKey(ix.keys, 3, realmConfig, "setRealmConfig");
  if (ix.keys[3]!.isWritable !== true || ix.keys[3]!.isSigner !== false) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "setRealmConfig key[3] RealmConfig must be writable non-signer",
    ]);
  }
  return {
    instructions,
    derivedAddresses: {
      realm,
      governance,
      councilMint,
      councilHolding,
      realmConfig,
    },
  };
}

export async function buildCreateProposal(params: BuildProposalParams): Promise<UnsignedInstructionBuild> {
  assertIdentityBoundLifecycle(params, params.verifiedGovernance, "buildCreateProposal", [
    "ichorMint",
  ]);
  requireNonEmptyString(params.name, "name");
  requirePublicKey(params.tokenOwnerRecord, "tokenOwnerRecord");
  requirePublicKey(params.governingTokenMint, "governingTokenMint");
  requirePublicKey(params.governanceAuthority, "governanceAuthority");
  requirePublicKey(params.payer, "payer");
  if (params.options.length === 0) {
    throw new ClientValidationError("PROPOSAL_OPTIONS", ["at least one option is required"]);
  }
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm } = verifiedRealm;
  const instructions: TransactionInstruction[] = [];
  const proposal = await withCreateProposal(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    governance,
    params.tokenOwnerRecord,
    params.name,
    params.descriptionLink,
    params.governingTokenMint,
    params.governanceAuthority,
    params.proposalIndex,
    VoteType.SINGLE_CHOICE,
    [...params.options],
    params.useDenyOption,
    params.payer,
    undefined,
    params.proposalSeed,
  );
  return {
    instructions,
    derivedAddresses: { proposal, governance },
  };
}

export async function buildCreateCommunityProposal(
  params: BuildCommunityProposalParams,
): Promise<UnsignedInstructionBuild> {
  assertCommunityGovernanceBuilder(params, params.verifiedGovernance, "buildCreateCommunityProposal");
  requireNonEmptyString(params.name, "name");
  requirePublicKey(params.tokenOwnerRecord, "tokenOwnerRecord");
  requirePublicKey(params.governanceAuthority, "governanceAuthority");
  requirePublicKey(params.payer, "payer");
  if (params.options.length === 0) {
    throw new ClientValidationError("PROPOSAL_OPTIONS", ["at least one option is required"]);
  }
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm, communityMint } = verifiedRealm;
  const instructions: TransactionInstruction[] = [];
  const proposal = await withCreateProposal(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    governance,
    params.tokenOwnerRecord,
    params.name,
    params.descriptionLink,
    communityMint,
    params.governanceAuthority,
    params.proposalIndex,
    VoteType.SINGLE_CHOICE,
    [...params.options],
    params.useDenyOption,
    params.payer,
    undefined,
    params.proposalSeed,
  );
  return {
    instructions,
    derivedAddresses: { proposal, governance },
  };
}

/**
 * 0.3.33 signature (verified):
 * withInsertTransaction(ixs, programId, programVersion, governance, proposal,
 * tokenOwnerRecord, governanceAuthority, index, optionIndex, holdUpTime,
 * transactionInstructions, payer)
 */
export async function buildInsertProposalTransaction(
  params: InsertProposalTransactionParams,
): Promise<InsertProposalTransactionBuild> {
  assertIdentityBoundLifecycle(
    params,
    params.verifiedGovernance,
    "buildInsertProposalTransaction",
    ["ichorMint", "governingTokenMint", "transactionAddress"],
  );
  requirePublicKey(params.proposal, "proposal");
  requirePublicKey(params.tokenOwnerRecord, "tokenOwnerRecord");
  requirePublicKey(params.governanceAuthority, "governanceAuthority");
  requirePublicKey(params.payer, "payer");
  const index = requireUnsignedIntegerInRange(params.index, "index", 0xffff);
  const optionIndex = requireUnsignedIntegerInRange(
    params.optionIndex,
    "optionIndex",
    0xff,
  );
  const holdUpTime = requireUnsignedIntegerInRange(
    params.holdUpTime,
    "holdUpTime",
    0xffff_ffff,
  );
  if (params.transactionInstructions.length === 0) {
    throw new ClientValidationError("PROPOSAL_TX", ["transactionInstructions must not be empty"]);
  }
  const inner = cloneInnerInstructions(params.transactionInstructions);
  const encoded = inner.map(toInstructionData);
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const verified = verifiedRealm.verified;
  const instructions: TransactionInstruction[] = [];
  const transactionAddress = await withInsertTransaction(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    governance,
    params.proposal,
    params.tokenOwnerRecord,
    params.governanceAuthority,
    index,
    optionIndex,
    holdUpTime,
    encoded,
    params.payer,
  );
  const derived = await getProposalTransactionAddress(
    verified.network.realmsProgramId,
    verified.network.programVersion,
    params.proposal,
    optionIndex,
    index,
  );
  if (!transactionAddress.equals(derived)) {
    throw new ClientValidationError("PROPOSAL_TX_PDA", [
      `insert returned ${transactionAddress.toBase58()} but PDA is ${derived.toBase58()}`,
    ]);
  }
  const staged = new IssuedStagedProposalActions({
    identity: params.verifiedGovernance,
    transactionAddress,
    proposal: params.proposal,
    optionIndex,
    index,
    inner,
  });
  issuedStagedProposalActions.add(staged);
  return {
    instructions,
    derivedAddresses: { transaction: transactionAddress, governance },
    staged,
  };
}

/**
 * Recover an insert-issued receipt from the live ProposalTransaction account.
 * This is the restart-safe path: stored inner instructions are parsed from
 * chain rather than trusted from local storage.
 */
export async function recoverProposalTransaction(
  params: RecoverProposalTransactionParams,
): Promise<RecoveredProposalTransaction> {
  assertIdentityBoundLifecycle(
    params,
    params.verifiedGovernance,
    "recoverProposalTransaction",
    ["ichorMint", "governingTokenMint", "transactionAddress"],
  );
  const { verifiedRealm } = params.verifiedGovernance;
  if (
    !(verifiedRealm instanceof IssuedVerifiedRealm) ||
    !verifiedRealm.boundTo(params.connection, verifiedRealm.verified)
  ) {
    throw new ClientValidationError("CONNECTION_MISMATCH", [
      "connection is not the exact Connection bound to the Governance identity",
    ]);
  }
  const proposal = requirePublicKey(params.proposal, "proposal");
  const index = requireUnsignedIntegerInRange(params.index, "index", 0xffff);
  const optionIndex = requireUnsignedIntegerInRange(
    params.optionIndex,
    "optionIndex",
    0xff,
  );
  const verified = verifiedRealm.verified;
  const transactionAddress = await getProposalTransactionAddress(
    verified.network.realmsProgramId,
    verified.network.programVersion,
    proposal,
    optionIndex,
    index,
  );
  const raw = await params.connection.getAccountInfo(transactionAddress, "confirmed");
  if (raw === null) {
    throw new ClientValidationError("PROPOSAL_TX_MISSING", [
      `ProposalTransaction ${transactionAddress.toBase58()} has no account`,
    ]);
  }
  if (!raw.owner.equals(verified.network.realmsProgramId)) {
    throw new ClientValidationError("PROPOSAL_TX_OWNER", [
      `ProposalTransaction owner ${raw.owner.toBase58()} is not the verified Realms program`,
    ]);
  }
  const parsed = await getGovernanceAccount(
    params.connection,
    transactionAddress,
    ProposalTransaction,
  );
  if (
    !parsed.pubkey.equals(transactionAddress) ||
    !parsed.account.proposal.equals(proposal) ||
    parsed.account.instructionIndex !== index ||
    parsed.account.optionIndex !== optionIndex
  ) {
    throw new ClientValidationError("PROPOSAL_TX_IDENTITY", [
      "parsed ProposalTransaction does not match its derived proposal/option/index identity",
    ]);
  }
  const inner = parsed.account
    .getAllInstructions()
    .map((instructionData) => fromInstructionData(instructionData));
  if (inner.length === 0) {
    throw new ClientValidationError("PROPOSAL_TX", [
      "live ProposalTransaction contains no inner instructions",
    ]);
  }
  const staged = new IssuedStagedProposalActions({
    identity: params.verifiedGovernance,
    transactionAddress,
    proposal,
    optionIndex,
    index,
    inner,
  });
  issuedStagedProposalActions.add(staged);
  return {
    staged,
    transactionInstructions: cloneInnerInstructions(inner),
    holdUpTime: parsed.account.holdUpTime,
    executedAt: parsed.account.executedAt,
    executionStatus: parsed.account.executionStatus,
  };
}

export async function buildSignOffProposal(
  params: BuildSignOffProposalParams,
): Promise<UnsignedInstructionBuild> {
  assertIdentityBoundLifecycle(
    params,
    params.verifiedGovernance,
    "buildSignOffProposal",
    ["ichorMint", "governingTokenMint"],
  );
  requirePublicKey(params.proposal, "proposal");
  requirePublicKey(params.signatory, "signatory");
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm } = verifiedRealm;
  const instructions: TransactionInstruction[] = [];
  withSignOffProposal(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    governance,
    params.proposal,
    params.signatory,
    undefined,
    params.proposalOwnerRecord,
  );
  return {
    instructions,
    derivedAddresses: { proposal: params.proposal, governance },
  };
}

/**
 * 0.3.33 signature (verified):
 * withExecuteTransaction(ixs, programId, programVersion, governance, proposal,
 * transactionAddress, transactionInstructions)
 */
export async function buildExecuteProposalTransaction(
  params: ExecuteProposalTransactionParams,
): Promise<UnsignedInstructionBuild> {
  assertIdentityBoundLifecycle(
    params,
    params.verifiedGovernance,
    "buildExecuteProposalTransaction",
    ["ichorMint", "governingTokenMint", "transactionAddress"],
  );
  assertStagedProposalActions(params.staged);
  if (!(params.staged instanceof IssuedStagedProposalActions) || !params.staged.boundTo(params.verifiedGovernance)) {
    throw new ClientValidationError("STAGED_GOVERNANCE_MISMATCH", [
      "staged proposal actions are not bound to this issued VerifiedGovernanceIdentity",
    ]);
  }
  requirePublicKey(params.proposal, "proposal");
  if (!params.proposal.equals(params.staged.proposal)) {
    throw new ClientValidationError("PROPOSAL_MISMATCH", [
      `proposal ${params.proposal.toBase58()} is not staged.proposal ${params.staged.proposal.toBase58()}`,
    ]);
  }
  if (params.transactionInstructions.length === 0) {
    throw new ClientValidationError("PROPOSAL_TX", ["transactionInstructions must not be empty"]);
  }
  const inner = params.staged.cloneInnerInstructions();
  assertInnerInstructionsMatch(inner, params.transactionInstructions);
  const encoded = inner.map(toInstructionData);
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const verified = verifiedRealm.verified;
  const derived = await getProposalTransactionAddress(
    verified.network.realmsProgramId,
    verified.network.programVersion,
    params.proposal,
    params.staged.optionIndex,
    params.staged.index,
  );
  if (!params.staged.transactionAddress.equals(derived)) {
    throw new ClientValidationError("PROPOSAL_TX_PDA", [
      `staged transaction ${params.staged.transactionAddress.toBase58()} is not the PDA ${derived.toBase58()}`,
    ]);
  }
  const instructions: TransactionInstruction[] = [];
  await withExecuteTransaction(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    governance,
    params.proposal,
    params.staged.transactionAddress,
    encoded,
  );
  return {
    instructions,
    derivedAddresses: { transaction: params.staged.transactionAddress, governance },
  };
}

/**
 * 0.3.33 signature (verified from registry):
 * withCastVote(ixs, programId, programVersion, realm, governance, proposal,
 * proposalOwnerRecord, tokenOwnerRecord, governanceAuthority,
 * voteGoverningTokenMint, vote, payer, voterWeightRecord?, maxVoterWeightRecord?)
 *
 * Community Yes/No only via `Vote.fromYesNoVote`. Plugin weight accounts are
 * omitted (`undefined`, `undefined`) for linear default voting.
 */
export async function buildCastCommunityVote(
  params: CastCommunityVoteParams,
): Promise<UnsignedInstructionBuild> {
  assertCommunityGovernanceBuilder(params, params.verifiedGovernance, "buildCastCommunityVote");
  requirePublicKey(params.proposal, "proposal");
  requirePublicKey(params.proposalOwnerRecord, "proposalOwnerRecord");
  requirePublicKey(params.tokenOwnerRecord, "tokenOwnerRecord");
  requirePublicKey(params.governanceAuthority, "governanceAuthority");
  requirePublicKey(params.payer, "payer");
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm, communityMint } = verifiedRealm;
  const vote = Vote.fromYesNoVote(yesNoVoteFromChoice(params.choice));
  const instructions: TransactionInstruction[] = [];
  const voteRecord = await withCastVote(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    governance,
    params.proposal,
    params.proposalOwnerRecord,
    params.tokenOwnerRecord,
    params.governanceAuthority,
    communityMint,
    vote,
    params.payer,
    undefined,
    undefined,
  );
  const derived = await getVoteRecordAddress(
    verified.network.realmsProgramId,
    params.proposal,
    params.tokenOwnerRecord,
  );
  if (!voteRecord.equals(derived)) {
    throw new ClientValidationError("VOTE_RECORD_PDA", [
      `cast returned ${voteRecord.toBase58()} but PDA is ${derived.toBase58()}`,
    ]);
  }
  return {
    instructions,
    derivedAddresses: { voteRecord, governance },
  };
}

export async function buildCastCouncilVote(
  params: CastCouncilVoteParams,
): Promise<UnsignedInstructionBuild> {
  assertIdentityBoundLifecycle(params, params.verifiedGovernance, "buildCastCouncilVote");
  requirePublicKey(params.proposal, "proposal");
  requirePublicKey(params.proposalOwnerRecord, "proposalOwnerRecord");
  requirePublicKey(params.tokenOwnerRecord, "tokenOwnerRecord");
  requirePublicKey(params.governanceAuthority, "governanceAuthority");
  requirePublicKey(params.payer, "payer");
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm, councilMint } = verifiedRealm;
  if (councilMint === null) {
    throw new ClientValidationError("COUNCIL_MINT_MISSING", [
      "verified Realm has no council mint; community vote is a different builder",
    ]);
  }
  const vote = Vote.fromYesNoVote(yesNoVoteFromChoice(params.choice));
  const instructions: TransactionInstruction[] = [];
  const voteRecord = await withCastVote(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    governance,
    params.proposal,
    params.proposalOwnerRecord,
    params.tokenOwnerRecord,
    params.governanceAuthority,
    councilMint,
    vote,
    params.payer,
    undefined,
    undefined,
  );
  const derived = await getVoteRecordAddress(
    verified.network.realmsProgramId,
    params.proposal,
    params.tokenOwnerRecord,
  );
  if (!voteRecord.equals(derived)) {
    throw new ClientValidationError("VOTE_RECORD_PDA", [
      `council cast returned ${voteRecord.toBase58()} but PDA is ${derived.toBase58()}`,
    ]);
  }
  return {
    instructions,
    derivedAddresses: { voteRecord, governance, councilMint },
  };
}

/**
 * 0.3.33 signature (verified from registry):
 * withRelinquishVote(ixs, programId, programVersion, realm, governance,
 * proposal, tokenOwnerRecord, governingTokenMint, voteRecord,
 * governanceAuthority?, beneficiary?)
 */
export async function buildRelinquishCommunityVote(
  params: RelinquishCommunityVoteParams,
): Promise<UnsignedInstructionBuild> {
  assertNoSecretMaterial(params, "buildRelinquishCommunityVote");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertLinearDefaultVoting(params, "buildRelinquishCommunityVote");
  assertNoCallerGovernanceOrMint(params, "buildRelinquishCommunityVote");
  requirePublicKey(params.proposal, "proposal");
  requirePublicKey(params.tokenOwnerRecord, "tokenOwnerRecord");
  requirePublicKey(params.voteRecord, "voteRecord");
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm, communityMint } = verifiedRealm;
  const derivedVoteRecord = await getVoteRecordAddress(
    verified.network.realmsProgramId,
    params.proposal,
    params.tokenOwnerRecord,
  );
  if (!params.voteRecord.equals(derivedVoteRecord)) {
    throw new ClientValidationError("VOTE_RECORD_PDA", [
      `voteRecord ${params.voteRecord.toBase58()} is not the PDA ${derivedVoteRecord.toBase58()}`,
    ]);
  }
  const governanceAuthority =
    params.governanceAuthority === undefined
      ? undefined
      : requirePublicKey(params.governanceAuthority, "governanceAuthority");
  const beneficiary =
    params.beneficiary === undefined ? undefined : requirePublicKey(params.beneficiary, "beneficiary");
  const instructions: TransactionInstruction[] = [];
  await withRelinquishVote(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    governance,
    params.proposal,
    params.tokenOwnerRecord,
    communityMint,
    params.voteRecord,
    governanceAuthority,
    beneficiary,
  );
  return {
    instructions,
    derivedAddresses: { voteRecord: params.voteRecord },
  };
}

function proposalStateLabel(state: number): string {
  return proposalStateName(state as ProposalState);
}

/**
 * Standing community votes for one wallet on the issued Governance's program.
 * Relinquish is per VoteRecord - withdrawing fails until every one is cleared
 * (`unrelinquished_votes_count == 0`), even after Finalize / Execute.
 */
export async function listStandingCommunityVotes(
  params: ListStandingCommunityVotesParams,
): Promise<readonly StandingCommunityVote[]> {
  assertNoSecretMaterial(params, "listStandingCommunityVotes");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertBoundConnection(params.verifiedGovernance.verifiedRealm.verified, params.connection);
  requirePublicKey(params.governingTokenOwner, "governingTokenOwner");
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm, communityMint } = verifiedRealm;
  const tokenOwnerRecord = await getTokenOwnerRecordAddress(
    verified.network.realmsProgramId,
    realm,
    communityMint,
    params.governingTokenOwner,
  );
  const govAccount = await getGovernance(params.connection, governance);
  const baseVotingTime = govAccount.account.config.baseVotingTime;
  const nowSecs = Math.floor(Date.now() / 1000);
  const records = await getVoteRecordsByVoter(
    params.connection,
    verified.network.realmsProgramId,
    params.governingTokenOwner,
  );
  const standing: StandingCommunityVote[] = [];
  for (const row of records) {
    if (row.account.isRelinquished) {
      continue;
    }
    const expected = await getVoteRecordAddress(
      verified.network.realmsProgramId,
      row.account.proposal,
      tokenOwnerRecord,
    );
    if (!row.pubkey.equals(expected)) {
      // Different TOR (e.g. council) - leave it alone.
      continue;
    }
    const proposal = await getProposal(params.connection, row.account.proposal);
    if (!proposal.account.governance.equals(governance)) {
      continue;
    }
    if (!proposal.account.governingTokenMint.equals(communityMint)) {
      continue;
    }
    const votingAt = proposal.account.votingAt ?? null;
    const maxVotingTime = proposal.account.maxVotingTime ?? null;
    const windowSecs =
      maxVotingTime != null && maxVotingTime > 0 ? maxVotingTime : baseVotingTime;
    const needsFinalizeBeforeRelinquish =
      proposal.account.state === ProposalState.Voting &&
      votingAt != null &&
      nowSecs >= votingAt.toNumber() + windowSecs;
    standing.push({
      proposal: row.account.proposal,
      voteRecord: row.pubkey,
      tokenOwnerRecord,
      proposalState: proposal.account.state,
      proposalStateName: proposalStateLabel(proposal.account.state),
      proposalName: proposal.account.name,
      needsFinalizeBeforeRelinquish,
    });
  }
  return standing;
}

/**
 * One RelinquishVote per standing community VoteRecord. Needed because Realms
 * tracks `unrelinquished_votes_count` across every proposal this TOR voted on -
 * finishing one proposal (or relinquishing one) does not free the deposit.
 */
export async function buildRelinquishStandingCommunityVotes(
  params: RelinquishStandingCommunityVotesParams,
): Promise<RelinquishStandingCommunityVotesBuild> {
  assertNoSecretMaterial(params, "buildRelinquishStandingCommunityVotes");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertLinearDefaultVoting(params, "buildRelinquishStandingCommunityVotes");
  assertNoCallerGovernanceOrMint(params, "buildRelinquishStandingCommunityVotes");
  assertBoundConnection(params.verifiedGovernance.verifiedRealm.verified, params.connection);
  requirePublicKey(params.governingTokenOwner, "governingTokenOwner");
  requirePublicKey(params.governanceAuthority, "governanceAuthority");
  requirePublicKey(params.beneficiary, "beneficiary");
  if (!params.governanceAuthority.equals(params.governingTokenOwner)) {
    throw new ClientValidationError("GOVERNANCE_AUTHORITY", [
      "governanceAuthority must be the governing token owner for standing RelinquishVote",
    ]);
  }
  const standing = await listStandingCommunityVotes({
    connection: params.connection,
    verifiedGovernance: params.verifiedGovernance,
    governingTokenOwner: params.governingTokenOwner,
  });
  if (standing.length === 0) {
    throw new ClientValidationError("NO_STANDING_VOTES", [
      "No standing community votes on this TokenOwnerRecord - withdraw is not blocked by RelinquishVote",
    ]);
  }
  const needsFinalize = standing.filter((row) => row.needsFinalizeBeforeRelinquish);
  if (needsFinalize.length > 0) {
    throw new ClientValidationError("FINALIZE_BEFORE_RELINQUISH", [
      `FinalizeVote first on ${String(needsFinalize.length)} proposal(s) still showing Voting after the window: ${needsFinalize
        .map((row) => row.proposalName || row.proposal.toBase58())
        .join("; ")}`,
    ]);
  }
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm, communityMint } = verifiedRealm;
  const instructions: TransactionInstruction[] = [];
  for (const row of standing) {
    const stillOpenVoting = row.proposalState === ProposalState.Voting;
    await withRelinquishVote(
      instructions,
      verified.network.realmsProgramId,
      verified.network.programVersion,
      realm,
      governance,
      row.proposal,
      row.tokenOwnerRecord,
      communityMint,
      row.voteRecord,
      stillOpenVoting ? params.governanceAuthority : undefined,
      stillOpenVoting ? params.beneficiary : undefined,
    );
  }
  return {
    instructions,
    derivedAddresses: {
      tokenOwnerRecord: standing[0]!.tokenOwnerRecord,
    },
    standingCount: standing.length,
    proposalNames: standing.map((row) => row.proposalName),
  };
}

/** Soft tx-size cap: Finalize + N RelinquishVote ixs in one legacy transaction. */
const DEFAULT_MAX_VOTE_RELEASES_PER_TX = 8;

/**
 * Every non-relinquished VoteRecord on one proposal (all voters). Used to
 * unlock deposits when a proposal ends - Realms never clears these itself.
 */
export async function listUnrelinquishedVotesOnProposal(
  params: ListUnrelinquishedVotesOnProposalParams,
): Promise<readonly UnrelinquishedVoteOnProposal[]> {
  assertNoSecretMaterial(params, "listUnrelinquishedVotesOnProposal");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertBoundConnection(params.verifiedGovernance.verifiedRealm.verified, params.connection);
  requirePublicKey(params.proposal, "proposal");
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm, communityMint } = verifiedRealm;
  const proposal = await getProposal(params.connection, params.proposal);
  if (!proposal.account.governance.equals(governance)) {
    throw new ClientValidationError("PROPOSAL_GOVERNANCE", [
      `proposal governance ${proposal.account.governance.toBase58()} is not the issued Governance ${governance.toBase58()}`,
    ]);
  }
  if (!proposal.account.governingTokenMint.equals(communityMint)) {
    throw new ClientValidationError("PROPOSAL_MINT", [
      "listUnrelinquishedVotesOnProposal only covers community-mint proposals",
    ]);
  }
  const proposalFilter = pubkeyFilter(1, params.proposal);
  if (proposalFilter === undefined) {
    throw new ClientValidationError("PROPOSAL_FILTER", [
      "pubkeyFilter(1, proposal) returned undefined",
    ]);
  }
  const rows = await getGovernanceAccounts(
    params.connection,
    verified.network.realmsProgramId,
    VoteRecord,
    [proposalFilter],
  );
  const standing: UnrelinquishedVoteOnProposal[] = [];
  for (const row of rows) {
    if (row.account.isRelinquished) {
      continue;
    }
    if (!row.account.proposal.equals(params.proposal)) {
      continue;
    }
    const tokenOwnerRecord = await getTokenOwnerRecordAddress(
      verified.network.realmsProgramId,
      realm,
      communityMint,
      row.account.governingTokenOwner,
    );
    const expected = await getVoteRecordAddress(
      verified.network.realmsProgramId,
      params.proposal,
      tokenOwnerRecord,
    );
    if (!row.pubkey.equals(expected)) {
      continue;
    }
    standing.push({
      voteRecord: row.pubkey,
      tokenOwnerRecord,
      governingTokenOwner: row.account.governingTokenOwner,
    });
  }
  return standing;
}

async function appendPermissionlessRelinquishOnProposal(
  instructions: TransactionInstruction[],
  params: {
    readonly verifiedGovernance: VerifiedGovernanceIdentity;
    readonly proposal: PublicKey;
    readonly records: readonly UnrelinquishedVoteOnProposal[];
  },
): Promise<void> {
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm, communityMint } = verifiedRealm;
  for (const row of params.records) {
    await withRelinquishVote(
      instructions,
      verified.network.realmsProgramId,
      verified.network.programVersion,
      realm,
      governance,
      params.proposal,
      row.tokenOwnerRecord,
      communityMint,
      row.voteRecord,
      undefined,
      undefined,
    );
  }
}

/**
 * Permissionless RelinquishVote for standing VoteRecords on a closed proposal.
 * Anyone may send this after Finalize / tip - unlocks every voter's deposit lock
 * for this proposal without each holder knowing Realms semantics.
 */
export async function buildReleaseVotesOnClosedProposal(
  params: ReleaseVotesOnClosedProposalParams,
): Promise<ReleaseVotesOnClosedProposalBuild> {
  assertNoSecretMaterial(params, "buildReleaseVotesOnClosedProposal");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertLinearDefaultVoting(params, "buildReleaseVotesOnClosedProposal");
  assertNoCallerGovernanceOrMint(params, "buildReleaseVotesOnClosedProposal");
  assertBoundConnection(params.verifiedGovernance.verifiedRealm.verified, params.connection);
  requirePublicKey(params.proposal, "proposal");
  const maxReleases =
    params.maxReleases === undefined ? DEFAULT_MAX_VOTE_RELEASES_PER_TX : params.maxReleases;
  if (!Number.isInteger(maxReleases) || maxReleases < 1) {
    throw new ClientValidationError("MAX_RELEASES", ["maxReleases must be a positive integer"]);
  }
  const proposal = await getProposal(params.connection, params.proposal);
  const { governance } = params.verifiedGovernance;
  if (!proposal.account.governance.equals(governance)) {
    throw new ClientValidationError("PROPOSAL_GOVERNANCE", [
      `proposal governance ${proposal.account.governance.toBase58()} is not the issued Governance ${governance.toBase58()}`,
    ]);
  }
  if (proposal.account.state === ProposalState.Voting) {
    const govAccount = await getGovernance(params.connection, governance);
    const votingAt = proposal.account.votingAt;
    const maxVotingTime = proposal.account.maxVotingTime;
    const windowSecs =
      maxVotingTime != null && maxVotingTime > 0
        ? maxVotingTime
        : govAccount.account.config.baseVotingTime;
    const nowSecs = Math.floor(Date.now() / 1000);
    const pastWindow = votingAt != null && nowSecs >= votingAt.toNumber() + windowSecs;
    throw new ClientValidationError(
      pastWindow ? "FINALIZE_BEFORE_RELEASE" : "PROPOSAL_STILL_VOTING",
      pastWindow
        ? [
            "Voting time has ended but the proposal is still Voting on chain. FinalizeVote first - Relinquish is refused in that state. Finalize in this UI also releases voter deposits.",
          ]
        : [
            "Proposal is still open for voting; deposits stay locked until it ends and votes are released.",
          ],
    );
  }
  const all = await listUnrelinquishedVotesOnProposal({
    connection: params.connection,
    verifiedGovernance: params.verifiedGovernance,
    proposal: params.proposal,
  });
  if (all.length === 0) {
    throw new ClientValidationError("NO_STANDING_VOTES_ON_PROPOSAL", [
      "No standing VoteRecords on this proposal - deposits for this vote are already free",
    ]);
  }
  const batch = all.slice(0, maxReleases);
  const instructions: TransactionInstruction[] = [];
  await appendPermissionlessRelinquishOnProposal(instructions, {
    verifiedGovernance: params.verifiedGovernance,
    proposal: params.proposal,
    records: batch,
  });
  return {
    instructions,
    derivedAddresses: { proposal: params.proposal },
    releasedCount: batch.length,
    remainingCount: all.length - batch.length,
    proposalState: proposal.account.state,
    proposalStateName: proposalStateLabel(proposal.account.state),
  };
}

/**
 * 0.3.33 signature (verified from published .d.ts):
 * withRelinquishVote(ixs, programId, programVersion, realm, governance,
 * proposal, tokenOwnerRecord, governingTokenMint, voteRecord,
 * governanceAuthority?, beneficiary?)
 * Council mint only - do not substitute community RelinquishVote.
 */
export async function buildRelinquishCouncilVote(
  params: RelinquishCouncilVoteParams,
): Promise<UnsignedInstructionBuild> {
  assertNoSecretMaterial(params, "buildRelinquishCouncilVote");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertLinearDefaultVoting(params, "buildRelinquishCouncilVote");
  assertNoCallerGovernanceOrMint(params, "buildRelinquishCouncilVote");
  requirePublicKey(params.proposal, "proposal");
  requirePublicKey(params.tokenOwnerRecord, "tokenOwnerRecord");
  requirePublicKey(params.voteRecord, "voteRecord");
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm, councilMint } = verifiedRealm;
  if (councilMint === null) {
    throw new ClientValidationError("COUNCIL_MINT_MISSING", [
      "verified Realm has no council mint; community RelinquishVote is a different builder",
    ]);
  }
  const derivedVoteRecord = await getVoteRecordAddress(
    verified.network.realmsProgramId,
    params.proposal,
    params.tokenOwnerRecord,
  );
  if (!params.voteRecord.equals(derivedVoteRecord)) {
    throw new ClientValidationError("VOTE_RECORD_PDA", [
      `voteRecord ${params.voteRecord.toBase58()} is not the PDA ${derivedVoteRecord.toBase58()}`,
    ]);
  }
  const governanceAuthority =
    params.governanceAuthority === undefined
      ? undefined
      : requirePublicKey(params.governanceAuthority, "governanceAuthority");
  const beneficiary =
    params.beneficiary === undefined ? undefined : requirePublicKey(params.beneficiary, "beneficiary");
  const instructions: TransactionInstruction[] = [];
  await withRelinquishVote(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    governance,
    params.proposal,
    params.tokenOwnerRecord,
    councilMint,
    params.voteRecord,
    governanceAuthority,
    beneficiary,
  );
  return {
    instructions,
    derivedAddresses: { voteRecord: params.voteRecord, councilMint },
  };
}

/**
 * 0.3.33 signature (verified from published .d.ts):
 * withFinalizeVote(ixs, programId, programVersion, realm, governance,
 * proposal, proposalOwnerRecord, governingTokenMint, maxVoterWeightRecord?)
 * Plugins are refused. v3 keys: realm, governance, proposal,
 * proposalOwnerRecord, governingTokenMint, RealmConfig.
 */
export async function buildFinalizeVote(
  params: FinalizeVoteParams,
): Promise<FinalizeVoteBuild> {
  assertIdentityBoundLifecycle(params, params.verifiedGovernance, "buildFinalizeVote");
  requirePublicKey(params.proposal, "proposal");
  requirePublicKey(params.proposalOwnerRecord, "proposalOwnerRecord");
  const governingTokenMint = requirePublicKey(params.governingTokenMint, "governingTokenMint");
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm, communityMint, councilMint } = verifiedRealm;
  if (verified.network.programVersion !== REALMS_PROGRAM_VERSION) {
    throw new ClientValidationError("PROGRAM_VERSION", [
      "buildFinalizeVote requires programVersion=3",
    ]);
  }
  const isCommunity = governingTokenMint.equals(communityMint);
  const isCouncil = councilMint !== null && governingTokenMint.equals(councilMint);
  if (!isCommunity && !isCouncil) {
    throw new ClientValidationError("GOVERNING_MINT_UNKNOWN", [
      "governingTokenMint must be the issued community mint or council mint",
    ]);
  }
  const instructions: TransactionInstruction[] = [];
  await withFinalizeVote(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    governance,
    params.proposal,
    params.proposalOwnerRecord,
    governingTokenMint,
    undefined,
  );
  if (instructions.length !== 1) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `finalizeVote helper produced ${String(instructions.length)} instructions; expected 1`,
    ]);
  }
  const ix = instructions[0]!;
  if (!ix.programId.equals(verified.network.realmsProgramId)) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `finalizeVote programId ${ix.programId.toBase58()} is not ${verified.network.realmsProgramId.toBase58()}`,
    ]);
  }
  if (ix.keys.length !== 6) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `finalizeVote helper produced ${String(ix.keys.length)} keys; expected 6 for v3 without plugins`,
    ]);
  }
  const realmConfig = await getRealmConfigAddress(verified.network.realmsProgramId, realm);
  requireInstructionKey(ix.keys, 0, realm, "finalizeVote");
  requireInstructionKey(ix.keys, 1, governance, "finalizeVote");
  requireInstructionKey(ix.keys, 2, params.proposal, "finalizeVote");
  requireInstructionKey(ix.keys, 3, params.proposalOwnerRecord, "finalizeVote");
  requireInstructionKey(ix.keys, 4, governingTokenMint, "finalizeVote");
  requireInstructionKey(ix.keys, 5, realmConfig, "finalizeVote");
  if (ix.keys[0]!.isWritable !== true || ix.keys[0]!.isSigner !== false) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "finalizeVote key[0] realm must be writable non-signer",
    ]);
  }
  if (ix.keys[1]!.isWritable !== true || ix.keys[1]!.isSigner !== false) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "finalizeVote key[1] Governance must be writable non-signer",
    ]);
  }

  let releasedVoteCount = 0;
  let remainingUnreleasedCount = 0;
  const wantRelease =
    params.connection !== undefined && params.releaseVoterDeposits !== false;
  if (wantRelease) {
    assertBoundConnection(verified, params.connection);
    if (!isCommunity) {
      throw new ClientValidationError("RELEASE_COMMUNITY_ONLY", [
        "releaseVoterDeposits on Finalize is implemented for community-mint proposals only",
      ]);
    }
    const maxReleases =
      params.maxReleases === undefined ? DEFAULT_MAX_VOTE_RELEASES_PER_TX : params.maxReleases;
    if (!Number.isInteger(maxReleases) || maxReleases < 1) {
      throw new ClientValidationError("MAX_RELEASES", ["maxReleases must be a positive integer"]);
    }
    const all = await listUnrelinquishedVotesOnProposal({
      connection: params.connection,
      verifiedGovernance: params.verifiedGovernance,
      proposal: params.proposal,
    });
    const batch = all.slice(0, maxReleases);
    await appendPermissionlessRelinquishOnProposal(instructions, {
      verifiedGovernance: params.verifiedGovernance,
      proposal: params.proposal,
      records: batch,
    });
    releasedVoteCount = batch.length;
    remainingUnreleasedCount = all.length - batch.length;
  }

  return {
    instructions,
    derivedAddresses: { realmConfig, governingTokenMint, governance },
    releasedVoteCount,
    remainingUnreleasedCount,
  };
}

/**
 * 0.3.33 signature (verified from published .d.ts):
 * withSetRealmConfig(ixs, programId, programVersion, realm, realmAuthority,
 * councilMint, communityMintMaxVoteWeightSource,
 * minCommunityWeightToCreateGovernance, communityTokenConfig,
 * councilTokenConfig, payer)
 * Passes council mint B (Some). Refuses undefined/null (Some → None).
 */
export async function buildSetRealmConfigCouncilMint(
  params: SetRealmConfigCouncilMintParams,
): Promise<UnsignedInstructionBuild> {
  assertIdentityBoundLifecycle(
    params,
    params.verifiedGovernance,
    "buildSetRealmConfigCouncilMint",
    ["ichorMint", "governingTokenMint", "councilMint"],
  );
  const identity = params.verifiedGovernance;
  if (
    !(identity instanceof IssuedVerifiedGovernanceIdentity) ||
    !identity.boundTo(params.connection, identity.verifiedRealm)
  ) {
    throw new ClientValidationError("CONNECTION_MISMATCH", [
      "connection is not the exact Connection instance bound to the issued VerifiedGovernanceIdentity",
    ]);
  }
  const newCouncilMint = requirePublicKey(params.newCouncilMint, "newCouncilMint");
  const payer = requirePublicKey(params.payer, "payer");
  const { verifiedRealm, governance } = identity;
  const { verified, realm, councilMint, communityMint } = verifiedRealm;
  if (verified.network.programVersion !== REALMS_PROGRAM_VERSION) {
    throw new ClientValidationError("PROGRAM_VERSION", [
      "buildSetRealmConfigCouncilMint requires programVersion=3",
    ]);
  }
  if (councilMint === null) {
    throw new ClientValidationError("COUNCIL_MINT_MISSING", [
      "verified Realm has no council mint A; Some(A) → Some(B) requires a live council",
    ]);
  }
  if (newCouncilMint.equals(PublicKey.default)) {
    throw new ClientValidationError("DEFAULT_PUBKEY", [
      "newCouncilMint must not be the default/System Program address",
    ]);
  }
  if (newCouncilMint.equals(councilMint)) {
    throw new ClientValidationError("COUNCIL_MINT_UNCHANGED", [
      "newCouncilMint equals live council mint A; Some(A) → Some(A) is not the Q4 probe",
    ]);
  }
  if (newCouncilMint.equals(communityMint)) {
    throw new ClientValidationError("COUNCIL_IS_COMMUNITY", [
      "newCouncilMint cannot be the community mint",
    ]);
  }
  const parsed = await getRealm(params.connection, realm);
  if (!parsed.pubkey.equals(realm) || !parsed.account.communityMint.equals(communityMint)) {
    throw new ClientValidationError("REALM_IDENTITY", [
      "live Realm identity changed after verification",
    ]);
  }
  if (parsed.account.authority === undefined || !parsed.account.authority.equals(governance)) {
    throw new ClientValidationError("REALM_AUTHORITY", [
      "Governance must be the live Realm authority before SetRealmConfig Some(B)",
    ]);
  }
  if (
    parsed.account.config.councilMint === undefined ||
    !parsed.account.config.councilMint.equals(councilMint)
  ) {
    throw new ClientValidationError("COUNCIL_MINT_MISMATCH", [
      "live Realm council mint A changed after verification",
    ]);
  }
  const newSnapshot = await fetchMintSnapshot(
    params.connection,
    verified.network,
    newCouncilMint,
  );
  assertLegacySplMint(newSnapshot, "new council mint");
  const newHolding = await getTokenHoldingAddress(
    verified.network.realmsProgramId,
    realm,
    newCouncilMint,
  );
  const instructions: TransactionInstruction[] = [];
  await withSetRealmConfig(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    governance,
    newCouncilMint,
    parsed.account.config.communityMintMaxVoteWeightSource,
    parsed.account.config.minCommunityTokensToCreateGovernance,
    linearDepositedTokenConfig(),
    linearDepositedTokenConfig(),
    payer,
  );
  if (instructions.length !== 1) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `setRealmConfig Some(B) helper produced ${String(instructions.length)} instructions; expected 1`,
    ]);
  }
  const ix = instructions[0]!;
  if (!ix.programId.equals(verified.network.realmsProgramId)) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `setRealmConfig programId ${ix.programId.toBase58()} is not ${verified.network.realmsProgramId.toBase58()}`,
    ]);
  }
  if (ix.keys.length !== 7) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `setRealmConfig Some(B) produced ${String(ix.keys.length)} keys; expected 7 for v3 with payer and no plugins`,
    ]);
  }
  const realmConfig = await getRealmConfigAddress(verified.network.realmsProgramId, realm);
  requireInstructionKey(ix.keys, 0, realm, "setRealmConfig Some(B)");
  requireInstructionKey(ix.keys, 1, governance, "setRealmConfig Some(B)");
  requireInstructionKey(ix.keys, 2, newCouncilMint, "setRealmConfig Some(B)");
  requireInstructionKey(ix.keys, 3, newHolding, "setRealmConfig Some(B)");
  requireInstructionKey(ix.keys, 4, SystemProgram.programId, "setRealmConfig Some(B)");
  requireInstructionKey(ix.keys, 5, realmConfig, "setRealmConfig Some(B)");
  requireInstructionKey(ix.keys, 6, payer, "setRealmConfig Some(B)");
  if (ix.keys[1]!.isWritable !== false || ix.keys[1]!.isSigner !== true) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "setRealmConfig key[1] Governance must be a readonly signer",
    ]);
  }
  if (ix.keys[6]!.isWritable !== true || ix.keys[6]!.isSigner !== true) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "setRealmConfig key[6] payer must be a writable signer",
    ]);
  }
  return {
    instructions,
    derivedAddresses: {
      realm,
      governance,
      previousCouncilMint: councilMint,
      newCouncilMint,
      newCouncilHolding: newHolding,
      realmConfig,
    },
  };
}

const EXTRA_REALM_SIGNER_FIELDS = [
  "keypairPath",
  "keypairFile",
  "secretKeyFile",
  "signerKeypair",
] as const;

function assertNoExtraRealmSigner(params: object, label: string): void {
  assertNoSecretMaterial(params, label);
  const hits = EXTRA_REALM_SIGNER_FIELDS.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError("EXTRA_SIGNER_REFUSED", [
      `${label} refuses extra signer/keypair fields: ${hits.join(", ")}`,
    ]);
  }
}

function liveTokenConfigArgs(config: {
  voterWeightAddin?: PublicKey;
  maxVoterWeightAddin?: PublicKey;
  tokenType: (typeof GoverningTokenType)[keyof typeof GoverningTokenType];
}): GoverningTokenConfigAccountArgs {
  return new GoverningTokenConfigAccountArgs({
    voterWeightAddin: config.voterWeightAddin,
    maxVoterWeightAddin: config.maxVoterWeightAddin,
    tokenType: config.tokenType,
  });
}

function sdkVoteWeightSource(source: CommunityMintMaxVoteWeightSource): MintMaxVoteWeightSource {
  return new MintMaxVoteWeightSource({
    type:
      source.type === "absolute"
        ? MintMaxVoteWeightSourceType.Absolute
        : MintMaxVoteWeightSourceType.SupplyFraction,
    value: source.value,
  });
}

function observedVoteWeightSource(live: MintMaxVoteWeightSource): CommunityMintMaxVoteWeightSource {
  return {
    type: live.type === MintMaxVoteWeightSourceType.Absolute ? "absolute" : "supply-fraction",
    value: live.value,
  };
}

export function emergencyBrakeVoteWeightSource(): CommunityMintMaxVoteWeightSource {
  return { type: "absolute", value: U64_MAX };
}

export function assertRealmConfigFieldsPreserved(params: {
  before: Omit<LiveRealmConfigSnapshot, "communityMintMaxVoteWeightSource">;
  after: Omit<LiveRealmConfigSnapshot, "communityMintMaxVoteWeightSource">;
}): void {
  const errors: string[] = [];
  if (!params.before.realm.equals(params.after.realm)) {
    errors.push("realm changed");
  }
  if (!params.before.realmAuthority.equals(params.after.realmAuthority)) {
    errors.push("realmAuthority changed");
  }
  if (!params.before.communityMint.equals(params.after.communityMint)) {
    errors.push("communityMint changed");
  }
  const beforeCouncil = params.before.councilMint;
  const afterCouncil = params.after.councilMint;
  if ((beforeCouncil === null) !== (afterCouncil === null)) {
    errors.push("councilMint presence changed");
  } else if (beforeCouncil !== null && afterCouncil !== null && !beforeCouncil.equals(afterCouncil)) {
    errors.push("councilMint changed");
  }
  if (
    !params.before.minCommunityTokensToCreateGovernance.eq(
      params.after.minCommunityTokensToCreateGovernance,
    )
  ) {
    errors.push("minCommunityTokensToCreateGovernance changed");
  }
  for (const side of ["communityTokenConfig", "councilTokenConfig"] as const) {
    const a = params.before[side];
    const b = params.after[side];
    if (a.tokenType !== b.tokenType) {
      errors.push(`${side}.tokenType changed`);
    }
    const addin = (left?: PublicKey, right?: PublicKey): boolean =>
      (left === undefined && right === undefined) ||
      (left !== undefined && right !== undefined && left.equals(right));
    if (!addin(a.voterWeightAddin, b.voterWeightAddin)) {
      errors.push(`${side}.voterWeightAddin changed`);
    }
    if (!addin(a.maxVoterWeightAddin, b.maxVoterWeightAddin)) {
      errors.push(`${side}.maxVoterWeightAddin changed`);
    }
  }
  if (errors.length > 0) {
    throw new ClientValidationError("REALM_CONFIG_PRESERVE", errors);
  }
}

/**
 * Unsigned SetRealmConfig that changes only communityMintMaxVoteWeightSource.
 * Realm authority is the signer (recovery-window creator wallet), not Governance.
 * Does not go through verifyRealmDeployment — mainnet verifier rejects brake state.
 */
export async function composeSetRealmConfigVoteWeightOnly(params: {
  realmsProgramId: PublicKey;
  programVersion: 3;
  realm: PublicKey;
  realmAuthority: PublicKey;
  councilMint: PublicKey | undefined;
  source: CommunityMintMaxVoteWeightSource;
  minCommunityTokensToCreateGovernance: BN;
  communityTokenConfig: GoverningTokenConfigAccountArgs;
  councilTokenConfig: GoverningTokenConfigAccountArgs;
  payer: PublicKey;
}): Promise<UnsignedInstructionBuild> {
  if (params.programVersion !== REALMS_PROGRAM_VERSION) {
    throw new ClientValidationError("PROGRAM_VERSION", [
      "composeSetRealmConfigVoteWeightOnly requires programVersion=3",
    ]);
  }
  if (!params.payer.equals(params.realmAuthority)) {
    throw new ClientValidationError("EXTRA_SIGNER_REFUSED", [
      "SetRealmConfig brake/restore payer must be the Realm authority (sole signer)",
    ]);
  }
  const reachable = requireReachableMintMaxVoteWeightSource(
    params.source,
    MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value,
  );
  const instructions: TransactionInstruction[] = [];
  await withSetRealmConfig(
    instructions,
    params.realmsProgramId,
    params.programVersion,
    params.realm,
    params.realmAuthority,
    params.councilMint,
    sdkVoteWeightSource(reachable),
    params.minCommunityTokensToCreateGovernance,
    params.communityTokenConfig,
    params.councilTokenConfig,
    params.payer,
  );
  if (instructions.length !== 1) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `setRealmConfig vote-weight helper produced ${String(instructions.length)} instructions; expected 1`,
    ]);
  }
  const ix = instructions[0]!;
  if (!ix.programId.equals(params.realmsProgramId)) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `setRealmConfig programId ${ix.programId.toBase58()} is not ${params.realmsProgramId.toBase58()}`,
    ]);
  }
  const realmConfig = await getRealmConfigAddress(params.realmsProgramId, params.realm);
  requireInstructionKey(ix.keys, 0, params.realm, "setRealmConfig vote-weight");
  requireInstructionKey(ix.keys, 1, params.realmAuthority, "setRealmConfig vote-weight");
  if (ix.keys[1]!.isWritable !== false || ix.keys[1]!.isSigner !== true) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      "setRealmConfig key[1] Realm authority must be a readonly signer",
    ]);
  }
  if (params.councilMint !== undefined) {
    if (ix.keys.length !== 7) {
      throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
        `setRealmConfig with council produced ${String(ix.keys.length)} keys; expected 7`,
      ]);
    }
    requireInstructionKey(ix.keys, 2, params.councilMint, "setRealmConfig vote-weight");
    requireInstructionKey(ix.keys, 4, SystemProgram.programId, "setRealmConfig vote-weight");
    requireInstructionKey(ix.keys, 5, realmConfig, "setRealmConfig vote-weight");
    requireInstructionKey(ix.keys, 6, params.payer, "setRealmConfig vote-weight");
    if (ix.keys[6]!.isWritable !== true || ix.keys[6]!.isSigner !== true) {
      throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
        "setRealmConfig key[6] payer must be a writable signer",
      ]);
    }
  } else if (ix.keys.length !== 5) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `setRealmConfig without council produced ${String(ix.keys.length)} keys; expected 5`,
    ]);
  }
  return {
    instructions,
    derivedAddresses: { realm: params.realm, realmConfig, realmAuthority: params.realmAuthority },
  };
}

async function readLiveRealmConfigSnapshot(
  connection: Connection,
  verified: VerifiedNetwork,
  realm: PublicKey,
): Promise<LiveRealmConfigSnapshot> {
  assertVerifiedNetwork(verified);
  assertBoundConnection(verified, connection);
  requirePublicKey(realm, "realm");
  const parsed = await getRealm(connection, realm);
  if (!parsed.pubkey.equals(realm)) {
    throw new ClientValidationError("REALM_IDENTITY", ["getRealm returned a different pubkey"]);
  }
  if (parsed.account.authority === undefined) {
    throw new ClientValidationError("REALM_AUTHORITY", [
      "live Realm has no authority; SetRealmConfig brake/restore cannot proceed",
    ]);
  }
  const realmConfig = await tryGetRealmConfig(connection, verified.network.realmsProgramId, realm);
  if (realmConfig === undefined) {
    throw new ClientValidationError("REALM_CONFIG_MISSING", [
      "RealmConfig is required to preserve live token-type fields",
    ]);
  }
  const councilMint = parsed.account.config.councilMint ?? null;
  return {
    realm,
    realmAuthority: parsed.account.authority,
    communityMint: parsed.account.communityMint,
    councilMint,
    communityMintMaxVoteWeightSource: observedVoteWeightSource(
      parsed.account.config.communityMintMaxVoteWeightSource,
    ),
    minCommunityTokensToCreateGovernance: parsed.account.config.minCommunityTokensToCreateGovernance,
    communityTokenConfig: {
      voterWeightAddin: realmConfig.account.communityTokenConfig.voterWeightAddin,
      maxVoterWeightAddin: realmConfig.account.communityTokenConfig.maxVoterWeightAddin,
      tokenType: realmConfig.account.communityTokenConfig.tokenType,
    },
    councilTokenConfig: {
      voterWeightAddin: realmConfig.account.councilTokenConfig.voterWeightAddin,
      maxVoterWeightAddin: realmConfig.account.councilTokenConfig.maxVoterWeightAddin,
      tokenType: realmConfig.account.councilTokenConfig.tokenType,
    },
  };
}

async function buildSetRealmConfigVoteWeightFromLive(params: {
  connection: Connection;
  verified: VerifiedNetwork;
  realm: PublicKey;
  realmAuthority: PublicKey;
  nextSource: CommunityMintMaxVoteWeightSource;
  label: string;
}): Promise<UnsignedInstructionBuild> {
  assertNoExtraRealmSigner(params, params.label);
  if (params.verified.network.programVersion !== REALMS_PROGRAM_VERSION) {
    throw new ClientValidationError("PROGRAM_VERSION", [
      `${params.label} requires programVersion=3`,
    ]);
  }
  const live = await readLiveRealmConfigSnapshot(params.connection, params.verified, params.realm);
  const authority = requirePublicKey(params.realmAuthority, "realmAuthority");
  if (!live.realmAuthority.equals(authority)) {
    throw new ClientValidationError("REALM_AUTHORITY", [
      `live Realm authority ${live.realmAuthority.toBase58()} is not realmAuthority ${authority.toBase58()}`,
    ]);
  }
  return composeSetRealmConfigVoteWeightOnly({
    realmsProgramId: params.verified.network.realmsProgramId,
    programVersion: params.verified.network.programVersion,
    realm: live.realm,
    realmAuthority: authority,
    councilMint: live.councilMint ?? undefined,
    source: params.nextSource,
    minCommunityTokensToCreateGovernance: live.minCommunityTokensToCreateGovernance,
    communityTokenConfig: liveTokenConfigArgs({
      ...(live.communityTokenConfig.voterWeightAddin === undefined
        ? {}
        : { voterWeightAddin: live.communityTokenConfig.voterWeightAddin }),
      ...(live.communityTokenConfig.maxVoterWeightAddin === undefined
        ? {}
        : { maxVoterWeightAddin: live.communityTokenConfig.maxVoterWeightAddin }),
      tokenType: live.communityTokenConfig.tokenType,
    }),
    councilTokenConfig: liveTokenConfigArgs({
      ...(live.councilTokenConfig.voterWeightAddin === undefined
        ? {}
        : { voterWeightAddin: live.councilTokenConfig.voterWeightAddin }),
      ...(live.councilTokenConfig.maxVoterWeightAddin === undefined
        ? {}
        : { maxVoterWeightAddin: live.councilTokenConfig.maxVoterWeightAddin }),
      tokenType: live.councilTokenConfig.tokenType,
    }),
    payer: authority,
  });
}

/**
 * Emergency brake: set communityMintMaxVoteWeightSource to Absolute(u64::MAX)
 * while preserving every other live Realm/RealmConfig field. Realm authority
 * signs. No send path. Mainnet `verifyRealmDeployment` rejects the resulting state.
 */
export async function buildSetRealmConfigEmergencyBrake(
  params: BuildSetRealmConfigEmergencyBrakeParams,
): Promise<UnsignedInstructionBuild> {
  return buildSetRealmConfigVoteWeightFromLive({
    connection: params.connection,
    verified: params.verified,
    realm: params.realm,
    realmAuthority: params.realmAuthority,
    nextSource: emergencyBrakeVoteWeightSource(),
    label: "buildSetRealmConfigEmergencyBrake",
  });
}

/**
 * Restore the exact prior communityMintMaxVoteWeightSource snapshot while
 * preserving every other live Realm/RealmConfig field. On mainnet the restore
 * target is checked against the SupplyFraction pin. No send path.
 */
export async function buildRestoreRealmConfigVoteWeightSource(
  params: BuildRestoreRealmConfigVoteWeightSourceParams,
): Promise<UnsignedInstructionBuild> {
  const prior = requireReachableMintMaxVoteWeightSource(
    params.priorSource,
    MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value,
  );
  requireU64Bn(prior.value, "priorSource.value");
  assertMainnetVoteWeightSource({
    cluster: params.verified.network.cluster,
    source: prior,
    fullSupplyFractionValue: MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value,
  });
  return buildSetRealmConfigVoteWeightFromLive({
    connection: params.connection,
    verified: params.verified,
    realm: params.realm,
    realmAuthority: params.realmAuthority,
    nextSource: prior,
    label: "buildRestoreRealmConfigVoteWeightSource",
  });
}

/**
 * Realms community mint holding PDA. This is deposited voting ICHOR, not the
 * native treasury. Not an ATA of the Realm.
 */
export async function communityGoverningTokenHoldingAddress(
  verifiedRealm: VerifiedRealm,
): Promise<PublicKey> {
  assertVerifiedRealm(verifiedRealm);
  return getTokenHoldingAddress(
    verifiedRealm.verified.network.realmsProgramId,
    verifiedRealm.realm,
    verifiedRealm.communityMint,
  );
}

/**
 * Live community TokenOwnerRecord deposit. A missing account is a measured
 * zero, not an unread value: the wallet has not deposited yet.
 */
export async function readCommunityGoverningTokenDeposit(
  params: ReadCommunityGoverningTokenDepositParams,
): Promise<CommunityGoverningTokenDeposit> {
  assertNoSecretMaterial(params, "readCommunityGoverningTokenDeposit");
  assertVerifiedRealm(params.verifiedRealm);
  assertBoundConnection(params.verifiedRealm.verified, params.connection);
  requirePublicKey(params.governingTokenOwner, "governingTokenOwner");
  const { verified, realm, communityMint } = params.verifiedRealm;
  const tokenOwnerRecord = await getTokenOwnerRecordAddress(
    verified.network.realmsProgramId,
    realm,
    communityMint,
    params.governingTokenOwner,
  );
  const info = await params.connection.getAccountInfo(tokenOwnerRecord, "confirmed");
  if (info === null) {
    return {
      tokenOwnerRecord,
      present: false,
      amount: new BN(0),
      unrelinquishedVotesCount: 0,
    };
  }
  const record = await getTokenOwnerRecord(params.connection, tokenOwnerRecord);
  if (!record.account.realm.equals(realm)) {
    throw new ClientValidationError("TOKEN_OWNER_RECORD_REALM", [
      `TokenOwnerRecord realm ${record.account.realm.toBase58()} !== ${realm.toBase58()}`,
    ]);
  }
  if (!record.account.governingTokenMint.equals(communityMint)) {
    throw new ClientValidationError("TOKEN_OWNER_RECORD_MINT", [
      `TokenOwnerRecord mint ${record.account.governingTokenMint.toBase58()} !== ICHOR ${communityMint.toBase58()}`,
    ]);
  }
  if (!record.account.governingTokenOwner.equals(params.governingTokenOwner)) {
    throw new ClientValidationError("TOKEN_OWNER_RECORD_OWNER", [
      `TokenOwnerRecord owner ${record.account.governingTokenOwner.toBase58()} !== ${params.governingTokenOwner.toBase58()}`,
    ]);
  }
  return {
    tokenOwnerRecord,
    present: true,
    amount: record.account.governingTokenDepositAmount,
    unrelinquishedVotesCount: record.account.unrelinquishedVotesCount,
  };
}

function proposalStateName(state: ProposalState): string {
  const named = ProposalState[state];
  if (typeof named === "string" && named.length > 0) {
    return named;
  }
  return String(state);
}

/**
 * List community proposals for the issued Governance only.
 *
 * Uses `getProposalsByGovernance` (SDK filters by governance pubkey). Every
 * row is re-checked against the issued community mint. This is the holder
 * board - not harvest discovery and not an unbounded Realms scan.
 */
export async function listCommunityProposals(
  params: ListCommunityProposalsParams,
): Promise<readonly CommunityProposalListItem[]> {
  assertNoSecretMaterial(params, "listCommunityProposals");
  assertVerifiedGovernance(params.verifiedGovernance);
  assertBoundConnection(params.verifiedGovernance.verifiedRealm.verified, params.connection);
  const { verifiedRealm, governance, communityMint } = params.verifiedGovernance;
  const verified = verifiedRealm.verified;
  const rows = await getProposalsByGovernance(
    params.connection,
    verified.network.realmsProgramId,
    governance,
  );
  const items: CommunityProposalListItem[] = [];
  for (const row of rows) {
    const account = row.account;
    if (!account.governance.equals(governance)) {
      continue;
    }
    if (!account.governingTokenMint.equals(communityMint)) {
      continue;
    }
    const approve = account.options[0];
    items.push({
      proposal: row.pubkey,
      name: account.name,
      descriptionLink: account.descriptionLink,
      state: account.state,
      stateName: proposalStateName(account.state),
      tokenOwnerRecord: account.tokenOwnerRecord,
      yesVotesCount: account.getYesVoteCount(),
      noVotesCount: account.getNoVoteCount(),
      approveInstructionsCount: approve?.instructionsCount ?? 0,
      draftAt: account.draftAt,
      votingAt: account.votingAt ?? null,
    });
  }
  items.sort((a, b) => {
    const rank = (state: number): number => {
      if (state === ProposalState.Voting) return 0;
      if (state === ProposalState.SigningOff) return 1;
      if (state === ProposalState.Draft) return 2;
      if (state === ProposalState.Succeeded || state === ProposalState.Executing) return 3;
      return 4;
    };
    const byState = rank(a.state) - rank(b.state);
    if (byState !== 0) return byState;
    const aTime = a.votingAt?.toNumber() ?? a.draftAt.toNumber();
    const bTime = b.votingAt?.toNumber() ?? b.draftAt.toNumber();
    return bTime - aTime;
  });
  return items;
}

/**
 * Read one community Proposal by address. Owner and identity must match the
 * issued VerifiedGovernance. Uses getAccountInfo + getProposal - never a
 * program-wide scan.
 */
export async function readCommunityProposal(
  params: ReadCommunityProposalParams,
): Promise<CommunityProposalSnapshot> {
  assertNoSecretMaterial(params, "readCommunityProposal");
  assertVerifiedGovernance(params.verifiedGovernance);
  assertBoundConnection(params.verifiedGovernance.verifiedRealm.verified, params.connection);
  const proposal = requirePublicKey(params.proposal, "proposal");
  const { verifiedRealm, governance, communityMint } = params.verifiedGovernance;
  const verified = verifiedRealm.verified;
  const info = await params.connection.getAccountInfo(proposal, "confirmed");
  if (info === null) {
    throw new ClientValidationError("PROPOSAL_MISSING", [
      `proposal ${proposal.toBase58()} has no account`,
    ]);
  }
  if (!info.owner.equals(verified.network.realmsProgramId)) {
    throw new ClientValidationError("PROPOSAL_OWNER", [
      `proposal owner ${info.owner.toBase58()} is not the verified Realms program ${verified.network.realmsProgramId.toBase58()}`,
    ]);
  }
  const parsed = await getProposal(params.connection, proposal);
  if (!parsed.pubkey.equals(proposal)) {
    throw new ClientValidationError("PROPOSAL_IDENTITY", [
      `getProposal returned ${parsed.pubkey.toBase58()} for ${proposal.toBase58()}`,
    ]);
  }
  const account = parsed.account;
  if (!account.governance.equals(governance)) {
    throw new ClientValidationError("PROPOSAL_GOVERNANCE", [
      `proposal governance ${account.governance.toBase58()} !== issued ${governance.toBase58()}`,
    ]);
  }
  if (!account.governingTokenMint.equals(communityMint)) {
    throw new ClientValidationError("PROPOSAL_MINT", [
      `proposal mint ${account.governingTokenMint.toBase58()} !== community ICHOR ${communityMint.toBase58()}`,
    ]);
  }
  return {
    proposal,
    governance: account.governance,
    governingTokenMint: account.governingTokenMint,
    tokenOwnerRecord: account.tokenOwnerRecord,
    state: account.state,
    stateName: proposalStateName(account.state),
    name: account.name,
    descriptionLink: account.descriptionLink,
    yesVotesCount: account.getYesVoteCount(),
    noVotesCount: account.getNoVoteCount(),
    options: account.options.map((option) => ({
      label: option.label,
      voteWeight: option.voteWeight,
      voteResult: option.voteResult,
      instructionsCount: option.instructionsCount,
      instructionsExecutedCount: option.instructionsExecutedCount,
    })),
    votingAt: account.votingAt ?? null,
    votingCompletedAt: account.votingCompletedAt ?? null,
    maxVotingTime: account.maxVotingTime ?? null,
    draftAt: account.draftAt,
  };
}

/**
 * Treasury ICHOR TransferChecked for proposal insert. Authority is the native
 * treasury PDA. Gross amount is pre-fee; expectedNet is what the recipient ATA
 * receives after the live mint transfer fee.
 */
export async function buildTreasuryIchorTransfer(
  params: BuildTreasuryIchorTransferParams,
): Promise<TreasuryIchorTransferBuild> {
  assertNoSecretMaterial(params, "buildTreasuryIchorTransfer");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertBoundConnection(params.verifiedGovernance.verifiedRealm.verified, params.connection);
  requirePublicKey(params.recipient, "recipient");
  requirePositiveBn(params.amount, "amount");
  const { verifiedRealm, governance, communityMint } = params.verifiedGovernance;
  const verified = verifiedRealm.verified;
  const treasury = await getNativeTreasuryAddress(verified.network.realmsProgramId, governance);
  if (params.recipient.equals(treasury)) {
    throw new ClientValidationError("TREASURY_SELF_TRANSFER", [
      "recipient must not be the native treasury",
    ]);
  }
  const mint = await fetchMintSnapshot(params.connection, verified.network, communityMint);
  assertIchorIsToken2022(mint);
  const sourceAta = getAssociatedTokenAddressSync(mint.mint, treasury, true, mint.ownerProgram);
  const destinationAta = getAssociatedTokenAddressSync(
    mint.mint,
    params.recipient,
    false,
    mint.ownerProgram,
  );
  const sourceInfo = await params.connection.getAccountInfo(sourceAta, "confirmed");
  if (sourceInfo === null) {
    throw new ClientValidationError("TREASURY_ICHOR_ATA_MISSING", [
      `treasury ICHOR ATA ${sourceAta.toBase58()} has no account; create it before proposing a payout`,
    ]);
  }
  const sourceAccount = unpackAccount(sourceAta, sourceInfo, mint.ownerProgram);
  if (!sourceAccount.mint.equals(mint.mint)) {
    throw new ClientValidationError("TREASURY_ICHOR_ATA_MINT", [
      `treasury ATA mint ${sourceAccount.mint.toBase58()} !== ICHOR ${mint.mint.toBase58()}`,
    ]);
  }
  if (!sourceAccount.owner.equals(treasury)) {
    throw new ClientValidationError("TREASURY_ICHOR_ATA_OWNER", [
      `treasury ATA owner ${sourceAccount.owner.toBase58()} !== treasury ${treasury.toBase58()}`,
    ]);
  }
  const sourceBalance = new BN(sourceAccount.amount.toString());
  if (sourceBalance.lt(params.amount)) {
    throw new ClientValidationError("TREASURY_ICHOR_SHORTFALL", [
      `treasury ICHOR ATA holds ${sourceBalance.toString(10)}; need gross ${params.amount.toString(10)}`,
    ]);
  }
  const fee = await liveIchorMintFee({
    connection: params.connection,
    verified,
    ichorMint: mint.mint,
    amount: params.amount,
  });
  const destInfo = await params.connection.getAccountInfo(destinationAta, "confirmed");
  const instructions: TransactionInstruction[] = [];
  if (destInfo === null) {
    if (params.createDestinationAta !== true) {
      throw new ClientValidationError("RECIPIENT_ATA_MISSING", [
        `recipient ICHOR ATA ${destinationAta.toBase58()} has no account; set createDestinationAta or create it first`,
      ]);
    }
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        treasury,
        destinationAta,
        params.recipient,
        mint.mint,
        mint.ownerProgram,
      ),
    );
  } else {
    const destAccount = unpackAccount(destinationAta, destInfo, mint.ownerProgram);
    if (!destAccount.mint.equals(mint.mint) || !destAccount.owner.equals(params.recipient)) {
      throw new ClientValidationError("RECIPIENT_ATA_IDENTITY", [
        `recipient ATA ${destinationAta.toBase58()} mint/owner does not match the requested payout`,
      ]);
    }
  }
  instructions.push(
    createTransferCheckedInstruction(
      sourceAta,
      mint.mint,
      destinationAta,
      treasury,
      BigInt(params.amount.toString(10)),
      mint.decimals,
      [],
      mint.ownerProgram,
    ),
  );
  return {
    instructions,
    derivedAddresses: {
      treasury,
      sourceAta,
      destinationAta,
      mint: mint.mint,
      recipient: params.recipient,
      governance,
    },
    transfer: {
      amount: params.amount,
      expectedMintFee: fee.expectedMintFee,
      expectedNet: fee.expectedNet,
    },
    treasury,
    sourceAta,
    destinationAta,
  };
}

/**
 * Native treasury SystemProgram.transfer for proposal insert. Lamports are
 * measured from a live getBalance against the derived treasury PDA.
 */
export async function buildTreasurySolTransfer(
  params: BuildTreasurySolTransferParams,
): Promise<TreasurySolTransferBuild> {
  assertNoSecretMaterial(params, "buildTreasurySolTransfer");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertBoundConnection(params.verifiedGovernance.verifiedRealm.verified, params.connection);
  requirePublicKey(params.recipient, "recipient");
  requirePositiveBn(params.lamports, "lamports");
  if (params.lamports.gt(new BN(Number.MAX_SAFE_INTEGER))) {
    throw new ClientValidationError("LAMPORTS_UNSAFE", [
      `lamports ${params.lamports.toString(10)} exceeds Number.MAX_SAFE_INTEGER`,
    ]);
  }
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const verified = verifiedRealm.verified;
  const treasury = await getNativeTreasuryAddress(verified.network.realmsProgramId, governance);
  if (params.recipient.equals(treasury)) {
    throw new ClientValidationError("TREASURY_SELF_TRANSFER", [
      "recipient must not be the native treasury",
    ]);
  }
  const balance = await params.connection.getBalance(treasury, "confirmed");
  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw new ClientValidationError("TREASURY_BALANCE_UNAVAILABLE", [
      `treasury ${treasury.toBase58()} balance is not a safe non-negative integer`,
    ]);
  }
  const lamports = params.lamports.toNumber();
  if (balance < lamports) {
    throw new ClientValidationError("TREASURY_SOL_SHORTFALL", [
      `treasury holds ${String(balance)} lamports; need ${String(lamports)}`,
    ]);
  }
  // SystemProgram.transfer refuses to leave the source below rent-exempt
  // (InsufficientFundsForRent). The native treasury is a 0-byte system
  // account funded at create time with exactly rent - a pay of N lamports
  // needs balance >= rent + N, not just >= N.
  const info = await params.connection.getAccountInfo(treasury, "confirmed");
  const space = info?.data.length ?? 0;
  const rentExempt = await params.connection.getMinimumBalanceForRentExemption(
    space,
    "confirmed",
  );
  if (!Number.isSafeInteger(rentExempt) || rentExempt < 0) {
    throw new ClientValidationError("TREASURY_RENT_UNAVAILABLE", [
      `rent exemption for treasury space ${String(space)} is not a safe non-negative integer`,
    ]);
  }
  const remaining = balance - lamports;
  if (remaining < rentExempt) {
    throw new ClientValidationError("TREASURY_SOL_RENT", [
      `treasury holds ${String(balance)} lamports; paying ${String(lamports)} would leave ${String(remaining)}, below rent-exempt ${String(rentExempt)} for a ${String(space)}-byte account`,
      `fund native treasury ${treasury.toBase58()} with at least ${String(rentExempt + lamports - balance)} more lamports before insert/execute`,
    ]);
  }
  const instruction = SystemProgram.transfer({
    fromPubkey: treasury,
    toPubkey: params.recipient,
    lamports,
  });
  return {
    instructions: [instruction],
    derivedAddresses: {
      treasury,
      recipient: params.recipient,
      governance,
    },
    lamports: params.lamports,
    treasury,
    recipient: params.recipient,
  };
}

/**
 * 0.3.33 signature (verified from registry):
 * withWithdrawGoverningTokens(ixs, programId, programVersion, realm,
 * governingTokenDestination, governingTokenMint, governingTokenOwner)
 */
export async function buildWithdrawIchorVotes(
  params: WithdrawIchorVotesParams,
): Promise<WithdrawIchorVotesBuild> {
  assertCommunityBuilder(params, params.verifiedRealm, "buildWithdrawIchorVotes");
  assertBoundConnection(params.verifiedRealm.verified, params.connection);
  requirePublicKey(params.governingTokenOwner, "governingTokenOwner");
  const { verified, realm, communityMint } = params.verifiedRealm;
  const destination = getAssociatedTokenAddressSync(
    communityMint,
    params.governingTokenOwner,
    false,
    verified.network.token2022ProgramId,
  );
  if (params.governingTokenDestination !== undefined) {
    requirePublicKey(params.governingTokenDestination, "governingTokenDestination");
    if (!params.governingTokenDestination.equals(destination)) {
      throw new ClientValidationError("DESTINATION_MISMATCH", [
        `governingTokenDestination ${params.governingTokenDestination.toBase58()} is not the canonical Token-2022 ATA ${destination.toBase58()}`,
      ]);
    }
  }
  const tokenOwnerRecord = await getTokenOwnerRecordAddress(
    verified.network.realmsProgramId,
    realm,
    communityMint,
    params.governingTokenOwner,
  );
  const record = await getTokenOwnerRecord(params.connection, tokenOwnerRecord);
  if (
    record.account.unrelinquishedVotesCount > 0 &&
    params.expectRelinquishInSameTransaction !== true
  ) {
    throw new ClientValidationError("UNRELINQUISHED_VOTES", [
      `TokenOwnerRecord still has ${String(record.account.unrelinquishedVotesCount)} unrelinquished vote(s). Relinquish every standing vote (one per proposal you voted on) before withdraw - finishing or finalizing a proposal does not clear them.`,
    ]);
  }
  if (record.account.outstandingProposalCount > 0) {
    throw new ClientValidationError("OUTSTANDING_PROPOSALS", [
      `TokenOwnerRecord still owns ${String(record.account.outstandingProposalCount)} outstanding proposal(s). Finalize or cancel them before withdraw.`,
    ]);
  }
  const amount = record.account.governingTokenDepositAmount;
  requirePositiveBn(amount, "governingTokenDepositAmount");
  const transfer = await liveIchorMintFee({
    connection: params.connection,
    verified,
    ichorMint: communityMint,
    amount,
  });
  const instructions: TransactionInstruction[] = [];
  await withWithdrawGoverningTokens(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    destination,
    communityMint,
    params.governingTokenOwner,
  );
  if (instructions.length !== 1) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `withdraw helper produced ${String(instructions.length)} instructions; expected 1`,
    ]);
  }
  const realmConfig = await getRealmConfigAddress(verified.network.realmsProgramId, realm);
  patchWithdrawGoverningTokenKeys(instructions[0]!, communityMint, realmConfig);
  return {
    instructions,
    derivedAddresses: { tokenOwnerRecord, realmConfig, destination },
    transfer: {
      amount,
      expectedMintFee: transfer.expectedMintFee,
      expectedNet: transfer.expectedNet,
    },
  };
}

/**
 * Auto-release this wallet's standing votes on finished proposals, then withdraw.
 * Open-window votes still require an explicit Relinquish (changes the tally).
 * Past-window Voting needs Finalize first (Finalize also releases all voters).
 */
export async function buildReleaseStandingAndWithdrawIchorVotes(
  params: ReleaseStandingAndWithdrawIchorParams,
): Promise<ReleaseStandingAndWithdrawIchorBuild> {
  assertNoSecretMaterial(params, "buildReleaseStandingAndWithdrawIchorVotes");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertLinearDefaultVoting(params, "buildReleaseStandingAndWithdrawIchorVotes");
  assertNoCallerGovernanceOrMint(params, "buildReleaseStandingAndWithdrawIchorVotes");
  assertBoundConnection(params.verifiedGovernance.verifiedRealm.verified, params.connection);
  requirePublicKey(params.governingTokenOwner, "governingTokenOwner");
  requirePublicKey(params.governanceAuthority, "governanceAuthority");
  requirePublicKey(params.beneficiary, "beneficiary");
  if (!params.governanceAuthority.equals(params.governingTokenOwner)) {
    throw new ClientValidationError("GOVERNANCE_AUTHORITY", [
      "governanceAuthority must be the governing token owner for standing RelinquishVote",
    ]);
  }
  const standing = await listStandingCommunityVotes({
    connection: params.connection,
    verifiedGovernance: params.verifiedGovernance,
    governingTokenOwner: params.governingTokenOwner,
  });
  const needsFinalize = standing.filter((row) => row.needsFinalizeBeforeRelinquish);
  if (needsFinalize.length > 0) {
    throw new ClientValidationError("FINALIZE_BEFORE_RELINQUISH", [
      `FinalizeVote first on ${String(needsFinalize.length)} proposal(s) still showing Voting after the window: ${needsFinalize
        .map((row) => row.proposalName || row.proposal.toBase58())
        .join("; ")}. Finalize also releases voter deposits.`,
    ]);
  }
  const openActive = standing.filter(
    (row) => row.proposalState === ProposalState.Voting && !row.needsFinalizeBeforeRelinquish,
  );
  if (openActive.length > 0) {
    throw new ClientValidationError("ACTIVE_VOTES_BLOCK_WITHDRAW", [
      `This wallet still has ${String(openActive.length)} open vote${openActive.length === 1 ? "" : "s"} on: ${openActive
        .map((row) => row.proposalName || row.proposal.toBase58())
        .join("; ")}. Relinquish ${openActive.length === 1 ? "that vote" : "those votes"} (or wait until the proposal ends), then withdraw.`,
    ]);
  }
  const closedStanding = standing.filter((row) => row.proposalState !== ProposalState.Voting);
  const { verifiedRealm, governance } = params.verifiedGovernance;
  const { verified, realm, communityMint } = verifiedRealm;
  const releaseInstructions: TransactionInstruction[] = [];
  for (const row of closedStanding) {
    await withRelinquishVote(
      releaseInstructions,
      verified.network.realmsProgramId,
      verified.network.programVersion,
      realm,
      governance,
      row.proposal,
      row.tokenOwnerRecord,
      communityMint,
      row.voteRecord,
      undefined,
      undefined,
    );
  }
  const withdraw = await buildWithdrawIchorVotes({
    connection: params.connection,
    verifiedRealm,
    ...(params.governingTokenDestination !== undefined
      ? { governingTokenDestination: params.governingTokenDestination }
      : {}),
    governingTokenOwner: params.governingTokenOwner,
    expectRelinquishInSameTransaction: closedStanding.length > 0,
  });
  return {
    instructions: [...releaseInstructions, ...withdraw.instructions],
    derivedAddresses: withdraw.derivedAddresses,
    transfer: withdraw.transfer,
    releasedStandingCount: closedStanding.length,
    proposalNames: closedStanding.map((row) => row.proposalName),
  };
}

export async function buildWithdrawCouncilVotes(
  params: WithdrawCouncilVotesParams,
): Promise<UnsignedInstructionBuild> {
  assertNoSecretMaterial(params, "buildWithdrawCouncilVotes");
  assertVerifiedRealm(params.verifiedRealm);
  assertLinearDefaultVoting(params, "buildWithdrawCouncilVotes");
  assertBoundConnection(params.verifiedRealm.verified, params.connection);
  requirePublicKey(params.governingTokenOwner, "governingTokenOwner");
  const { verified, realm, councilMint } = params.verifiedRealm;
  if (councilMint === null) {
    throw new ClientValidationError("COUNCIL_MINT_MISSING", [
      "verified Realm has no council mint",
    ]);
  }
  const destination = getAssociatedTokenAddressSync(
    councilMint,
    params.governingTokenOwner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const tokenOwnerRecord = await getTokenOwnerRecordAddress(
    verified.network.realmsProgramId,
    realm,
    councilMint,
    params.governingTokenOwner,
  );
  const record = await getTokenOwnerRecord(params.connection, tokenOwnerRecord);
  const amount = record.account.governingTokenDepositAmount;
  requirePositiveBn(amount, "governingTokenDepositAmount");
  const instructions: TransactionInstruction[] = [];
  await withWithdrawGoverningTokens(
    instructions,
    verified.network.realmsProgramId,
    verified.network.programVersion,
    realm,
    destination,
    councilMint,
    params.governingTokenOwner,
  );
  if (instructions.length !== 1) {
    throw new ClientValidationError("REALMS_SDK_LAYOUT_DRIFT", [
      `council withdraw helper produced ${String(instructions.length)} instructions; expected 1`,
    ]);
  }
  return {
    instructions,
    derivedAddresses: { tokenOwnerRecord, destination, councilMint },
  };
}

export { VoteType, YesNoVote, ProposalState };
