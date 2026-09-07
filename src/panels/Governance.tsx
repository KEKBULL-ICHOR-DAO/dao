import {
  CLUSTER_GENESIS_HASH,
  ClientValidationError,
  assertNoSecretMaterial,
  buildAcceptAuthorityAsGovernance,
  buildApplyEmissionRatio,
  buildCancelPendingRatio,
  buildCastCommunityVote,
  buildCommunityActivationInstruction,
  buildCreateCommunityProposal,
  buildDepositIchorVotes,
  buildExecuteProposalTransaction,
  buildFreezeRatioUpdates,
  buildIncreaseRatioTimelock,
  buildInsertProposalTransaction,
  buildProposeEmissionRatio,
  buildRelinquishCommunityVote,
  buildRemoveCouncilInstruction,
  buildRevokeTransferFeeAuthority,
  buildSetPaused,
  buildSetPendingAuthorityToGovernance,
  buildSignOffProposal,
  buildTransferProgramUpgradeAuthorityToGovernance,
  buildTransferRealmAuthorityToGovernance,
  buildUpgradeIchorProgram,
  buildWithdrawIchorVotes,
  readCommunityGoverningTokenDeposit,
  requireNonNegativeInt,
  requireYesVotePercent,
  requirePositiveBn,
  requirePositiveInt,
  requirePublicKey,
  recoverProposalTransaction,
  type BuildSignOffProposalParams,
  type CommunityActivationConfig,
  type CommunityYesNoChoice,
  type ExecuteProposalTransactionParams,
  type InsertProposalTransactionParams,
  type VerifiedGovernance,
  type VerifiedGovernanceIdentity,
  type VerifiedRealm,
} from "@kekbull/ichor-client";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { fetchBoundMintSnapshot } from "../chain.ts";
import type { DeploymentConfig } from "../config.ts";
import { formatError, parsePositiveDecimalIntegerString, parseUiToBaseUnits } from "../format.ts";
import {
  payloadReview,
  sameInstructionBytes,
  type InsertedProposalSession,
  type StagedGovernanceAction,
  type UnsignedPayload,
} from "../send.ts";
import type { PreflightState } from "./Preflight.tsx";

function parseStrictNonNegativeInteger(value: string, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ClientValidationError("INVALID_INT", [
      `${label} must be a strict non-negative decimal integer (no sign, whitespace, decimal point, leading zero, or exponent)`,
    ]);
  }
  return requireNonNegativeInt(Number(value), label);
}

function parseHexBytes(value: string, label: string): Uint8Array {
  if (typeof value !== "string") {
    throw new ClientValidationError("INVALID_HEX", [`${label} must be a hex string`]);
  }
  const trimmed = value.trim();
  const hex = /^(?:0x|0X)/.test(trimmed) ? trimmed.slice(2) : trimmed;
  if (hex.length % 2 !== 0) {
    throw new ClientValidationError("INVALID_HEX", [`${label} hex length is odd`]);
  }
  if (hex.length > 0 && !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new ClientValidationError("INVALID_HEX", [`${label} is not hexadecimal`]);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function parseGenericAccountMetas(json: string): AccountMeta[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ClientValidationError("INVALID_JSON", ["accounts is not valid JSON"]);
  }
  if (!Array.isArray(parsed)) {
    throw new ClientValidationError("INVALID_ACCOUNT_META", ["accounts must be a JSON array"]);
  }
  return parsed.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new ClientValidationError("INVALID_ACCOUNT_META", [
        `accounts[${String(index)}] must be an object`,
      ]);
    }
    const record = item as Record<string, unknown>;
    assertNoSecretMaterial(record, `accounts[${String(index)}]`);
    if (!("pubkey" in record) || !("isSigner" in record) || !("isWritable" in record)) {
      throw new ClientValidationError("INVALID_ACCOUNT_META", [
        `accounts[${String(index)}] missing pubkey, isSigner, or isWritable`,
      ]);
    }
    if (typeof record.isSigner !== "boolean" || typeof record.isWritable !== "boolean") {
      throw new ClientValidationError("INVALID_ACCOUNT_META", [
        `accounts[${String(index)}] isSigner/isWritable must be boolean`,
      ]);
    }
    return {
      pubkey: requirePublicKey(record.pubkey, `accounts[${String(index)}].pubkey`),
      isSigner: record.isSigner,
      isWritable: record.isWritable,
    };
  });
}

function parseGenericInnerInstruction(params: {
  programId: string;
  accountsJson: string;
  dataHex: string;
}): TransactionInstruction {
  assertNoSecretMaterial(params, "parseGenericInnerInstruction");
  const programId = requirePublicKey(params.programId, "programId");
  const keys = parseGenericAccountMetas(params.accountsJson);
  const data = parseHexBytes(params.dataHex, "data");
  return new TransactionInstruction({
    programId,
    keys,
    data: data as TransactionInstruction["data"],
  });
}

export const MAINNET_UNPAUSE_REFUSED =
  "MAINNET_UNPAUSE_REFUSED: verified mainnet cannot stage or send set_paused(false) through wallet.signTransaction. Use the phase-pinned mainnet-F open-conversion signer (ichor_mainnet_f_signer / open-conversion).";

export function assertWalletUnpauseAllowed(params: {
  readonly cluster?: string | null;
  readonly verifiedCluster?: string | null;
  readonly verifiedGenesis?: string | null;
}): void {
  if (
    params.cluster === "mainnet-beta" ||
    params.verifiedCluster === "mainnet-beta" ||
    params.verifiedGenesis === CLUSTER_GENESIS_HASH["mainnet-beta"]
  ) {
    throw new Error(MAINNET_UNPAUSE_REFUSED);
  }
  const rehearsal =
    params.cluster === "devnet" ||
    params.cluster === "localnet" ||
    params.verifiedCluster === "devnet" ||
    params.verifiedCluster === "localnet";
  if (!rehearsal) {
    throw new Error(MAINNET_UNPAUSE_REFUSED);
  }
}

export function walletUnpauseAvailable(params: {
  readonly cluster?: string | null;
  readonly verifiedCluster?: string | null;
  readonly verifiedGenesis?: string | null;
}): boolean {
  try {
    assertWalletUnpauseAllowed(params);
    return true;
  } catch {
    return false;
  }
}

export function Governance(props: {
  config: DeploymentConfig;
  preflight: PreflightState;
  stagedAction: StagedGovernanceAction | null;
  insertedSession: InsertedProposalSession | null;
  onStageAction: (payload: StagedGovernanceAction) => void;
  onClearStagedAction: () => void;
  onInsertedSession: (session: InsertedProposalSession) => void;
  onRequestSend: (payload: UnsignedPayload) => void;
  /** Operator console only. Holder page keeps deposit / propose / vote / insert. */
  operatorView?: boolean;
}) {
  const operatorView = props.operatorView ?? true;
  const { connection } = useConnection();
  const wallet = useWallet();
  const [depositUi, setDepositUi] = useState("");
  const [proposalName, setProposalName] = useState("");
  const [proposalLink, setProposalLink] = useState("");
  const [proposalOptions, setProposalOptions] = useState("Approve");
  const [tokenOwnerRecord, setTokenOwnerRecord] = useState(
    props.config.communityTokenOwnerRecord ?? "",
  );
  const [proposalOwnerRecord, setProposalOwnerRecord] = useState("");
  const [proposalAddress, setProposalAddress] = useState("");
  const [voteRecord, setVoteRecord] = useState("");
  const [executeTxAddress, setExecuteTxAddress] = useState("");
  const [insertIndex, setInsertIndex] = useState("0");
  const [optionIndex, setOptionIndex] = useState("0");
  const [holdUpTime, setHoldUpTime] = useState("1");
  const [communityVoteThresholdPercent, setCommunityVoteThresholdPercent] = useState("");
  const [minCommunityTokensToCreateProposal, setMinCommunityTokensToCreateProposal] =
    useState("");
  const [councilVoteThresholdPercent, setCouncilVoteThresholdPercent] = useState("");
  const [councilVetoVoteThresholdPercent, setCouncilVetoVoteThresholdPercent] = useState("");
  const [minCouncilTokensToCreateProposal, setMinCouncilTokensToCreateProposal] = useState("");
  const [baseVotingTime, setBaseVotingTime] = useState("");
  const [minInstructionHoldUpTime, setMinInstructionHoldUpTime] = useState("");
  const [votingCoolOffTime, setVotingCoolOffTime] = useState("");
  const [depositExemptProposalCount, setDepositExemptProposalCount] = useState("");
  const [upgradeBuffer, setUpgradeBuffer] = useState("");
  const [genericProgramId, setGenericProgramId] = useState("");
  const [genericAccountsJson, setGenericAccountsJson] = useState("");
  const [genericDataHex, setGenericDataHex] = useState("");
  const [emissionNumerator, setEmissionNumerator] = useState("");
  const [emissionDenominator, setEmissionDenominator] = useState("");
  const [newRatioTimelockSecs, setNewRatioTimelockSecs] = useState("");
  const [lastDerived, setLastDerived] = useState<string | null>(null);
  const [governanceTransferPreview, setGovernanceTransferPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activationNotice, setActivationNotice] = useState<string | null>(null);
  const [activationOk, setActivationOk] = useState(false);
  const [insertNotice, setInsertNotice] = useState<string | null>(null);
  const [insertOk, setInsertOk] = useState(false);
  const passed = props.preflight.status === "passed" ? props.preflight : null;
  const verifiedRealm = passed?.verifiedRealm ?? null;
  const verifiedGovernance = passed?.verifiedGovernance ?? null;
  const verifiedGovernanceIdentity = passed?.verifiedGovernanceIdentity ?? null;
  const verifiedIchorProgram = passed?.verifiedIchorProgram ?? null;
  const verifiedIchorConfig = passed?.verifiedIchorConfig ?? null;
  const voteReady = Boolean(verifiedGovernance && wallet.publicKey);
  const identityReady = Boolean(verifiedGovernanceIdentity && wallet.publicKey);
  const ichorUpgradeReady = Boolean(verifiedIchorProgram && verifiedGovernanceIdentity);
  const configAuthorityReady = Boolean(
    verifiedIchorConfig && verifiedGovernanceIdentity && wallet.publicKey,
  );
  const unpauseIdentity = {
    cluster: props.config.cluster,
    verifiedCluster: verifiedIchorConfig?.verifiedProgram.verified.network.cluster ?? null,
    verifiedGenesis: verifiedIchorConfig?.verifiedProgram.verified.genesisHash ?? null,
  };
  const showWalletUnpause = walletUnpauseAvailable(unpauseIdentity);

  function recordDerived(built: { derivedAddresses: Record<string, { toBase58(): string }> }): void {
    const lines = Object.entries(built.derivedAddresses).map(
      ([name, key]) => `${name}=${key.toBase58()}`,
    );
    setLastDerived(lines.join("\n"));
    const tor = built.derivedAddresses.tokenOwnerRecord;
    if (tor) {
      setTokenOwnerRecord(tor.toBase58());
    }
    const proposal = built.derivedAddresses.proposal;
    if (proposal) {
      setProposalAddress(proposal.toBase58());
    }
    const record = built.derivedAddresses.voteRecord;
    if (record) {
      setVoteRecord(record.toBase58());
    }
  }

  function requireRealm(): {
    verifiedRealm: VerifiedRealm;
    owner: NonNullable<typeof wallet.publicKey>;
  } {
    if (!passed) {
      throw new Error("preflight has not passed");
    }
    if (!passed.verifiedRealm) {
      throw new Error(
        passed.realmReason ??
          "VerifiedRealm missing; deposit/withdraw/relinquish stay disabled until verifyRealmDeployment issues a proof",
      );
    }
    if (!wallet.publicKey) {
      throw new Error("connect a wallet; this app never receives private keys");
    }
    return { verifiedRealm: passed.verifiedRealm, owner: wallet.publicKey };
  }

  function requireGovernance(): {
    verifiedGovernance: VerifiedGovernance;
    owner: NonNullable<typeof wallet.publicKey>;
  } {
    if (!passed) {
      throw new Error("preflight has not passed");
    }
    if (!passed.verifiedGovernance) {
      throw new Error(
        passed.governanceReason ??
          "VerifiedGovernance missing; propose/vote stay disabled until verifyGovernanceDeployment issues a proof",
      );
    }
    if (!wallet.publicKey) {
      throw new Error("connect a wallet; this app never receives private keys");
    }
    return { verifiedGovernance: passed.verifiedGovernance, owner: wallet.publicKey };
  }

  function requireGovernanceIdentity(): {
    verifiedGovernance: VerifiedGovernanceIdentity;
    owner: NonNullable<typeof wallet.publicKey>;
  } {
    if (!passed?.verifiedGovernanceIdentity) {
      throw new Error(
        passed?.governanceReason ??
          "VerifiedGovernanceIdentity is required for this Governance account",
      );
    }
    if (!wallet.publicKey) {
      throw new Error("connect a wallet; this app never receives private keys");
    }
    return {
      verifiedGovernance: passed.verifiedGovernanceIdentity,
      owner: wallet.publicKey,
    };
  }

  function resolveConfigAdminAuthority(): {
    authority: NonNullable<typeof wallet.publicKey>;
    mode: "recovery" | "proposal";
  } {
    if (!verifiedIchorConfig || !verifiedGovernanceIdentity) {
      throw new Error(
        passed?.ichorReason ??
          passed?.governanceReason ??
          "VerifiedIchorConfig and VerifiedGovernanceIdentity are required for Config admin actions",
      );
    }
    if (!wallet.publicKey) {
      throw new Error("connect a wallet; this app never receives private keys");
    }
    const live = verifiedIchorConfig.config.authority;
    const governance = verifiedGovernanceIdentity.governance;
    if (live.equals(governance)) {
      return { authority: governance, mode: "proposal" };
    }
    if (live.equals(wallet.publicKey)) {
      return { authority: wallet.publicKey, mode: "recovery" };
    }
    throw new Error(
      `CONFIG_AUTHORITY_MISMATCH: live config.authority ${live.toBase58()} is neither the connected wallet nor Governance ${governance.toBase58()}`,
    );
  }

  function dispatchConfigAdmin(
    label: string,
    built: { instructions: UnsignedPayload["instructions"]; derivedAddresses: UnsignedPayload["derivedAddresses"] },
    mode: "recovery" | "proposal",
  ): void {
    recordDerived(built);
    if (mode === "proposal") {
      props.onStageAction({
        label,
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
      return;
    }
    props.onRequestSend({
      label: `${label} (recovery window)`,
      instructions: built.instructions,
      derivedAddresses: built.derivedAddresses,
    });
  }

  async function communityTokenAta(
    verifiedRealm: VerifiedRealm,
    owner: NonNullable<typeof wallet.publicKey>,
  ) {
    const mint = await fetchBoundMintSnapshot(
      connection,
      verifiedRealm.verified,
      verifiedRealm.communityMint,
    );
    return getAssociatedTokenAddressSync(mint.mint, owner, false, mint.ownerProgram);
  }

  async function buildDeposit(): Promise<void> {
    setError(null);
    try {
      const { verifiedRealm, owner } = requireRealm();
      const mint = await fetchBoundMintSnapshot(
        connection,
        verifiedRealm.verified,
        verifiedRealm.communityMint,
      );
      const amount = parseUiToBaseUnits(depositUi, mint.decimals);
      const tokenSourceAccount = getAssociatedTokenAddressSync(
        mint.mint,
        owner,
        false,
        mint.ownerProgram,
      );
      const built = await buildDepositIchorVotes({
        connection,
        verifiedRealm,
        tokenSourceAccount,
        tokenOwner: owner,
        sourceAuthority: owner,
        payer: owner,
        amount,
      });
      const payload: UnsignedPayload = {
        label: "deposit ICHOR votes",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      };
      recordDerived(built);
      setGovernanceTransferPreview(
        `Deposit gross ${built.transfer.amount.toString(10)}; expected withheld fee ${built.transfer.expectedMintFee.toString(10)}; voting weight credited ${built.transfer.expectedNet.toString(10)} base units.`,
      );
      props.onRequestSend(payload);
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function buildWithdraw(): Promise<void> {
    setError(null);
    try {
      const { verifiedRealm, owner } = requireRealm();
      const destination = await communityTokenAta(verifiedRealm, owner);
      const built = await buildWithdrawIchorVotes({
        connection,
        verifiedRealm,
        governingTokenDestination: destination,
        governingTokenOwner: owner,
      });
      const payload: UnsignedPayload = {
        label: "withdraw deposited ICHOR",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      };
      recordDerived(built);
      setGovernanceTransferPreview(
        `Withdrawal gross ${built.transfer.amount.toString(10)}; expected withheld fee ${built.transfer.expectedMintFee.toString(10)}; wallet receives ${built.transfer.expectedNet.toString(10)} base units.`,
      );
      props.onRequestSend(payload);
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function buildProposal(): Promise<void> {
    setError(null);
    try {
      const { verifiedGovernance, owner } = requireGovernance();
      if (!tokenOwnerRecord.trim()) {
        throw new Error("token owner record is unknown; deposit first or paste the live PDA");
      }
      const options = proposalOptions
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const built = await buildCreateCommunityProposal({
        verifiedGovernance,
        tokenOwnerRecord: requirePublicKey(tokenOwnerRecord, "tokenOwnerRecord"),
        governanceAuthority: owner,
        payer: owner,
        name: proposalName,
        descriptionLink: proposalLink,
        options,
        useDenyOption: true,
      });
      const payload: UnsignedPayload = {
        label: "create community proposal",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      };
      recordDerived(built);
      props.onRequestSend(payload);
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function buildSignOff(): Promise<void> {
    setError(null);
    try {
      const { verifiedGovernance, owner } = requireGovernanceIdentity();
      if (!proposalAddress.trim()) {
        throw new Error("proposal address is required");
      }
      const signOff: BuildSignOffProposalParams = {
        verifiedGovernance,
        proposal: requirePublicKey(proposalAddress, "proposal"),
        signatory: owner,
        ...(tokenOwnerRecord.trim()
          ? { proposalOwnerRecord: requirePublicKey(tokenOwnerRecord, "tokenOwnerRecord") }
          : {}),
      };
      const built = await buildSignOffProposal(signOff);
      const payload: UnsignedPayload = {
        label: "sign off proposal",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      };
      recordDerived(built);
      props.onRequestSend(payload);
    } catch (err) {
      setError(formatError(err));
    }
  }

  /**
   * Live baseVotingTime on this throwaway is 30s. Phantom confirm on Sign off alone
   * routinely burns the whole window. Same-tx Sign off then CastVote Yes: voting
   * opens and the Yes lands atomically (Solana applies ixs in order).
   */
  async function buildSignOffAndVoteYes(): Promise<void> {
    setError(null);
    try {
      const { verifiedGovernance, owner } = requireGovernance();
      const { verifiedGovernance: identity } = requireGovernanceIdentity();
      if (!proposalAddress.trim()) {
        throw new Error("proposal address is required");
      }
      const tor = tokenOwnerRecord.trim()
        ? tokenOwnerRecord.trim()
        : await resolveConnectedTokenOwnerRecord();
      const ownerRecord = proposalOwnerRecord.trim() || tor;
      const proposal = requirePublicKey(proposalAddress, "proposal");
      const signOff = await buildSignOffProposal({
        verifiedGovernance: identity,
        proposal,
        signatory: owner,
        proposalOwnerRecord: requirePublicKey(tor, "tokenOwnerRecord"),
      });
      const vote = await buildCastCommunityVote({
        verifiedGovernance,
        proposal,
        proposalOwnerRecord: requirePublicKey(ownerRecord, "proposalOwnerRecord"),
        tokenOwnerRecord: requirePublicKey(tor, "tokenOwnerRecord"),
        governanceAuthority: owner,
        payer: owner,
        choice: "yes",
      });
      const built = {
        instructions: [...signOff.instructions, ...vote.instructions],
        derivedAddresses: { ...signOff.derivedAddresses, ...vote.derivedAddresses },
      };
      recordDerived(built);
      props.onRequestSend({
        label: "sign off + vote Yes (one tx)",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function buildVote(choice: CommunityYesNoChoice): Promise<void> {
    setError(null);
    try {
      const { verifiedGovernance, owner } = requireGovernance();
      const built = await buildCastCommunityVote({
        verifiedGovernance,
        proposal: requirePublicKey(proposalAddress, "proposal"),
        proposalOwnerRecord: requirePublicKey(proposalOwnerRecord, "proposalOwnerRecord"),
        tokenOwnerRecord: requirePublicKey(tokenOwnerRecord, "tokenOwnerRecord"),
        governanceAuthority: owner,
        payer: owner,
        choice,
      });
      const payload: UnsignedPayload = {
        label: `cast community vote ${choice}`,
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      };
      recordDerived(built);
      props.onRequestSend(payload);
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function buildRelinquish(): Promise<void> {
    setError(null);
    try {
      const { verifiedGovernance, owner } = requireGovernanceIdentity();
      const built = await buildRelinquishCommunityVote({
        verifiedGovernance,
        proposal: requirePublicKey(proposalAddress, "proposal"),
        tokenOwnerRecord: requirePublicKey(tokenOwnerRecord, "tokenOwnerRecord"),
        voteRecord: requirePublicKey(voteRecord, "voteRecord"),
        governanceAuthority: owner,
        beneficiary: owner,
      });
      const payload: UnsignedPayload = {
        label: "relinquish community vote",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      };
      recordDerived(built);
      props.onRequestSend(payload);
    } catch (err) {
      setError(formatError(err));
    }
  }

  function communityActivationFromForm(): CommunityActivationConfig {
    const config: CommunityActivationConfig = {
      communityVoteThresholdPercent: requireYesVotePercent(
        parseStrictNonNegativeInteger(
          communityVoteThresholdPercent,
          "communityVoteThresholdPercent",
        ),
        "communityVoteThresholdPercent",
      ),
      minCommunityTokensToCreateProposal: requirePositiveBn(
        parsePositiveDecimalIntegerString(
          minCommunityTokensToCreateProposal,
          "minCommunityTokensToCreateProposal",
        ),
        "minCommunityTokensToCreateProposal",
      ),
      minCouncilTokensToCreateProposal: requirePositiveBn(
        parsePositiveDecimalIntegerString(
          minCouncilTokensToCreateProposal,
          "minCouncilTokensToCreateProposal",
        ),
        "minCouncilTokensToCreateProposal",
      ),
      baseVotingTime: requirePositiveInt(
        parseStrictNonNegativeInteger(baseVotingTime, "baseVotingTime"),
        "baseVotingTime",
      ),
      minInstructionHoldUpTime: requirePositiveInt(
        parseStrictNonNegativeInteger(minInstructionHoldUpTime, "minInstructionHoldUpTime"),
        "minInstructionHoldUpTime",
      ),
      votingCoolOffTime: parseStrictNonNegativeInteger(votingCoolOffTime, "votingCoolOffTime"),
      depositExemptProposalCount: parseStrictNonNegativeInteger(
        depositExemptProposalCount,
        "depositExemptProposalCount",
      ),
    };
    // Council percents are optional; communityActivationGovernanceConfig disables council.
    if (councilVoteThresholdPercent.trim().length > 0) {
      Object.assign(config, {
        councilVoteThresholdPercent: requireYesVotePercent(
          parseStrictNonNegativeInteger(councilVoteThresholdPercent, "councilVoteThresholdPercent"),
          "councilVoteThresholdPercent",
        ),
      });
    }
    if (councilVetoVoteThresholdPercent.trim().length > 0) {
      Object.assign(config, {
        councilVetoVoteThresholdPercent: requireYesVotePercent(
          parseStrictNonNegativeInteger(
            councilVetoVoteThresholdPercent,
            "councilVetoVoteThresholdPercent",
          ),
          "councilVetoVoteThresholdPercent",
        ),
      });
    }
    return config;
  }

  function communityActivationFromLive(
    identity: VerifiedGovernanceIdentity,
    nextBaseVotingTime: number,
  ): CommunityActivationConfig {
    const cfg = identity.config;
    if (cfg.communityVoteThresholdValue === undefined) {
      throw new ClientValidationError("COMMUNITY_ACTIVATION", [
        "live communityVoteThreshold is not YesVotePercentage; fill the form fields explicitly",
      ]);
    }
    return {
      communityVoteThresholdPercent: requireYesVotePercent(
        cfg.communityVoteThresholdValue,
        "live.communityVoteThresholdValue",
      ),
      minCommunityTokensToCreateProposal: requirePositiveBn(
        cfg.minCommunityTokensToCreateProposal,
        "live.minCommunityTokensToCreateProposal",
      ),
      minCouncilTokensToCreateProposal: requirePositiveBn(
        cfg.minCouncilTokensToCreateProposal,
        "live.minCouncilTokensToCreateProposal",
      ),
      baseVotingTime: requirePositiveInt(nextBaseVotingTime, "baseVotingTime"),
      minInstructionHoldUpTime: requirePositiveInt(
        Math.max(1, cfg.minInstructionHoldUpTime),
        "live.minInstructionHoldUpTime",
      ),
      votingCoolOffTime: requireNonNegativeInt(cfg.votingCoolOffTime, "live.votingCoolOffTime"),
      depositExemptProposalCount: requireNonNegativeInt(
        cfg.depositExemptProposalCount,
        "live.depositExemptProposalCount",
      ),
    };
  }

  function fillCommunityActivationForm(
    identity: VerifiedGovernanceIdentity,
    nextBaseVotingTime?: number,
  ): void {
    const cfg = identity.config;
    if (cfg.communityVoteThresholdValue !== undefined) {
      setCommunityVoteThresholdPercent(String(cfg.communityVoteThresholdValue));
    }
    setMinCommunityTokensToCreateProposal(cfg.minCommunityTokensToCreateProposal.toString(10));
    if (cfg.councilVoteThresholdValue !== undefined) {
      setCouncilVoteThresholdPercent(String(cfg.councilVoteThresholdValue));
    }
    if (cfg.councilVetoVoteThresholdValue !== undefined) {
      setCouncilVetoVoteThresholdPercent(String(cfg.councilVetoVoteThresholdValue));
    }
    setMinCouncilTokensToCreateProposal(cfg.minCouncilTokensToCreateProposal.toString(10));
    setBaseVotingTime(String(nextBaseVotingTime ?? cfg.baseVotingTime));
    setMinInstructionHoldUpTime(String(Math.max(1, cfg.minInstructionHoldUpTime)));
    setVotingCoolOffTime(String(cfg.votingCoolOffTime));
    setDepositExemptProposalCount(String(cfg.depositExemptProposalCount));
  }

  useEffect(() => {
    if (!verifiedGovernanceIdentity) {
      return;
    }
    // Prefill once when the form is still empty so Stage is not a silent no-op
    // on blank required fields (errors previously rendered far above this block).
    if (
      communityVoteThresholdPercent.length > 0 ||
      minCommunityTokensToCreateProposal.length > 0 ||
      baseVotingTime.length > 0
    ) {
      return;
    }
    fillCommunityActivationForm(verifiedGovernanceIdentity, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifiedGovernanceIdentity]);

  async function stageCommunityActivation(): Promise<void> {
    setError(null);
    setActivationNotice(null);
    setActivationOk(false);
    try {
      if (!verifiedGovernanceIdentity) {
        throw new Error(
          passed?.governanceReason ??
            "VerifiedGovernanceIdentity is required for this Governance account",
        );
      }
      const built = buildCommunityActivationInstruction({
        verifiedGovernance: verifiedGovernanceIdentity,
        config: communityActivationFromForm(),
      });
      props.onStageAction({
        label: "SetGovernanceConfig community activation",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
      setActivationOk(true);
      setActivationNotice(
        `Staged. baseVotingTime=${baseVotingTime || "?"}s. Scroll to Insert / execute below, then create proposal → Insert.`,
      );
      document.getElementById("governance-insert")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    } catch (err) {
      const message = formatError(err);
      setError(message);
      setActivationOk(false);
      setActivationNotice(message);
    }
  }

  async function stageFiveMinuteVotingWindow(): Promise<void> {
    setError(null);
    setActivationNotice(null);
    setActivationOk(false);
    try {
      if (!verifiedGovernanceIdentity) {
        throw new Error(
          passed?.governanceReason ??
            "VerifiedGovernanceIdentity is required for this Governance account",
        );
      }
      const config = communityActivationFromLive(verifiedGovernanceIdentity, 300);
      fillCommunityActivationForm(verifiedGovernanceIdentity, 300);
      const built = buildCommunityActivationInstruction({
        verifiedGovernance: verifiedGovernanceIdentity,
        config,
      });
      props.onStageAction({
        label: "SetGovernanceConfig community activation",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
      setActivationOk(true);
      setActivationNotice(
        "Staged live thresholds with baseVotingTime=300 (5 minutes). Scroll to Insert / execute → create proposal → Insert.",
      );
      document.getElementById("governance-insert")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    } catch (err) {
      const message = formatError(err);
      setError(message);
      setActivationOk(false);
      setActivationNotice(message);
    }
  }

  async function sendCommunityActivation(): Promise<void> {
    setError(null);
    try {
      if (!verifiedGovernanceIdentity) {
        throw new Error(
          passed?.governanceReason ??
            "VerifiedGovernanceIdentity is required for this Governance account",
        );
      }
      const built = buildCommunityActivationInstruction({
        verifiedGovernance: verifiedGovernanceIdentity,
        config: communityActivationFromForm(),
      });
      props.onRequestSend({
        label: "SetGovernanceConfig community activation (recovery window)",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function stageCouncilRemoval(): Promise<void> {
    setError(null);
    try {
      if (!verifiedGovernanceIdentity) {
        throw new Error(
          passed?.governanceReason ??
            "VerifiedGovernanceIdentity is required for this Governance account",
        );
      }
      const built = await buildRemoveCouncilInstruction({
        connection,
        verifiedGovernance: verifiedGovernanceIdentity,
      });
      props.onStageAction({
        label: "SetRealmConfig permanent council removal",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function buildBootstrapAuthorityHandoff(): Promise<void> {
    setError(null);
    try {
      const { verifiedGovernance, owner } = requireGovernanceIdentity();
      const built = await buildTransferRealmAuthorityToGovernance({
        connection,
        verifiedGovernance,
        currentAuthority: owner,
      });
      recordDerived(built);
      props.onRequestSend({
        label: "transfer Realm authority to Governance (SetChecked)",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  useEffect(() => {
    if (!verifiedGovernanceIdentity) {
      return;
    }
    const liveHold = verifiedGovernanceIdentity.config.minInstructionHoldUpTime;
    if (holdUpTime === "1" || holdUpTime.length === 0) {
      setHoldUpTime(String(Math.max(0, liveHold)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifiedGovernanceIdentity]);

  useEffect(() => {
    if (!verifiedRealm || !wallet.publicKey) {
      return;
    }
    if (tokenOwnerRecord.trim().length > 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const deposit = await readCommunityGoverningTokenDeposit({
          connection,
          verifiedRealm,
          governingTokenOwner: wallet.publicKey!,
        });
        if (cancelled) {
          return;
        }
        // Always surface the PDA; Create/Insert need it even before a deposit exists.
        setTokenOwnerRecord(deposit.tokenOwnerRecord.toBase58());
      } catch {
        // Leave blank; Insert will explain.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifiedRealm, wallet.publicKey, connection]);

  async function resolveConnectedTokenOwnerRecord(): Promise<string> {
    if (tokenOwnerRecord.trim().length > 0) {
      return tokenOwnerRecord.trim();
    }
    if (!verifiedRealm || !wallet.publicKey) {
      throw new Error(
        "TokenOwnerRecord is empty and wallet/realm are not ready; deposit ICHOR or paste the live TOR PDA",
      );
    }
    const deposit = await readCommunityGoverningTokenDeposit({
      connection,
      verifiedRealm,
      governingTokenOwner: wallet.publicKey,
    });
    const tor = deposit.tokenOwnerRecord.toBase58();
    setTokenOwnerRecord(tor);
    if (!deposit.present) {
      throw new Error(
        `TokenOwnerRecord ${tor} is not on chain yet. Deposit ICHOR first (Deposit / withdraw above), then retry Insert`,
      );
    }
    return tor;
  }

  async function buildInsert(): Promise<void> {
    setError(null);
    setInsertNotice(null);
    setInsertOk(false);
    try {
      const { verifiedGovernance, owner } = requireGovernanceIdentity();
      if (!props.stagedAction) {
        throw new Error(
          "stage a fee claim, community activation, council removal, program upgrade, config-authority accept, Config admin action, or generic instruction before insert",
        );
      }
      if (!proposalAddress.trim()) {
        throw new Error(
          "Proposal is empty. Scroll up to Create community proposal → Build community proposal → confirm in Phantom. The derived proposal address fills these fields; then return here and Insert.",
        );
      }
      const tokenOwnerRecord = await resolveConnectedTokenOwnerRecord();
      const proposal = requirePublicKey(proposalAddress, "proposal");
      const innerInstructions = props.stagedAction.instructions.slice();
      const params: InsertProposalTransactionParams = {
        verifiedGovernance,
        proposal,
        tokenOwnerRecord: requirePublicKey(tokenOwnerRecord, "tokenOwnerRecord"),
        governanceAuthority: owner,
        payer: owner,
        index: parseStrictNonNegativeInteger(insertIndex, "index"),
        optionIndex: parseStrictNonNegativeInteger(optionIndex, "optionIndex"),
        holdUpTime: parseStrictNonNegativeInteger(holdUpTime, "holdUpTime"),
        transactionInstructions: innerInstructions,
      };
      const built = await buildInsertProposalTransaction(params);
      props.onInsertedSession({
        action: {
          label: props.stagedAction.label,
          instructions: innerInstructions,
          derivedAddresses: { ...props.stagedAction.derivedAddresses },
        },
        staged: built.staged,
        verifiedGovernance,
      });
      setExecuteTxAddress(built.staged.transactionAddress.toBase58());
      recordDerived(built);
      props.onRequestSend({
        label: "insert proposal transaction",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
      setInsertOk(true);
      setInsertNotice(
        "Insert built. Confirm in the wallet dialog. After it lands, Sign off → Vote → Execute.",
      );
    } catch (err) {
      const message = formatError(err);
      setError(message);
      setInsertOk(false);
      setInsertNotice(message);
      if (!proposalAddress.trim()) {
        document.getElementById("governance-create-proposal")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
    }
  }

  async function recoverInserted(): Promise<void> {
    setError(null);
    try {
      const { verifiedGovernance } = requireGovernanceIdentity();
      const recovered = await recoverProposalTransaction({
        connection,
        verifiedGovernance,
        proposal: requirePublicKey(proposalAddress, "proposal"),
        index: parseStrictNonNegativeInteger(insertIndex, "index"),
        optionIndex: parseStrictNonNegativeInteger(optionIndex, "optionIndex"),
      });
      const action: StagedGovernanceAction = {
        label: "recovered on-chain proposal transaction",
        instructions: [...recovered.transactionInstructions],
        derivedAddresses: {
          proposal: recovered.staged.proposal,
          transaction: recovered.staged.transactionAddress,
        },
      };
      props.onStageAction(action);
      props.onInsertedSession({
        action,
        staged: recovered.staged,
        verifiedGovernance,
      });
      setExecuteTxAddress(recovered.staged.transactionAddress.toBase58());
      setLastDerived(
        [
          `proposal=${recovered.staged.proposal.toBase58()}`,
          `transaction=${recovered.staged.transactionAddress.toBase58()}`,
          `holdUpTime=${String(recovered.holdUpTime)}`,
          `executionStatus=${String(recovered.executionStatus)}`,
        ].join("\n"),
      );
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function buildExecute(): Promise<void> {
    setError(null);
    try {
      const { verifiedGovernance } = requireGovernanceIdentity();
      if (!props.insertedSession) {
        throw new Error(
          "EXECUTE_PAYLOAD_MISSING: buildExecuteProposalTransaction needs the inserted-session record of the original inner instructions. This panel will not invent those bytes or reuse the insert instruction.",
        );
      }
      const session = props.insertedSession;
      if (verifiedGovernance !== session.verifiedGovernance) {
        throw new Error(
          "EXECUTE_IDENTITY_CHANGED: VerifiedGovernanceIdentity is not the identity that issued the insert receipt",
        );
      }
      if (props.stagedAction) {
        if (
          props.stagedAction.label !== session.action.label ||
          !sameInstructionBytes(props.stagedAction.instructions, session.action.instructions)
        ) {
          throw new Error(
            "EXECUTE_IDENTITY_CHANGED: staged action does not match the inserted-session record",
          );
        }
      }
      const proposal = requirePublicKey(proposalAddress, "proposal");
      if (!proposal.equals(session.staged.proposal)) {
        throw new Error(
          "EXECUTE_IDENTITY_CHANGED: proposal does not match the inserted-session record",
        );
      }
      if (executeTxAddress.trim().length > 0) {
        const pasted = requirePublicKey(executeTxAddress, "transactionAddress");
        if (!pasted.equals(session.staged.transactionAddress)) {
          throw new Error(
            "EXECUTE_IDENTITY_CHANGED: proposal-transaction PDA does not match the inserted-session record",
          );
        }
      }
      const params: ExecuteProposalTransactionParams = {
        verifiedGovernance,
        proposal: session.staged.proposal,
        staged: session.staged,
        transactionInstructions: [...session.action.instructions],
      };
      const built = await buildExecuteProposalTransaction(params);
      props.onRequestSend({
        label: "execute proposal transaction",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function stageIchorProgramUpgrade(): Promise<void> {
    setError(null);
    try {
      if (!verifiedIchorProgram || !verifiedGovernanceIdentity) {
        throw new Error(
          passed?.ichorReason ??
            passed?.governanceReason ??
            "VerifiedIchorProgram and VerifiedGovernanceIdentity are required to stage Upgrade",
        );
      }
      const built = await buildUpgradeIchorProgram({
        connection,
        verifiedProgram: verifiedIchorProgram,
        verifiedGovernance: verifiedGovernanceIdentity,
        buffer: requirePublicKey(upgradeBuffer, "buffer"),
      });
      props.onStageAction({
        label: "Upgrade ICHOR program",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function stageTransferUpgradeAuthorityToGovernance(): Promise<void> {
    setError(null);
    try {
      if (!verifiedIchorProgram || !verifiedGovernanceIdentity) {
        throw new Error(
          passed?.ichorReason ??
            passed?.governanceReason ??
            "VerifiedIchorProgram and VerifiedGovernanceIdentity are required to stage upgrade-authority transfer",
        );
      }
      const built = await buildTransferProgramUpgradeAuthorityToGovernance({
        verifiedProgram: verifiedIchorProgram,
        verifiedGovernance: verifiedGovernanceIdentity,
      });
      props.onStageAction({
        label: "transfer upgrade authority to Governance PDA",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function sendIchorProgramUpgrade(): Promise<void> {
    setError(null);
    try {
      if (!verifiedIchorProgram || !verifiedGovernanceIdentity) {
        throw new Error(
          passed?.ichorReason ??
            passed?.governanceReason ??
            "VerifiedIchorProgram and VerifiedGovernanceIdentity are required to send Upgrade",
        );
      }
      if (!wallet.publicKey) {
        throw new Error("connect the upgrade-authority wallet before sending Upgrade");
      }
      const authority = verifiedIchorProgram.upgradeAuthority;
      if (authority === null) {
        throw new Error("ProgramData has no upgrade authority; program is immutable");
      }
      if (!wallet.publicKey.equals(authority)) {
        throw new Error(
          `connected wallet is not upgrade authority ${authority.toBase58()}`,
        );
      }
      const built = await buildUpgradeIchorProgram({
        connection,
        verifiedProgram: verifiedIchorProgram,
        verifiedGovernance: verifiedGovernanceIdentity,
        buffer: requirePublicKey(upgradeBuffer, "buffer"),
      });
      props.onRequestSend({
        label: "Upgrade ICHOR program from written loader buffer",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function sendSetPendingAuthorityToGovernance(): Promise<void> {
    setError(null);
    try {
      if (!verifiedIchorConfig || !verifiedGovernanceIdentity) {
        throw new Error(
          passed?.ichorReason ??
            passed?.governanceReason ??
            "VerifiedIchorConfig and VerifiedGovernanceIdentity are required to set pending authority to Governance",
        );
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      const built = await buildSetPendingAuthorityToGovernance({
        connection,
        verifiedConfig: verifiedIchorConfig,
        authority: wallet.publicKey,
        verifiedGovernance: verifiedGovernanceIdentity,
      });
      recordDerived(built);
      props.onRequestSend({
        label: "set pending authority to Governance (recovery window)",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function stageAcceptAuthorityAsGovernance(): Promise<void> {
    setError(null);
    try {
      if (!verifiedIchorConfig || !verifiedGovernanceIdentity) {
        throw new Error(
          passed?.ichorReason ??
            passed?.governanceReason ??
            "VerifiedIchorConfig and VerifiedGovernanceIdentity are required to stage accept authority as Governance",
        );
      }
      const built = await buildAcceptAuthorityAsGovernance({
        connection,
        verifiedConfig: verifiedIchorConfig,
        verifiedGovernance: verifiedGovernanceIdentity,
      });
      recordDerived(built);
      props.onStageAction({
        label: "accept authority as Governance (unproven until a Realms execute rehearsal)",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function stageGenericInstruction(): Promise<void> {
    setError(null);
    try {
      const instruction = parseGenericInnerInstruction({
        programId: genericProgramId,
        accountsJson: genericAccountsJson,
        dataHex: genericDataHex,
      });
      const prior =
        props.stagedAction !== null &&
        props.stagedAction.label.startsWith("generic inner instruction")
          ? props.stagedAction.instructions
          : [];
      const instructions = [...prior, instruction];
      props.onStageAction({
        label:
          instructions.length === 1
            ? "generic inner instruction"
            : `generic inner instruction (${String(instructions.length)})`,
        instructions,
        derivedAddresses: { programId: instruction.programId },
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function dispatchSetPaused(paused: boolean): Promise<void> {
    setError(null);
    try {
      if (!paused) {
        assertWalletUnpauseAllowed(unpauseIdentity);
      }
      const { authority, mode } = resolveConfigAdminAuthority();
      if (!verifiedIchorConfig) {
        throw new Error("VerifiedIchorConfig is required");
      }
      const built = await buildSetPaused({
        connection,
        verifiedConfig: verifiedIchorConfig,
        authority,
        paused,
      });
      dispatchConfigAdmin(paused ? "pause ICHOR convert" : "unpause ICHOR convert", built, mode);
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function dispatchPauseConvert(): Promise<void> {
    await dispatchSetPaused(true);
  }

  async function dispatchProposeEmissionRatio(): Promise<void> {
    setError(null);
    try {
      const { authority, mode } = resolveConfigAdminAuthority();
      if (!verifiedIchorConfig) {
        throw new Error("VerifiedIchorConfig is required");
      }
      const built = await buildProposeEmissionRatio({
        connection,
        verifiedConfig: verifiedIchorConfig,
        authority,
        numerator: parsePositiveDecimalIntegerString(emissionNumerator, "emissionNumerator"),
        denominator: parsePositiveDecimalIntegerString(emissionDenominator, "emissionDenominator"),
      });
      dispatchConfigAdmin("propose emission ratio", built, mode);
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function sendApplyEmissionRatio(): Promise<void> {
    setError(null);
    try {
      if (!verifiedIchorConfig) {
        throw new Error(
          passed?.ichorReason ?? "VerifiedIchorConfig is required to apply a pending emission ratio",
        );
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      const built = await buildApplyEmissionRatio({
        connection,
        verifiedConfig: verifiedIchorConfig,
      });
      recordDerived(built);
      props.onRequestSend({
        label: "apply emission ratio (permissionless after timelock)",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function dispatchCancelPendingRatio(): Promise<void> {
    setError(null);
    try {
      const { authority, mode } = resolveConfigAdminAuthority();
      if (!verifiedIchorConfig) {
        throw new Error("VerifiedIchorConfig is required");
      }
      const built = await buildCancelPendingRatio({
        connection,
        verifiedConfig: verifiedIchorConfig,
        authority,
      });
      dispatchConfigAdmin("cancel pending emission ratio", built, mode);
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function dispatchFreezeRatioUpdates(): Promise<void> {
    setError(null);
    try {
      const { authority, mode } = resolveConfigAdminAuthority();
      if (!verifiedIchorConfig) {
        throw new Error("VerifiedIchorConfig is required");
      }
      const built = await buildFreezeRatioUpdates({
        connection,
        verifiedConfig: verifiedIchorConfig,
        authority,
      });
      dispatchConfigAdmin("freeze emission-ratio updates", built, mode);
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function dispatchIncreaseRatioTimelock(): Promise<void> {
    setError(null);
    try {
      const { authority, mode } = resolveConfigAdminAuthority();
      if (!verifiedIchorConfig) {
        throw new Error("VerifiedIchorConfig is required");
      }
      const built = await buildIncreaseRatioTimelock({
        connection,
        verifiedConfig: verifiedIchorConfig,
        authority,
        newSecs: parsePositiveDecimalIntegerString(newRatioTimelockSecs, "newRatioTimelockSecs"),
      });
      dispatchConfigAdmin("increase emission-ratio timelock", built, mode);
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function dispatchRevokeTransferFeeAuthority(): Promise<void> {
    setError(null);
    try {
      const { authority, mode } = resolveConfigAdminAuthority();
      if (!verifiedIchorConfig) {
        throw new Error("VerifiedIchorConfig is required");
      }
      const built = await buildRevokeTransferFeeAuthority({
        connection,
        verifiedConfig: verifiedIchorConfig,
        authority,
      });
      dispatchConfigAdmin("revoke transfer-fee authority", built, mode);
    } catch (err) {
      setError(formatError(err));
    }
  }

  return (
    <section className="panel">
      <h2>Realms governance (unsigned)</h2>
      <p className="muted">
        Deposit, withdraw, and relinquish use an issued VerifiedRealm. Community propose and
        cast vote require an issued VerifiedGovernance. Realm, mint, and governance come from
        those proofs, not caller substitution. Payloads still go through review, simulation, and
        wallet send.
      </p>
      {verifiedRealm ? (
        <dl className="dl">
          <dt>Proof realm</dt>
          <dd>{verifiedRealm.realm.toBase58()}</dd>
          <dt>Proof community mint</dt>
          <dd>{verifiedRealm.communityMint.toBase58()}</dd>
        </dl>
      ) : (
        <div className="blocked">
          <p>Deposit/withdraw/relinquish require a passed VerifiedRealm.</p>
          <pre>{passed?.realmReason ?? "Run preflight after realm and ICHOR mint are configured."}</pre>
        </div>
      )}
      {verifiedGovernance ? (
        <dl className="dl">
          <dt>Proof governance</dt>
          <dd>{verifiedGovernance.governance.toBase58()}</dd>
          <dt>Observed community threshold</dt>
          <dd>
            type {String(verifiedGovernance.config.communityVoteThresholdType)} value{" "}
            {String(verifiedGovernance.config.communityVoteThresholdValue)}
          </dd>
        </dl>
      ) : (
        <div className="blocked">
          <p>Propose/vote require a passed VerifiedGovernance.</p>
          <pre>{passed?.governanceReason ?? "Run preflight after governance is configured and community voting is enabled on-chain."}</pre>
        </div>
      )}
      {verifiedGovernanceIdentity ? (
        <dl className="dl">
          <dt>Proof governance identity</dt>
          <dd>{verifiedGovernanceIdentity.governance.toBase58()}</dd>
        </dl>
      ) : (
        <div className="blocked">
          <p>
            Sign-off, relinquish, insert, execute, and community activation require
            VerifiedGovernanceIdentity. There is no pasted governance fallback.
          </p>
          <pre>{passed?.governanceReason ?? "Run preflight after Governance exists."}</pre>
        </div>
      )}
      {error ? (
        <div className="gate-fail">
          <pre>{error}</pre>
        </div>
      ) : null}
      {governanceTransferPreview ? (
        <div className="gate-pass">
          <p>{governanceTransferPreview}</p>
        </div>
      ) : null}
      {lastDerived ? (
        <p className="mono">
          Last derived addresses
          <pre>{lastDerived}</pre>
        </p>
      ) : null}
      {voteRecord ? <p className="mono">voteRecord {voteRecord}</p> : null}

      <h3>Deposit / withdraw ICHOR</h3>
      <div className="row">
        <label>
          Amount (UI, mint decimals from communityMint account)
          <input
            value={depositUi}
            onChange={(event) => setDepositUi(event.target.value)}
            inputMode="decimal"
          />
        </label>
        <button
          type="button"
          onClick={() => void buildDeposit()}
          disabled={!verifiedRealm || !wallet.publicKey}
        >
          Build deposit
        </button>
        <button
          type="button"
          onClick={() => void buildWithdraw()}
          disabled={!verifiedRealm || !wallet.publicKey}
        >
          Build withdraw
        </button>
      </div>

      <h3 id="governance-create-proposal">Create community proposal</h3>
      <p className="muted">
        Insert needs a live Proposal address. Build + confirm a proposal here first (TokenOwnerRecord
        auto-fills from the connected wallet when a deposit exists). After send, the derived
        proposal pubkey appears under Last derived addresses and in the Proposal field below.
      </p>
      <div className="row">
        <label>
          Token owner record
          <input
            value={tokenOwnerRecord}
            onChange={(event) => setTokenOwnerRecord(event.target.value)}
          />
        </label>
        <label>
          Name
          <input value={proposalName} onChange={(event) => setProposalName(event.target.value)} />
        </label>
        <label>
          Description link
          <input value={proposalLink} onChange={(event) => setProposalLink(event.target.value)} />
        </label>
        <label>
          Options (one per line)
          <textarea
            value={proposalOptions}
            onChange={(event) => setProposalOptions(event.target.value)}
          />
        </label>
        <button type="button" onClick={() => void buildProposal()} disabled={!voteReady}>
          Build community proposal
        </button>
        <button
          type="button"
          onClick={() => void buildSignOffAndVoteYes()}
          disabled={!voteReady || !identityReady}
          title="Live window is 30s. Sign off alone usually loses the race to Phantom. This packs Sign off + Vote Yes in one transaction."
        >
          Sign off + Vote Yes (one tx)
        </button>
        <button
          type="button"
          onClick={() => void buildSignOff()}
          disabled={!identityReady}
        >
          Build sign-off only
        </button>
      </div>
      <p className="muted">
        On-chain <code>baseVotingTime</code> is still 30s. Separate Sign-off then Vote loses to
        Phantom. Prefer <strong>Sign off + Vote Yes (one tx)</strong>.
      </p>

      <h3>Vote Yes / No</h3>
      <div className="row">
        <label>
          Proposal
          <input
            value={proposalAddress}
            onChange={(event) => setProposalAddress(event.target.value)}
          />
        </label>
        <label>
          Proposal owner record
          <input
            value={proposalOwnerRecord}
            onChange={(event) => setProposalOwnerRecord(event.target.value)}
          />
        </label>
        <label>
          Token owner record
          <input
            value={tokenOwnerRecord}
            onChange={(event) => setTokenOwnerRecord(event.target.value)}
          />
        </label>
        <button type="button" onClick={() => void buildVote("yes")} disabled={!voteReady}>
          Build Yes vote
        </button>
        <button type="button" onClick={() => void buildVote("no")} disabled={!voteReady}>
          Build No vote
        </button>
      </div>

      <h3>Relinquish vote</h3>
      <div className="row">
        <label>
          Vote record
          <input value={voteRecord} onChange={(event) => setVoteRecord(event.target.value)} />
        </label>
        <button
          type="button"
          onClick={() => void buildRelinquish()}
          disabled={!identityReady}
        >
          Build relinquish
        </button>
      </div>

      {operatorView ? (<>
      <h3>Community activation</h3>
      <p className="muted">
        Every CommunityActivationConfig field is required except the ignored council yes-percents
        (builder always disables council). Yes-vote percentages are 1-100. SetGovernanceConfig
        must be staged into a proposal. The Governance PDA signs on Execute; a direct wallet
        send cannot. For official-devnet holder smoke use baseVotingTime <strong>300</strong>{" "}
        (5 minutes); values under 3600 bypass the SDK JS-only 1-hour floor (on-chain accepts
        them). After Stage: create proposal → Insert → Sign off → Vote immediately (Strict
        tipping can close the vote early) → wait hold-up → Execute.
      </p>
      <div className="row">
        <button
          type="button"
          onClick={() => {
            if (!verifiedGovernanceIdentity) {
              setActivationOk(false);
              setActivationNotice(
                passed?.governanceReason ??
                  "VerifiedGovernanceIdentity is required; run preflight first",
              );
              return;
            }
            fillCommunityActivationForm(verifiedGovernanceIdentity, 300);
            setActivationOk(true);
            setActivationNotice(
              "Form filled from live Governance config with baseVotingTime=300. Click Stage community activation.",
            );
          }}
          disabled={!verifiedGovernanceIdentity}
        >
          Load live config → 300s
        </button>
        <button
          type="button"
          onClick={() => void stageFiveMinuteVotingWindow()}
          disabled={!verifiedGovernanceIdentity}
        >
          Stage 5-minute window (from live)
        </button>
      </div>
      <div className="row">
        <label>
          communityVoteThresholdPercent
          <input
            value={communityVoteThresholdPercent}
            onChange={(event) => setCommunityVoteThresholdPercent(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label>
          minCommunityTokensToCreateProposal
          <input
            value={minCommunityTokensToCreateProposal}
            onChange={(event) => setMinCommunityTokensToCreateProposal(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label>
          councilVoteThresholdPercent (ignored)
          <input
            value={councilVoteThresholdPercent}
            onChange={(event) => setCouncilVoteThresholdPercent(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label>
          councilVetoVoteThresholdPercent (ignored)
          <input
            value={councilVetoVoteThresholdPercent}
            onChange={(event) => setCouncilVetoVoteThresholdPercent(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label>
          minCouncilTokensToCreateProposal
          <input
            value={minCouncilTokensToCreateProposal}
            onChange={(event) => setMinCouncilTokensToCreateProposal(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label>
          baseVotingTime
          <input
            value={baseVotingTime}
            onChange={(event) => setBaseVotingTime(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label>
          minInstructionHoldUpTime
          <input
            value={minInstructionHoldUpTime}
            onChange={(event) => setMinInstructionHoldUpTime(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label>
          votingCoolOffTime
          <input
            value={votingCoolOffTime}
            onChange={(event) => setVotingCoolOffTime(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label>
          depositExemptProposalCount
          <input
            value={depositExemptProposalCount}
            onChange={(event) => setDepositExemptProposalCount(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <button
          type="button"
          onClick={() => void stageCommunityActivation()}
          disabled={!verifiedGovernanceIdentity}
        >
          Stage community activation
        </button>
        <button
          type="button"
          onClick={() => void sendCommunityActivation()}
          disabled
          title="Realms 3.1 requires the Governance PDA to sign SetGovernanceConfig; use Stage + proposal Execute"
        >
          Send community activation (recovery window, disabled)
        </button>
      </div>
      {activationNotice ? (
        <div className={activationOk ? "gate-pass" : "gate-fail"}>
          <pre>{activationNotice}</pre>
        </div>
      ) : null}
      {!verifiedGovernanceIdentity ? (
        <p className="muted">
          Stage stays disabled until VerifiedGovernanceIdentity issues from preflight.
        </p>
      ) : null}

      <h3>Bootstrap authority handoff</h3>
      <p className="muted">
        Direct wallet send (not a proposal). Transfers live Realm authority from the connected
        bootstrap signer to the verified Governance PDA with SetChecked. Distinct from
        proposal-staged council removal, which requires Governance to already be Realm authority.
      </p>
      <button
        type="button"
        onClick={() => void buildBootstrapAuthorityHandoff()}
        disabled={!identityReady}
      >
        Build Realm authority handoff
      </button>

      <h3>Remove bootstrap council</h3>
      <p className="muted">
        Proposal-only and irreversible. Stage for insert, do not send directly. Governance must
        already be Realm authority (complete the handoff above first). The builder reads the live
        council holding account and refuses while any council deposits remain, because Realms
        cannot withdraw them after removal.
      </p>
      <button
        type="button"
        onClick={() => void stageCouncilRemoval()}
        disabled={!verifiedGovernanceIdentity}
      >
        Stage permanent council removal
      </button>

      <h3>Program upgrade (proposal-staged)</h3>
      <p className="muted">
        Upgrade uses a caller-supplied already-written loader buffer pubkey;
        spill is the derived Realms native treasury. If the connected wallet is the live
        upgrade authority, Send Upgrade asks that wallet to sign. If authority is already
        Governance, Stage Upgrade inserts a proposal. Transfer upgrade authority to the
        issued Governance PDA is the tooling path; the existing treasury transfer builder
        is unchanged.
      </p>
      {verifiedIchorProgram && verifiedGovernanceIdentity ? (
        <div className="row">
          <label>
            loader buffer pubkey
            <input
              value={upgradeBuffer}
              onChange={(event) => setUpgradeBuffer(event.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => void sendIchorProgramUpgrade()}
            disabled={!ichorUpgradeReady || !wallet.publicKey}
          >
            Send Upgrade
          </button>
          <button
            type="button"
            onClick={() => void stageIchorProgramUpgrade()}
            disabled={!ichorUpgradeReady}
          >
            Stage Upgrade
          </button>
          <button
            type="button"
            onClick={() => void stageTransferUpgradeAuthorityToGovernance()}
            disabled={!ichorUpgradeReady}
          >
            Stage transfer upgrade authority to Governance PDA
          </button>
        </div>
      ) : (
        <div className="blocked">
          <p>
            Staging Upgrade or Governance upgrade-authority transfer requires a passed
            VerifiedIchorProgram and VerifiedGovernanceIdentity.
          </p>
          <pre>
            {passed?.ichorReason ??
              passed?.governanceReason ??
              "Run preflight after the ICHOR program and Governance exist."}
          </pre>
        </div>
      )}

      <h3>Config authority to Governance</h3>
      <p className="muted">
        Two-step that already exists: send set pending (current config.authority wallet
        must still sign; recovery window), then stage accept as a proposal inner
        instruction so Governance can sign via invoke_signed. Accept is unproven until
        a Realms execute rehearsal. Q2 is not claimed.
      </p>
      {verifiedIchorConfig && verifiedGovernanceIdentity ? (
        <div className="row">
          <button
            type="button"
            onClick={() => void sendSetPendingAuthorityToGovernance()}
            disabled={!configAuthorityReady}
          >
            Send set pending authority to Governance
          </button>
          <button
            type="button"
            onClick={() => void stageAcceptAuthorityAsGovernance()}
            disabled={!configAuthorityReady}
          >
            Stage accept authority as proposal
          </button>
        </div>
      ) : (
        <div className="blocked">
          <p>
            Setting pending Config authority to Governance requires a passed
            VerifiedIchorConfig and VerifiedGovernanceIdentity.
          </p>
          <pre>
            {passed?.ichorReason ??
              passed?.governanceReason ??
              "Run preflight after the ICHOR Config and Governance exist."}
          </pre>
        </div>
      )}

      <h3>Config admin (PLAN §12.2)</h3>
      <p className="muted">
        After Config authority is Governance, these stage as proposal inner
        instructions so the PDA can sign. While the bootstrap wallet is still
        config.authority they send directly (recovery window). Apply is
        permissionless after the on-chain timelock and always sends. Freeze and
        revoke are one-way.
      </p>
      {verifiedIchorConfig && verifiedGovernanceIdentity ? (
        <div className="row">
          <button
            type="button"
            onClick={() => void dispatchPauseConvert()}
            disabled={!configAuthorityReady}
          >
            Pause convert
          </button>
          {showWalletUnpause ? (
            <button
              type="button"
              onClick={() => void dispatchSetPaused(false)}
              disabled={!configAuthorityReady}
            >
              Unpause convert
            </button>
          ) : (
            <p className="muted">
              Unpause convert is unavailable on verified mainnet. Opening
              conversion uses the phase-pinned mainnet-F signer (
              <code>ichor_mainnet_f_signer</code> / <code>open-conversion</code>
              ), not a wallet <code>signTransaction</code> of bare{" "}
              <code>set_paused(false)</code>.
            </p>
          )}
          <label>
            emission numerator
            <input
              value={emissionNumerator}
              onChange={(event) => setEmissionNumerator(event.target.value)}
              inputMode="numeric"
            />
          </label>
          <label>
            emission denominator
            <input
              value={emissionDenominator}
              onChange={(event) => setEmissionDenominator(event.target.value)}
              inputMode="numeric"
            />
          </label>
          <button
            type="button"
            onClick={() => void dispatchProposeEmissionRatio()}
            disabled={!configAuthorityReady}
          >
            Propose emission ratio
          </button>
          <button
            type="button"
            onClick={() => void sendApplyEmissionRatio()}
            disabled={!verifiedIchorConfig || !wallet.publicKey}
          >
            Apply pending emission ratio
          </button>
          <button
            type="button"
            onClick={() => void dispatchCancelPendingRatio()}
            disabled={!configAuthorityReady}
          >
            Cancel pending ratio
          </button>
          <button
            type="button"
            onClick={() => void dispatchFreezeRatioUpdates()}
            disabled={!configAuthorityReady}
          >
            Freeze ratio updates
          </button>
          <label>
            new ratio timelock (seconds)
            <input
              value={newRatioTimelockSecs}
              onChange={(event) => setNewRatioTimelockSecs(event.target.value)}
              inputMode="numeric"
            />
          </label>
          <button
            type="button"
            onClick={() => void dispatchIncreaseRatioTimelock()}
            disabled={!configAuthorityReady}
          >
            Increase ratio timelock
          </button>
          <button
            type="button"
            onClick={() => void dispatchRevokeTransferFeeAuthority()}
            disabled={!configAuthorityReady}
          >
            Revoke transfer-fee authority
          </button>
        </div>
      ) : (
        <div className="blocked">
          <p>
            Config admin requires a passed VerifiedIchorConfig and
            VerifiedGovernanceIdentity.
          </p>
          <pre>
            {passed?.ichorReason ??
              passed?.governanceReason ??
              "Run preflight after the ICHOR Config and Governance exist."}
          </pre>
        </div>
      )}

      <h3>Generic inner instruction (stage only)</h3>
      <p className="muted">
        PLAN §12.2 arbitrary instruction. Stage for insert. This panel never sends it
        directly. Accounts is a JSON array of {"{pubkey, isSigner, isWritable}"}. Data is
        hex (0x optional). Staging again while a generic action is already staged
        appends another inner instruction to the same insert.
      </p>
      <div className="row">
        <label>
          programId (base58)
          <input
            value={genericProgramId}
            onChange={(event) => setGenericProgramId(event.target.value)}
          />
        </label>
        <label>
          accounts JSON
          <textarea
            value={genericAccountsJson}
            onChange={(event) => setGenericAccountsJson(event.target.value)}
          />
        </label>
        <label>
          data (hex)
          <input
            value={genericDataHex}
            onChange={(event) => setGenericDataHex(event.target.value)}
          />
        </label>
        <button type="button" onClick={() => void stageGenericInstruction()}>
          Stage generic instruction
        </button>
      </div>
      </>) : null}

      <h3 id="governance-insert">Insert / execute</h3>
      <p className="muted">
        Insert wraps the App-owned staged inner instructions. Execute consumes that inserted-session
        record and the original staged bytes, not the insert instruction. This panel will not
        invent those bytes. After a refresh or multi-day vote, recover reads the exact stored
        instructions from the live ProposalTransaction account. Defaults: insertion index 0,
        option index 0, hold-up from live Governance minInstructionHoldUpTime.
      </p>
      {props.stagedAction ? (
        <dl className="dl">
          <dt>Staged action</dt>
          <dd>{props.stagedAction.label}</dd>
          <dt>Inner instructions</dt>
          <dd>
            <pre>{JSON.stringify(payloadReview(props.stagedAction), null, 2)}</pre>
          </dd>
        </dl>
      ) : (
        <p className="muted">
          No staged action. Stage a Meteora fee claim, community activation, council removal,
          program upgrade, config-authority accept, Config admin action, or generic
          instruction before insert.
        </p>
      )}
      {props.insertedSession ? (
        <dl className="dl">
          <dt>Inserted-session action</dt>
          <dd>{props.insertedSession.action.label}</dd>
          <dt>Inserted-session proposal</dt>
          <dd>{props.insertedSession.staged.proposal.toBase58()}</dd>
          <dt>Inserted-session proposal-transaction PDA</dt>
          <dd>{props.insertedSession.staged.transactionAddress.toBase58()}</dd>
        </dl>
      ) : null}
      <div className="row">
        <label>
          Proposal
          <input
            value={proposalAddress}
            onChange={(event) => setProposalAddress(event.target.value)}
          />
        </label>
        <label>
          community TokenOwnerRecord (proposal owner)
          <input
            value={tokenOwnerRecord}
            onChange={(event) => setTokenOwnerRecord(event.target.value)}
          />
        </label>
        <label>
          insertion index
          <input
            value={insertIndex}
            onChange={(event) => setInsertIndex(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label>
          option index
          <input
            value={optionIndex}
            onChange={(event) => setOptionIndex(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label>
          hold-up time
          <input
            value={holdUpTime}
            onChange={(event) => setHoldUpTime(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label>
          Proposal transaction PDA
          <input
            value={executeTxAddress}
            onChange={(event) => setExecuteTxAddress(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="secondary"
          onClick={props.onClearStagedAction}
          disabled={!props.stagedAction}
        >
          Clear staged action
        </button>
        <button
          type="button"
          onClick={() => void buildInsert()}
          disabled={!identityReady || !props.stagedAction}
        >
          Insert proposal transaction
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => void recoverInserted()}
          disabled={!identityReady}
        >
          Recover inserted transaction
        </button>
        <button
          type="button"
          onClick={() => void buildExecute()}
          disabled={!identityReady || !props.insertedSession}
        >
          Build execute
        </button>
      </div>
      {insertNotice ? (
        <div className={insertOk ? "gate-pass" : "gate-fail"}>
          <pre>{insertNotice}</pre>
        </div>
      ) : null}
    </section>
  );
}
