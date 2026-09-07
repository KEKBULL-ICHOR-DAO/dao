import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ObservedGovernanceConfig } from "@kekbull/ichor-client";
import { readCurveComplete } from "../chain.ts";
import type { DeploymentConfig } from "../config.ts";
import { resolveDaoState, UNRESOLVED_STATES, type DaoState } from "../dao-state.ts";
import { formatGovernanceSeconds } from "../format.ts";
import type { PreflightState } from "./Preflight.tsx";

/**
 * Holder handbook. Copy source: docs/DAO_HANDBOOK.md. Governance times,
 * thresholds, and proposal deposits are read from the live account - never
 * typed into this file.
 *
 * VoteThresholdType / VoteTipping numbers are the SPL Governance enums
 * (`YesVotePercentage = 0`, `Disabled = 2` / `Strict = 0`, `Disabled = 2`).
 */

function unread(what: string): string {
  return `Unread. ${what}.`;
}

function yesThresholdLabel(config: ObservedGovernanceConfig): string {
  const type = config.communityVoteThresholdType;
  const value = config.communityVoteThresholdValue;
  if (type === 2) {
    return "Disabled. Community proposals cannot pass on this Governance account.";
  }
  if (value === undefined) {
    return unread("threshold value is missing on this Governance account");
  }
  if (type === 0) {
    return `${String(value)}% of max voter weight must vote Yes, and Yes must beat No. Max voter weight is a fraction of ICHOR supply set on the Realm, not 100% of supply. This page does not yet print that live fraction, so the effective Yes floor as a percent of ICHOR supply is unread.`;
  }
  if (type === 1) {
    return `${String(value)}% attendance quorum.`;
  }
  return unread(`threshold type ${String(type)} is not a known VoteThresholdType`);
}

function tippingLabel(value: number): string {
  if (value === 0) {
    return "Strict. Can end early once Yes cannot be caught.";
  }
  if (value === 1) {
    return "Early. Can end early once the result cannot change.";
  }
  if (value === 2) {
    return "Disabled. The vote runs the full window.";
  }
  return unread(`tipping ${String(value)} is not a known VoteTipping`);
}

function Fold(props: {
  question: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <details className="panel fold">
      <summary>
        <h2>{props.question}</h2>
        <span className="fold-hint">{props.hint}</span>
      </summary>
      {props.children}
    </details>
  );
}

export function Handbook(props: {
  config: DeploymentConfig;
  preflight: PreflightState;
  lockVerified: boolean | null;
}) {
  const { connection } = useConnection();
  const [curveComplete, setCurveComplete] = useState<boolean | null>(null);
  const passed = props.preflight.status === "passed" ? props.preflight : null;
  const verifiedConfig = passed?.verifiedIchorConfig ?? null;
  const gov =
    passed?.verifiedGovernance?.config ?? passed?.verifiedGovernanceIdentity?.config ?? null;
  const govProof = passed?.verifiedGovernance
    ? "VerifiedGovernance"
    : passed?.verifiedGovernanceIdentity
      ? "VerifiedGovernanceIdentity"
      : null;

  useEffect(() => {
    let cancelled = false;
    if (!passed || !verifiedConfig) {
      setCurveComplete(null);
      return;
    }
    void (async () => {
      try {
        const complete = await readCurveComplete({
          connection,
          verified: passed.verified,
          kekbullMint: verifiedConfig.config.kekbullMint,
          bondingCurve: verifiedConfig.config.bondingCurve,
        });
        if (!cancelled) {
          setCurveComplete(complete);
        }
      } catch {
        if (!cancelled) {
          setCurveComplete(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, passed, verifiedConfig]);

  const state: DaoState = resolveDaoState({
    ichorProgramPublished: props.config.ichorProgram !== null,
    configVerified: verifiedConfig !== null,
    paused: verifiedConfig?.config.paused ?? null,
    daoDestinationCommitted: passed?.committedDaoDestination != null,
    curveComplete,
    poolPublished: props.config.meteoraPool !== null,
    lockVerified: props.lockVerified,
  });

  const ratio = verifiedConfig
    ? `${verifiedConfig.config.emissionNumerator.toString(10)} ICHOR per ${verifiedConfig.config.emissionDenominator.toString(10)} KEKBULL`
    : unread("Config emission ratio has not been verified");
  const paused =
    verifiedConfig == null
      ? unread("Config.paused has not been verified")
      : verifiedConfig.config.paused
        ? "Burning is paused on this Config."
        : "Burning is open on this Config.";
  const voteWindow = gov
    ? formatGovernanceSeconds(gov.baseVotingTime)
    : unread("Governance voting window has not been verified");
  const coolOff = gov
    ? formatGovernanceSeconds(gov.votingCoolOffTime)
    : unread("Governance cool-off has not been verified");
  const holdUp = gov
    ? formatGovernanceSeconds(gov.minInstructionHoldUpTime)
    : unread("Governance hold-up has not been verified");
  const toPropose = gov
    ? `${gov.minCommunityTokensToCreateProposal.toString(10)} base units (mint decimals unread on this panel)`
    : unread("minCommunityTokensToCreateProposal has not been verified");
  const depositExempt = gov
    ? String(gov.depositExemptProposalCount)
    : unread("depositExemptProposalCount has not been verified");
  const threshold = gov ? yesThresholdLabel(gov) : unread("community vote threshold has not been verified");
  const tipping = gov
    ? tippingLabel(gov.communityVoteTipping)
    : unread("communityVoteTipping has not been verified");

  return (
    <div>
      <p className="muted">
        How this DAO works, for someone about to act. Tokenomics and why KEKBULL
        exists live on{" "}
        <a href="https://kekbull.com" target="_blank" rel="noreferrer noopener">
          kekbull.com
        </a>
        .
      </p>

      <Fold question="What does the DAO control?" hint="And what it does not">
        <p>
          The DAO is the community treasury plus the vote that spends it. Once
          voting is on, deposited ICHOR decides what leaves that treasury: SOL,
          KEKBULL, ICHOR, and the fees earned by the locked ICHOR/SOL pool. The
          token dev does not sign those transfers.
        </p>
        <p>
          The DAO does not create KEKBULL. Mint authority is gone. It does not
          create ICHOR except by the same public burn anyone uses. It cannot
          pull the starting ICHOR/SOL liquidity. It cannot take or raise the
          token dev&apos;s 25% of harvested ICHOR fees, or of the pump.fun and
          PumpSwap creator cuts.
        </p>
        <p>
          Until handover, one wallet can still change the voting rules. It
          cannot move treasury funds. Day 90 is a checkpoint to stop and
          re-decide, not a deadline. Realm authority handoff happens only after
          measured activation inputs have held, an official-devnet
          SetRealmConfig brake rehearsal, and an explicit operator decision.
          Vote-program upgrade authority is a later, separate review. After
          handover, a realm-authority fix needs a passed proposal.
        </p>
        <p>
          <code>app.realms.today</code> is not this DAO. Voting runs on
          KEKBULL&apos;s own program so ICHOR&apos;s 0.25% transfer fee works.
        </p>
      </Fold>

      <Fold question="Why are there two tokens?" hint="KEKBULL and ICHOR">
        <p>
          KEKBULL is the coin you buy. ICHOR is the vote. ICHOR exists only by
          burning KEKBULL. There is no free mint and no path back.
        </p>
        <p>
          The starting rate is 1 ICHOR per 1 KEKBULL burned. Governance can
          lower that rate. Nobody can raise it. Live Config on this page:{" "}
          <strong>{ratio}</strong>.
        </p>
        <p>
          ICHOR charges <strong>0.25%</strong> on every transfer, including a
          send to your own second wallet. Depositing to vote and withdrawing
          are transfers. Minting is not a transfer. The burn itself does not
          take 0.25%. The Vote panel reads the live mint rate before you sign.
        </p>
        <a className="btn-link" href="https://kekbull.com#tokenomics" target="_blank" rel="noreferrer noopener">
          Fees and supply on kekbull.com
        </a>
      </Fold>

      <Fold question="What happens when I burn KEKBULL?" hint="Irreversible">
        <p>
          Your KEKBULL is destroyed. You receive ICHOR in the same transaction.
          Nobody can reverse it. No 0.25% is taken on the mint.
        </p>
        <p>
          {paused} If the pool is not live yet, you can still burn, and you
          will hold ICHOR you cannot sell until it is. Waiting costs you
          nothing.
        </p>
        <p>
          Burning ships switched off. The first conversion after graduation is
          an atomic defensive stake. Holder convert opens later. The ICHOR/SOL
          pool and its permanent lock come after that first stake, not before.
        </p>
        <a className="btn-link" href="#burn">
          Go to Burn
        </a>
      </Fold>

      <Fold question="What happens to my ICHOR if I vote?" hint="0.25% in and out">
        <p>
          Tokens in your wallet do not vote. You deposit ICHOR. Weight is
          linear: one deposited ICHOR, one vote. A large holder outweighs a
          small one.
        </p>
        <p>
          Depositing is a transfer. <strong>0.25% is withheld on the way
          in.</strong> Vote weight is what arrives. Withdrawing is a transfer.{" "}
          <strong>The same 0.25% is withheld on the way out.</strong>
        </p>
        <p>
          Depositing is not a lock-up. Withdraw once every vote you cast on
          that deposit has finished. An open vote needs Relinquish, or you
          wait. Nothing else reaches your deposit.
        </p>
        <a className="btn-link" href="#vote">
          Go to Vote
        </a>
      </Fold>

      <Fold question="What does it take to pass a proposal?" hint="Read live">
        <p>
          These numbers are on the Governance account
          {govProof ? ` (${govProof})` : ""}. If the recovery window changes a
          value, the account is what matters.
        </p>
        <p>
          <strong>To open one.</strong> {toPropose}
        </p>
        <p>
          <strong>To pass.</strong> {threshold}
        </p>
        <p>
          <strong>Voting window.</strong> {voteWindow}
        </p>
        <p>
          <strong>Cool-off.</strong> {coolOff} After the window, deny and veto
          only.
        </p>
        <p>
          <strong>Then wait.</strong> A passed proposal waits {holdUp} before
          it can execute.
        </p>
        <p>
          <strong>Deposit-exempt proposals.</strong> {depositExempt}
        </p>
        <p>
          <strong>Vote tipping.</strong> {tipping}
        </p>
        <details className="raw">
          <summary>Exact values read from the Governance account</summary>
          {gov ? (
            <dl className="dl">
              <dt>baseVotingTime</dt>
              <dd>{String(gov.baseVotingTime)} seconds</dd>
              <dt>votingCoolOffTime</dt>
              <dd>{String(gov.votingCoolOffTime)} seconds</dd>
              <dt>minInstructionHoldUpTime</dt>
              <dd>{String(gov.minInstructionHoldUpTime)} seconds</dd>
              <dt>communityVoteThresholdType</dt>
              <dd>{String(gov.communityVoteThresholdType)}</dd>
              <dt>communityVoteThresholdValue</dt>
              <dd>{String(gov.communityVoteThresholdValue)}</dd>
              <dt>minCommunityTokensToCreateProposal</dt>
              <dd>{gov.minCommunityTokensToCreateProposal.toString(10)}</dd>
              <dt>depositExemptProposalCount</dt>
              <dd>{String(gov.depositExemptProposalCount)}</dd>
              <dt>communityVoteTipping</dt>
              <dd>{String(gov.communityVoteTipping)}</dd>
            </dl>
          ) : (
            <p className="muted">Governance config unread until preflight verifies the account.</p>
          )}
        </details>
      </Fold>

      <Fold question="Where does the money go?" hint="25 / 75">
        <p>
          ICHOR movement: <strong>0.25%</strong> every transfer. Anyone can
          trigger the harvest. Split: 75% community treasury, 25% token dev.
        </p>
        <p>
          pump.fun and PumpSwap creator fees use a per-mint share list. Future
          KEKBULL fees are set at 25% token dev / 75% DAO treasury PDA
          immediately after the DAO exists, while the curve is still open.
          Anyone can trigger the payout. The pre-split collect_creator_fee vault
          is creator-global; that old receipt stays with the token dev. There is
          no retroactive 75% transfer.
        </p>
        <p>
          Locked ICHOR/SOL pool fees: 100% to the treasury, by a vote. The
          starting liquidity cannot be withdrawn.
        </p>
        <a className="btn-link" href="https://kekbull.com#where-money-goes" target="_blank" rel="noreferrer noopener">
          The three streams on kekbull.com
        </a>
      </Fold>

      <Fold question="What can the token dev still do?" hint="These powers end">
        <p>
          <strong>Cannot, at any time.</strong> Create more KEKBULL. Create
          ICHOR except by burning KEKBULL. Pull starting liquidity. Redirect
          the bound 75/25 splits. Spend the treasury once voting is on, except
          by the same proposal path as anyone else.
        </p>
        <p>
          <strong>Can, and both end.</strong> Pause and unpause burning,
          without a vote. Convert ships paused. Upgrade the ICHOR program. That
          is how a bug is fixed instead of becoming permanent.
        </p>
        <p>
          <strong>Can, during the recovery window only.</strong> Change quorum,
          threshold, voting window, and hold-up without a vote. Cannot move
          funds.
        </p>
        <p>
          Realm authority moves to the Governance PDA only after measured
          activation inputs have held, an official-devnet SetRealmConfig brake
          rehearsal, and an explicit operator decision. Day 90 is a checkpoint
          to stop and re-decide, not a deadline. Vote-program upgrade authority
          has its own later review. The burn-pause key is{" "}
          <code>config.authority</code> and can pause or unpause without a vote
          until that handoff. After realm-authority handoff a fix needs a passed
          proposal. A bad self-upgrade of the voting program can freeze
          CastVote / FinalizeVote / Execute. That brick risk is accepted.
        </p>
        <p>There is no council at launch. Nobody holds council power.</p>
      </Fold>

      <Fold question="Where is the project right now?" hint={state.status}>
        <p>
          A state is not an error. This page currently reads:{" "}
          <strong>{state.heading}</strong>
        </p>
        <p>{state.body}</p>
        {state.caution ? <p>{state.caution}</p> : null}
        <p>
          <strong>You can:</strong> {state.youCan}
        </p>
        <p className="muted">
          Six states this timeline can tell apart. Three plan states are not
          timeline flips yet: {UNRESOLVED_STATES.join("; ")}.
        </p>
      </Fold>

      <Fold question="How do I check the addresses myself?" hint="Explorer, not this page">
        <p>
          The only official addresses are the ones published on kekbull.com and
          on this page after a passed preflight. Character for character. Anyone
          messaging a different mint is trying to take your money.
        </p>
        <p>
          Check the mint, the programs, the Realm, and the treasury on an
          explorer. Do not take this page&apos;s word for a pubkey.
        </p>
        <a className="btn-link" href="#addresses">
          Published addresses
        </a>
      </Fold>

      <Fold question="What if the token dev is gone without warning?" hint="Unforeseen">
        <p>
          This is for death, or illness that takes them out of contact, while they
          still hold the domain and the Telegram group. Not for walking away.
          A planned exit would hand those over first. The DAO is accounts on
          Solana, not a website. Deposit, propose, vote, and execute do not need
          the token dev. <code>app.realms.today</code> will not do this.
        </p>
        <a className="btn-link" href="#continuity">
          If the community needs to take over
        </a>
      </Fold>

      <Fold question="What do these words mean?" hint="Glossary">
        <dl className="dl prose">
          <dt>Burn</dt>
          <dd>Destroying tokens for good. Supply drops. They do not go to a project wallet.</dd>
          <dt>Mint authority</dt>
          <dd>Permission to create new tokens. KEKBULL: none. ICHOR: the burn program, only by destroying KEKBULL.</dd>
          <dt>LP token</dt>
          <dd>A receipt for a share of a trading pool. Burn or lock it and nobody can pull that share out.</dd>
          <dt>Liquidity</dt>
          <dd>The pot of two tokens that lets people trade. Put one in, take the other out.</dd>
          <dt>Quorum</dt>
          <dd>How much voting weight must show up before a proposal can pass.</dd>
          <dt>Treasury</dt>
          <dd>The project&apos;s shared wallet. Once voting is on, ICHOR holders decide what leaves it.</dd>
          <dt>PDA</dt>
          <dd>A program-derived account. No person holds its private key.</dd>
          <dt>Token-2022</dt>
          <dd>Solana&apos;s newer token program. ICHOR uses it for the 0.25% transfer fee.</dd>
          <dt>Transfer fee</dt>
          <dd>A cut withheld when a token moves. ICHOR: 0.25%. KEKBULL: none. Minting is not a transfer.</dd>
          <dt>Bonding curve</dt>
          <dd>pump.fun&apos;s automatic price ladder. Each buy pushes the price up.</dd>
          <dt>Graduation</dt>
          <dd>Enough of the coin is bought that it moves off the curve onto PumpSwap. It may not happen.</dd>
        </dl>
      </Fold>
    </div>
  );
}
