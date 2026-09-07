import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useEffect, useState } from "react";
import { isLocalGovernanceDevHost } from "../config.ts";
import type { PreflightState } from "./Preflight.tsx";

/*
 * One strip that carries the three things that used to be three full-width
 * panels stacked above the fold: which origin this is, whether the addresses
 * matched on chain, and the wallet.
 *
 * A holder arriving from a Telegram link met "Local development origin",
 * "Connect your wallet" and "Contract verification" as bordered boxes before
 * reaching anything they came to do. None of those are tasks. Two are statuses
 * and one is a control, so they belong in chrome.
 *
 * The failure state deliberately does NOT live here. A pill is the right size
 * for "this is fine" and the wrong size for "this may not be the real site";
 * Preflight still takes the full width when it fails.
 *
 * Layout note, 2026-08-25: every child of .topbar is flex:none in the
 * stylesheet and the nav scrolls rather than wraps. Without that the nav links
 * and the verify pill shrink below their own text below about 1000px and break
 * onto two and three lines inside a 60px bar. The pill label is also short now
 * ("Verified", full phrase in the title attribute) because the long one is
 * what forced the wrap in the first place.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;

function VerifyPill(props: { state: PreflightState; deployed: boolean }) {
  if (!props.deployed) {
    return (
      <span className="pill dead" title="The DAO is not published on this page's addresses yet">
        Not deployed yet
      </span>
    );
  }
  if (props.state.status === "running") {
    return (
      <span className="pill" title="Reading this page's addresses from the chain">
        Verifying
      </span>
    );
  }
  if (props.state.status === "passed") {
    return (
      <span className="pill ok" title="Every address on this page was checked against the chain and matched">
        Verified
      </span>
    );
  }
  if (props.state.status === "failed") {
    return (
      <span className="pill bad" title="This page did not match the chain. Do not sign anything.">
        Verification failed
      </span>
    );
  }
  return (
    <span className="pill" title="The check has not run yet">
      Not verified yet
    </span>
  );
}

/* Lives in its own component so the wallet hooks only run when a WalletRoot is
   actually mounted. With no rpcUrl there is no provider to read from. */
function WalletChip() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [lamports, setLamports] = useState<number | null>(null);

  useEffect(() => {
    if (!publicKey) {
      setLamports(null);
      return;
    }
    let live = true;
    // A real read. Unread stays null and prints nothing rather than "0 SOL",
    // which would be a balance this page never actually saw.
    void connection
      .getBalance(publicKey)
      .then((value) => {
        if (live) setLamports(value);
      })
      .catch(() => {
        if (live) setLamports(null);
      });
    return () => {
      live = false;
    };
  }, [publicKey, connection]);

  return (
    <div className="wallet-chip">
      {publicKey && lamports !== null ? (
        <span className="mono sol">{(lamports / LAMPORTS_PER_SOL).toFixed(2)} SOL</span>
      ) : null}
      <WalletMultiButton />
    </div>
  );
}

export function Masthead(props: {
  operatorView: boolean;
  preflight: PreflightState;
  deployed: boolean;
  walletMounted: boolean;
  cluster: "devnet" | "mainnet-beta";
}) {
  const host = typeof window === "undefined" ? "" : window.location.hostname;

  /* Marketing-site deep links arrive as /#burn and /#vote. The browser tries
     to scroll before this tree is painted, so the hash would otherwise land
     at the top. After mount the ids exist and we honour them. */
  useEffect(() => {
    const id = window.location.hash.replace(/^#/, "");
    if (!id) return;
    document.getElementById(id)?.scrollIntoView();
  }, []);

  return (
    <header className="topbar">
      <div className="brand">
        <img src="/logo.png" className="kek" alt="" width={28} height={28} />
        <span className="wordmark">KEKBULL</span>
        <span className="brand-sub">{props.operatorView ? "Console" : "Governance"}</span>
      </div>
      {!props.operatorView ? (
        <nav className="navlinks" aria-label="On this page">
          <a href="#start">Start here</a>
          <a href="#treasury">Treasury</a>
          <a href="#liquidity">Liquidity</a>
          <a href="#handbook">Handbook</a>
          <a href="#burn">Burn</a>
          <a href="#deposit">Deposit</a>
          <a href="#vote">Vote</a>
          <a href="#addresses">Addresses</a>
        </nav>
      ) : null}
      <div className="topbar-status">
        {isLocalGovernanceDevHost(host) ? <span className="pill dead">Local dev</span> : null}
        {props.cluster === "devnet" ? (
          <span className="pill warn" title="Official Solana devnet. Nothing here is real money.">
            Devnet
          </span>
        ) : null}
        <VerifyPill state={props.preflight} deployed={props.deployed} />
        <a
          href={isLocalGovernanceDevHost(host) ? "http://127.0.0.1:8765/" : "https://kekbull.com"}
          target="_blank"
          rel="noopener noreferrer"
        >
          What is KEKBULL?
        </a>
        {props.walletMounted ? <WalletChip /> : null}
      </div>
    </header>
  );
}
