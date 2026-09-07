/**
 * Where the project is, as one value.
 *
 * The holder page used to branch on a single `published` boolean, so it could
 * not tell "KEKBULL has not graduated" apart from "graduated, pool being built".
 * With nothing to say about the project, the copy fell back to the only variable
 * it could see - whether an individual field had been read - and the page opened
 * by talking about RPC reads instead of about KEKBULL.
 *
 * A state is not an error. Everything here describes a real, expected condition
 * of the timeline. Read failures are separate and stay local to the value that
 * failed.
 *
 * Timeline source: docs/PLAN_KEKBULL_DAO_TREASURY.md sections 9, 13.4, 15.2-15.3, 16.
 */

export type DaoStateId =
  | "prelaunch"
  | "open-for-scrutiny"
  | "sealed-awaiting-graduation"
  | "graduated-market-building"
  | "burn-open-no-pool"
  | "market-live";

export interface DaoState {
  readonly id: DaoStateId;
  /** Third cell of the SOLANA / CLUSTER / ___ status strip. */
  readonly status: string;
  readonly heading: string;
  readonly body: string;
  /** What a holder can actually do today. Always answered, including "nothing yet". */
  readonly youCan: string;
  /** Rendered prominently. Present only where acting today can cost the reader. */
  readonly caution?: string;
}

export interface DaoStateInput {
  /** deployment.json carries an ICHOR program address. */
  readonly ichorProgramPublished: boolean;
  /** Preflight issued a VerifiedIchorConfig. */
  readonly configVerified: boolean;
  /** Config.paused, or null when Config was not read. */
  readonly paused: boolean | null;
  /** commit_dao_destination has been written. Write-once; sections 15.2/15.3. */
  readonly daoDestinationCommitted: boolean;
  /** Bonding curve `complete`, or null when the curve was not read. */
  readonly curveComplete: boolean | null;
  /** deployment.json carries a Meteora pool address. */
  readonly poolPublished: boolean;
  /**
   * Permanent-lock proof from chain (`isFullyPermanentlyLocked === true`).
   * Null when the lock has not been read. Unknown fails backwards: do not
   * claim a lock that this page has not verified.
   */
  readonly lockVerified: boolean | null;
}

/**
 * First match wins. Order is the timeline order, so a later state can assume
 * every earlier condition already held.
 *
 * Unknown inputs (`null`) resolve backwards, to the earlier state. A page that
 * has not read the curve must not claim the coin graduated.
 */
export function resolveDaoState(input: DaoStateInput): DaoState {
  if (!input.ichorProgramPublished || !input.configVerified) {
    return {
      id: "prelaunch",
      status: "DAO NOT PUBLISHED",
      heading: "KEKBULL is live. The DAO is not published here yet.",
      body:
        "The programs that create ICHOR and run the voting are not published on this page's addresses yet, so there is nothing here that can hold your money and nothing to sign. Everything below is the real interface, waiting.",
      youCan: "Buy and hold KEKBULL. That is all there is to do today.",
    };
  }

  if (!input.daoDestinationCommitted) {
    return {
      id: "open-for-scrutiny",
      status: "OPEN FOR SCRUTINY",
      heading: "Nothing is locked yet. Tell us if it is wrong.",
      body:
        "The program, the mint and the source are public, and none of the permanent decisions have been made. Once the treasury address is committed and the fee split is bound, neither can ever be changed. That has not happened yet, which means a problem found today can still be fixed.",
      youCan:
        "Read the program and the findings, and say something. This is the only window where saying something can change anything.",
    };
  }

  if (input.curveComplete !== true) {
    return {
      id: "sealed-awaiting-graduation",
      status: "AWAITING GRADUATION",
      heading: "The DAO is built and waiting on graduation.",
      body:
        "The treasury, the governance accounts and the fee split are set and can no longer be changed. The treasury is empty and ICHOR does not exist, because both depend on KEKBULL graduating first. Whether that happens is up to buyers, not to us.",
      youCan: "Buy and hold KEKBULL. Burning opens after graduation.",
    };
  }

  if (input.paused !== false) {
    return {
      id: "graduated-market-building",
      status: "MARKET BEING BUILT",
      heading: "KEKBULL graduated. The ICHOR market is being built now.",
      body:
        "Burning is still switched off. The first conversion is an atomic defensive stake from the creator wallet. Holder convert opens later. The ICHOR/SOL pool and its lock come after that first stake, not before.",
      youCan: "Hold. This step is minutes of work, not days.",
    };
  }

  if (!input.poolPublished) {
    return {
      id: "burn-open-no-pool",
      status: "POOL NOT LIVE",
      heading: "Burning is open. The pool is not live yet.",
      body:
        "You can burn KEKBULL for ICHOR right now, but the ICHOR/SOL pool is still being created, so there is nowhere to sell ICHOR yet.",
      caution:
        "Burning is permanent. If you burn before the pool is live you will hold ICHOR you cannot trade until it is.",
      youCan: "Burn, or wait. Waiting costs you nothing.",
    };
  }

  if (input.lockVerified !== true) {
    return {
      id: "market-live",
      status: "LIVE",
      heading: "ICHOR trades.",
      body:
        "The ICHOR/SOL pool is published. The permanent lock has not been verified from chain yet.",
      youCan: "Burn KEKBULL for ICHOR, trade ICHOR, and deposit ICHOR to vote.",
    };
  }

  return {
    id: "market-live",
    status: "LIVE",
    heading: "ICHOR trades, and the starting liquidity is sealed.",
    body:
      "The ICHOR/SOL pool is live and 100% of the liquidity that started it is under a permanent lock. Nobody can withdraw it, not us and not a passed vote. Your own ICHOR is yours and you can sell it whenever you like.",
    caution:
      "While voting is being handed over, the wallet that set this up can still change the voting rules without a vote. It cannot move funds. Day 90 is a checkpoint to stop and re-decide, not a deadline. Realm-authority handoff happens only after measured activation inputs have held, a SetRealmConfig brake rehearsal, and an explicit operator decision. Every change it makes is a public transaction.",
    youCan: "Burn KEKBULL for ICHOR, trade ICHOR, and deposit ICHOR to vote.",
  };
}

/**
 * States this cannot yet tell apart, and why. Each needs a read the UI does not
 * currently make; none is a copy problem.
 *
 * - Plan states 2 and 3 are merged into `open-for-scrutiny`. Publishing for
 *   scrutiny is an editorial act, not an on-chain fact, so there is nothing to
 *   detect. `commit_dao_destination` is the real boundary and it is detected.
 *
 * - Plan states 6 and 7 are merged into `market-live`. SharingConfig is
 *   read on the Collect sibling (`PumpCreatorFees`): missing = none, not
 *   unread. That read is not a `DaoStateId` flip yet.
 *
 * - Plan states 8 and 9 are merged into `market-live`, and its `caution`
 *   discloses the recovery window unconditionally. Splitting them needs
 *   `realm.authority` compared against the Governance PDA, which no current type
 *   exposes. Over-disclosing is the safe direction: a reader told the window may
 *   be open when it has closed loses nothing, while the reverse hides a live
 *   power. Remove the caution only once the authority read exists.
 */
export const UNRESOLVED_STATES = [
  "published-for-scrutiny (editorial, not on-chain)",
  "fees-finalized (SharingConfig is read on Collect sibling; not a timeline state)",
  "self-governing (needs realm.authority vs Governance PDA)",
] as const;
