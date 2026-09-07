import type { DeploymentConfig } from "../config.ts";
import type { PreflightState } from "./Preflight.tsx";

/**
 * Holder-facing succession copy. Official-devnet is rehearsal for the same
 * story mainnet must tell: voting and treasury must not depend on one person
 * being reachable. This panel states what already works without the token dev,
 * the published sunset (Governance PDA + brick risk), and what a third-party
 * UI needs.
 *
 * Does not claim realms.today is a lifeboat (PLAN §12.3).
 */
export function Succession(props: {
  config: DeploymentConfig;
  preflight: PreflightState;
}) {
  const passed = props.preflight.status === "passed" ? props.preflight : null;
  const clusterLabel = props.config.cluster === "mainnet-beta" ? "mainnet" : "official-devnet";
  const governanceProgram =
    passed?.verified.realms.programId.toBase58() ?? props.config.voteProgram;
  const ichorProgram =
    passed?.verifiedIchorProgram?.programId.toBase58() ?? props.config.ichorProgram;
  const ichorMint =
    passed?.verifiedIchorConfig?.config.ichorMint.toBase58() ?? props.config.ichorMint;
  const realm =
    passed?.verifiedGovernanceIdentity?.verifiedRealm?.realm.toBase58() ?? props.config.realm;
  const governance =
    passed?.verifiedGovernanceIdentity?.governance?.toBase58() ?? props.config.governance;
  // `VerifiedGovernanceIdentity` no longer carries the treasury; Preflight
  // derives it and exposes it directly. Was a compile error before this edit.
  const treasury = passed?.verifiedNativeTreasury?.toBase58() ?? props.config.nativeTreasury;
  const ichorUpgradeAuth =
    passed?.verifiedIchorProgram?.upgradeAuthority?.toBase58() ?? null;
  const governanceUpgradeAuth =
    // Official-devnet measured recovery for kekbull_governance ProgramData.
    // Public pubkey (not a secret). Mainnet must replace via published sunset docs -
    // do not ship this string as if it were mainnet authority.
    props.config.cluster === "devnet" && props.config.realmsInstance === "kekbull"
      ? "87iypjzaf4HiFKfqbpHRMqxA7hV2UZPiaFFxuPyUrVAA"
      : null;

  return (
    <section id="succession">
      <p>
        This page is on <strong>{clusterLabel}</strong>.
        {props.config.cluster === "devnet"
          ? " Nothing on this cluster is launch validation. It rehearses the design below."
          : ""}
      </p>

      <h3>The short version</h3>
      <p>
        <strong>
          The DAO is accounts on Solana. This website is one way to reach them. It is not
          the DAO.
        </strong>{" "}
        If this site goes offline tomorrow and never comes back, nothing on chain changes.
        Your ICHOR, your deposit, the treasury, the locked pool and every proposal are exactly
        where they were. Someone rebuilds a front end, points it at the addresses below, and
        the DAO carries on.
      </p>

      <h3>Two different things. Only one is the token dev&apos;s</h3>
      <div className="topic-grid topic-grid-two">
        <div className="topic">
          <p className="k">Authority over the DAO</p>
          <p>
            Transferred to the Governance PDA only after measured activation inputs have held,
            an official-devnet SetRealmConfig brake rehearsal, and an explicit operator
            decision. Day 90 is a checkpoint to stop and re-decide, not a deadline. After
            that no key the token dev holds can move the treasury, change the fee split, or
            alter the rules. Holders do that by proposal, or it does not happen. Vote-program
            upgrade authority is a later, separate review.
          </p>
        </div>
        <div className="topic">
          <p className="k">Running this website and its helpers</p>
          <p>
            A convenience, not an authority. It has never been able to move a token or change a
            vote. It runs on one server today because someone has to run it first. A planned
            exit hands the domain and the Telegram group to the community first. Those
            assets can then move without permission.
          </p>
        </div>
      </div>
      <p>
        The chain already answers a hostile token dev. This section is for the other case:
        they become unreachable in an unforeseen way (death, or illness that takes them out
        of contact) while they still hold the domain and the Telegram group. That is the
        only case this section is for. Walking away, or losing interest, is not one of them.
      </p>

      <h3>What keeps working with nobody at the wheel</h3>
      <ul>
        <li>
          Deposit ICHOR, open proposals, vote, finalize, and execute treasury actions on the
          committed Realm, through this UI or any other client that speaks the same program
          ids.
        </li>
        <li>The locked liquidity stays locked. No key unlocks it, including the token dev&apos;s.</li>
        <li>
          Burning KEKBULL for ICHOR keeps working. It is a program, not a service someone
          operates.
        </li>
        <li>Every address here is verifiable on any explorer, by anyone, forever.</li>
      </ul>

      <h3>What stops, and what to do about it</h3>
      <p>
        Only if the token dev is gone without warning, still holding the host assets.
      </p>
      <div className="topic-grid topic-grid-three">
        <div className="topic">
          <p className="k">This website stops being served</p>
          <p>
            Fixed by deploying the source below to any host. It is a static front end plus a
            small helper; it needs no special infrastructure.
          </p>
        </div>
        <div className="topic">
          <p className="k">The domain may lapse</p>
          <p>
            <span className="mono">kekbull.com</span> is registered by the token dev. If it
            expires, a replacement front end lives at a different address. Publish the
            new one through the DAO&apos;s own channels and verify it against the pubkeys below.
            Never trust a domain alone. A lapsed domain can be re-registered by anyone.
          </p>
        </div>
        <div className="topic">
          <p className="k">Discussion needs a new home</p>
          <p>
            Proposals are discussed in Telegram, one topic each. That group belongs to the
            token dev&apos;s account, so a successor may have to start a new one. The
            conversation is not part of the DAO and is not recoverable from the chain, and
            anyone can delete their own messages at any time — so do not treat chat as a
            record. Anything meant to last belongs in the proposal body, which is pinned to
            IPFS and cannot be edited. Proposals, votes and results are unaffected. Those are
            on chain.
          </p>
        </div>
      </div>

      <h3>How to bring it back up</h3>
      <ol>
        <li>
          Get the source:{" "}
          {props.config.sourceRepo ? (
            <a className="mono" href={props.config.sourceRepo} rel="noreferrer noopener">
              {props.config.sourceRepo}
            </a>
          ) : (
            <span className="muted">
              not published yet. This link appears once the public repository exists
            </span>
          )}
          . The UI and the on-chain programs are both there.
        </li>
        <li>
          Build the front end and host it anywhere static. A VPS, object storage, or a
          local machine. There is no server-side secret in it.
        </li>
        <li>
          Point its deployment config at the cluster, Realms instance and addresses in the
          next section. Those values are the DAO; the code is replaceable.
        </li>
        <li>
          Check it against an explorer before trusting it: Realm community mint must be
          ICHOR, and the governance program must be the one named below.
        </li>
      </ol>

      <h3>What is not a lifeboat</h3>
      <p>
        <span className="mono">app.realms.today</span> drives published GovER5. This DAO runs
        on <span className="mono">kekbull_governance</span> (
        <span className="mono">{governanceProgram ?? "not published"}</span>
        ). Stock Realms will not vote for you. A second independent UI is the real backup,
        not realms.today.
      </p>

      <h3>Two upgrade authorities (do not confuse them)</h3>
      <div className="topic-grid topic-grid-two">
        <div className="topic">
          <p className="k">ICHOR program</p>
          <p className="mono">{ichorProgram ?? "unset"}</p>
          <p>
            Product intent: hand upgrade authority to the Governance PDA so holders can pass an
            Upgrade proposal without a founder key. Live authority right now:{" "}
            {ichorUpgradeAuth ? (
              <span className="mono">{ichorUpgradeAuth}</span>
            ) : (
              "read after preflight"
            )}
            .
          </p>
        </div>
        <div className="topic">
          <p className="k">Voting program / kekbull_governance</p>
          <p className="mono">{governanceProgram ?? "not published"}</p>
          <p>
            Recovery holds upgrade authority until a later, separate review. Realm-authority
            handoff does not move vote-program upgrade authority at the same time. Day 90 is a
            checkpoint to stop and re-decide, not a deadline for either move. After a later
            vote-program handoff to the <strong>Governance PDA</strong>, holders upgrade via
            proposal. A bad self-upgrade can brick CastVote / FinalizeVote / Execute with{" "}
            <strong>no treasury recovery path</strong>. That brick risk is accepted so the DAO
            does not depend on one person forever. Live recovery pubkey before handoff
            (official-devnet measured):{" "}
            {governanceUpgradeAuth ? (
              <span className="mono">{governanceUpgradeAuth}</span>
            ) : (
              "n/a for this Realms instance"
            )}
            .
          </p>
        </div>
      </div>

      <h3>Addresses a replacement UI needs</h3>
      <dl className="dl">
        <dt>Cluster</dt>
        <dd className="mono">{props.config.cluster}</dd>
        <dt>Realms instance</dt>
        <dd className="mono">{props.config.realmsInstance}</dd>
        <dt>Governance program</dt>
        <dd className="mono">{governanceProgram ?? "not published"}</dd>
        <dt>ICHOR program</dt>
        <dd className="mono">{ichorProgram ?? "unset"}</dd>
        <dt>ICHOR mint</dt>
        <dd className="mono">{ichorMint ?? "unset"}</dd>
        <dt>Realm</dt>
        <dd className="mono">{realm ?? "unset"}</dd>
        <dt>Governance</dt>
        <dd className="mono">{governance ?? "unset"}</dd>
        <dt>Native treasury</dt>
        <dd className="mono">{treasury ?? "unset"}</dd>
      </dl>
      <p className="field-note">
        Prefer values after a passed preflight. Fixture JSON under{" "}
        <span className="mono">ichor/governance-ui/fixtures/</span> is the offline copy for
        this cluster.
      </p>

      <h3>Checklist, if it comes to that</h3>
      <ol>
        <li>Confirm this panel's addresses on an explorer (Realm community mint = ICHOR).</li>
        <li>
          Run or host any UI that uses Realms instance{" "}
          <span className="mono">kekbull</span> and those pubkeys, not GovER5.
        </li>
        <li>Deposit ICHOR; propose; vote; execute. Treasury moves do not need the token dev.</li>
        <li>
          ICHOR upgrades: only after upgrade authority is the Governance PDA (or a published
          recovery process still holds it).
        </li>
        <li>
          Voting-program upgrades: before handoff, recovery may still patch. After handoff,
          only via Governance PDA proposal. Accept that a bad upgrade can freeze the treasury.
        </li>
      </ol>
      <p className="muted">
        Policy source: <span className="mono">ichor/kekbull_governance/docs/UPGRADE_AUTH.md</span>{" "}
        and PLAN §12.3. Official-devnet rehearses this; mainnet must ship the same honesty.
      </p>
    </section>
  );
}
