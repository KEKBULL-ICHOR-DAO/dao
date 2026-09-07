import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  isOperatorConsoleUnlocked,
  operatorAuthoritiesFromPreflight,
} from "../operator-access.ts";
import type { PreflightState } from "./Preflight.tsx";

export function OperatorLock(props: {
  preflight: PreflightState;
  programConfigured: boolean;
}) {
  const wallet = useWallet();
  const authorities = operatorAuthoritiesFromPreflight(props.preflight, props.programConfigured);
  const unlocked = isOperatorConsoleUnlocked({
    connected: wallet.publicKey,
    authorities,
  });
  if (unlocked) {
    return null;
  }

  const reading =
    props.programConfigured &&
    (props.preflight.status === "idle" || props.preflight.status === "running");
  const refused =
    wallet.publicKey !== null &&
    !reading &&
    (authorities.length === 0 ||
      !authorities.some((row) => row.key.equals(wallet.publicKey)));

  return (
    <section className="empty operator-lock" id="operator-lock">
      <p className="status-line">
        <span>OPERATOR</span>
        <span className="sep">/</span>
        <span>CONSOLE LOCKED</span>
      </p>
      <h3>Connect an authorized wallet</h3>
      <p className="muted">
        This is the loopback operator console, not the public DAO. Tabs, the deployment
        form, and every operator builder stay unmounted until the connected wallet is an
        on-chain authority: program upgrade authority, Config authority, pending Config
        authority, or the live creator beneficiary. Those identities are read from issued
        preflight proofs, not typed into this page.
      </p>
      {reading ? (
        <p className="muted">Reading on-chain operator authorities. Nothing is shown until that finishes.</p>
      ) : null}
      {props.preflight.status === "failed" ? (
        <div className="gate-fail">
          <strong>Could not read on-chain authorities</strong>
          <pre>{props.preflight.message}</pre>
        </div>
      ) : null}
      {refused ? (
        <div className="gate-fail">
          <strong>This wallet is not an operator authority</strong>
          <p>
            <span className="mono">{wallet.publicKey?.toBase58()}</span> is not the live
            upgrade, Config, pending, or creator-beneficiary authority. Disconnect and
            connect the wallet that holds one of those roles. This page does not list those
            addresses here.
          </p>
        </div>
      ) : null}
      <div className="operator-lock-connect">
        <WalletMultiButton />
      </div>
    </section>
  );
}
