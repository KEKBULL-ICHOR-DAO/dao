import { type MintSnapshot } from "@kekbull/ichor-client";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useState, type ReactNode } from "react";
import {
  ProposalState,
  listCommunityProposals,
} from "@kekbull/ichor-client";
import {
  readBurnLiveState,
  readHolderVoteBalances,
  readIchorMint,
  readTreasuryLiveState,
  readWalletLiveState,
  type HolderVoteBalances,
  type TokenAccountRead,
  type TreasuryLiveState,
  type WalletLiveState,
} from "../chain.ts";
import { formatBaseUnits, formatError } from "../format.ts";
import { useThrottledLiveRefresh } from "../live-refresh.ts";
import type { PreflightState } from "./Preflight.tsx";

/*
 * Redesign 2026-08-25. Reads are measured; presentation matches the Design
 * hero + statgrid composition.
 *
 *  - `.hero`: DaoStateBanner (left) + `.your-position` (right), including this
 *    wallet's deposited voting weight from `readHolderVoteBalances`.
 *  - `.statgrid`: on-chain totals only - ICHOR supply, KEKBULL burned,
 *    burn ratio, open proposals. Spendable treasury lives in TreasuryAssets.
 *  - Secondary protocol figures stay below in the existing Stat grid.
 */

function tokenLines(label: string, read: WalletLiveState["ichor"]): string {
  if (!read) {
    return `${label}: ICHOR mint not configured, no token read attempted`;
  }
  if (!read.present || !read.amount || read.decimals === null) {
    return `${label}: no ATA at ${read.ata.toBase58()} (mint decimals ${String(read.mintDecimals)} from mint account)`;
  }
  const withheld =
    read.withheldAmount === null
      ? ""
      : `; withheld ${read.withheldAmount.toString(10)} base units`;
  const ui = formatBaseUnits(read.amount, read.decimals);
  const mintUi = formatBaseUnits(read.amount, read.mintDecimals);
  const decimalNote =
    read.decimals === read.mintDecimals
      ? `decimals ${String(read.decimals)} (token account matches mint)`
      : `token-account decimals ${String(read.decimals)} vs mint decimals ${String(read.mintDecimals)}`;
  const authority = read.authority ? `; authority ${read.authority.toBase58()}` : "";
  return `${label}: ${read.amount.toString(10)} base units (${ui} @ token-account decimals; ${mintUi} @ mint decimals); ${decimalNote}; ATA ${read.ata.toBase58()}${authority}${withheld}`;
}

/* Group a UI amount for reading: "4182400.25" -> "4,182,400.25". The exact
   base-unit figure stays available in the raw block below, so nothing is lost
   by making the headline number legible. */
function grouped(ui: string): string {
  const [whole, fraction] = ui.split(".");
  const withCommas = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (!fraction) {
    return withCommas;
  }
  const trimmed = fraction.replace(/0+$/, "").slice(0, 2);
  return trimmed.length > 0 ? `${withCommas}.${trimmed}` : withCommas;
}

function uiAmount(read: WalletLiveState["ichor"]): string | null {
  if (!read || !read.present || !read.amount || read.decimals === null) {
    return null;
  }
  return grouped(formatBaseUnits(read.amount, read.decimals));
}

/* A headline figure. Same unread rule as Stat: never a zero it did not read. */
function Headline(props: {
  label: string;
  value: string | null;
  unit?: string;
  note: string;
  token?: "kek" | "ichor";
}) {
  const unread = props.value === null;
  const figClass = props.token === "kek" ? "kek-fig" : props.token === "ichor" ? "ichor-fig" : "";
  return (
    <div>
      <p className="lbl">{props.label}</p>
      <p className={unread ? "val unread" : `val ${figClass}`}>
        {unread ? "unread" : props.value}
        {!unread && props.unit ? <span className="u"> {props.unit}</span> : null}
      </p>
      <p className="note">{props.note}</p>
    </div>
  );
}

/* A stat reads as a real figure or says why it is unavailable. It never shows
   a zero it did not read: an empty config field is unknown, not none. */
function Stat(props: {
  token?: "kek" | "ichor";
  label: string;
  value: string | null;
  unit?: string;
  note: string;
}) {
  const mark =
    props.token === "kek"
      ? { src: "/logo.png", className: "kek" }
      : props.token === "ichor"
        ? { src: "/ichor-mark.png", className: "" }
        : null;
  const unread = props.value === null;
  return (
    <div className={`stat${props.token ? ` ${props.token}` : ""}`}>
      <div className="k">
        {mark ? <img src={mark.src} className={mark.className} alt="" width={18} height={18} /> : null}
        <span>{props.label}</span>
      </div>
      <div className="v" style={unread ? { color: "rgba(200,196,180,.5)", fontSize: "15px" } : undefined}>
        {unread ? "unread" : props.value}
        {!unread && props.unit ? <span className="u"> {props.unit}</span> : null}
      </div>
      <div className="n">{props.note}</div>
    </div>
  );
}

export function LiveState(props: {
  preflight: PreflightState;
  lastConfirmedSignature?: string | null;
  /** DaoStateBanner - rendered once as the left column of `.hero`. */
  /* Holder view only. The operator console mounts this panel under its
     own "state" tab, where the hero banner is not wanted. */
  stateBanner?: ReactNode;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [walletState, setWalletState] = useState<WalletLiveState | null>(null);
  const [walletKekbull, setWalletKekbull] = useState<TokenAccountRead | null>(null);
  const [treasury, setTreasury] = useState<TreasuryLiveState | null>(null);
  const [mint, setMint] = useState<MintSnapshot | null>(null);
  const [holderVotes, setHolderVotes] = useState<HolderVoteBalances | null>(null);
  const [openProposals, setOpenProposals] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [readAt, setReadAt] = useState<Date | null>(null);
  const passed = props.preflight.status === "passed" ? props.preflight : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (!passed) {
      setError("The checks this page runs on arrival have not passed, so nothing was read from the chain.");
      return;
    }
    setBusy(true);
    setError(null);
    setWalletState(null);
    setWalletKekbull(null);
    setTreasury(null);
    setMint(null);
    setHolderVotes(null);
    setOpenProposals(null);
    try {
      const ichorMint = passed.verifiedIchorConfig?.config.ichorMint.toBase58() ?? null;
      const kekbullMint = passed.verifiedIchorConfig?.config.kekbullMint.toBase58() ?? null;
      const nativeTreasury = passed.verifiedNativeTreasury?.toBase58() ?? null;
      if (ichorMint) {
        setMint(
          await readIchorMint({
            connection,
            verified: passed.verified,
            ichorMint,
          }),
        );
      }
      if (wallet.publicKey) {
        setWalletState(
          await readWalletLiveState({
            connection,
            verified: passed.verified,
            owner: wallet.publicKey,
            ichorMint,
          }),
        );
        if (ichorMint && kekbullMint) {
          const burn = await readBurnLiveState({
            connection,
            verified: passed.verified,
            owner: wallet.publicKey,
            kekbullMint,
            ichorMint,
            treasury: nativeTreasury,
          });
          setWalletKekbull(burn.walletKekbull);
        }
        if (passed.verifiedRealm) {
          setHolderVotes(
            await readHolderVoteBalances({
              connection,
              verifiedRealm: passed.verifiedRealm,
              owner: wallet.publicKey,
            }),
          );
        }
      }
      if (nativeTreasury) {
        setTreasury(
          await readTreasuryLiveState({
            connection,
            verified: passed.verified,
            treasury: nativeTreasury,
            ichorMint,
            kekbullMint,
            verifiedRealm: passed.verifiedRealm ?? passed.verifiedGovernanceIdentity?.verifiedRealm ?? null,
          }),
        );
      }
      if (passed.verifiedGovernance) {
        const rows = await listCommunityProposals({
          connection,
          verifiedGovernance: passed.verifiedGovernance,
        });
        setOpenProposals(rows.filter((row) => row.state === ProposalState.Voting).length);
      }
      setReadAt(new Date());
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [connection, passed, wallet.publicKey]);

  /* Read on arrival and whenever the wallet changes. Requiring a button press
     before the page shows any figure made an empty dashboard the default view,
     which reads as broken rather than as "nothing has happened yet". Floor
     is 15s unless a confirmed signature arrives - the ICHOR mint 429'd when
     every panel re-read it on each `passed` identity change. */
  useThrottledLiveRefresh(Boolean(passed), refresh, props.lastConfirmedSignature);

  const config = passed?.verifiedIchorConfig?.config ?? null;
  const ichorDecimals = mint?.decimals ?? null;

  const supply = mint ? grouped(formatBaseUnits(mint.supply, mint.decimals)) : null;
  const burned =
    config && mint ? grouped(formatBaseUnits(config.totalKekbullBurned, mint.decimals)) : null;
  const burnRatio = config
    ? `${config.emissionNumerator.toString(10)} : ${config.emissionDenominator.toString(10)}`
    : null;
  const depositedToVote = treasury ? uiAmount(treasury.realmDeposit) : null;
  const walletIchor = walletState ? uiAmount(walletState.ichor) : null;
  const walletKekbullUi = uiAmount(walletKekbull);

  const depositedValue = !treasury
    ? null
    : treasury.realmDeposit === null
      ? null
      : treasury.realmDeposit.present
        ? depositedToVote
        : "none";

  const myVotingWeight =
    !wallet.publicKey
      ? null
      : holderVotes === null
        ? null
        : holderVotes.deposit.present
          ? grouped(formatBaseUnits(holderVotes.deposit.amount, holderVotes.decimals))
          : "none";
  const openProposalsLabel =
    openProposals === null ? null : openProposals === 0 ? "0" : String(openProposals);

  return (
    <>
      <div className="hero" id="start">
        {props.stateBanner}
        <div className="your-position">
          <p className="k">Your position</p>
          <div className="row">
            <span>
              <img src="/logo.png" className="kek" alt="" width={15} height={15} /> KEKBULL held
            </span>
            <span className="v kek-fig">
              {wallet.publicKey
                ? walletKekbull
                  ? (walletKekbullUi ?? "none")
                  : "unread"
                : "connect a wallet"}
            </span>
          </div>
          <div className="row">
            <span>
              <img src="/ichor-mark.png" alt="" width={15} height={15} /> ICHOR held
            </span>
            <span className="v ichor-fig">
              {wallet.publicKey ? (walletIchor ?? "unread") : "connect a wallet"}
            </span>
          </div>
          <div className="deposited">
            <p className="k">Deposited in the realm</p>
            <div className="v">
              {wallet.publicKey
                ? myVotingWeight === null
                  ? "unread"
                  : myVotingWeight === "none"
                    ? "none"
                    : myVotingWeight
                : "connect a wallet"}
            </div>
            <p className="note">
              Voting weight. A separate balance, not part of the ICHOR above. It sits in the realm
              until you withdraw it, which you can do any time you are not holding a standing vote.
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <div className="gate-fail">
          <pre>{error}</pre>
        </div>
      ) : null}

      <div className="statgrid">
        <Headline
          token="ichor"
          label="ICHOR supply"
          value={supply}
          note="All of it created by burning. On-chain mint supply, not the treasury."
        />
        <Headline
          token="kek"
          label="KEKBULL burned"
          value={burned}
          note="Destroyed for good, never in anyone's wallet"
        />
        <Headline
          token="ichor"
          label="Burn ratio"
          value={burnRatio}
          note={config ? "ICHOR minted per KEKBULL burned, from live Config" : "not read yet"}
        />
        <Headline
          label="Open proposals"
          value={openProposalsLabel}
          note={
            openProposals === null
              ? "Unread until governance verifies"
              : openProposals === 1
                ? "1 proposal open for voting"
                : `${String(openProposals)} proposals open for voting`
          }
        />
      </div>

      <details className="panel fold">
      <summary>
        <h2>On-chain figures</h2>
        <span className="fold-hint">Deposited weight and exact reads</span>
      </summary>
      <div className="panel-head">
        <div className="panel-actions">
          <span className="mono read-age">
            {busy ? "reading chain" : readAt ? `read ${readAt.toLocaleTimeString()}` : "not read"}
          </span>
          <button type="button" className="secondary" onClick={() => void refresh()} disabled={!passed || busy}>
            {busy ? "Reading" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Remaining protocol figures. Same Stat component as before. */}
      <div className="stats">
        <Stat
          token="ichor"
          label="ICHOR deposited to vote"
          value={depositedValue}
          note="Everyone's voting weight. Not the DAO's to spend."
        />
      </div>

      {/* The engineering view is kept verbatim, one fold down. Base units, ATAs,
          decimals and authorities are what a reader checking the mechanism
          actually needs, and none of it belongs in the headline figures. */}
      <details className="raw">
        <summary>Exact values read from chain</summary>
        {!passed?.verifiedIchorConfig ? (
          <p className="muted">ICHOR mint: unread until the on-chain config is verified.</p>
        ) : null}
        {!passed?.verifiedNativeTreasury ? (
          <p className="muted">Treasury: unread until the treasury address is derived.</p>
        ) : null}
        {mint ? (
          <dl className="dl">
            <dt>ICHOR mint</dt>
            <dd>{mint.mint.toBase58()}</dd>
            <dt>Owner program</dt>
            <dd>
              {mint.ownerProgram.toBase58()} ({mint.tokenProgramKind})
            </dd>
            <dt>Decimals</dt>
            <dd>{String(mint.decimals)}</dd>
            <dt>Supply (base)</dt>
            <dd>{mint.supply.toString(10)}</dd>
            <dt>Supply (UI)</dt>
            <dd>{formatBaseUnits(mint.supply, mint.decimals)}</dd>
            <dt>Mint authority</dt>
            <dd>{mint.mintAuthority ? mint.mintAuthority.toBase58() : "none"}</dd>
            <dt>Freeze authority</dt>
            <dd>{mint.freezeAuthority ? mint.freezeAuthority.toBase58() : "none"}</dd>
          </dl>
        ) : null}
        {config && ichorDecimals !== null ? (
          <dl className="dl">
            <dt>Emission numerator / denominator</dt>
            <dd>
              {config.emissionNumerator.toString(10)} / {config.emissionDenominator.toString(10)}
              {config.ratioUpdatesFrozen ? " · ratio updates frozen" : ""}
              {config.hasPendingRatio ? " · pending ratio exists" : ""}
            </dd>
            <dt>Total KEKBULL burned (base)</dt>
            <dd>{config.totalKekbullBurned.toString(10)}</dd>
            <dt>Total ICHOR minted (base)</dt>
            <dd>{config.totalIchorMinted.toString(10)}</dd>
          </dl>
        ) : null}
        {walletState ? (
          <dl className="dl">
            <dt>Wallet</dt>
            <dd>{walletState.owner.toBase58()}</dd>
            <dt>SOL lamports</dt>
            <dd>{walletState.solLamports.toString(10)}</dd>
            <dt>SOL (native mint decimals)</dt>
            <dd>{formatBaseUnits(walletState.solLamports, walletState.nativeMintDecimals)}</dd>
            <dt>Wallet KEKBULL</dt>
            <dd>
              {walletKekbull
                ? tokenLines("wallet KEKBULL", walletKekbull)
                : "unread until Config kekbullMint is verified"}
            </dd>
            <dt>Wallet ICHOR</dt>
            <dd>{tokenLines("wallet", walletState.ichor)}</dd>
          </dl>
        ) : null}
        {treasury ? (
          <dl className="dl">
            <dt>Treasury</dt>
            <dd>{treasury.treasury.toBase58()}</dd>
            <dt>Treasury lamports</dt>
            <dd>{treasury.solLamports.toString(10)}</dd>
            <dt>Treasury SOL</dt>
            <dd>{formatBaseUnits(treasury.solLamports, treasury.nativeMintDecimals)}</dd>
            <dt>Treasury ICHOR (native treasury ATA)</dt>
            <dd>{tokenLines("treasury", treasury.ichor)}</dd>
            <dt>Realm deposit vault ICHOR</dt>
            <dd>
              {treasury.realmDeposit
                ? tokenLines("realm vault", treasury.realmDeposit)
                : "Realm identity unavailable, no vault read attempted"}
            </dd>
            <dt>Mint withheld ICHOR (base)</dt>
            <dd>
              {treasury.mintWithheld === null
                ? "ICHOR mint unread"
                : treasury.mintWithheld.toString(10)}
            </dd>
          </dl>
        ) : null}
      </details>
    </details>
    </>
  );
}
