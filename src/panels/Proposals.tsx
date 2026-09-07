import {
  ProposalState,
  buildCastCommunityVote,
  buildCreateCommunityProposal,
  buildDepositIchorVotes,
  buildExecuteProposalTransaction,
  buildFinalizeVote,
  buildRelinquishCommunityVote,
  buildRelinquishStandingCommunityVotes,
  buildReleaseStandingAndWithdrawIchorVotes,
  buildReleaseVotesOnClosedProposal,
  buildSignOffProposal,
  listStandingCommunityVotes,
  listUnrelinquishedVotesOnProposal,
  recoverProposalTransaction,
  readCommunityProposal,
  listCommunityProposals,
  requirePublicKey,
  type BuildSignOffProposalParams,
  type CommunityProposalListItem,
  type CommunityProposalSnapshot,
  type CommunityYesNoChoice,
  type StagedProposalActions,
  type VerifiedRealm,
} from "@kekbull/ichor-client";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { proposalFromHash, proposalHashFor } from "../proposal-deep-link.ts";
import type { TransactionInstruction } from "@solana/web3.js";
import { fetchBoundMintSnapshot, readHolderVoteBalances, type HolderVoteBalances } from "../chain.ts";
import { useThrottledLiveRefresh } from "../live-refresh.ts";
import type { DeploymentConfig } from "../config.ts";
import {
  formatBaseUnits,
  formatError,
  groupUiAmount,
  isStaleIssuedProofError,
  parseUiToBaseUnits,
  STALE_PROOF_REVERIFY_MESSAGE,
} from "../format.ts";
import {
  buildHolderPayIchorAction,
  buildHolderPaySolAction,
  buildHolderUpgradeAction,
  insertApproveAction,
  proposalVoteEnded,
  proposalVotingAcceptsCast,
  proposalVotingEndsAtSecs,
  proposalInstructionsReviewedForVote,
  summarizeProposalInstructionsForReview,
  proposalReviewOptions,
  summarizeRecoveredProposalTransactions,
  type ActionEnglishSummary,
  type HolderActionKind,
} from "../proposal-actions.ts";
import {
  assertProposalMarkdown,
  fetchProposalMarkdown,
  pinProposalMarkdown,
  renderStrictMarkdown,
} from "../proposal-markdown.ts";
import type { UnsignedPayload } from "../send.ts";
import type { PreflightState } from "./Preflight.tsx";
import { HolderSection } from "../holder-section.tsx";

interface TransferPreview {
  readonly kind: "deposit" | "withdraw";
  readonly grossUi: string;
  readonly feeUi: string;
  readonly netUi: string;
  readonly grossBase: string;
  readonly feeBase: string;
  readonly netBase: string;
}

function ichorAmountLabel(amount: BN, decimals: number): string {
  return `${groupUiAmount(formatBaseUnits(amount, decimals))} ICHOR`;
}

function feePercentLabel(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const frac = String(basisPoints % 100).padStart(2, "0");
  return `${String(whole)}.${frac}%`;
}

function proposalKindLabel(item: CommunityProposalListItem): string {
  return item.approveInstructionsCount > 0 ? "Has on-chain action" : "Signal only";
}

function proposalTagClass(state: number): string {
  if (state === ProposalState.Succeeded || state === ProposalState.Executing) {
    return "tag succeeded";
  }
  if (
    state === ProposalState.Defeated ||
    state === ProposalState.Cancelled ||
    state === ProposalState.Vetoed ||
    state === ProposalState.ExecutingWithErrors
  ) {
    return "tag defeated";
  }
  return "tag";
}

function voteBarWidths(yes: BN, no: BN): { yesPct: number; noPct: number } {
  const y = BigInt(yes.toString(10));
  const n = BigInt(no.toString(10));
  const total = y + n;
  if (total === 0n) {
    return { yesPct: 0, noPct: 0 };
  }
  const yesPct = Number((y * 10000n) / total) / 100;
  return { yesPct, noPct: 100 - yesPct };
}

function proposalMatchesFilter(
  item: CommunityProposalListItem,
  filter: "all" | "voting" | "draft" | "execute" | "done",
): boolean {
  if (filter === "all") return true;
  if (filter === "voting") return item.state === ProposalState.Voting;
  if (filter === "draft") {
    return item.state === ProposalState.Draft || item.state === ProposalState.SigningOff;
  }
  if (filter === "execute") {
    return item.state === ProposalState.Succeeded || item.state === ProposalState.Executing;
  }
  return (
    item.state === ProposalState.Completed ||
    item.state === ProposalState.Defeated ||
    item.state === ProposalState.Cancelled ||
    item.state === ProposalState.Vetoed ||
    item.state === ProposalState.ExecutingWithErrors
  );
}

function depositRecordExplorerUrl(
  address: string,
  cluster: DeploymentConfig["cluster"],
): string {
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://solscan.io/account/${address}${suffix}`;
}

/**
 * Holder-facing governance: deposit, withdraw, propose (with optional treasury
 * action), sign off, vote, finalize, execute. Council removal and generic hex
 * staging stay in Governance.tsx.
 */
export function Proposals(props: {
  config: DeploymentConfig;
  preflight: PreflightState;
  onRequestSend: (payload: UnsignedPayload) => void;
  lastConfirmedSignature?: string | null;
  /** Clear preflight to idle so verify* re-issues proofs after HMR WeakSet loss. */
  onProofStale?: () => void;
}) {
  const recoverStaleProof = (err: unknown): boolean => {
    if (!isStaleIssuedProofError(err)) {
      return false;
    }
    props.onProofStale?.();
    return true;
  };
  const { connection } = useConnection();
  const wallet = useWallet();
  const [depositUi, setDepositUi] = useState("");
  const [tokenOwnerRecord, setTokenOwnerRecord] = useState("");
  const [proposalAddress, setProposalAddress] = useState("");
  const [proposalOwnerRecord, setProposalOwnerRecord] = useState("");
  const [voteRecord, setVoteRecord] = useState("");
  const [proposalName, setProposalName] = useState("");
  const [proposalMarkdown, setProposalMarkdown] = useState("");
  const [proposalLinkOverride, setProposalLinkOverride] = useState("");
  const [pinnedDescriptionLink, setPinnedDescriptionLink] = useState<string | null>(null);
  const [actionKind, setActionKind] = useState<HolderActionKind>("none");
  const [payRecipient, setPayRecipient] = useState("");
  const [payAmountUi, setPayAmountUi] = useState("");
  const [createDestAta, setCreateDestAta] = useState(true);
  const [upgradeBuffer, setUpgradeBuffer] = useState("");
  const [creating, setCreating] = useState(false);
  const [transfer, setTransfer] = useState<TransferPreview | null>(null);
  const [derived, setDerived] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const depositActionErrorRef = useRef<HTMLDivElement | null>(null);
  const [balances, setBalances] = useState<HolderVoteBalances | null>(null);
  const [balancesError, setBalancesError] = useState<string | null>(null);
  const [balancesBusy, setBalancesBusy] = useState(false);
  const [fetchedProposal, setFetchedProposal] = useState<CommunityProposalSnapshot | null>(null);
  const [standingVotesOnOpenProposal, setStandingVotesOnOpenProposal] = useState<number | null>(
    null,
  );
  const [fetchedMarkdown, setFetchedMarkdown] = useState<ReactNode | null>(null);
  const [actionSummary, setActionSummary] = useState<ActionEnglishSummary | null>(null);
  const [reviewedProposalAddress, setReviewedProposalAddress] = useState<string | null>(null);
  const [recoveredStaged, setRecoveredStaged] = useState<StagedProposalActions | null>(null);
  const [recoveredInstructions, setRecoveredInstructions] = useState<
    Awaited<ReturnType<typeof recoverProposalTransaction>>["transactionInstructions"] | null
  >(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [proposalList, setProposalList] = useState<readonly CommunityProposalListItem[]>([]);
  const [proposalListBusy, setProposalListBusy] = useState(false);
  const [proposalListError, setProposalListError] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState<"all" | "voting" | "draft" | "execute" | "done">(
    "all",
  );
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));

  const passed = props.preflight.status === "passed" ? props.preflight : null;
  const verifiedRealm = passed?.verifiedRealm ?? null;
  const verifiedGovernance = passed?.verifiedGovernance ?? null;
  const verifiedGovernanceIdentity = passed?.verifiedGovernanceIdentity ?? null;
  const verifiedIchorProgram = passed?.verifiedIchorProgram ?? null;
  const connected = Boolean(wallet.publicKey);
  const depositReady = Boolean(verifiedRealm) && connected;
  const voteReady = Boolean(verifiedGovernance) && connected;
  const identityReady = Boolean(verifiedGovernanceIdentity) && connected;
  const hasProposal = proposalAddress.trim().length > 0;
  const baseVotingTime =
    verifiedGovernance?.config.baseVotingTime ??
    verifiedGovernanceIdentity?.config.baseVotingTime ??
    null;
  const instructionsReviewed =
    proposalInstructionsReviewedForVote(actionSummary) &&
    reviewedProposalAddress !== null &&
    reviewedProposalAddress === proposalAddress.trim();
  const votingAcceptsCast =
    fetchedProposal !== null &&
    baseVotingTime !== null &&
    proposalVotingAcceptsCast(fetchedProposal, baseVotingTime, nowSecs);
  const votingWindowEnded =
    fetchedProposal !== null &&
    fetchedProposal.state === ProposalState.Voting &&
    baseVotingTime !== null &&
    proposalVoteEnded(fetchedProposal, baseVotingTime, nowSecs);
  const votingEndsAt =
    fetchedProposal !== null &&
    fetchedProposal.state === ProposalState.Voting &&
    baseVotingTime !== null
      ? proposalVotingEndsAtSecs(fetchedProposal, baseVotingTime)
      : null;
  const votingSecondsLeft =
    votingEndsAt !== null && fetchedProposal?.state === ProposalState.Voting
      ? Math.max(0, votingEndsAt - nowSecs)
      : null;
  /** Official-devnet once used 30s for harness speed; Phantom cannot beat that. */
  const shortVoteWindow =
    baseVotingTime !== null && baseVotingTime > 0 && baseVotingTime < 120;
  const needsVoteClock =
    baseVotingTime !== null &&
    (fetchedProposal?.state === ProposalState.Voting ||
      proposalList.some((row) => row.state === ProposalState.Voting));

  useEffect(() => {
    if (!needsVoteClock) {
      return;
    }
    setNowSecs(Math.floor(Date.now() / 1000));
    const id = window.setInterval(() => {
      setNowSecs(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [needsVoteClock]);

  function listRowStateLabel(row: CommunityProposalListItem): string {
    if (
      row.state === ProposalState.Voting &&
      baseVotingTime !== null &&
      proposalVoteEnded(
        { votingAt: row.votingAt, maxVotingTime: null },
        baseVotingTime,
        nowSecs,
      )
    ) {
      return "VOTING ENDED";
    }
    return row.stateName.toUpperCase();
  }

  function openProposalStateLabel(): string {
    if (!fetchedProposal) {
      return "OPEN BY ADDRESS";
    }
    if (votingWindowEnded) {
      return "VOTING ENDED";
    }
    return fetchedProposal.stateName.toUpperCase();
  }

  const refreshProposalList = useCallback(async (): Promise<void> => {
    if (!verifiedGovernance) {
      setProposalList([]);
      setProposalListError(null);
      return;
    }
    setProposalListBusy(true);
    setProposalListError(null);
    try {
      const rows = await listCommunityProposals({
        connection,
        verifiedGovernance,
      });
      setProposalList(rows);
    } catch (err) {
      setProposalList([]);
      if (recoverStaleProof(err)) {
        setProposalListError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setProposalListError(formatError(err));
      }
    } finally {
      setProposalListBusy(false);
    }
  }, [connection, verifiedGovernance, props.onProofStale]);

  useThrottledLiveRefresh(
    Boolean(verifiedGovernance),
    refreshProposalList,
    props.lastConfirmedSignature,
  );

  const refreshProposal = useCallback(async (): Promise<void> => {
    if (!verifiedGovernance || !proposalAddress.trim()) {
      setFetchedProposal(null);
      setStandingVotesOnOpenProposal(null);
      setFetchedMarkdown(null);
      setActionSummary(null);
      setReviewedProposalAddress(null);
      setRecoveredStaged(null);
      setRecoveredInstructions(null);
      return;
    }
    setProposalBusy(true);
    setError(null);
    setReviewedProposalAddress(null);
    setActionSummary(null);
    setRecoveredStaged(null);
    setRecoveredInstructions(null);
    try {
      const snapshot = await readCommunityProposal({
        connection,
        verifiedGovernance,
        proposal: requirePublicKey(proposalAddress, "proposal"),
      });
      setFetchedProposal(snapshot);
      setProposalOwnerRecord(snapshot.tokenOwnerRecord.toBase58());
      if (verifiedGovernanceIdentity) {
        try {
          const standing = await listUnrelinquishedVotesOnProposal({
            connection,
            verifiedGovernance: verifiedGovernanceIdentity,
            proposal: snapshot.proposal,
          });
          setStandingVotesOnOpenProposal(standing.length);
        } catch {
          setStandingVotesOnOpenProposal(null);
        }
      } else {
        setStandingVotesOnOpenProposal(null);
      }
      const body = await fetchProposalMarkdown(snapshot.descriptionLink);
      setFetchedMarkdown(body ? renderStrictMarkdown(body) : null);
      if (!verifiedGovernanceIdentity) {
        setActionSummary({
          kind: "unknown",
          headline: "Action unread",
          details: ["VerifiedGovernanceIdentity is required to recover inserted instructions."],
          recoveryComplete: false,
        });
        setReviewedProposalAddress(null);
        setRecoveredStaged(null);
        setRecoveredInstructions(null);
        return;
      }
      const approve = snapshot.options[0];
      const instructionsCount = approve?.instructionsCount ?? 0;
      // Fee bps come from a live mint read when the holder has balances loaded;
      // never invent 0.25%. Amount decode (H5) does not depend on this.
      const feeOpts = {
        transferFeeBasisPoints: balances?.withdrawQuote?.basisPoints ?? null,
      };
      if (instructionsCount <= 0) {
        setRecoveredStaged(null);
        setRecoveredInstructions(null);
        setActionSummary(
          summarizeRecoveredProposalTransactions({
            instructionsCount: 0,
            recoveredIndexes: 0,
            instructions: [],
            ichorMint: verifiedGovernance.communityMint,
            opts: feeOpts,
          }),
        );
        setReviewedProposalAddress(snapshot.proposal.toBase58());
        return;
      }
      try {
        const allInners: TransactionInstruction[] = [];
        let firstStaged: StagedProposalActions | null = null;
        let recoveredIndexes = 0;
        for (let index = 0; index < instructionsCount; index += 1) {
          const recovered = await recoverProposalTransaction({
            connection,
            verifiedGovernance: verifiedGovernanceIdentity,
            proposal: snapshot.proposal,
            optionIndex: 0,
            index,
          });
          recoveredIndexes += 1;
          if (index === 0) {
            firstStaged = recovered.staged;
          }
          allInners.push(...recovered.transactionInstructions);
        }
        const reviewOpts = await proposalReviewOptions({
          connection,
          instructions: allInners,
          verifiedProgram: verifiedIchorProgram,
          verifiedGovernance: verifiedGovernanceIdentity,
          transferFeeBasisPoints: feeOpts.transferFeeBasisPoints,
        });
        const summary = summarizeRecoveredProposalTransactions({
          instructionsCount,
          recoveredIndexes,
          instructions: allInners,
          ichorMint: verifiedGovernance.communityMint,
          opts: reviewOpts,
        });
        setActionSummary(summary);
        setReviewedProposalAddress(summary.recoveryComplete ? snapshot.proposal.toBase58() : null);
        // C4/C5: only keep an executable staged receipt when there is exactly
        // one ProposalTransaction index and the summary is not unknown.
        if (instructionsCount === 1 && summary.kind !== "unknown" && firstStaged) {
          setRecoveredStaged(firstStaged);
          setRecoveredInstructions(allInners);
        } else {
          setRecoveredStaged(null);
          setRecoveredInstructions(allInners.length > 0 ? allInners : null);
        }
      } catch {
        setRecoveredStaged(null);
        setRecoveredInstructions(null);
        setReviewedProposalAddress(null);
        setActionSummary(
          summarizeRecoveredProposalTransactions({
            instructionsCount,
            recoveredIndexes: 0,
            instructions: [],
            ichorMint: verifiedGovernance.communityMint,
            opts: feeOpts,
          }),
        );
      }
    } catch (err) {
      setFetchedProposal(null);
      setStandingVotesOnOpenProposal(null);
      setFetchedMarkdown(null);
      setActionSummary(null);
      setReviewedProposalAddress(null);
      setRecoveredStaged(null);
      setRecoveredInstructions(null);
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    } finally {
      setProposalBusy(false);
    }
  }, [
    connection,
    proposalAddress,
    verifiedGovernance,
    verifiedGovernanceIdentity,
    balances?.withdrawQuote?.basisPoints,
    props.onProofStale,
  ]);

  useEffect(() => {
    void refreshProposal();
  }, [refreshProposal]);

  // After any confirmed send, re-read the open proposal. Sign-off / vote /
  // finalize / execute change state on chain; refreshing only the list left
  // the open card stuck on Draft until a manual refresh.
  useEffect(() => {
    if (!props.lastConfirmedSignature) {
      return;
    }
    void refreshProposal();
  }, [props.lastConfirmedSignature, refreshProposal]);

  const refreshBalances = useCallback(async (): Promise<void> => {
    if (!verifiedRealm || !wallet.publicKey) {
      setBalances(null);
      setBalancesError(null);
      setTokenOwnerRecord("");
      return;
    }
    setBalancesBusy(true);
    setBalancesError(null);
    try {
      const next = await readHolderVoteBalances({
        connection,
        verifiedRealm,
        owner: wallet.publicKey,
      });
      setBalances(next);
      // Always the PDA for this connected wallet - never a pasted fixture or
      // another owner's record. Account may not exist yet (present: false).
      setTokenOwnerRecord(next.deposit.tokenOwnerRecord.toBase58());
    } catch (err) {
      setBalances(null);
      setTokenOwnerRecord("");
      setBalancesError(formatError(err));
    } finally {
      setBalancesBusy(false);
    }
  }, [connection, verifiedRealm, wallet.publicKey]);

  useThrottledLiveRefresh(
    Boolean(verifiedRealm && wallet.publicKey),
    refreshBalances,
    props.lastConfirmedSignature,
  );

  useEffect(() => {
    if (!props.lastConfirmedSignature) {
      return;
    }
    setTransfer(null);
  }, [props.lastConfirmedSignature]);

  function recordDerived(built: {
    derivedAddresses: Record<string, { toBase58(): string }>;
  }): void {
    setDerived(
      Object.entries(built.derivedAddresses)
        .map(([name, key]) => `${name}=${key.toBase58()}`)
        .join("\n"),
    );
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

  async function communityTokenAta(
    realm: VerifiedRealm,
    owner: NonNullable<typeof wallet.publicKey>,
  ) {
    const mint = await fetchBoundMintSnapshot(connection, realm.verified, realm.communityMint);
    return getAssociatedTokenAddressSync(mint.mint, owner, false, mint.ownerProgram);
  }

  async function buildDeposit(): Promise<void> {
    setError(null);
    try {
      const { verifiedRealm: realm, owner } = requireRealm();
      const mint = await fetchBoundMintSnapshot(connection, realm.verified, realm.communityMint);
      const amount = parseUiToBaseUnits(depositUi, mint.decimals);
      const tokenSourceAccount = getAssociatedTokenAddressSync(
        mint.mint,
        owner,
        false,
        mint.ownerProgram,
      );
      const built = await buildDepositIchorVotes({
        connection,
        verifiedRealm: realm,
        tokenSourceAccount,
        tokenOwner: owner,
        sourceAuthority: owner,
        payer: owner,
        amount,
      });
      recordDerived(built);
      const grossUi = formatBaseUnits(built.transfer.amount, mint.decimals);
      const feeUi = formatBaseUnits(built.transfer.expectedMintFee, mint.decimals);
      const netUi = formatBaseUnits(built.transfer.expectedNet, mint.decimals);
      setTransfer({
        kind: "deposit",
        grossUi,
        feeUi,
        netUi,
        grossBase: built.transfer.amount.toString(10),
        feeBase: built.transfer.expectedMintFee.toString(10),
        netBase: built.transfer.expectedNet.toString(10),
      });
      props.onRequestSend({
        label: "deposit ICHOR votes",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
        holderSummary: {
          kind: "deposit",
          headline: "Deposit ICHOR to vote",
          details: [
            "This is a transfer, not a burn. Your ICHOR moves into the Realms holding account for this realm.",
            `Move ${grossUi} ICHOR. The 0.25% transfer fee withholds ${feeUi}. Voting weight credited is ${netUi}.`,
            "You can withdraw after standing votes on finished proposals are released (Withdraw does that automatically). The same 0.25% applies on the way out.",
          ],
        },
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    }
  }

  async function buildWithdraw(): Promise<void> {
    setError(null);
    setWithdrawBusy(true);
    try {
      const { verifiedRealm: realm, owner } = requireRealm();
      if (!passed?.verifiedGovernanceIdentity) {
        throw new Error(
          passed?.governanceReason ??
            "VerifiedGovernanceIdentity is required to release standing votes on withdraw",
        );
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      const mint = await fetchBoundMintSnapshot(connection, realm.verified, realm.communityMint);
      const destination = await communityTokenAta(realm, owner);
      const built = await buildReleaseStandingAndWithdrawIchorVotes({
        connection,
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        governingTokenOwner: owner,
        governanceAuthority: owner,
        beneficiary: owner,
        governingTokenDestination: destination,
      });
      recordDerived(built);
      setTransfer({
        kind: "withdraw",
        grossUi: formatBaseUnits(built.transfer.amount, mint.decimals),
        feeUi: formatBaseUnits(built.transfer.expectedMintFee, mint.decimals),
        netUi: formatBaseUnits(built.transfer.expectedNet, mint.decimals),
        grossBase: built.transfer.amount.toString(10),
        feeBase: built.transfer.expectedMintFee.toString(10),
        netBase: built.transfer.expectedNet.toString(10),
      });
      const releaseNote =
        built.releasedStandingCount > 0
          ? `This transaction first releases ${String(built.releasedStandingCount)} standing vote${built.releasedStandingCount === 1 ? "" : "s"} on finished proposal(s)${built.proposalNames.length > 0 ? ` (${built.proposalNames.filter(Boolean).join("; ")})` : ""}, then withdraws.`
          : "No standing votes on finished proposals. Withdraw only.";
      props.onRequestSend({
        label: "withdraw deposited ICHOR",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
        holderSummary: {
          kind: "withdraw",
          headline: "Withdraw deposited ICHOR",
          details: [
            "This returns your deposit to your wallet. It is not a burn.",
            releaseNote,
            `Gross ${formatBaseUnits(built.transfer.amount, mint.decimals)} ICHOR. The 0.25% transfer fee withholds ${formatBaseUnits(built.transfer.expectedMintFee, mint.decimals)}. Your wallet receives ${formatBaseUnits(built.transfer.expectedNet, mint.decimals)}.`,
          ],
        },
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
      window.requestAnimationFrame(() => {
        depositActionErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    } finally {
      setWithdrawBusy(false);
    }
  }

  async function buildRelinquishAllStanding(): Promise<void> {
    setError(null);
    try {
      if (!passed?.verifiedGovernanceIdentity) {
        throw new Error(
          passed?.governanceReason ??
            "VerifiedGovernanceIdentity is required for this Governance account",
        );
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      const standing = await listStandingCommunityVotes({
        connection,
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        governingTokenOwner: wallet.publicKey,
      });
      if (standing.length === 0) {
        throw new Error(
          "No standing votes on this deposit record. If withdraw still fails, refresh balances. The chain count may already be zero.",
        );
      }
      const built = await buildRelinquishStandingCommunityVotes({
        connection,
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        governingTokenOwner: wallet.publicKey,
        governanceAuthority: wallet.publicKey,
        beneficiary: wallet.publicKey,
      });
      recordDerived(built);
      props.onRequestSend({
        label: "relinquish all standing community votes",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
        holderSummary: {
          kind: "vote",
          headline: `Relinquish ${String(built.standingCount)} standing vote${built.standingCount === 1 ? "" : "s"}`,
          details: [
            "Realms keeps one standing vote per proposal you voted on. Relinquishing one does not clear the others.",
            `Clears: ${built.proposalNames.map((name) => name || "(untitled)").join("; ")}`,
            "After this confirms, withdraw can return your deposit.",
          ],
        },
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    }
  }

  type SelectedActionBuild = {
    instructions: UnsignedPayload["instructions"];
    derivedAddresses: UnsignedPayload["derivedAddresses"];
    label: string;
    details: string[];
  };

  /**
   * Build the selected treasury/upgrade inner(s). Shared by Create (auto-pack)
   * and the standalone Insert recovery button.
   */
  async function buildSelectedAction(): Promise<SelectedActionBuild> {
    if (!passed?.verifiedGovernanceIdentity || !passed.verifiedGovernance) {
      throw new Error("VerifiedGovernanceIdentity is required to insert an action");
    }
    if (actionKind === "none") {
      throw new Error("choose Pay ICHOR, Pay SOL, or Upgrade before insert");
    }
    const identity = passed.verifiedGovernanceIdentity;
    if (actionKind === "pay-ichor") {
      const mint = await fetchBoundMintSnapshot(
        connection,
        passed.verifiedGovernance.verifiedRealm.verified,
        passed.verifiedGovernance.communityMint,
      );
      const built = await buildHolderPayIchorAction({
        connection,
        verifiedGovernance: identity,
        recipient: payRecipient,
        amountUi: payAmountUi,
        decimals: mint.decimals,
        createDestinationAta: createDestAta,
      });
      return {
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
        label: "Pay ICHOR from treasury",
        details: [
          `Gross ${formatBaseUnits(built.transfer.amount, mint.decimals)} ICHOR`,
          `Fee ${formatBaseUnits(built.transfer.expectedMintFee, mint.decimals)}`,
          `Recipient receives ${formatBaseUnits(built.transfer.expectedNet, mint.decimals)}`,
          `To ${payRecipient.trim()}`,
        ],
      };
    }
    if (actionKind === "pay-sol") {
      const built = await buildHolderPaySolAction({
        connection,
        verifiedGovernance: identity,
        recipient: payRecipient,
        amountUi: payAmountUi,
      });
      return {
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
        label: "Pay SOL from treasury",
        details: [
          `${formatBaseUnits(built.lamports, 9)} SOL (${built.lamports.toString(10)} lamports)`,
          `To ${payRecipient.trim()}`,
        ],
      };
    }
    if (!verifiedIchorProgram) {
      throw new Error("VerifiedIchorProgram is required to stage an upgrade");
    }
    const built = await buildHolderUpgradeAction({
      connection,
      verifiedProgram: verifiedIchorProgram,
      verifiedGovernance: identity,
      buffer: upgradeBuffer,
    });
    return {
      instructions: built.instructions,
      derivedAddresses: built.derivedAddresses,
      label: "Upgrade ICHOR program",
      details: [`Buffer ${upgradeBuffer.trim()}`, "Spill goes to the native treasury"],
    };
  }

  async function buildProposal(): Promise<void> {
    setError(null);
    try {
      if (!passed?.verifiedGovernance || !passed.verifiedGovernanceIdentity) {
        throw new Error(
          passed?.governanceReason ??
            "VerifiedGovernance missing; propose/vote stay disabled until verifyGovernanceDeployment issues a proof",
        );
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      if (!tokenOwnerRecord.trim()) {
        throw new Error("token owner record is unknown; deposit first or paste the live PDA");
      }
      if (!proposalName.trim()) {
        throw new Error("proposal title is required");
      }
      let descriptionLink = proposalLinkOverride.trim();
      if (descriptionLink.length === 0) {
        assertProposalMarkdown(proposalMarkdown);
        const pinned = await pinProposalMarkdown(
          proposalMarkdown,
          wallet.publicKey?.toBase58() ?? "",
        );
        descriptionLink = pinned.descriptionLink;
        setPinnedDescriptionLink(descriptionLink);
      }
      const tor = requirePublicKey(tokenOwnerRecord, "tokenOwnerRecord");
      const built = await buildCreateCommunityProposal({
        verifiedGovernance: passed.verifiedGovernance,
        tokenOwnerRecord: tor,
        governanceAuthority: wallet.publicKey,
        payer: wallet.publicKey,
        name: proposalName.trim(),
        descriptionLink,
        options: ["Approve"],
        useDenyOption: true,
      });
      setProposalOwnerRecord(tokenOwnerRecord.trim());
      const proposal = built.derivedAddresses.proposal;
      if (!proposal) {
        throw new Error("create did not derive a proposal address");
      }
      setProposalAddress(proposal.toBase58());

      // When an action is selected, pack CreateProposal + InsertTransaction in
      // one wallet confirm. On-chain they are two instructions; exposing them
      // as two Phantom prompts caused operators to skip Insert and vote on
      // signal-only drafts (instructionsCount 0).
      const instructions: TransactionInstruction[] = [...built.instructions];
      let derivedAddresses: UnsignedPayload["derivedAddresses"] = {
        ...built.derivedAddresses,
      };
      let actionBuild: SelectedActionBuild | null = null;
      if (actionKind !== "none") {
        const identity = passed.verifiedGovernanceIdentity;
        const holdUp = identity.config.minInstructionHoldUpTime;
        actionBuild = await buildSelectedAction();
        const { insert } = await insertApproveAction({
          verifiedGovernance: identity,
          proposal,
          tokenOwnerRecord: tor,
          governanceAuthority: wallet.publicKey,
          payer: wallet.publicKey,
          holdUpTime: holdUp,
          instructions: [...actionBuild.instructions],
        });
        instructions.push(...insert.instructions);
        derivedAddresses = {
          ...derivedAddresses,
          ...insert.derivedAddresses,
        };
        recordDerived(insert);
        setRecoveredStaged(insert.staged);
        setRecoveredInstructions([...actionBuild.instructions]);
        setActionSummary(
          await summarizeProposalInstructionsForReview({
            connection,
            instructions: actionBuild.instructions,
            ichorMint: passed.verifiedGovernance.communityMint,
            verifiedProgram: verifiedIchorProgram,
            verifiedGovernance: passed.verifiedGovernanceIdentity,
            transferFeeBasisPoints: balances?.withdrawQuote?.basisPoints ?? null,
          }),
        );
      } else {
        recordDerived(built);
        setRecoveredStaged(null);
        setRecoveredInstructions(null);
        setActionSummary(null);
      }

      const holdUp =
        passed.verifiedGovernanceIdentity.config.minInstructionHoldUpTime;
      props.onRequestSend({
        label:
          actionBuild === null
            ? "create community proposal"
            : "create community proposal + insert action",
        instructions,
        derivedAddresses,
        holderSummary: {
          kind: "propose",
          headline:
            actionBuild === null
              ? "Create a proposal"
              : `Create proposal and attach: ${actionBuild.label}`,
          details: [
            "This creates a Realms proposal. It does not burn ICHOR and it does not move the treasury yet.",
            `Title: ${proposalName.trim()}`,
            `Description: ${descriptionLink}`,
            ...(actionBuild === null
              ? [
                  "Signal only. No treasury action in this transaction. Use Insert action later if you change your mind, or leave it as a signal.",
                ]
              : [
                  ...actionBuild.details,
                  `Hold-up after a yes vote: ${String(holdUp)} seconds (from live governance config).`,
                  "Create and Insert are packed in this one confirmation. The 0.0001 SOL (or ICHOR) pay only leaves the treasury on Execute after a yes vote.",
                ]),
            "Voting stays closed until you sign off.",
          ],
        },
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    }
  }

  /** Recovery path: attach an action to an existing draft that has none. */
  async function buildInsertAction(): Promise<void> {
    setError(null);
    try {
      if (!passed?.verifiedGovernanceIdentity || !passed.verifiedGovernance) {
        throw new Error("VerifiedGovernanceIdentity is required to insert an action");
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      if (!proposalAddress.trim()) {
        throw new Error("create the proposal first so its address is known");
      }
      if (!tokenOwnerRecord.trim()) {
        throw new Error("your deposit record is required to insert");
      }
      if (actionKind === "none") {
        throw new Error("choose Pay ICHOR, Pay SOL, or Upgrade before insert");
      }
      const identity = passed.verifiedGovernanceIdentity;
      const holdUp = identity.config.minInstructionHoldUpTime;
      const actionBuild = await buildSelectedAction();
      const { insert } = await insertApproveAction({
        verifiedGovernance: identity,
        proposal: requirePublicKey(proposalAddress, "proposal"),
        tokenOwnerRecord: requirePublicKey(tokenOwnerRecord, "tokenOwnerRecord"),
        governanceAuthority: wallet.publicKey,
        payer: wallet.publicKey,
        holdUpTime: holdUp,
        instructions: [...actionBuild.instructions],
      });
      recordDerived(insert);
      setRecoveredStaged(insert.staged);
      setRecoveredInstructions([...actionBuild.instructions]);
      setActionSummary(
        await summarizeProposalInstructionsForReview({
          connection,
          instructions: actionBuild.instructions,
          ichorMint: passed.verifiedGovernance.communityMint,
          verifiedProgram: verifiedIchorProgram,
          verifiedGovernance: passed.verifiedGovernanceIdentity,
          transferFeeBasisPoints: balances?.withdrawQuote?.basisPoints ?? null,
        }),
      );
      props.onRequestSend({
        label: "insert proposal transaction",
        instructions: insert.instructions,
        derivedAddresses: insert.derivedAddresses,
        holderSummary: {
          kind: "propose",
          headline: `Attach: ${actionBuild.label}`,
          details: [
            ...actionBuild.details,
            `Hold-up after a yes vote: ${String(holdUp)} seconds (from live governance config).`,
            "Sign off after this lands to open voting.",
          ],
        },
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    }
  }

  async function buildFinalize(): Promise<void> {
    setError(null);
    try {
      if (!passed?.verifiedGovernanceIdentity || !fetchedProposal) {
        throw new Error("open a proposal and wait for VerifiedGovernanceIdentity");
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      const built = await buildFinalizeVote({
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        proposal: fetchedProposal.proposal,
        proposalOwnerRecord: fetchedProposal.tokenOwnerRecord,
        governingTokenMint: fetchedProposal.governingTokenMint,
        connection,
        releaseVoterDeposits: true,
      });
      recordDerived(built);
      const releaseDetails =
        built.releasedVoteCount > 0
          ? [
              `Also releases ${String(built.releasedVoteCount)} standing vote record${built.releasedVoteCount === 1 ? "" : "s"} on this proposal so those deposits unlock. Realms does not do that by itself.`,
              ...(built.remainingUnreleasedCount > 0
                ? [
                    `${String(built.remainingUnreleasedCount)} more vote record(s) remain; use "Release voter deposits" after this confirms.`,
                  ]
                : []),
            ]
          : [
              "No standing VoteRecords were found to release on this proposal.",
            ];
      props.onRequestSend({
        label: "finalize proposal vote",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
        holderSummary: {
          kind: "vote",
          headline: "Finalize this proposal",
          details: [
            "Closes the voting window on chain so the result can move to Succeeded or Defeated.",
            "Anyone can send this after the clock is up.",
            ...releaseDetails,
          ],
        },
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    }
  }

  async function buildReleaseVoterDeposits(): Promise<void> {
    setError(null);
    try {
      if (!passed?.verifiedGovernanceIdentity || !fetchedProposal) {
        throw new Error("open a proposal and wait for VerifiedGovernanceIdentity");
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      const built = await buildReleaseVotesOnClosedProposal({
        connection,
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        proposal: fetchedProposal.proposal,
      });
      recordDerived(built);
      props.onRequestSend({
        label: "release voter deposits on closed proposal",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
        holderSummary: {
          kind: "vote",
          headline: "Release voter deposits",
          details: [
            `Permissionless RelinquishVote for ${String(built.releasedCount)} standing vote${built.releasedCount === 1 ? "" : "s"} on this closed proposal.`,
            "Anyone can send this after a proposal is finalized or tipped. It unlocks those voters' deposits.",
            ...(built.remainingCount > 0
              ? [`${String(built.remainingCount)} more remain; send again after this confirms.`]
              : []),
          ],
        },
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    }
  }

  async function buildExecute(): Promise<void> {
    setError(null);
    try {
      if (!passed?.verifiedGovernanceIdentity) {
        throw new Error("VerifiedGovernanceIdentity is required to execute");
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      if (!proposalAddress.trim()) {
        throw new Error("proposal address is required");
      }
      if (actionSummary?.kind === "unknown") {
        throw new Error(
          "Execute stays closed while the recovered action is unclassified. This page will not send an unrecognized payload.",
        );
      }
      if (actionSummary?.kind === "none") {
        throw new Error("This proposal has no inserted action to execute.");
      }
      if (
        reviewedProposalAddress === null ||
        reviewedProposalAddress !== proposalAddress.trim()
      ) {
        throw new Error(
          "Execute stays closed until this proposal's recovered instructions are reviewed.",
        );
      }
      let staged = recoveredStaged;
      let inners = recoveredInstructions;
      if (!staged || !inners) {
        const snapshot = fetchedProposal;
        const count = snapshot?.options[0]?.instructionsCount ?? 0;
        if (count !== 1) {
          throw new Error(
            count > 1
              ? `This proposal has ${String(count)} ProposalTransaction indexes; this page executes only a single classified index-0 action.`
              : "No ProposalTransaction to execute.",
          );
        }
        const recovered = await recoverProposalTransaction({
          connection,
          verifiedGovernance: passed.verifiedGovernanceIdentity,
          proposal: requirePublicKey(proposalAddress, "proposal"),
          optionIndex: 0,
          index: 0,
        });
        staged = recovered.staged;
        inners = recovered.transactionInstructions;
        const summary = await summarizeProposalInstructionsForReview({
          connection,
          instructions: inners,
          ichorMint: passed.verifiedGovernance?.communityMint ?? null,
          verifiedProgram: verifiedIchorProgram,
          verifiedGovernance: passed.verifiedGovernanceIdentity,
          transferFeeBasisPoints: balances?.withdrawQuote?.basisPoints ?? null,
        });
        if (summary.kind === "unknown" || summary.kind === "none") {
          setActionSummary(summary);
          throw new Error(
            "Recovered action is unclassified or empty; Execute stays closed on this page.",
          );
        }
        setActionSummary(summary);
        setRecoveredStaged(staged);
        setRecoveredInstructions(inners);
      }
      if (!staged.proposal.equals(requirePublicKey(proposalAddress, "proposal"))) {
        throw new Error("Staged execute receipt is not this proposal.");
      }
      const built = await buildExecuteProposalTransaction({
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        proposal: staged.proposal,
        staged,
        transactionInstructions: [...inners],
      });
      recordDerived(built);
      const summary = await summarizeProposalInstructionsForReview({
        connection,
        instructions: inners,
        ichorMint: passed.verifiedGovernance?.communityMint ?? null,
        verifiedProgram: verifiedIchorProgram,
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        transferFeeBasisPoints: balances?.withdrawQuote?.basisPoints ?? null,
      });
      if (summary.kind === "unknown") {
        setActionSummary(summary);
        throw new Error(
          "Execute stays closed while the recovered action is unclassified. This page will not send an unrecognized payload.",
        );
      }
      props.onRequestSend({
        label: "execute proposal transaction",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
        holderSummary: {
          kind: "other",
          headline: `Execute: ${summary.headline}`,
          details: [
            ...summary.details,
            "Permissionless after a yes vote and the hold-up. This is what moves the treasury or upgrades the program.",
          ],
        },
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    }
  }

  async function buildSignOff(): Promise<void> {
    setError(null);
    try {
      if (!passed?.verifiedGovernanceIdentity) {
        throw new Error(
          passed?.governanceReason ??
            "VerifiedGovernanceIdentity is required for this Governance account",
        );
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      if (!proposalAddress.trim()) {
        throw new Error("proposal address is required");
      }
      const signOff: BuildSignOffProposalParams = {
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        proposal: requirePublicKey(proposalAddress, "proposal"),
        signatory: wallet.publicKey,
        ...(tokenOwnerRecord.trim()
          ? { proposalOwnerRecord: requirePublicKey(tokenOwnerRecord, "tokenOwnerRecord") }
          : {}),
      };
      const built = await buildSignOffProposal(signOff);
      recordDerived(built);
      const voteSecs =
        passed.verifiedGovernanceIdentity.config.baseVotingTime ??
        passed.verifiedGovernance?.config.baseVotingTime;
      props.onRequestSend({
        label: "sign off proposal",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
        holderSummary: {
          kind: "propose",
          headline: "Sign off to open voting",
          details: [
            "This opens voting on the proposal you just created. It does not burn ICHOR.",
            `Proposal ${proposalAddress}`,
            voteSecs !== undefined
              ? `After this lands, CastVote is only accepted for ${String(voteSecs)} seconds. Prefer "Sign off + Vote Yes (one tx)" so Phantom confirm cannot burn the window.`
              : "After this lands, voting opens for the governance baseVotingTime only.",
          ],
        },
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    }
  }

  async function buildSignOffAndVoteYes(): Promise<void> {
    setError(null);
    try {
      if (!passed?.verifiedGovernanceIdentity || !passed.verifiedGovernance) {
        throw new Error(
          passed?.governanceReason ??
            "VerifiedGovernance is required to sign off and vote",
        );
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      if (!proposalAddress.trim()) {
        throw new Error("proposal address is required");
      }
      if (!tokenOwnerRecord.trim()) {
        throw new Error("your deposit TokenOwnerRecord is required");
      }
      const tor = tokenOwnerRecord.trim();
      const ownerRecord = (proposalOwnerRecord.trim() || tor);
      const proposal = requirePublicKey(proposalAddress, "proposal");
      if (
        fetchedProposal &&
        fetchedProposal.state !== ProposalState.Draft &&
        fetchedProposal.state !== ProposalState.SigningOff
      ) {
        throw new Error(
          `Sign off + Vote needs a Draft/SigningOff proposal; this one is "${fetchedProposal.stateName}". Create a new proposal (the expired Voting one cannot be revived).`,
        );
      }
      if (!instructionsReviewed) {
        throw new Error(
          "Open the proposal and wait until every instruction is recovered before voting Yes. This page will not cast a vote against an unread action.",
        );
      }
      const signOff = await buildSignOffProposal({
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        proposal,
        signatory: wallet.publicKey,
        proposalOwnerRecord: requirePublicKey(tor, "tokenOwnerRecord"),
      });
      const vote = await buildCastCommunityVote({
        verifiedGovernance: passed.verifiedGovernance,
        proposal,
        proposalOwnerRecord: requirePublicKey(ownerRecord, "proposalOwnerRecord"),
        tokenOwnerRecord: requirePublicKey(tor, "tokenOwnerRecord"),
        governanceAuthority: wallet.publicKey,
        payer: wallet.publicKey,
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
        holderSummary: {
          kind: "vote",
          headline: "Sign off and vote Yes in one transaction",
          details: [
            "Opens voting and records your Yes in the same confirmation.",
            "Use this whenever baseVotingTime is shorter than a wallet approve.",
            `Proposal ${proposalAddress}`,
          ],
        },
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    }
  }

  async function buildVote(choice: CommunityYesNoChoice): Promise<void> {
    setError(null);
    try {
      if (!passed?.verifiedGovernance) {
        throw new Error(
          passed?.governanceReason ??
            "VerifiedGovernance missing; propose/vote stay disabled until verifyGovernanceDeployment issues a proof",
        );
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      if (!fetchedProposal) {
        throw new Error("open a proposal from the list before voting");
      }
      if (!instructionsReviewed) {
        throw new Error(
          "Open the proposal and wait until every instruction is recovered before voting. This page will not cast a vote against an unread action.",
        );
      }
      if (fetchedProposal.state !== ProposalState.Voting) {
        throw new Error(
          fetchedProposal.state === ProposalState.Draft ||
            fetchedProposal.state === ProposalState.SigningOff
            ? `Voting is not open yet. This proposal is still "${fetchedProposal.stateName}". Click "Sign off to open voting" first, then vote.`
            : `You can only vote while a proposal is Voting. This one is "${fetchedProposal.stateName}".`,
        );
      }
      if (
        baseVotingTime === null ||
        !proposalVotingAcceptsCast(
          fetchedProposal,
          baseVotingTime,
          Math.floor(Date.now() / 1000),
        )
      ) {
        throw new Error(
          "Voting time has ended on this proposal. Realms still shows Voting until someone finalizes; Vote for / Vote against stay closed. Use Finalize vote.",
        );
      }
      await castCommunityVoteAt({
        choice,
        proposal: requirePublicKey(proposalAddress, "proposal"),
        proposalOwnerRecord: requirePublicKey(proposalOwnerRecord, "proposalOwnerRecord"),
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    }
  }

  async function castCommunityVoteAt(params: {
    choice: CommunityYesNoChoice;
    proposal: ReturnType<typeof requirePublicKey>;
    proposalOwnerRecord: ReturnType<typeof requirePublicKey>;
  }): Promise<void> {
    if (!passed?.verifiedGovernance) {
      throw new Error(
        passed?.governanceReason ??
          "VerifiedGovernance missing; propose/vote stay disabled until verifyGovernanceDeployment issues a proof",
      );
    }
    if (!wallet.publicKey) {
      throw new Error("connect a wallet; this app never receives private keys");
    }
    if (!tokenOwnerRecord.trim()) {
      throw new Error("your deposit record is required; deposit ICHOR before voting");
    }
    const built = await buildCastCommunityVote({
      verifiedGovernance: passed.verifiedGovernance,
      proposal: params.proposal,
      proposalOwnerRecord: params.proposalOwnerRecord,
      tokenOwnerRecord: requirePublicKey(tokenOwnerRecord, "tokenOwnerRecord"),
      governanceAuthority: wallet.publicKey,
      payer: wallet.publicKey,
      choice: params.choice,
    });
    recordDerived(built);
    props.onRequestSend({
      label: `cast community vote ${params.choice}`,
      instructions: built.instructions,
      derivedAddresses: built.derivedAddresses,
      holderSummary: {
        kind: "vote",
        headline: params.choice === "yes" ? "Vote for this proposal" : "Vote against this proposal",
        details: [
          "This records your vote. It does not burn ICHOR and it does not move your deposit.",
          "When the proposal ends, Finalize (or Release voter deposits) unlocks standing votes. Withdraw also releases your finished standing votes automatically.",
        ],
      },
    });
  }

  async function buildVoteFromCard(
    row: CommunityProposalListItem,
    choice: CommunityYesNoChoice,
  ): Promise<void> {
    setError(null);
    const openAddress = row.proposal.toBase58();
    try {
      if (proposalAddress !== openAddress || !instructionsReviewed) {
        openProposalFromList(row);
        throw new Error(
          "Open this proposal and read the recovered instructions below before voting. Vote stays closed until every instruction is recovered.",
        );
      }
      if (
        baseVotingTime === null ||
        !proposalVotingAcceptsCast(
          {
            state: row.state,
            votingAt: row.votingAt,
            maxVotingTime: null,
          },
          baseVotingTime,
          Math.floor(Date.now() / 1000),
        )
      ) {
        throw new Error(
          "Voting time has ended on this proposal. Realms still shows Voting until someone finalizes; Vote for / Vote against stay closed. Use Finalize vote.",
        );
      }
      await castCommunityVoteAt({
        choice,
        proposal: row.proposal,
        proposalOwnerRecord: row.tokenOwnerRecord,
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    }
  }

  /** Any wallet (or none) can open any proposal - chain read is permissionless. */
  function openProposalFromList(row: CommunityProposalListItem): void {
    setError(null);
    const next = row.proposal.toBase58();
    setProposalOwnerRecord(row.tokenOwnerRecord.toBase58());
    // Make the open proposal linkable. replaceState rather than assigning
    // location.hash: assigning pushes a history entry per click, so Back
    // walks every proposal the reader glanced at instead of leaving the page.
    // It also fires hashchange, which would re-enter the effect below.
    window.history.replaceState(null, "", proposalHashFor(next));
    if (proposalAddress === next) {
      // Re-click: useEffect will not re-run; force a fresh read so a second
      // wallet does not sit on a stale empty detail panel.
      void refreshProposal();
    } else {
      setProposalAddress(next);
    }
    // Fill this wallet's VoteRecord PDA for the open proposal when known.
    void fillVoteRecordForProposal(row.proposal);
    // Detail panel is below the board; scroll so the click is obvious.
    window.setTimeout(() => {
      document.getElementById("proposal-detail")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 50);
  }

  /**
   * Open the proposal named in the URL, on load and on hashchange.
   *
   * Two-stage on purpose. The address alone is enough for the detail panel to
   * read the proposal from chain, so it is applied immediately and the reader
   * sees content without waiting for the list. The TokenOwnerRecord is not
   * derivable from the address, so it is filled in a second pass once
   * `proposalList` arrives - that is what the row click supplies directly.
   */
  useEffect(() => {
    function applyHash(): void {
      const wanted = proposalFromHash(window.location.hash);
      if (!wanted || wanted === proposalAddress) {
        return;
      }
      setError(null);
      setProposalAddress(wanted);
      window.setTimeout(() => {
        document.getElementById("proposal-detail")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 50);
    }
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
    // proposalAddress is read inside to avoid re-opening a proposal the reader
    // has since navigated away from; it must not re-subscribe on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Second stage of the deep link: supply the TokenOwnerRecord once the list
   * is loaded. Without this a deep-linked proposal renders but the panel does
   * not know whose record created it, which the vote path needs.
   */
  useEffect(() => {
    if (!proposalAddress || proposalOwnerRecord || proposalList.length === 0) {
      return;
    }
    const row = proposalList.find((r) => r.proposal.toBase58() === proposalAddress);
    if (row) {
      setProposalOwnerRecord(row.tokenOwnerRecord.toBase58());
      void fillVoteRecordForProposal(row.proposal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposalAddress, proposalOwnerRecord, proposalList]);

  async function fillVoteRecordForProposal(proposal: {
    toBase58(): string;
    equals?(other: { toBase58(): string }): boolean;
  }): Promise<void> {
    if (!passed?.verifiedGovernanceIdentity || !wallet.publicKey) {
      return;
    }
    try {
      const standing = await listStandingCommunityVotes({
        connection,
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        governingTokenOwner: wallet.publicKey,
      });
      const match = standing.find((row) => row.proposal.toBase58() === proposal.toBase58());
      if (match) {
        setVoteRecord(match.voteRecord.toBase58());
      }
    } catch {
      // Leave the field alone; Relinquish-all does not need it.
    }
  }

  async function buildRelinquish(): Promise<void> {
    setError(null);
    try {
      if (!passed?.verifiedGovernanceIdentity) {
        throw new Error(
          passed?.governanceReason ??
            "VerifiedGovernanceIdentity is required for this Governance account",
        );
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet; this app never receives private keys");
      }
      const built = await buildRelinquishCommunityVote({
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        proposal: requirePublicKey(proposalAddress, "proposal"),
        tokenOwnerRecord: requirePublicKey(tokenOwnerRecord, "tokenOwnerRecord"),
        voteRecord: requirePublicKey(voteRecord, "voteRecord"),
        governanceAuthority: wallet.publicKey,
        beneficiary: wallet.publicKey,
      });
      recordDerived(built);
      props.onRequestSend({
        label: "relinquish community vote",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
        holderSummary: {
          kind: "vote",
          headline: "Relinquish my vote",
          details: [
            "This drops your standing vote so you can withdraw. It does not burn ICHOR.",
          ],
        },
      });
    } catch (err) {
      if (recoverStaleProof(err)) {
        setError(STALE_PROOF_REVERIFY_MESSAGE);
      } else {
        setError(formatError(err));
      }
    }
  }

  return (
    <>
      <HolderSection
        id="deposit"
        idx="06"
        group="What you can do"
        kicker="Deposit ICHOR to vote"
        note="Deposit ICHOR to vote. Relinquish a vote to free the deposit again."
        token="ichor"
      >
      <section className="panel ichor">
        <div className="panel-head">
          <div>
            <h2>Depositing to vote is not a lock</h2>
            <p className="muted">
              Weight is linear deposited ICHOR. Not your wallet balance, not square-root, not
              quadratic, so splitting across wallets gains nothing and a large holder does carry
              more weight than a small one.
            </p>
          </div>
          <div className="panel-actions">
            <span className="pill ichor">YOU CONTROL THE WITHDRAWAL</span>
          </div>
        </div>

        {/* The three states of a deposit, in the order a holder meets them.
            Written because "deposit" reads as "locked up" to a first-timer,
            and the thing that actually holds it is their own unrelinquished
            vote, not us. */}
        <div className="lifecycle">
          <div>
            <div className="k">DEPOSIT</div>
            <p>
              Your ICHOR is transferred out of your wallet into the holding account the Realms
              program owns for this realm, so your wallet balance drops by what you deposit. Your
              recorded weight is what arrives, so the 0.25% transfer fee comes off on the way in.
            </p>
          </div>
          <div>
            <div className="k">RELINQUISH</div>
            <p>
              Realms keeps a standing vote lock until it is released, even after a proposal
              closes. This page releases those locks when someone finalizes (or taps Release
              voter deposits), and Withdraw releases your finished standing votes in the same
              transaction. You can still relinquish early while a vote is open if you want to
              pull your weight back.
            </p>
          </div>
          <div>
            <div className="k">WITHDRAW</div>
            <p>
              The deposit returns to your wallet, minus the 0.25% transfer fee on the way out.
              Withdraw auto-releases your standing votes on finished proposals. Open votes still
              need an explicit Relinquish (or wait for the proposal to end).
            </p>
          </div>
        </div>

        <p className="muted">
          <strong>The permanent lock further down this page is the project&apos;s liquidity, not
          this deposit.</strong>{" "}
          Your ICHOR is never locked by us. Nothing else reaches your deposit: not a passed
          proposal, not the treasury, not us.
        </p>

        {!verifiedRealm ? (
          <div className="empty">
            <h3>Voting opens when the realm is published</h3>
            <p className="muted">
              Deposit, withdraw and vote stay closed until this page can match a published realm
              on chain. Nothing here is guessed.
            </p>
            {passed?.realmReason ? <pre>{passed.realmReason}</pre> : null}
          </div>
        ) : null}

        <div className="row">
          <label>
            ICHOR to deposit or withdraw
            <input
              value={depositUi}
              onChange={(event) => setDepositUi(event.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={!depositReady || !balances?.walletIchor?.present || !balances?.walletIchor?.amount}
            onClick={() => {
              if (!balances?.walletIchor?.amount) {
                return;
              }
              setDepositUi(formatBaseUnits(balances.walletIchor.amount, balances.decimals));
            }}
          >
            Use wallet balance
          </button>
          <button type="button" onClick={() => void buildDeposit()} disabled={!depositReady}>
            {connected ? "Deposit to vote" : "Connect a wallet to deposit"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void buildRelinquishAllStanding()}
            disabled={!identityReady}
          >
            {connected
              ? balances?.deposit.unrelinquishedVotesCount &&
                balances.deposit.unrelinquishedVotesCount > 0
                ? `Relinquish all standing votes (${String(balances.deposit.unrelinquishedVotesCount)})`
                : "Relinquish all standing votes"
              : "Connect a wallet to relinquish"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void buildWithdraw()}
            disabled={!depositReady || withdrawBusy}
          >
            {withdrawBusy
              ? "Checking withdraw…"
              : connected
                ? "Withdraw my deposit"
                : "Connect a wallet to withdraw"}
          </button>
        </div>

        {error ? (
          <div className="gate-fail" ref={depositActionErrorRef} role="alert">
            <pre>{error}</pre>
          </div>
        ) : null}

        <div className="mine deposit-balances">
          <div>
            <div className="k">
              <img src="/ichor-mark.png" alt="" width={18} height={18} />
              <span>ICHOR to deposit</span>
            </div>
            <div className="v">
              {!connected
                ? "connect a wallet"
                : !verifiedRealm
                  ? "unread"
                  : balancesBusy && !balances
                    ? "reading chain"
                    : balances
                      ? ichorAmountLabel(
                          balances.walletIchor.amount ?? new BN(0),
                          balances.decimals,
                        )
                      : "unread"}
            </div>
            <div className="n">
              {balances
                ? balances.walletIchor.present && balances.depositQuote
                  ? `In this wallet. Depositing all of it credits ${ichorAmountLabel(balances.depositQuote.net, balances.decimals)} of voting weight after the ${feePercentLabel(balances.depositQuote.basisPoints)} transfer fee (${ichorAmountLabel(balances.depositQuote.fee, balances.decimals)}).`
                  : balances.walletIchor.present
                    ? `In this wallet. Base units ${balances.walletIchor.amount?.toString(10) ?? "0"}.`
                    : `No ICHOR token account at ${balances.walletIchor.ata.toBase58()}. Measured as zero, not guessed.`
                : verifiedRealm
                  ? balancesError ?? "Wallet ICHOR is read from the mint ATA after the realm verifies."
                  : "Unread until this page matches a published realm."}
            </div>
          </div>
          <div>
            <div className="k">
              <img src="/ichor-mark.png" alt="" width={18} height={18} />
              <span>ICHOR your wallet receives on withdraw</span>
            </div>
            <div className="v">
              {!connected
                ? "connect a wallet"
                : !verifiedRealm
                  ? "unread"
                  : balancesBusy && !balances
                    ? "reading chain"
                    : balances
                      ? ichorAmountLabel(
                          balances.withdrawQuote?.net ?? balances.deposit.amount,
                          balances.decimals,
                        )
                      : "unread"}
            </div>
            <div className="n">
              {balances
                ? balances.deposit.present && balances.withdrawQuote
                  ? balances.deposit.unrelinquishedVotesCount > 0
                    ? `Voting weight is ${ichorAmountLabel(balances.deposit.amount, balances.decimals)}. The ${feePercentLabel(balances.withdrawQuote.basisPoints)} fee would take ${ichorAmountLabel(balances.withdrawQuote.fee, balances.decimals)} on the way out. Withdraw releases finished standing votes automatically; open votes still need Relinquish first (${String(balances.deposit.unrelinquishedVotesCount)} standing).`
                    : `Voting weight is ${ichorAmountLabel(balances.deposit.amount, balances.decimals)}. The ${feePercentLabel(balances.withdrawQuote.basisPoints)} transfer fee takes ${ichorAmountLabel(balances.withdrawQuote.fee, balances.decimals)} on the way out. Deposit plus withdraw is two transfers.`
                  : balances.deposit.present
                    ? `Deposited voting weight. Base units ${balances.deposit.amount.toString(10)}.`
                    : "Nothing deposited yet. The deposit record below is reserved for this wallet; Realms creates it on the first deposit."
                : verifiedRealm
                  ? balancesError ?? "Deposited ICHOR is read from your deposit record after the realm verifies."
                  : "Unread until this page matches a published realm."}
            </div>
            <p className="deposit-record">
              <span className="k">Your deposit record</span>
              {balances ? (
                <a
                  className="mono"
                  href={depositRecordExplorerUrl(
                    balances.deposit.tokenOwnerRecord.toBase58(),
                    props.config.cluster,
                  )}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {balances.deposit.tokenOwnerRecord.toBase58()}
                </a>
              ) : (
                <span className="mono">
                  {connected ? "reading chain" : "connect a wallet to show the address"}
                </span>
              )}
              <span className="n">
                Realms name: TokenOwnerRecord. This account holds your deposited ICHOR and
                voting weight. It is derived from this wallet and this realm. It is not your
                wallet address
                {balances
                  ? balances.deposit.present
                    ? "."
                    : ", and it has no account until you deposit."
                  : "."}
              </span>
            </p>
          </div>
        </div>

        {/* Real figures from the builder, not an estimate: gross in, fee
            withheld, and what the chain will actually credit or return. */}
        {transfer ? (
          <div className="transfer-preview">
            <div>
              <span className="k">{transfer.kind === "deposit" ? "You deposit" : "You withdraw"}</span>
              <span className="v">{groupUiAmount(transfer.grossUi)} ICHOR</span>
            </div>
            <div>
              <span className="k">
                {balances?.withdrawQuote
                  ? `${feePercentLabel(balances.withdrawQuote.basisPoints)} transfer fee`
                  : balances?.depositQuote
                    ? `${feePercentLabel(balances.depositQuote.basisPoints)} transfer fee`
                    : "Transfer fee"}
              </span>
              <span className="v fee">−{groupUiAmount(transfer.feeUi)} ICHOR</span>
            </div>
            <div>
              <span className="k">
                {transfer.kind === "deposit" ? "Voting weight credited" : "Your wallet receives"}
              </span>
              <span className="v net">{groupUiAmount(transfer.netUi)} ICHOR</span>
            </div>
            <p className="muted">
              Human ICHOR from the mint&apos;s on-chain decimals, not APPLE. Base units{" "}
              {transfer.grossBase} / fee {transfer.feeBase} / net {transfer.netBase}. Nothing has
              been sent yet; your wallet asks you to approve it as a separate step.
            </p>
          </div>
        ) : null}
      </section>
      </HolderSection>

      <HolderSection
        id="vote"
        idx="07"
        group="What you can do"
        kicker="Proposals"
        note="Tap a row to read it and act. Sorted so open votes come first."
      >
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Proposals</h2>
            <p className="muted">
              A proposal spends the treasury only if it passes. Every vote is a public record on
              chain, including yours.
            </p>
          </div>
          <div className="panel-actions">
            <a className="btn-link secondary" href="#deposit" style={{ fontSize: 13, padding: "9px 15px" }}>
              Manage deposit
            </a>
            {verifiedGovernance ? (
              <button type="button" className="secondary" onClick={() => setCreating((open) => !open)}>
                {creating ? "Close" : "New proposal"}
              </button>
            ) : (
              <span className="pill dead">
                {connected ? "VOTING NOT ACTIVE YET" : "CONNECT A WALLET"}
              </span>
            )}
          </div>
        </div>

        {!verifiedGovernance ? (
          <div className="empty">
            <h3>Proposals appear after the DAO is published</h3>
            <p className="muted">
              This page will not invent a title or a tally. Proposals appear here once the DAO
              is published on this cluster.
            </p>
            {passed?.governanceReason ? <pre>{passed.governanceReason}</pre> : null}
          </div>
        ) : null}

        {error ? (
          <div className="gate-fail">
            <pre>{error}</pre>
          </div>
        ) : null}

        {creating ? (
          <div className="create-form">
            <h3>Write a proposal</h3>
            <p className="muted">
              Say what should happen and why. The treasury moves nothing until an action is
              inserted, the proposal passes, and its hold-up has elapsed.
            </p>
            <label>
              Title
              <input value={proposalName} onChange={(event) => setProposalName(event.target.value)} />
            </label>
            <label>
              Full description (markdown)
              <textarea
                value={proposalMarkdown}
                onChange={(event) => setProposalMarkdown(event.target.value)}
                placeholder="# Why&#10;&#10;Write the case. No images. Pinned to Pinata when you create."
              />
            </label>
            <p className="field-note">
              Text only, max 64 KiB. Create pins it and stores the gateway URL on chain as
              descriptionLink. Images are not accepted.
            </p>
            <label>
              Or paste an already-pinned description URL
              <input
                value={proposalLinkOverride}
                onChange={(event) => setProposalLinkOverride(event.target.value)}
                placeholder="optional https://…/ipfs/…"
              />
            </label>
            {pinnedDescriptionLink ? (
              <p className="field-note mono">Pinned: {pinnedDescriptionLink}</p>
            ) : null}
            <label>
              Action if this passes
              <select
                value={actionKind}
                onChange={(event) => setActionKind(event.target.value as HolderActionKind)}
              >
                <option value="none">Signal only (no treasury move)</option>
                <option value="pay-ichor">Pay ICHOR from the treasury</option>
                <option value="pay-sol">Pay SOL from the treasury</option>
                <option value="upgrade">Upgrade the ICHOR program</option>
              </select>
            </label>
            <p className="field-note">
              Voting is for or against. Deny is added automatically. When you pick an action here,
              Create packs it into the same wallet confirmation (CreateProposal + InsertTransaction).
              The treasury still only moves on Execute after a yes vote, not at create time.
            </p>
            {actionKind === "pay-ichor" || actionKind === "pay-sol" ? (
              <div className="row">
                <label>
                  Recipient wallet
                  <input
                    value={payRecipient}
                    onChange={(event) => setPayRecipient(event.target.value)}
                    placeholder="base58 pubkey"
                  />
                </label>
                <label>
                  Amount ({actionKind === "pay-ichor" ? "ICHOR" : "SOL"})
                  <input
                    value={payAmountUi}
                    onChange={(event) => setPayAmountUi(event.target.value)}
                    inputMode="decimal"
                    placeholder="0"
                  />
                </label>
                {actionKind === "pay-ichor" ? (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={createDestAta}
                      onChange={(event) => setCreateDestAta(event.target.checked)}
                    />
                    Create recipient ICHOR account if missing (treasury pays rent)
                  </label>
                ) : null}
              </div>
            ) : null}
            {actionKind === "upgrade" ? (
              <label>
                Already-written loader buffer pubkey
                <input
                  value={upgradeBuffer}
                  onChange={(event) => setUpgradeBuffer(event.target.value)}
                  placeholder="buffer account"
                />
              </label>
            ) : null}
            <label>
              Your deposit record
              <input
                value={tokenOwnerRecord}
                readOnly
                aria-readonly="true"
                title="Derived from the connected wallet. Not editable."
                placeholder="connect a wallet. Filled from your deposit PDA"
              />
            </label>
            <p className="field-note">
              Derived from the connected wallet (Realms TokenOwnerRecord PDA). It is not your
              wallet address and cannot be pasted or altered here. Wrong TOR would only fail
              the transaction; editing is disabled so it cannot look optional.
            </p>
            <div className="row">
              <button type="button" onClick={() => void buildProposal()} disabled={!voteReady}>
                {actionKind === "none"
                  ? "Create proposal"
                  : "Create proposal + insert action"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void buildInsertAction()}
                disabled={!identityReady || !hasProposal || actionKind === "none"}
                title="Recovery only: attach an action to a draft that was created as signal-only"
              >
                Insert action (recovery)
              </button>
              <button
                type="button"
                onClick={() => void buildSignOffAndVoteYes()}
                disabled={!identityReady || !voteReady || !hasProposal || !instructionsReviewed}
                title={
                  instructionsReviewed
                    ? "Packs Sign off + Vote Yes in one transaction so a short baseVotingTime cannot lose to Phantom"
                    : "Open this proposal and read the recovered instructions before voting Yes"
                }
              >
                Sign off + Vote Yes (one tx)
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void buildSignOff()}
                disabled={!identityReady || !hasProposal}
              >
                Sign off only
              </button>
            </div>
            <p className="field-note">
              With an action selected, Create and Insert are one confirmation. Prefer{" "}
              <strong>Sign off + Vote Yes (one tx)</strong> whenever the live voting window is short.
              Sign off alone starts the clock before you can approve Vote. Use{" "}
              <strong>Insert action (recovery)</strong> only for an existing signal-only draft.
            </p>
            {shortVoteWindow ? (
              <div className="gate-fail">
                <p>
                  <strong>Voting window is only {String(baseVotingTime)}s.</strong> That is shorter
                  than a typical wallet confirm. Do not Sign off alone. Use{" "}
                  <strong>Sign off + Vote Yes (one tx)</strong> so the Yes lands in the same
                  confirmation that opens voting. After this SetGovernanceConfig executes,
                  lengthen <code>baseVotingTime</code> for normal holder smoke.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Holder board: proposals for the issued Governance, sorted for
            handholding (voting first, then drafts, then executable). Paste-by
            address stays as a lifeboat only. */}
        {verifiedGovernance ? (
          <div className="proposal-board">
            <div className="panel-head">
              <div>
                <h3>Open proposals</h3>
                <p className="muted">
                  Tap a row to read it and act. Sorted so open votes come first.
                </p>
              </div>
              <button
                type="button"
                className="secondary"
                onClick={() => void refreshProposalList()}
                disabled={proposalListBusy}
              >
                {proposalListBusy ? "Reading…" : "Refresh list"}
              </button>
            </div>
            <div className="proposal-filters" role="group" aria-label="Filter proposals">
              {(
                [
                  ["all", "All"],
                  ["voting", "Open for voting"],
                  ["draft", "Needs sign-off"],
                  ["execute", "Ready to execute"],
                  ["done", "Finished"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={listFilter === value}
                  onClick={() => setListFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {proposalListError ? (
              <div className="gate-fail">
                <pre>{proposalListError}</pre>
              </div>
            ) : null}
            {proposalList.filter((row) => proposalMatchesFilter(row, listFilter)).length === 0 ? (
              <p className="muted">
                {proposalListBusy
                  ? "Reading proposals from the issued governance…"
                  : "No proposals in this filter yet. Write one above."}
              </p>
            ) : (
              <ul className="proposal-list">
                {proposalList
                  .filter((row) => proposalMatchesFilter(row, listFilter))
                  .map((row) => {
                    const selected = proposalAddress === row.proposal.toBase58();
                    const bars = voteBarWidths(row.yesVotesCount, row.noVotesCount);
                    const rowVotingOpen =
                      row.state === ProposalState.Voting &&
                      baseVotingTime !== null &&
                      proposalVotingAcceptsCast(
                        {
                          state: row.state,
                          votingAt: row.votingAt,
                          maxVotingTime: null,
                        },
                        baseVotingTime,
                        nowSecs,
                      );
                    const rowVotingEnded =
                      row.state === ProposalState.Voting &&
                      baseVotingTime !== null &&
                      proposalVoteEnded(
                        { votingAt: row.votingAt, maxVotingTime: null },
                        baseVotingTime,
                        nowSecs,
                      );
                    const succeeded =
                      row.state === ProposalState.Succeeded ||
                      row.state === ProposalState.Executing;
                    const closedNoAction =
                      row.state === ProposalState.Defeated ||
                      row.state === ProposalState.Cancelled ||
                      row.state === ProposalState.Vetoed ||
                      row.state === ProposalState.Completed ||
                      row.state === ProposalState.ExecutingWithErrors;
                    const summary =
                      row.approveInstructionsCount > 0
                        ? proposalKindLabel(row)
                        : "Signal only";
                    const rowStatus = rowVotingOpen
                      ? null
                      : succeeded
                        ? "Awaiting execution"
                        : rowVotingEnded
                          ? "Finalize to tally"
                          : closedNoAction
                            ? "Closed"
                            : row.state === ProposalState.Draft ||
                                row.state === ProposalState.SigningOff
                              ? "Needs sign-off"
                              : "Closed";
                    return (
                      <li
                        key={row.proposal.toBase58()}
                        data-selected={selected ? "true" : undefined}
                        aria-current={selected ? "true" : undefined}
                      >
                        <button
                          type="button"
                          onClick={() => openProposalFromList(row)}
                          aria-label={
                            selected
                              ? `Selected proposal: ${row.name || "untitled"}. Full proposal below.`
                              : `Open full proposal: ${row.name || "untitled"}`
                          }
                        >
                          <span>
                            <span className="proposal-row-line">
                              <span className={proposalTagClass(row.state)}>
                                {listRowStateLabel(row)}
                              </span>
                              <span className="proposal-row-title">
                                {row.name || "(untitled)"}
                              </span>
                            </span>
                            <span className="proposal-row-meta">
                              Yes {row.yesVotesCount.toString(10)} · No{" "}
                              {row.noVotesCount.toString(10)} · {summary}
                              {rowStatus ? ` · ${rowStatus}` : null}
                              {selected ? " · Open below" : null}
                            </span>
                          </span>
                          <span className="proposal-row-tally">
                            <span className="votebar" aria-hidden="true">
                              <span className="yes" style={{ width: `${String(bars.yesPct)}%` }} />
                              <span className="no" style={{ width: `${String(bars.noPct)}%` }} />
                            </span>
                          </span>
                        </button>
                        {rowVotingOpen ? (
                          <div className="vote-actions">
                            <button
                              type="button"
                              className="yes"
                              disabled={!voteReady || !selected || !instructionsReviewed}
                              onClick={() => void buildVoteFromCard(row, "yes")}
                              title={
                                selected && instructionsReviewed
                                  ? undefined
                                  : "Open this proposal and read the recovered instructions before voting"
                              }
                            >
                              Vote for
                            </button>
                            <button
                              type="button"
                              className="no"
                              disabled={!voteReady || !selected || !instructionsReviewed}
                              onClick={() => void buildVoteFromCard(row, "no")}
                              title={
                                selected && instructionsReviewed
                                  ? undefined
                                  : "Open this proposal and read the recovered instructions before voting"
                              }
                            >
                              Vote against
                            </button>
                          </div>
                        ) : succeeded &&
                          selected &&
                          actionSummary !== null &&
                          actionSummary.kind !== "unknown" &&
                          actionSummary.kind !== "none" &&
                          recoveredStaged !== null &&
                          reviewedProposalAddress === proposalAddress.trim() ? (
                          <div className="vote-actions">
                            <button
                              type="button"
                              className="primary"
                              onClick={() => void buildExecute()}
                              disabled={!identityReady}
                            >
                              Execute action
                            </button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
              </ul>
            )}
            <details className="raw">
              <summary>Advanced: open by address</summary>
              <div className="proposal-open">
                <label>
                  Proposal address
                  <input
                    value={proposalAddress}
                    onChange={(event) => setProposalAddress(event.target.value)}
                    placeholder="only if you already have the pubkey"
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void refreshProposal()}
                  disabled={!hasProposal || proposalBusy}
                >
                  {proposalBusy ? "Reading…" : "Refresh proposal"}
                </button>
              </div>
            </details>
          </div>
        ) : null}

        {hasProposal ? (
          <article className="proposal" id="proposal-detail">
            <div className="proposal-head">
              <span className="mono id">
                {proposalAddress.slice(0, 6)}…{proposalAddress.slice(-4)}
              </span>
              <span className="pill">{openProposalStateLabel()}</span>
            </div>
            {proposalBusy && !fetchedProposal ? (
              <p className="muted">Reading proposal from chain…</p>
            ) : null}
            {fetchedProposal ? (
              <>
                <h3>{fetchedProposal.name}</h3>
                <p className="muted">
                  Yes {fetchedProposal.yesVotesCount.toString(10)} · No{" "}
                  {fetchedProposal.noVotesCount.toString(10)}. Proposer deposit record{" "}
                  <span className="mono">{fetchedProposal.tokenOwnerRecord.toBase58()}</span>.
                </p>
                {fetchedProposal.descriptionLink ? (
                  <p className="field-note">
                    Description link:{" "}
                    <a
                      href={fetchedProposal.descriptionLink}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {fetchedProposal.descriptionLink}
                    </a>
                  </p>
                ) : null}
                {fetchedMarkdown ? (
                  <div className="proposal-body">{fetchedMarkdown}</div>
                ) : (
                  <p className="muted">
                    Body unread from Pinata (host not allowlisted, or fetch failed). The link
                    above is still the on-chain pointer.
                  </p>
                )}
                <p className="field-note">
                  Discussion is in{" "}
                  <a href="https://t.me/kekbull" target="_blank" rel="noreferrer noopener">
                    THE HERD on Telegram
                  </a>
                  . This page is the vote record. It does not host a comment thread.
                </p>
              </>
            ) : !proposalBusy ? (
              <p className="muted">
                Could not load this proposal yet. Check the error above, or use Advanced → open by
                address. Any wallet can read any proposal. This is not gated on being the writer.
              </p>
            ) : null}

            {actionSummary ? (
              <div
                className={
                  actionSummary.kind === "unknown" ? "action-summary gate-fail" : "action-summary"
                }
              >
                <div className="k">If this passes and is executed</div>
                <div className="v">{actionSummary.headline}</div>
                <ul>
                  {actionSummary.details.map((line, i) => (
                    <li key={`${String(i)}-${line}`}>{line}</li>
                  ))}
                </ul>
                {actionSummary.kind === "unknown" ? (
                  <p>
                    <strong>Execute stays closed.</strong> This page will not send an unclassified
                    payload. You can still vote No after recovery completes.
                  </p>
                ) : null}
                {!actionSummary.recoveryComplete ? (
                  <p>
                    <strong>Vote stays closed</strong> until every inserted instruction is
                    recovered. Do not vote from a partial view.
                  </p>
                ) : null}
              </div>
            ) : null}

            {fetchedProposal &&
            (fetchedProposal.state === ProposalState.Draft ||
              fetchedProposal.state === ProposalState.SigningOff) ? (
              <div className="gate-fail">
                <p>
                  <strong>Voting is not open yet.</strong> This proposal is still{" "}
                  {fetchedProposal.stateName}. Sign off first. That is what opens voting. Vote
                  buttons stay closed until the state is Voting.
                </p>
                {shortVoteWindow ? (
                  <p>
                    <strong>Clock starts at Sign off:</strong> live window is only{" "}
                    {String(baseVotingTime)}s. Use <strong>Sign off + Vote Yes (one tx)</strong>.
                    Separate Sign off then Vote loses to Phantom every time.
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={() => void buildSignOffAndVoteYes()}
                  disabled={!identityReady || !voteReady || !instructionsReviewed}
                >
                  Sign off + Vote Yes (one tx)
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void buildSignOff()}
                  disabled={!identityReady}
                >
                  Sign off only
                </button>
              </div>
            ) : null}

            {votingWindowEnded ? (
              <div className="gate-fail">
                <p>
                  <strong>Voting time has ended.</strong> Realms still reports this proposal as
                  Voting until someone finalizes the tally. That is not an invitation to vote.
                  CastVote is refused on-chain after the window (
                  {baseVotingTime !== null ? `${String(baseVotingTime)}s` : "governance base"} from
                  sign-off). Vote for / Vote against stay closed. Use Finalize vote.
                </p>
              </div>
            ) : null}

            {fetchedProposal?.state === ProposalState.Voting &&
            votingAcceptsCast &&
            votingSecondsLeft !== null ? (
              <p className="field-note" role="status">
                Voting is open for{" "}
                <strong>
                  {votingSecondsLeft < 60
                    ? `${String(votingSecondsLeft)}s`
                    : `${String(Math.floor(votingSecondsLeft / 60))}m ${String(votingSecondsLeft % 60)}s`}
                </strong>{" "}
                more. After that, votes are refused even while the pill still says Voting.
              </p>
            ) : null}

            <div className="vote-box">
              <div className="row">
                <label>
                  Proposer&apos;s deposit record
                  <input
                    value={proposalOwnerRecord}
                    onChange={(event) => setProposalOwnerRecord(event.target.value)}
                    placeholder="the writer's TokenOwnerRecord"
                    readOnly={Boolean(fetchedProposal)}
                  />
                </label>
                <label>
                  Your deposit record
                  <input
                    value={tokenOwnerRecord}
                    readOnly
                    aria-readonly="true"
                    title="Derived from the connected wallet. Not editable."
                  />
                </label>
              </div>
              <p className="field-note">
                Yours is derived from the connected wallet and cannot be edited. The
                proposer&apos;s is filled from the proposal account when it loads.
              </p>
              <div className="vote-actions">
                {votingAcceptsCast ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void buildVote("yes")}
                      disabled={!voteReady || !votingAcceptsCast || !instructionsReviewed}
                    >
                      Vote for
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void buildVote("no")}
                      disabled={!voteReady || !votingAcceptsCast || !instructionsReviewed}
                    >
                      Vote against
                    </button>
                  </>
                ) : fetchedProposal?.state === ProposalState.Succeeded ||
                  fetchedProposal?.state === ProposalState.Executing ? (
                  <p className="vote-closed" style={{ flex: 1 }}>
                    Voting closed · awaiting execution
                  </p>
                ) : fetchedProposal?.state === ProposalState.Defeated ||
                  fetchedProposal?.state === ProposalState.Cancelled ||
                  fetchedProposal?.state === ProposalState.Vetoed ||
                  fetchedProposal?.state === ProposalState.Completed ? (
                  <p className="vote-closed" style={{ flex: 1 }}>
                    Voting closed
                  </p>
                ) : votingWindowEnded ? (
                  <p className="vote-closed" style={{ flex: 1 }}>
                    Voting closed · finalize to tally
                  </p>
                ) : null}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void buildFinalize()}
                  disabled={
                    !identityReady ||
                    !fetchedProposal ||
                    fetchedProposal.state !== ProposalState.Voting ||
                    !votingWindowEnded
                  }
                >
                  Finalize vote
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void buildReleaseVoterDeposits()}
                  disabled={
                    !identityReady ||
                    !fetchedProposal ||
                    fetchedProposal.state === ProposalState.Voting ||
                    standingVotesOnOpenProposal === null ||
                    standingVotesOnOpenProposal === 0
                  }
                >
                  {standingVotesOnOpenProposal !== null && standingVotesOnOpenProposal > 0
                    ? `Release voter deposits (${String(standingVotesOnOpenProposal)})`
                    : "Release voter deposits"}
                </button>
                <button
                  type="button"
                  onClick={() => void buildExecute()}
                  disabled={
                    !identityReady ||
                    !fetchedProposal ||
                    (fetchedProposal.state !== ProposalState.Succeeded &&
                      fetchedProposal.state !== ProposalState.Executing) ||
                    actionSummary === null ||
                    actionSummary.kind === "unknown" ||
                    actionSummary.kind === "none" ||
                    recoveredStaged === null ||
                    reviewedProposalAddress !== proposalAddress.trim()
                  }
                >
                  Execute action
                </button>
              </div>
              <div className="row">
                <label>
                  Your vote record
                  <input value={voteRecord} onChange={(event) => setVoteRecord(event.target.value)} />
                </label>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void buildRelinquish()}
                  disabled={!identityReady || voteRecord.trim().length === 0}
                >
                  Relinquish my vote
                </button>
              </div>
              <p className="field-note">
                Finalize also releases standing votes on this proposal so deposits unlock. On
                already-closed proposals, use Release voter deposits (permissionless). Withdraw
                auto-releases your finished standing votes. Execute is permissionless after a yes
                result and the hold-up. That is what pays or upgrades.
              </p>
            </div>
          </article>
        ) : (
          <div className="empty">
            <p className="kicker">NOTHING OPEN</p>
            <h3>No proposal is open on this page</h3>
            <p className="muted">
              Pick a proposal from the list above, or write one yourself. Anyone holding enough
              deposited ICHOR can propose how the treasury is spent.
            </p>
            <div className="row centre">
              <button
                type="button"
                onClick={() => setCreating(true)}
                disabled={!voteReady}
              >
                {voteReady
                  ? "Write a proposal"
                  : connected
                    ? "Opens when the DAO is published"
                    : "Connect a wallet to propose"}
              </button>
              <a className="btn-link" href="#treasury">
                See what the treasury holds
              </a>
            </div>
          </div>
        )}

        <details className="raw">
          <summary>Addresses derived by the last action</summary>
          {derived ? <pre>{derived}</pre> : <p className="muted">No action built yet.</p>}
          {verifiedRealm ? (
            <dl className="dl">
              <dt>Proof realm</dt>
              <dd>{verifiedRealm.realm.toBase58()}</dd>
              <dt>Proof community mint</dt>
              <dd>{verifiedRealm.communityMint.toBase58()}</dd>
            </dl>
          ) : null}
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
          ) : null}
        </details>
      </section>
      </HolderSection>
    </>
  );
}
