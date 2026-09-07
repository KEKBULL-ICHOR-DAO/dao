import type { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type BN from "bn.js";

/** Clusters this client may name. IDs come from `network.ts`, not from guesswork. */
export type ClusterName = "devnet" | "mainnet-beta" | "localnet";

/**
 * Named Realms / SPL Governance instances. Cluster presence is selected, not
 * assumed. `kekbull` is the KEKBULL TransferFeeConfig fork (not GovER5; not
 * realms.today). Stock probes keep `default-shared`.
 */
export type RealmsInstanceName = "default-shared" | "test" | "kekbull";

export type TokenProgramKind = "legacy-spl" | "token-2022";

/**
 * Explicit account-read bank for live verifiers. Omitted arguments keep the
 * historical `confirmed` default so non-D callers are unchanged.
 */
export type AccountReadCommitment = "confirmed" | "finalized";

export interface NamedProgramId {
  readonly id: string;
  readonly label: string;
  readonly source: string;
}

export interface NetworkConfig {
  readonly cluster: ClusterName;
  readonly realmsInstance: RealmsInstanceName;
  readonly realmsProgramId: PublicKey;
  /** Official Realms SDK / docs: use `3` for the deployed v3.1.2 line. */
  readonly programVersion: 3;
  readonly meteoraCpAmmProgramId: PublicKey;
  readonly tokenProgramId: PublicKey;
  readonly token2022ProgramId: PublicKey;
  readonly nativeMint: PublicKey;
}

/** Live executable proof for one named program. Fields are observational, not a brand. */
export interface ProgramDeploymentProof {
  readonly cluster: ClusterName;
  readonly programId: PublicKey;
  readonly namedId: string;
  readonly executable: true;
  readonly owner: PublicKey;
  readonly loaderId: string;
  readonly dataLength: number;
}

/**
 * Named IDs plus live executable proofs, bound to the exact Connection
 * instance that passed genesis + program preflight. Runtime issuance is
 * module-private: only `verifyNetworkDeployment` can create an object that
 * `assertVerifiedNetwork` accepts. A structural lookalike is rejected.
 * A different Connection with the same rpcEndpoint is not accepted.
 * Do not construct this type by hand.
 */
export interface VerifiedNetwork {
  readonly network: NetworkConfig;
  readonly genesisHash: string;
  readonly rpcEndpoint: string;
  readonly meteora: ProgramDeploymentProof;
  readonly realms: ProgramDeploymentProof;
}

/**
 * Live realm proof bound to an issued VerifiedNetwork, the exact Connection
 * that read it, and the on-chain community mint. Only
 * `verifyRealmDeployment` can create an object that `assertVerifiedRealm`
 * accepts. A lookalike with a substituted council mint is rejected.
 */
export interface VerifiedRealm {
  readonly verified: VerifiedNetwork;
  readonly realm: PublicKey;
  readonly communityMint: PublicKey;
  readonly councilMint: PublicKey | null;
}

/** Observed GovernanceConfig fields from a live `getGovernanceAccount` parse. */
export interface ObservedGovernanceConfig {
  readonly communityVoteThresholdType: number;
  readonly communityVoteThresholdValue: number | undefined;
  readonly minCommunityTokensToCreateProposal: BN;
  readonly communityVoteTipping: number;
  readonly minInstructionHoldUpTime: number;
  readonly baseVotingTime: number;
  readonly votingCoolOffTime: number;
  readonly depositExemptProposalCount: number;
  readonly minCouncilTokensToCreateProposal: BN;
  readonly councilVoteThresholdType: number;
  readonly councilVoteThresholdValue: number | undefined;
  readonly councilVetoVoteThresholdType: number;
  readonly councilVetoVoteThresholdValue: number | undefined;
  readonly communityVetoVoteThresholdType: number;
  readonly communityVetoVoteThresholdValue: number | undefined;
  readonly councilVoteTipping: number;
}

/**
 * Live Governance identity proof. This is valid during council-only bootstrap:
 * it proves the account owner, Realm relationship, community mint, config, and
 * exact Connection without claiming community proposal/vote activation.
 */
export interface VerifiedGovernanceIdentity {
  readonly verifiedRealm: VerifiedRealm;
  readonly governance: PublicKey;
  readonly realm: PublicKey;
  readonly communityMint: PublicKey;
  readonly config: ObservedGovernanceConfig;
}

/**
 * Live governance proof bound to an issued VerifiedRealm and the exact
 * Connection that read it. Community propose/cast require this after
 * community voting is enabled on-chain. Only `verifyGovernanceDeployment`
 * can create an object that `assertVerifiedGovernance` accepts.
 */
export interface VerifiedGovernance extends VerifiedGovernanceIdentity {}

/** Live mint snapshot. Decimals, owner, and authorities are read from the account. */
export interface MintSnapshot {
  readonly mint: PublicKey;
  readonly ownerProgram: PublicKey;
  readonly tokenProgramKind: TokenProgramKind;
  readonly decimals: number;
  readonly supply: BN;
  readonly mintAuthority: PublicKey | null;
  readonly freezeAuthority: PublicKey | null;
  readonly isInitialized: boolean;
  readonly dataLength: number;
}

/**
 * Live `kekbull_ichor` Config fields. Parsed from the account; never assumed.
 * Only `verifyIchorConfigDeployment` may issue a proof that carries this.
 */
export interface IchorConfigSnapshot {
  readonly programId: PublicKey;
  readonly config: PublicKey;
  readonly authority: PublicKey;
  readonly pendingAuthority: PublicKey | null;
  readonly kekbullMint: PublicKey;
  readonly ichorMint: PublicKey;
  readonly kekbullTokenProgram: PublicKey;
  readonly ichorTokenProgram: PublicKey;
  readonly pumpProgram: PublicKey;
  readonly bondingCurve: PublicKey;
  readonly emissionNumerator: BN;
  readonly emissionDenominator: BN;
  readonly pendingEmissionNumerator: BN;
  readonly pendingEmissionDenominator: BN;
  readonly pendingRatioUnlockTs: BN;
  readonly ratioTimelockSecs: BN;
  readonly paused: boolean;
  readonly ratioUpdatesFrozen: boolean;
  readonly hasPendingRatio: boolean;
  readonly totalKekbullBurned: BN;
  readonly totalIchorMinted: BN;
  readonly creatorBeneficiary: PublicKey | null;
  readonly realmsProgram: PublicKey | null;
  readonly realmsRealm: PublicKey | null;
  readonly realmsGovernance: PublicKey | null;
  readonly realmsNativeTreasury: PublicKey | null;
  readonly feeBeneficiariesBound: boolean;
  readonly transferFeeAuthorityRevoked: boolean;
  readonly withdrawWithheldBump: number;
  /** Gross Token-2022 fees withdrawn from the mint-level accumulator. */
  readonly totalFeesWithdrawn: BN;
  /** Net base units measured into the creator escrow after second-hop fee. */
  readonly totalFeesToCreator: BN;
  /** Net base units measured into the Realms destination after second-hop fee. */
  readonly totalFeesToRealms: BN;
  readonly creatorEscrowBump: number;
  readonly lastCreatorClaimTs: BN;
  readonly creatorDecaySecs: BN;
  readonly totalCreatorClaimed: BN;
  readonly totalCreatorSwept: BN;
  readonly bump: number;
}

/** pump.fun bonding-curve 81-byte core. Trailing bytes are ignored. */
export interface BondingCurveSnapshot {
  readonly address: PublicKey;
  readonly owner: PublicKey;
  readonly virtualTokenReserves: BN;
  readonly virtualQuoteReserves: BN;
  readonly realTokenReserves: BN;
  readonly realQuoteReserves: BN;
  readonly tokenTotalSupply: BN;
  readonly complete: boolean;
  readonly creator: PublicKey;
  readonly dataLength: number;
}

/**
 * Live executable proof for the ICHOR burn program. Issued only by
 * `verifyIchorProgramDeployment`. A structural lookalike is rejected.
 * Bound to an issued VerifiedNetwork and that Connection instance.
 */
export interface VerifiedIchorProgram {
  readonly verified: VerifiedNetwork;
  readonly programId: PublicKey;
  readonly programData: PublicKey;
  readonly program: ProgramDeploymentProof;
  /**
   * Loader v3 ProgramData upgrade authority. `null` means the Option tag is
   * None (revoked). Initialize requires a live `Some` that equals `authority`.
   */
  readonly upgradeAuthority: PublicKey | null;
  /** Loader v3 ProgramData slot (u64 LE at offset 4). */
  readonly deploymentSlot: BN;
}

/**
 * Live Config proof bound to an issued VerifiedIchorProgram. Issued only by
 * `verifyIchorConfigDeployment`. Convert builders require this; initialize
 * cannot, because it creates the Config account.
 */
export interface VerifiedIchorConfig {
  readonly verifiedProgram: VerifiedIchorProgram;
  readonly config: IchorConfigSnapshot;
}

export interface BuildTransferProgramUpgradeAuthorityParams {
  readonly verifiedProgram: VerifiedIchorProgram;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
}

export interface BuildFreezeProgramUpgradesParams {
  readonly verifiedProgram: VerifiedIchorProgram;
}

/**
 * Unsigned loader Upgrade. Program / ProgramData / authority come from the
 * issued proof. Spill is the derived Realms native treasury. `buffer` is a
 * caller-supplied already-written loader account pubkey - not ELF bytes.
 */
export interface BuildUpgradeIchorProgramParams {
  /**
   * Required so the buffer account can be read. Without it this builder could
   * only compare addresses, and a buffer whose authority is still the proposer
   * stays rewritable until the moment of execute (before execute).
   */
  readonly connection: Connection;
  readonly verifiedProgram: VerifiedIchorProgram;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly buffer: PublicKey;
}

export interface BuildConvertParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
  readonly burner: PublicKey;
  /** ICHOR token-account owner. Canonical ATA is derived; may be a treasury PDA. */
  readonly recipient: PublicKey;
  /** Raw KEKBULL base units. Decimals come from the mint account. */
  readonly kekbullAmount: BN;
  /** Burner-signed floor. Raw ICHOR base units. Zero means no floor. */
  readonly minIchorAmount: BN;
}

export interface ConvertBuild {
  readonly unsigned: UnsignedTransactionBuild;
  readonly programId: PublicKey;
  readonly config: PublicKey;
  readonly kekbullMint: MintSnapshot;
  readonly ichorMint: MintSnapshot;
  readonly bondingCurve: BondingCurveSnapshot;
  readonly kekbullFrom: PublicKey;
  readonly ichorTo: PublicKey;
  readonly kekbullAmount: BN;
  readonly minIchorAmount: BN;
  readonly expectedIchorAmount: BN;
}

/** Shared admin builder inputs. Program and config come from the issued proof. */
export interface BuildAdminParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
  readonly authority: PublicKey;
}

export interface BuildSetPausedParams extends BuildAdminParams {
  readonly paused: boolean;
}

export interface BuildProposeEmissionRatioParams extends BuildAdminParams {
  readonly numerator: BN;
  readonly denominator: BN;
}

/** Permissionless apply. No program signer. */
export interface BuildApplyEmissionRatioParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
}

/** Transaction wrapper only. `payer` is the fee payer, not a program signer. */
export interface BuildApplyEmissionRatioTransactionParams extends BuildApplyEmissionRatioParams {
  readonly payer: PublicKey;
}

export type BuildCancelPendingRatioParams = BuildAdminParams;
export type BuildFreezeRatioUpdatesParams = BuildAdminParams;

export interface BuildIncreaseRatioTimelockParams extends BuildAdminParams {
  readonly newSecs: BN;
}

export interface BuildSetPendingAuthorityParams extends BuildAdminParams {
  /** Borsh `Option<Pubkey>`: `null` is None. Default pubkey is rejected. */
  readonly pending: PublicKey | null;
}

export interface BuildAcceptAuthorityParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
  readonly pendingAuthority: PublicKey;
}

/**
 * Unsigned `set_pending_authority` whose pending pubkey is the issued
 * Governance PDA. No caller `pending` field - destination is
 * `verifiedGovernance.governance` only.
 */
export interface BuildSetPendingAuthorityToGovernanceParams extends BuildAdminParams {
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
}

/**
 * Unsigned `accept_authority` whose signer is the issued Governance PDA.
 * No caller `pendingAuthority` - it is `verifiedGovernance.governance`.
 * Live config must already have that pubkey pending.
 */
export interface BuildAcceptAuthorityAsGovernanceParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
}

/** On-chain DAO destination committed before fee bind or position-rights handoff. */
export interface CommittedDaoDestination {
  readonly realm: PublicKey;
  readonly governance: PublicKey;
  readonly realmsProgram: PublicKey;
  readonly nativeTreasury: PublicKey;
}

/** Structural identity compared to a committed destination. Not a branded proof. */
export interface DaoDestinationIdentity {
  readonly realm: PublicKey;
  readonly governance: PublicKey;
  readonly realmsProgram: PublicKey;
  readonly nativeTreasury: PublicKey;
  readonly communityMint: PublicKey;
}

export interface BuildCommitDaoDestinationParams extends BuildAdminParams {
  /** Issued governance whose realm / Governance / treasury are committed. */
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
}

export interface BuildSetFeeDistributionParams extends BuildAdminParams {
  /** Issued governance that must match the already-committed on-chain destination. */
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly creatorBeneficiary: PublicKey;
}

export interface BuildDistributeTransferFeesParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
  readonly caller: PublicKey;
}

/** Permissionless collect: harvest derived sinks, then push 25/75. */
export interface BuildCollectTransferFeesParams extends BuildDistributeTransferFeesParams {
  /**
   * Extra Token-2022 ICHOR accounts the caller already knows.
   * Not discovered. Canonical sinks are always considered first.
   */
  readonly extraSources?: readonly PublicKey[];
}

export interface BuildSetTransferFeeParams extends BuildAdminParams {
  readonly transferFeeBasisPoints: number;
  readonly maximumFee: BN;
}

export type BuildRevokeTransferFeeAuthorityParams = BuildAdminParams;

export interface BuildHarvestWithheldTokensToMintParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
  /** Caller-supplied Token-2022 ICHOR accounts. Discovery is rejected. */
  readonly sources: readonly PublicKey[];
}

export interface SecondHopFeeReport {
  readonly transferAmount: BN;
  readonly expectedFee: BN;
  readonly expectedNet: BN;
}

export interface DistributeTransferFeesBuild {
  readonly unsigned: UnsignedInstructionBuild;
  readonly withheldBefore: BN;
  /** Gross withdrawn from the mint-level accumulator. Distinct from destination nets. */
  readonly expectedGrossWithdrawn: BN;
  readonly expectedVaultDistributed: BN;
  readonly creatorSecondHop: SecondHopFeeReport;
  readonly realmsSecondHop: SecondHopFeeReport;
  readonly expectedCreatorNet: BN;
  readonly expectedRealmsNet: BN;
  readonly feeVault: PublicKey;
  /** Canonical Token-2022 ATA owned by the bound creator beneficiary. */
  readonly creatorDestination: PublicKey;
  readonly realmsDestination: PublicKey;
  readonly withdrawWithheldAuthority: PublicKey;
}

export interface CollectTransferFeesBuild extends DistributeTransferFeesBuild {
  readonly harvestedSources: readonly PublicKey[];
  readonly harvestedWithheld: BN;
}

export interface HarvestWithheldTokensToMintBuild {
  readonly unsigned: UnsignedInstructionBuild;
  readonly mint: PublicKey;
  readonly sources: readonly PublicKey[];
  readonly withheldBySource: readonly BN[];
  readonly totalWithheld: BN;
}

export interface GovernanceTokenTransferPreview {
  readonly amount: BN;
  readonly expectedMintFee: BN;
  readonly expectedNet: BN;
}

export interface DepositIchorVotesBuild extends UnsignedInstructionBuild {
  readonly transfer: GovernanceTokenTransferPreview;
}

export interface WithdrawIchorVotesBuild extends UnsignedInstructionBuild {
  readonly transfer: GovernanceTokenTransferPreview;
}

/** Live TokenOwnerRecord deposit for one wallet. Absence is a measured zero. */
export interface CommunityGoverningTokenDeposit {
  readonly tokenOwnerRecord: PublicKey;
  readonly present: boolean;
  readonly amount: BN;
  readonly unrelinquishedVotesCount: number;
}

export interface ReadCommunityGoverningTokenDepositParams {
  readonly connection: Connection;
  readonly verifiedRealm: VerifiedRealm;
  readonly governingTokenOwner: PublicKey;
}

/** One Approve/Deny option on a live community Proposal account. */
export interface CommunityProposalOptionSnapshot {
  readonly label: string;
  readonly voteWeight: BN;
  readonly voteResult: number;
  readonly instructionsCount: number;
  readonly instructionsExecutedCount: number;
}

/**
 * Measured community Proposal fields. Title and descriptionLink come from the
 * account; the body behind descriptionLink is off-chain and not invented here.
 */
export interface CommunityProposalSnapshot {
  readonly proposal: PublicKey;
  readonly governance: PublicKey;
  readonly governingTokenMint: PublicKey;
  /** Proposer's TokenOwnerRecord (deposit record). */
  readonly tokenOwnerRecord: PublicKey;
  /** ProposalState numeric value from the live account. */
  readonly state: number;
  readonly stateName: string;
  readonly name: string;
  readonly descriptionLink: string;
  readonly yesVotesCount: BN;
  readonly noVotesCount: BN;
  readonly options: readonly CommunityProposalOptionSnapshot[];
  readonly votingAt: BN | null;
  readonly votingCompletedAt: BN | null;
  readonly maxVotingTime: number | null;
  readonly draftAt: BN;
}

export interface ReadCommunityProposalParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernance;
  readonly proposal: PublicKey;
}

/**
 * One row for the holder proposal board. Measured from the issued Governance
 * only - not a program-wide scan of unrelated realms.
 */
export interface CommunityProposalListItem {
  readonly proposal: PublicKey;
  readonly name: string;
  readonly descriptionLink: string;
  readonly state: number;
  readonly stateName: string;
  readonly tokenOwnerRecord: PublicKey;
  readonly yesVotesCount: BN;
  readonly noVotesCount: BN;
  /** Approve option instruction count; 0 means signal-only. */
  readonly approveInstructionsCount: number;
  readonly draftAt: BN;
  readonly votingAt: BN | null;
}

export interface ListCommunityProposalsParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernance;
}

export interface BuildTreasuryIchorTransferParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly recipient: PublicKey;
  /** Gross ICHOR base units leaving the treasury ATA (pre transfer fee). */
  readonly amount: BN;
  /**
   * When true and the recipient ATA is missing, include an idempotent create
   * with the treasury as payer (treasury signs on Realms execute).
   */
  readonly createDestinationAta?: boolean;
}

export interface TreasuryIchorTransferBuild extends UnsignedInstructionBuild {
  readonly transfer: GovernanceTokenTransferPreview;
  readonly treasury: PublicKey;
  readonly sourceAta: PublicKey;
  readonly destinationAta: PublicKey;
}

export interface BuildTreasurySolTransferParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly recipient: PublicKey;
  readonly lamports: BN;
}

export interface TreasurySolTransferBuild extends UnsignedInstructionBuild {
  readonly lamports: BN;
  readonly treasury: PublicKey;
  readonly recipient: PublicKey;
}

export interface BuildClaimCreatorFeesParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
  readonly creatorBeneficiary: PublicKey;
}

export interface BuildSweepUnclaimedCreatorFeesParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
  readonly caller: PublicKey;
}

export interface BuildSetCreatorBeneficiaryParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
  readonly creatorBeneficiary: PublicKey;
  readonly newBeneficiary: PublicKey;
}

export interface ClaimCreatorFeesBuild {
  readonly unsigned: UnsignedInstructionBuild;
  readonly escrowAmount: BN;
  readonly expectedNet: BN;
  readonly creatorEscrow: PublicKey;
  readonly creatorDestination: PublicKey;
}

export interface SweepUnclaimedCreatorFeesBuild {
  readonly unsigned: UnsignedInstructionBuild;
  readonly escrowAmount: BN;
  readonly expectedNet: BN;
  readonly creatorEscrow: PublicKey;
  readonly realmsDestination: PublicKey;
}

export interface BuildInitializeParams {
  readonly connection: Connection;
  readonly verifiedProgram: VerifiedIchorProgram;
  readonly authority: PublicKey;
  readonly kekbullMint: PublicKey;
  readonly ichorMint: PublicKey;
  readonly emissionNumerator: BN;
  readonly emissionDenominator: BN;
  /** Zero freezes the initialized ratio. */
  readonly ratioTimelockSecs: BN;
  /** Operator-supplied; must be > 0. Immutable after initialize. */
  readonly creatorDecaySecs: BN;
}

export interface InitializeBuild {
  readonly unsigned: UnsignedTransactionBuild;
  readonly programId: PublicKey;
  readonly programData: PublicKey;
  readonly config: PublicKey;
  readonly withdrawWithheldAuthority: PublicKey;
  readonly kekbullMint: MintSnapshot;
  readonly ichorMint: MintSnapshot;
  readonly bondingCurve: PublicKey;
  readonly emissionNumerator: BN;
  readonly emissionDenominator: BN;
  readonly ratioTimelockSecs: BN;
  readonly creatorDecaySecs: BN;
  readonly creatorEscrowAuthority: PublicKey;
}

/**
 * Unsigned Token-2022 mint creation sized for exactly TransferFeeConfig, plus
 * immutable Metaplex CreateV1 (name/symbol ICHOR + pinned HTTPS URI) +
 * SetAuthority so the final mint authority is the program config PDA. Fee
 * config is initialized before the mint, at 25 bps / u64::MAX. Fee-setting
 * authority is the config PDA; withdraw authority is the
 * ["withdraw-withheld"] PDA; freeze is unset. Caller cannot supply authority,
 * supply, rent, space, or token program. Decimals are the operator-selected
 * u8, not a client default. Metadata labels are pinned product strings. URI
 * is required - CreateV1 is immutable.
 */
export interface BuildIchorMintAccountParams {
  readonly connection: Connection;
  readonly verifiedProgram: VerifiedIchorProgram;
  readonly payer: PublicKey;
  /** New mint account pubkey. The matching keypair signs later, outside this client. */
  readonly mint: PublicKey;
  /** Operator-selected mint decimals. Validated as u8; never assumed. */
  readonly decimals: number;
  /** HTTPS /ipfs/ metadata JSON URI. Written permanently; empty is refused. */
  readonly metadataUri: string;
}

export interface IchorMintAccountBuild {
  readonly unsigned: UnsignedTransactionBuild;
  readonly programId: PublicKey;
  readonly derivedAddresses: {
    readonly mint: PublicKey;
    readonly config: PublicKey;
    readonly mintAuthority: PublicKey;
    readonly withdrawWithheldAuthority: PublicKey;
    readonly tokenProgram: PublicKey;
    /** Metaplex metadata PDA (wallet display). */
    readonly metadata: PublicKey;
  };
  /** Measured via `getMinimumBalanceForRentExemption` for TransferFeeConfig mint len. */
  readonly rentExemptionLamports: BN;
  readonly mintSpace: number;
  readonly decimals: number;
  readonly freezeAuthority: null;
  readonly transferFeeBasisPoints: 25;
  readonly maximumFee: BN;
  readonly metadataName: "ICHOR";
  readonly metadataSymbol: "ICHOR";
  readonly metadataUri: string;
}

/**
 * One operator-selected bootstrap council recipient. Amount is raw base units.
 * ATA is derived; do not pass an account address.
 */
export interface BootstrapCouncilMintRecipient {
  readonly owner: PublicKey;
  readonly amount: BN;
}

/**
 * Unsigned fixed-supply bootstrap council mint. Freeze is unset. After minting
 * the operator-selected recipient amounts, mint authority remains the current
 * mint authority so it can later be assigned to the verified Governance PDA.
 * Caller cannot supply ATA addresses, remaining/new authority, supply, rent,
 * space, or token program. Decimals are the operator-selected u8. Accepts an
 * issued VerifiedNetwork or VerifiedIchorProgram bound to the exact Connection
 * instance.
 */
interface BootstrapCouncilMintBaseParams {
  readonly connection: Connection;
  readonly payer: PublicKey;
  /** New mint account pubkey. The matching keypair signs later, outside this client. */
  readonly mint: PublicKey;
  /** Operator-selected mint decimals. Validated as u8; never assumed. */
  readonly decimals: number;
  /** Current mint authority. Signs mint-to; retained until assigned to Governance. */
  readonly mintAuthority: PublicKey;
  readonly recipients: readonly BootstrapCouncilMintRecipient[];
}

export type BuildBootstrapCouncilMintParams = BootstrapCouncilMintBaseParams &
  (
    | { readonly verified: VerifiedNetwork; readonly verifiedProgram?: never }
    | { readonly verifiedProgram: VerifiedIchorProgram; readonly verified?: never }
  );

export interface BootstrapCouncilMintBuild {
  readonly unsigned: UnsignedTransactionBuild;
  readonly derivedAddresses: {
    readonly mint: PublicKey;
    readonly tokenProgram: PublicKey;
    readonly recipientAtas: readonly PublicKey[];
  };
  /** Measured via `getMinimumBalanceForRentExemption` for `MINT_SIZE`. */
  readonly rentExemptionLamports: BN;
  readonly mintSpace: number;
  readonly decimals: number;
  /** Sum of operator-selected recipient raw amounts. Fits in u64. */
  readonly totalRawSupply: BN;
  readonly freezeAuthority: null;
  /** Retained current mint authority. Assigned to Governance after it exists. */
  readonly mintAuthority: PublicKey;
  readonly recipients: readonly {
    readonly owner: PublicKey;
    readonly amount: BN;
    readonly ata: PublicKey;
  }[];
}

/**
 * Unsigned zero-supply council mint. SystemProgram.createAccount +
 * initializeMint2 only. No recipients, ATA, or MintTo. Freeze is null. Mint
 * authority remains the current mint authority until assigned to Governance.
 */
interface ZeroSupplyCouncilMintBaseParams {
  readonly connection: Connection;
  readonly payer: PublicKey;
  /** New mint account pubkey. The matching keypair signs later, outside this client. */
  readonly mint: PublicKey;
  /** Operator-selected mint decimals. Validated as u8; never assumed. */
  readonly decimals: number;
  /** Current mint authority. Retained until assigned to Governance. */
  readonly mintAuthority: PublicKey;
}

export type BuildZeroSupplyCouncilMintParams = ZeroSupplyCouncilMintBaseParams &
  (
    | { readonly verified: VerifiedNetwork; readonly verifiedProgram?: never }
    | { readonly verifiedProgram: VerifiedIchorProgram; readonly verified?: never }
  );

export interface ZeroSupplyCouncilMintBuild {
  readonly unsigned: UnsignedTransactionBuild;
  readonly derivedAddresses: {
    readonly mint: PublicKey;
    readonly tokenProgram: PublicKey;
  };
  readonly rentExemptionLamports: BN;
  readonly mintSpace: number;
  readonly decimals: number;
  /** Always zero. */
  readonly totalRawSupply: BN;
  readonly freezeAuthority: null;
  readonly mintAuthority: PublicKey;
}

/**
 * Unsigned minimal-supply council mint (dropped as ship default; see
 * PLAN §13.1a). createAccount + initializeMint2 + sink ATA +
 * MintToChecked(1). Kept for comparison only. Freeze is null. Mint
 * authority stays current until assigned to Governance.
 */
interface MinimalSupplyCouncilMintBaseParams {
  readonly connection: Connection;
  readonly payer: PublicKey;
  readonly mint: PublicKey;
  readonly decimals: number;
  readonly mintAuthority: PublicKey;
}

export type BuildMinimalSupplyCouncilMintParams = MinimalSupplyCouncilMintBaseParams &
  (
    | { readonly verified: VerifiedNetwork; readonly verifiedProgram?: never }
    | { readonly verifiedProgram: VerifiedIchorProgram; readonly verified?: never }
  );

export interface MinimalSupplyCouncilMintBuild {
  readonly unsigned: UnsignedTransactionBuild;
  readonly derivedAddresses: {
    readonly mint: PublicKey;
    readonly tokenProgram: PublicKey;
    readonly nonvotingSink: PublicKey;
    readonly nonvotingSinkAta: PublicKey;
  };
  readonly rentExemptionLamports: BN;
  readonly mintSpace: number;
  readonly decimals: number;
  /** Always one base unit. */
  readonly totalRawSupply: BN;
  readonly freezeAuthority: null;
  readonly mintAuthority: PublicKey;
}

/**
 * Assign live council mint authority to the issued Governance PDA. Freeze stays
 * unset. New authority comes only from verifiedGovernance.governance; callers
 * cannot pass a substitute. Current mint authority must sign.
 */
export interface BuildAssignCouncilMintAuthorityToGovernanceParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly mint: PublicKey;
  readonly currentMintAuthority: PublicKey;
  readonly payer: PublicKey;
  readonly commitment?: AccountReadCommitment;
}

export interface AssignCouncilMintAuthorityToGovernanceBuild {
  readonly unsigned: UnsignedTransactionBuild;
  readonly mint: PublicKey;
  readonly currentMintAuthority: PublicKey;
  readonly newMintAuthority: PublicKey;
  readonly freezeAuthority: null;
  readonly tokenProgram: PublicKey;
}

export interface UnsignedTransactionBuild {
  readonly transaction: Transaction;
  readonly instructions: readonly TransactionInstruction[];
  /** Extra pubkeys that must sign later. Never a secret key. */
  readonly requiredSignerPubkeys: readonly PublicKey[];
}

export interface UnsignedInstructionBuild {
  readonly instructions: TransactionInstruction[];
  readonly derivedAddresses: Record<string, PublicKey>;
}

export interface IchorSolSeedAmounts {
  /** Raw ICHOR base units. Must be a BN measured from chain or a prior burn receipt. */
  readonly ichorAmount: BN;
  /** Raw wSOL / native-mint base units (lamports on the live mint). */
  readonly solAmount: BN;
}

/** Integer rounding used on a BN quotient. Never half-up or floating point. */
export type IntegerRoundingDirection = "floor" | "ceiling";

/**
 * Operator-selected ICHOR seed plus an explicit adjustment. `adjustmentBps`
 * has no client default: omit it and planning fails closed.
 */
export interface PlanIchorSolSeedParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
  /** Owner of the ICHOR ATA and native SOL that will seed the pool. */
  readonly seedOwner: PublicKey;
  /** Target net ICHOR base units to arrive in the Meteora pool. */
  readonly ichorAmount: BN;
  /**
   * Non-positive basis-point delta applied to raw SOL parity.
   * `adjusted = raw * (10000 + adjustmentBps) / 10000`.
   * Required. `0` is an explicit choice, not a fallback. Positive adjustments
   * are rejected until an on-chain fee/friction reader justifies them.
   */
  readonly adjustmentBps: number;
}

/** Live canonical PumpSwap pool plus the two mint snapshots used to format it. */
export interface CanonicalPumpSwapReserves {
  readonly pool: PumpSwapPoolSnapshot;
  readonly baseMint: MintSnapshot;
  readonly quoteMint: MintSnapshot;
}

/** Canonical PumpSwap pool fields measured from the account + vaults. */
export interface PumpSwapPoolSnapshot {
  readonly address: PublicKey;
  readonly owner: PublicKey;
  readonly creator: PublicKey;
  readonly poolAuthority: PublicKey;
  readonly baseMint: PublicKey;
  readonly quoteMint: PublicKey;
  readonly baseVault: PublicKey;
  readonly quoteVault: PublicKey;
  readonly coinCreator: PublicKey;
  readonly isMayhem: boolean;
  readonly isCashback: boolean;
  readonly dataLength: number;
  /** Signed i128. Measured zero when the 16-byte field is absent. */
  readonly virtualQuoteReserves: BN;
  readonly virtualQuotePresent: boolean;
  readonly baseVaultAmount: BN;
  readonly quoteVaultAmount: BN;
  readonly baseTokenProgram: PublicKey;
  readonly quoteTokenProgram: PublicKey;
  /** Vault quote + signed virtual. Rejected when non-positive. */
  readonly effectiveQuoteLamports: BN;
}

/** Raw KEKBULL amounts that floor-mint exactly `ichorAmount`. */
export interface KekbullEmissionInterval {
  readonly minRaw: BN;
  readonly maxRaw: BN;
}

export interface IchorSolSeedPlanSources {
  readonly ichorProgram: PublicKey;
  readonly config: PublicKey;
  readonly kekbullMint: PublicKey;
  readonly ichorMint: PublicKey;
  readonly pumpProgram: PublicKey;
  readonly pumpSwapProgram: PublicKey;
  readonly pool: PublicKey;
  readonly poolAuthority: PublicKey;
  readonly baseVault: PublicKey;
  readonly quoteVault: PublicKey;
  readonly seedOwner: PublicKey;
  readonly ichorAta: PublicKey;
  readonly nativeMint: PublicKey;
}

/**
 * Chain-derived ICHOR/SOL seed plan. Every reserve, decimal, and ratio is
 * measured. SOL amounts are raw native-mint units (lamports on wSOL).
 */
export interface IchorSolSeedPlan {
  readonly verifiedConfig: VerifiedIchorConfig;
  /** Target net selected by the operator. */
  readonly ichorAmount: BN;
  /** Minimal gross debit needed to achieve the target under the live fee. */
  readonly ichorGrossAmount: BN;
  readonly ichorExpectedTransferFee: BN;
  /** Actual net credit; can exceed target by integer rounding only. */
  readonly ichorNetAmount: BN;
  readonly transferFeeEpoch: BN;
  readonly adjustmentBps: number;
  readonly kekbullMint: MintSnapshot;
  readonly ichorMint: MintSnapshot;
  readonly nativeMint: MintSnapshot;
  readonly emissionNumerator: BN;
  readonly emissionDenominator: BN;
  readonly kekbullInterval: KekbullEmissionInterval;
  readonly pool: PumpSwapPoolSnapshot;
  readonly rawParityFloorLamports: BN;
  readonly rawParityCeilingLamports: BN;
  readonly adjustedSolFloorLamports: BN;
  readonly adjustedSolCeilingLamports: BN;
  /**
   * Explicitly adjusted SOL seed: adjusted floor of the measured parity
   * interval. Stays at or below the lower raw-parity bound when bps <= 0.
   */
  readonly adjustedSolLamports: BN;
  readonly rounding: {
    readonly emissionImage: "floor";
    readonly parityFloor: IntegerRoundingDirection;
    readonly parityCeiling: IntegerRoundingDirection;
    readonly adjustmentFloor: IntegerRoundingDirection;
    readonly adjustmentCeiling: IntegerRoundingDirection;
  };
  readonly seedOwner: PublicKey;
  readonly ichorAta: PublicKey;
  readonly ichorAtaAmount: BN;
  readonly solLamports: BN;
  readonly sources: IchorSolSeedPlanSources;
}

export interface MeteoraFeePlan {
  /**
   * Constant-fee DAMM v2 time scheduler. RateLimiter is rejected by 1.4.6
   * for new pools (`getBaseFeeParams` throws).
   */
  readonly startingFeeBps: number;
  readonly endingFeeBps: number;
  readonly numberOfPeriod: number;
  readonly totalDuration: number;
  readonly scheduler: "linear" | "exponential";
  /** When set, passed to `getDynamicFeeParams`. Omitted means `dynamicFee: null`. */
  readonly dynamicFeeBaseBps?: number;
}

export interface BuildIchorSolPoolParams {
  readonly connection: Connection;
  readonly payer: PublicKey;
  /** Must equal `payer` for atomic permanent-lock bootstrap. */
  readonly creator: PublicKey;
  /** Position NFT mint pubkey. The matching keypair signs later, outside this client. */
  readonly positionNftMint: PublicKey;
  /** Issued by `planIchorSolSeed`; caller-created lookalikes are rejected. */
  readonly seedPlan: IchorSolSeedPlan;
  readonly fee: MeteoraFeePlan;
  readonly activationType: 0 | 1;
  readonly activationPoint: BN | null;
  /** 0 BothToken · 1 OnlyB. Mode 2 Compounding is refused (compoundingFeeBps hardcoded 0). */
  readonly collectFeeMode: 0 | 1;
}

export interface IchorSolPoolBootstrap {
  readonly unsigned: UnsignedTransactionBuild;
  readonly pool: PublicKey;
  readonly position: PublicKey;
  readonly positionNftMint: PublicKey;
  readonly tokenAMint: PublicKey;
  readonly tokenBMint: PublicKey;
  readonly tokenAProgram: PublicKey;
  readonly tokenBProgram: PublicKey;
  readonly ichorMint: MintSnapshot;
  readonly solMint: MintSnapshot;
  readonly initSqrtPrice: BN;
  readonly liquidityDelta: BN;
  readonly isLockLiquidity: true;
  /** Seed-plan ICHOR transfer amount before Token-2022 fee. */
  readonly tokenAGrossAmount: BN;
  /** Epoch fee on the seed-plan ICHOR transfer. */
  readonly tokenAExpectedFee: BN;
  /** Seed-plan ICHOR after Token-2022 fee. */
  readonly tokenANetAmount: BN;
}

export interface PermanentLockVerification {
  readonly position: PublicKey;
  readonly pool: PublicKey;
  readonly liquidity: BN;
  readonly unlockedLiquidity: BN;
  readonly vestedLiquidity: BN;
  readonly permanentLockedLiquidity: BN;
  readonly expectedLiquidity: BN;
  /** Present only when the lock verified; `verifyPermanentLock` throws otherwise. */
  readonly isFullyPermanentlyLocked: true;
}

/** Measured DAMM vault balances behind a verified permanent lock. Not liquidityDelta. */
export interface LockedDammPoolTokens {
  readonly lock: PermanentLockVerification;
  readonly ichorMint: PublicKey;
  readonly solMint: PublicKey;
  readonly ichorVault: PublicKey;
  readonly solVault: PublicKey;
  readonly ichorAmount: BN;
  readonly solAmount: BN;
  readonly ichorDecimals: number;
  readonly solDecimals: number;
  readonly poolLiquidity: BN;
  readonly positionOwnsFullPool: boolean;
  /**
   * `poolFees.protocolFeePercent` from the live pool. Meteora takes this
   * share off the top; the DAO position receives the remainder (100 − this).
   * Not operator-tunable. Never hardcoded.
   */
  readonly protocolFeePercent: number;
  readonly positionNftMint: PublicKey;
  readonly treasuryPositionNftAta: PublicKey;
  /** Present only when the derived treasury ATA holds exactly 1 position NFT. */
  readonly treasuryHoldsPositionNft: true;
}

export interface ClaimFeesToTreasuryParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly pool: PublicKey;
  readonly position: PublicKey;
  readonly positionNftMint: PublicKey;
  /**
   * Ignored. Insert 0 ATA creates always use the derived native treasury as
   * `feePayer` so the SDK marks that PDA as signer (measured §5b shape).
   */
  readonly feePayer?: PublicKey;
}

/**
 * Two-insert claim (§5b). `insert0` is the ATA creates (treasury payer);
 * `insert1` is ClaimPositionFee + CloseAccount unwrap. `transaction` is the
 * original 4-ix SDK bundle - fallback only; one insert overflows 1573 > 1232.
 */
export interface ClaimFeesToTreasuryBuild {
  readonly insert0: Transaction;
  readonly insert1: Transaction;
  readonly transaction: Transaction;
  readonly pool: PublicKey;
  readonly receiver: PublicKey;
  readonly owner: PublicKey;
  readonly positionNftAccount: PublicKey;
}

/**
 * Council-only bootstrap. Community vote threshold is Disabled and community
 * proposal creation is u64 max. Those fields are not caller-configurable here.
 * Council yes/veto thresholds are YesVotePercentage and must be 1-100
 * (SPL Governance rejects YesVotePercentage(0)).
 */
export interface BootstrapCouncilConfig {
  readonly councilMint: PublicKey;
  /** YesVotePercentage; 1-100 inclusive. */
  readonly councilVoteThresholdPercent: number;
  /** YesVotePercentage; 1-100 inclusive. */
  readonly councilVetoVoteThresholdPercent: number;
  readonly minCouncilTokensToCreateProposal: BN;
  readonly minCommunityWeightToCreateGovernance: BN;
  /** Seconds. Must be > 0. */
  readonly baseVotingTime: number;
  /** Seconds. Must be > 0. */
  readonly minInstructionHoldUpTime: number;
  readonly votingCoolOffTime: number;
  readonly depositExemptProposalCount: number;
}

/**
 * Community-live governance config. Community yes-threshold and min tokens
 * are operator-supplied. Council vote thresholds are Disabled at create
 * (parked undeposited council unit cannot vote). Optional council percents are
 * accepted for later parameter-fix payloads; they do not enable council.
 */
export interface CommunityActivationConfig {
  /** YesVotePercentage; 1-100 inclusive. */
  readonly communityVoteThresholdPercent: number;
  readonly minCommunityTokensToCreateProposal: BN;
  /** Optional; ignored by communityActivationGovernanceConfig (council Disabled). */
  readonly councilVoteThresholdPercent?: number;
  /** Optional; ignored by communityActivationGovernanceConfig (council Disabled). */
  readonly councilVetoVoteThresholdPercent?: number;
  readonly minCouncilTokensToCreateProposal: BN;
  readonly baseVotingTime: number;
  readonly minInstructionHoldUpTime: number;
  readonly votingCoolOffTime: number;
  readonly depositExemptProposalCount: number;
}

/**
 * Operator-supplied community max voter-weight source. No default.
 * `supply-fraction` uses the Realms 10^10 fraction base; `absolute` is raw weight.
 * FULL_SUPPLY is refused at build time - locked LP + treasury ICHOR cannot vote.
 */
export type MintMaxVoteWeightSourceKind = "absolute" | "supply-fraction";

export interface CommunityMintMaxVoteWeightSource {
  readonly type: MintMaxVoteWeightSourceKind;
  readonly value: BN;
}

export interface BuildRealmParams {
  readonly verifiedConfig: VerifiedIchorConfig;
  readonly realmName: string;
  readonly realmAuthority: PublicKey;
  readonly payer: PublicKey;
  readonly councilMint: PublicKey;
  readonly minCommunityWeightToCreateGovernance: BN;
  readonly communityMintMaxVoteWeightSource: CommunityMintMaxVoteWeightSource;
}

export interface BuildNativeTreasuryParams {
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly payer: PublicKey;
}

export interface BuildTreasuryTokenAccountParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly payer: PublicKey;
  readonly mint: PublicKey;
}

export interface DepositIchorVoteParams {
  readonly connection: Connection;
  readonly verifiedRealm: VerifiedRealm;
  readonly tokenSourceAccount: PublicKey;
  readonly tokenOwner: PublicKey;
  readonly sourceAuthority: PublicKey;
  readonly payer: PublicKey;
  /** Raw transferred ICHOR. Vote weight is the net after get_current_mint_fee. */
  readonly amount: BN;
}

export interface DepositCouncilVoteParams {
  readonly verifiedRealm: VerifiedRealm;
  readonly tokenSourceAccount: PublicKey;
  readonly tokenOwner: PublicKey;
  readonly sourceAuthority: PublicKey;
  readonly payer: PublicKey;
  readonly amount: BN;
}

export interface BuildCreateGovernanceParams {
  readonly verifiedRealm: VerifiedRealm;
  readonly config: CommunityActivationConfig;
  readonly tokenOwnerRecord: PublicKey;
  readonly payer: PublicKey;
  readonly createAuthority: PublicKey;
  readonly governedAccount?: PublicKey;
  /** Required on mainnet-beta so the 10_000 ICHOR proposal floor scales from the live mint. */
  readonly ichorDecimals?: number;
}

export interface BuildRemoveCouncilParams {
  readonly connection: Connection;
  /** Governance must already be the live Realm authority. */
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
}

/**
 * Direct bootstrap handoff: current Realm authority → verified Governance PDA.
 * Destination comes only from the issued identity; never from caller input.
 */
export interface BuildTransferRealmAuthorityParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  /** Live bootstrap Realm authority that must sign. */
  readonly currentAuthority: PublicKey;
}

/** Community Yes/No only. Built with `Vote.fromYesNoVote`; not VSR/quadratic. */
export type CommunityYesNoChoice = "yes" | "no";

export interface CastCommunityVoteParams {
  readonly verifiedGovernance: VerifiedGovernance;
  readonly proposal: PublicKey;
  readonly proposalOwnerRecord: PublicKey;
  readonly tokenOwnerRecord: PublicKey;
  readonly governanceAuthority: PublicKey;
  readonly payer: PublicKey;
  readonly choice: CommunityYesNoChoice;
}

/** Council Yes/No during bootstrap. Uses council mint, not community mint. */
export interface CastCouncilVoteParams {
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly proposal: PublicKey;
  readonly proposalOwnerRecord: PublicKey;
  readonly tokenOwnerRecord: PublicKey;
  readonly governanceAuthority: PublicKey;
  readonly payer: PublicKey;
  readonly choice: CommunityYesNoChoice;
}

export interface RelinquishCommunityVoteParams {
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly proposal: PublicKey;
  readonly tokenOwnerRecord: PublicKey;
  readonly voteRecord: PublicKey;
  readonly governanceAuthority?: PublicKey;
  readonly beneficiary?: PublicKey;
}

/**
 * One standing (not-yet-relinquished) community VoteRecord for a wallet.
 * Measured from getVoteRecordsByVoter + the live Proposal account.
 */
export interface StandingCommunityVote {
  readonly proposal: PublicKey;
  readonly voteRecord: PublicKey;
  readonly tokenOwnerRecord: PublicKey;
  readonly proposalState: number;
  readonly proposalStateName: string;
  readonly proposalName: string;
  /** True when CastVote window is over but state is still Voting - Finalize first. */
  readonly needsFinalizeBeforeRelinquish: boolean;
}

export interface ListStandingCommunityVotesParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly governingTokenOwner: PublicKey;
}

export interface RelinquishStandingCommunityVotesParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly governingTokenOwner: PublicKey;
  /** Required when any standing vote is still inside an open Voting window. */
  readonly governanceAuthority: PublicKey;
  readonly beneficiary: PublicKey;
}

export interface RelinquishStandingCommunityVotesBuild extends UnsignedInstructionBuild {
  readonly standingCount: number;
  readonly proposalNames: readonly string[];
}

/**
 * One non-relinquished VoteRecord on a single proposal (any voter).
 * Measured via getGovernanceAccounts(VoteRecord) filtered by proposal.
 */
export interface UnrelinquishedVoteOnProposal {
  readonly voteRecord: PublicKey;
  readonly tokenOwnerRecord: PublicKey;
  readonly governingTokenOwner: PublicKey;
}

export interface ListUnrelinquishedVotesOnProposalParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly proposal: PublicKey;
}

/**
 * Permissionless RelinquishVote for every standing VoteRecord on a proposal
 * that is no longer Voting (Succeeded / Defeated / Completed / …). After the
 * window ends but before Finalize, Realms refuses Relinquish - Finalize first.
 */
export interface ReleaseVotesOnClosedProposalParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly proposal: PublicKey;
  /** Cap instructions per transaction (tx size). Default 8. */
  readonly maxReleases?: number;
}

export interface ReleaseVotesOnClosedProposalBuild extends UnsignedInstructionBuild {
  readonly releasedCount: number;
  readonly remainingCount: number;
  readonly proposalState: number;
  readonly proposalStateName: string;
}

/** Council RelinquishVote. Uses council mint; do not pass community mint. */
export interface RelinquishCouncilVoteParams {
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly proposal: PublicKey;
  readonly tokenOwnerRecord: PublicKey;
  readonly voteRecord: PublicKey;
  readonly governanceAuthority?: PublicKey;
  readonly beneficiary?: PublicKey;
}

/**
 * FinalizeVote after the voting window. `governingTokenMint` must be the
 * live community mint or the live council mint from the issued identity.
 *
 * When `connection` is passed (UI path), Finalize appends permissionless
 * RelinquishVote for standing VoteRecords on this proposal so voter deposits
 * unlock when the proposal ends - Realms does not clear them by itself.
 */
export interface FinalizeVoteParams {
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly proposal: PublicKey;
  readonly proposalOwnerRecord: PublicKey;
  readonly governingTokenMint: PublicKey;
  /** Required to discover and release VoteRecords after Finalize. */
  readonly connection?: Connection;
  /**
   * Default true when `connection` is set. Set false for finalize-only
   * (e2e / scripts that release separately).
   */
  readonly releaseVoterDeposits?: boolean;
  readonly maxReleases?: number;
}

export interface FinalizeVoteBuild extends UnsignedInstructionBuild {
  readonly releasedVoteCount: number;
  readonly remainingUnreleasedCount: number;
}

/**
 * SetRealmConfig Some(councilA) → Some(councilB). Refuses Some → None.
 * `buildRemoveCouncilInstruction` is the Some → None path and is not this.
 */
export interface SetRealmConfigCouncilMintParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly newCouncilMint: PublicKey;
  readonly payer: PublicKey;
}

/**
 * Withdraw deposited ICHOR. Destination is the owner's canonical Token-2022
 * ATA - not a caller-supplied account. If `governingTokenDestination` is
 * passed, it must equal that derived ATA.
 */
export interface WithdrawIchorVotesParams {
  readonly connection: Connection;
  readonly verifiedRealm: VerifiedRealm;
  readonly governingTokenDestination?: PublicKey;
  readonly governingTokenOwner: PublicKey;
  /**
   * When true, RelinquishVote for this wallet's standing votes is already
   * prepended in the same transaction - skip the live unrelinquished count
   * gate (chain state has not updated yet at build time).
   */
  readonly expectRelinquishInSameTransaction?: boolean;
}

/**
 * Relinquish this wallet's standing votes on finished proposals, then withdraw.
 * Active open-window votes still block; proposals past the window but still
 * Voting need Finalize first.
 */
export interface ReleaseStandingAndWithdrawIchorParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly governingTokenOwner: PublicKey;
  readonly governanceAuthority: PublicKey;
  readonly beneficiary: PublicKey;
  readonly governingTokenDestination?: PublicKey;
}

export interface ReleaseStandingAndWithdrawIchorBuild extends WithdrawIchorVotesBuild {
  readonly releasedStandingCount: number;
  readonly proposalNames: readonly string[];
}

/**
 * Withdraw bootstrap council deposits. Destination is the owner's canonical
 * legacy SPL ATA - not a caller-supplied account.
 */
export interface WithdrawCouncilVotesParams {
  readonly connection: Connection;
  readonly verifiedRealm: VerifiedRealm;
  readonly governingTokenOwner: PublicKey;
}

/**
 * Council or generic proposal. Realm and governance come from
 * `VerifiedGovernanceIdentity`. `governingTokenMint` and TokenOwnerRecord stay
 * the explicitly selected council (or other) mint/record. Community proposals
 * use `BuildCommunityProposalParams`.
 */
export interface BuildProposalParams {
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly tokenOwnerRecord: PublicKey;
  readonly governingTokenMint: PublicKey;
  readonly governanceAuthority: PublicKey;
  readonly payer: PublicKey;
  readonly name: string;
  readonly descriptionLink: string;
  readonly options: readonly string[];
  readonly useDenyOption: boolean;
  readonly proposalIndex?: number;
  readonly proposalSeed?: PublicKey;
}

/** Community proposal. Realm, mint, and governance come from VerifiedGovernance. */
export interface BuildCommunityProposalParams {
  readonly verifiedGovernance: VerifiedGovernance;
  readonly tokenOwnerRecord: PublicKey;
  readonly governanceAuthority: PublicKey;
  readonly payer: PublicKey;
  readonly name: string;
  readonly descriptionLink: string;
  readonly options: readonly string[];
  readonly useDenyOption: boolean;
  readonly proposalIndex?: number;
  readonly proposalSeed?: PublicKey;
}

export interface InsertProposalTransactionParams {
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly proposal: PublicKey;
  readonly tokenOwnerRecord: PublicKey;
  readonly governanceAuthority: PublicKey;
  readonly payer: PublicKey;
  readonly index: number;
  readonly optionIndex: number;
  readonly holdUpTime: number;
  readonly transactionInstructions: TransactionInstruction[];
}

/**
 * Issued only by `buildInsertProposalTransaction`. Carries the proposal
 * transaction PDA plus an immutable copy/fingerprint of the exact inner
 * instructions execute must replay. A structural lookalike is rejected.
 */
export interface StagedProposalActions {
  readonly transactionAddress: PublicKey;
  readonly proposal: PublicKey;
  readonly optionIndex: number;
  readonly index: number;
}

export interface InsertProposalTransactionBuild extends UnsignedInstructionBuild {
  readonly staged: StagedProposalActions;
}

export interface RecoverProposalTransactionParams {
  readonly connection: Connection;
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly proposal: PublicKey;
  readonly optionIndex: number;
  readonly index: number;
}

export interface RecoveredProposalTransaction {
  readonly staged: StagedProposalActions;
  readonly transactionInstructions: readonly TransactionInstruction[];
  readonly holdUpTime: number;
  readonly executedAt: BN | null;
  readonly executionStatus: number;
}

/**
 * Execute consumes the insert-issued staged actions. `transactionInstructions`
 * is the caller claim and must byte-equal the staged inner copy; execute
 * encodes the staged copy, not the claim.
 */
export interface ExecuteProposalTransactionParams {
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly proposal: PublicKey;
  readonly staged: StagedProposalActions;
  readonly transactionInstructions: TransactionInstruction[];
}

export interface BuildSignOffProposalParams {
  readonly verifiedGovernance: VerifiedGovernanceIdentity;
  readonly proposal: PublicKey;
  readonly signatory: PublicKey;
  readonly proposalOwnerRecord?: PublicKey;
}

/**
 * Exclusive operator-supplied token amount. No client default: omit it and
 * the defensive-stake composer refuses. `human` is scaled by the live mint
 * decimals; `raw` is already in base units.
 */
export type ExplicitTokenAmount =
  | { readonly kind: "raw"; readonly value: BN }
  | { readonly kind: "human"; readonly value: string };

export type DefensiveStakeComputePlan =
  | { readonly kind: "none" }
  | { readonly kind: "protocol-max-for-simulation" }
  | { readonly kind: "measured"; readonly unitsConsumed: number; readonly computeUnitLimit: number };

export type ComputeUnitsStatus =
  | { readonly status: "UNVERIFIED"; readonly reason: string }
  | {
      readonly status: "MEASURED";
      readonly unitsConsumed: number;
      readonly computeUnitLimit: number;
    };

/**
 * Packet size is measured offline from the exact legacy wire (one dummy
 * signature + a well-formed non-default size-only blockhash). That hash is
 * not current chain state and is never broadcast-ready. Distinct from CU,
 * which stays UNVERIFIED until on-cluster simulation.
 */
export type PacketSizeStatus = {
  readonly status: "MEASURED_OFFLINE";
  readonly packetBytes: number;
  readonly blockhash: string;
  readonly dummySignatureSlots: 1;
};

export type UnknownOrKnown<T> =
  | { readonly status: "unknown"; readonly reason: string }
  | ({ readonly status: "known" } & T);

export interface BuildAtomicDefensiveStakeParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
  readonly verifiedRealm: VerifiedRealm;
  readonly verifiedGovernanceIdentity: VerifiedGovernanceIdentity;
  readonly creator: PublicKey;
  readonly amount: ExplicitTokenAmount;
  readonly computePlan: DefensiveStakeComputePlan;
}

export interface VerifyAndBuildAtomicDefensiveStakeParams {
  readonly connection: Connection;
  readonly network: NetworkConfig;
  readonly ichorProgramId: PublicKey;
  readonly realm: PublicKey;
  readonly governance: PublicKey;
  readonly creator: PublicKey;
  readonly amount: ExplicitTokenAmount;
  readonly computePlan: DefensiveStakeComputePlan;
}

export interface DefensiveStakeAccountMeta {
  readonly pubkey: PublicKey;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
  readonly firstAppearance: number;
}

export interface AtomicDefensiveStakeBuild {
  readonly unsigned: UnsignedTransactionBuild;
  readonly instructions: readonly TransactionInstruction[];
  readonly requiredSignerPubkeys: readonly PublicKey[];
  readonly accountMetas: readonly DefensiveStakeAccountMeta[];
  readonly packet: PacketSizeStatus;
  readonly packetBytes: number;
  readonly fitsPacket: true;
  readonly computeUnits: ComputeUnitsStatus;
  readonly sendImplemented: false;
  readonly depositAmountSemantics: "gross";
  readonly kekbullAmount: BN;
  readonly expectedIchorGross: BN;
  readonly expectedMintFee: BN;
  readonly expectedTorNet: BN;
  readonly conversionRatio: { readonly numerator: BN; readonly denominator: BN };
  readonly kekbullFrom: PublicKey;
  readonly ichorTo: PublicKey;
  readonly tokenOwnerRecord: PublicKey;
  readonly groups: readonly ["unpause", "convert", "deposit", "repause"];
}

export interface LiveRealmConfigSnapshot {
  readonly realm: PublicKey;
  readonly realmAuthority: PublicKey;
  readonly communityMint: PublicKey;
  readonly councilMint: PublicKey | null;
  readonly communityMintMaxVoteWeightSource: CommunityMintMaxVoteWeightSource;
  readonly minCommunityTokensToCreateGovernance: BN;
  readonly communityTokenConfig: {
    readonly voterWeightAddin: PublicKey | undefined;
    readonly maxVoterWeightAddin: PublicKey | undefined;
    readonly tokenType: number;
  };
  readonly councilTokenConfig: {
    readonly voterWeightAddin: PublicKey | undefined;
    readonly maxVoterWeightAddin: PublicKey | undefined;
    readonly tokenType: number;
  };
}

export interface BuildSetRealmConfigEmergencyBrakeParams {
  readonly connection: Connection;
  readonly verified: VerifiedNetwork;
  readonly realm: PublicKey;
  readonly realmAuthority: PublicKey;
}

export interface BuildRestoreRealmConfigVoteWeightSourceParams {
  readonly connection: Connection;
  readonly verified: VerifiedNetwork;
  readonly realm: PublicKey;
  readonly realmAuthority: PublicKey;
  readonly priorSource: CommunityMintMaxVoteWeightSource;
}

export interface ActivationBarReadParams {
  readonly connection: Connection;
  readonly verifiedConfig: VerifiedIchorConfig;
  readonly verifiedRealm: VerifiedRealm;
  readonly creator: PublicKey;
  readonly kekbullAmount?: ExplicitTokenAmount;
  readonly barHeldSinceUnixTs?: number;
}

export interface ActivationBarModel {
  readonly ichorSupply: BN;
  /** Live mint decimals. Fetched; never assumed. */
  readonly ichorDecimals: number;
  readonly yesFloorCeilSOver20: BN;
  readonly communityMintMaxVoteWeightSource: CommunityMintMaxVoteWeightSource;
  readonly currentMaxVoterWeight: BN;
  readonly creatorDefensiveNet: BN;
  readonly distinctPositiveCommunityTorCount: {
    readonly status: "unknown";
    readonly reason: string;
  };
  readonly conversionRatio: { readonly numerator: BN; readonly denominator: BN };
  readonly kekbullAmount: UnknownOrKnown<{ readonly raw: BN; readonly decimals: number }>;
  readonly solAcquisitionQuote: UnknownOrKnown<{
    readonly source: "pumpswap-reserves";
    readonly lamports: BN;
    readonly pool: PublicKey;
    readonly baseVaultAmount: BN;
    readonly effectiveQuoteLamports: BN;
  }>;
  readonly barHeldSinceUnixTs: UnknownOrKnown<{ readonly unixTs: number }>;
}

export class ClientValidationError extends Error {
  readonly code: string;
  readonly details: readonly string[];

  constructor(code: string, details: readonly string[]) {
    super(`${code}: ${details.join("; ")}`);
    this.name = "ClientValidationError";
    this.code = code;
    this.details = details;
  }
}
