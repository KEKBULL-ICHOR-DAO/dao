import { requirePublicKey } from "@kekbull/ichor-client";
import { useConnection } from "@solana/wallet-adapter-react";
import { Fragment, useEffect, useState } from "react";
import { readToken2022MintDisplayName, type MintDisplayName } from "../chain.ts";
import type { DeploymentConfig } from "../config.ts";
import type { PreflightState } from "./Preflight.tsx";

/**
 * Read-only view of the addresses this page is operating against.
 *
 * On dao.kekbull.com this replaces ConfigForm. The editable form is an
 * operator tool: publishing deployment.json is what makes the site the answer
 * to "which contract is real", and a visitor who can retype the realm and the
 * mint defeats that answer. "Paste this address to claim your ICHOR" should
 * not be a supported flow on the official origin.
 *
 * Holders still need to check the site against the chain, so every address is
 * shown and linked to an explorer. Read, verify, do not edit.
 */

const EXPLORER = "https://solscan.io";

function explorerUrl(address: string, cluster: DeploymentConfig["cluster"]): string {
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return `${EXPLORER}/account/${address}${suffix}`;
}

function Address(props: { value: string | null; cluster: DeploymentConfig["cluster"] }) {
  if (!props.value) {
    return <span className="pill dead">not published</span>;
  }
  return (
    <a href={explorerUrl(props.value, props.cluster)} target="_blank" rel="noreferrer noopener">
      {props.value}
    </a>
  );
}

function sourceMintLabel(name: MintDisplayName | null | undefined): string {
  if (name && name.name.length > 0 && name.symbol.length > 0) {
    return `${name.name} (${name.symbol})`;
  }
  return "source mint";
}

export function DeploymentFacts(props: {
  config: DeploymentConfig;
  preflight?: PreflightState;
}) {
  const { connection } = useConnection();
  const cfg = props.config;
  const passed = props.preflight?.status === "passed" ? props.preflight : null;
  const [sourceName, setSourceName] = useState<MintDisplayName | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!passed || !cfg.kekbullMint) {
      setSourceName(null);
      return;
    }
    void (async () => {
      try {
        const name = await readToken2022MintDisplayName({
          connection,
          verified: passed.verified,
          mint: requirePublicKey(cfg.kekbullMint, "kekbullMint"),
        });
        if (!cancelled) setSourceName(name);
      } catch {
        if (!cancelled) setSourceName(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg.kekbullMint, connection, passed]);

  const votingProgram =
    passed?.verified.realms.programId.toBase58() ?? cfg.voteProgram;
  const rows: ReadonlyArray<readonly [string, string | null]> = [
    [`${sourceMintLabel(sourceName)} mint`, cfg.kekbullMint],
    ["ICHOR mint", cfg.ichorMint],
    ["ICHOR program", cfg.ichorProgram],
    ["Voting program", votingProgram],
    ["Realm", cfg.realm],
    ["Governance", cfg.governance],
    ["Treasury", cfg.nativeTreasury],
    ["Liquidity pool", cfg.meteoraPool],
  ];

  const published = rows.some(([, value]) => Boolean(value));

  return (
    <section className="panel quiet">
      <h2>Contract addresses</h2>
      <p className="muted">
        {published
          ? "The addresses this page uses. Each one opens in a block explorer."
          : "Nothing is published yet. Each row stays unread rather than showing an address this page does not have."}
      </p>
      <dl className="dl">
        {/* Fragment, not a wrapper element: .dl is a two-column grid and dt/dd
            have to be its direct children. A div would need display:contents,
            and an inline style attribute is blocked by the origin's CSP. */}
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>
              <Address value={value} cluster={cfg.cluster} />
            </dd>
          </Fragment>
        ))}
        <dt>Website</dt>
        <dd>
          <a href="https://kekbull.com" target="_blank" rel="noreferrer noopener">
            kekbull.com
          </a>
        </dd>
        <dt>Network</dt>
        <dd>{cfg.cluster}</dd>
      </dl>
    </section>
  );
}
