import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import { isLocalGovernanceDevHost, type DeploymentConfig } from "../config.ts";
import { formatError } from "../format.ts";
import { prepareThrowawayQ3bMint } from "../throwaway-mint.ts";
import {
  THROWAWAY_Q3B_TRANSFER_FEE_BASIS_POINTS,
  throwawayMintInputsPresent,
} from "../throwaway-mint-inputs.ts";
import type { UnsignedPayload } from "../send.ts";

export function ThrowawayMint(props: {
  config: DeploymentConfig;
  onRequestSend: (payload: UnsignedPayload) => void;
}) {
  const host = typeof window === "undefined" ? "" : window.location.hostname;
  if (!isLocalGovernanceDevHost(host)) {
    return null;
  }

  return <ThrowawayMintForm config={props.config} onRequestSend={props.onRequestSend} host={host} />;
}

function ThrowawayMintForm(props: {
  config: DeploymentConfig;
  onRequestSend: (payload: UnsignedPayload) => void;
  host: string;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [decimalsText, setDecimalsText] = useState("");
  const [amountText, setAmountText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mintAddress, setMintAddress] = useState<string | null>(null);

  async function buildMint(): Promise<void> {
    setError(null);
    setMintAddress(null);
    if (!wallet.publicKey) {
      setError("connect Phantom on official-devnet before building; this app never receives private keys");
      return;
    }
    setBusy(true);
    try {
      const payload = await prepareThrowawayQ3bMint({
        connection,
        rpcUrl: props.config.rpcUrl,
        cluster: props.config.cluster,
        hostname: props.host,
        payer: wallet.publicKey,
        decimalsText,
        amountText,
      });
      const mint = payload.derivedAddresses.mint;
      if (mint) {
        setMintAddress(mint.toBase58());
      }
      props.onRequestSend(payload);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setBusy(false);
    }
  }

  const inputsReady = throwawayMintInputsPresent(decimalsText, amountText);

  return (
    <section className="panel">
      <h2>Q3b throwaway mint</h2>
      <p className="muted">
        This is a throwaway Q3b mint, <strong>not ICHOR</strong>. It creates a Token-2022 mint with
        TransferFeeConfig {String(THROWAWAY_Q3B_TRANSFER_FEE_BASIS_POINTS)} bps (0.25%) and
        maximum fee u64::MAX. Freeze authority is null. Payer is mint authority and
        withdraw-withheld authority. An ephemeral mint keypair is generated in this page&apos;s
        memory, used once as the createAccount signer, then zeroized after send. Phantom still
        signs as payer. After confirmation, paste the mint address into Realms v1 Create DAO on
        official-devnet:{" "}
        <a href="https://app.realms.today/realms?cluster=devnet">
          app.realms.today/realms?cluster=devnet
        </a>
        . Do not deposit F5TH / CHARGED / SCHT. Those mints have no TransferFeeConfig.
      </p>
      <div className="row">
        <label>
          Decimals (u8 0-255)
          <input
            value={decimalsText}
            onChange={(event) => setDecimalsText(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
        <label>
          Raw amount (positive integer)
          <input
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
      </div>
      <button
        type="button"
        disabled={busy || !wallet.publicKey || !inputsReady}
        onClick={() => void buildMint()}
      >
        {busy ? "Building" : "Build throwaway mint"}
      </button>
      {mintAddress ? (
        <p className="gate-pass">
          Throwaway mint (paste into Realms Create DAO):{" "}
          <span className="mono">{mintAddress}</span>
        </p>
      ) : null}
      {error ? (
        <div className="gate-fail">
          <pre>{error}</pre>
        </div>
      ) : null}
    </section>
  );
}
