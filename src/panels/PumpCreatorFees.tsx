import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { useCallback, useRef, useState } from "react";
import { OPERATOR_CREATOR_FEE_BENEFICIARY } from "../creator-beneficiary.ts";
import { formatBaseUnits, formatError, groupUiAmount } from "../format.ts";
import { useThrottledLiveRefresh } from "../live-refresh.ts";
import {
  WSOL_MINT,
  ammTransferCanUnlock,
  buildPumpDistribute,
  measurePumpCreatorFees,
  pumpDistributeReady,
  pumpVaultCanPay,
  sharesMatchKekbullPolicy,
  sharingConfigAddress,
  type PumpCreatorFeeLive,
} from "../pump-distribute.ts";
import type { UnsignedPayload } from "../send.ts";
import type { PreflightState } from "./Preflight.tsx";

function groupedSol(lamports: BN): string {
  return `${groupUiAmount(formatBaseUnits(lamports, 9))} SOL`;
}

export function PumpCreatorFees(props: {
  preflight: PreflightState;
  onRequestSend: (payload: UnsignedPayload) => void;
  lastConfirmedSignature?: string | null;
  embedded?: boolean;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [live, setLive] = useState<PumpCreatorFeeLive | null>(null);
  const [missing, setMissing] = useState<"sharing-config" | "bonding-curve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passed = props.preflight.status === "passed" ? props.preflight : null;
  const mint = passed?.verifiedIchorConfig?.config.kekbullMint ?? null;
  const expectedTreasury = passed?.verifiedNativeTreasury ?? null;
  const expectedOperator = new PublicKey(OPERATOR_CREATOR_FEE_BENEFICIARY);
  const refreshGen = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++refreshGen.current;
    if (!mint) {
      setLive(null);
      setMissing(null);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const measured = await measurePumpCreatorFees(connection, mint);
      if (mine !== refreshGen.current) {
        return;
      }
      if ("missing" in measured) {
        setLive(null);
        setMissing(measured.missing);
        return;
      }
      setMissing(null);
      setLive(measured);
    } catch (cause) {
      if (mine !== refreshGen.current) {
        return;
      }
      setLive(null);
      setMissing(null);
      setError(formatError(cause));
    } finally {
      if (mine === refreshGen.current) {
        setBusy(false);
      }
    }
  }, [connection, mint]);

  useThrottledLiveRefresh(Boolean(mint), refresh, props.lastConfirmedSignature);

  const blocked =
    !mint
      ? "This page has not verified the published KEKBULL mint yet."
      : missing === "bonding-curve"
        ? "No bonding curve on this cluster for the published mint."
        : missing === "sharing-config"
          ? "Pump fee-sharing is not on this mint yet. Anyone can push these fees only after create_fee_sharing_config. This page does not send that."
          : live === null
            ? busy
              ? "Reading the Pump creator-fee vault."
              : error ?? "Pump creator-fee vault is unread."
            : live.sharing.status !== "Active"
              ? "SharingConfig is Paused. This page does not send distribute."
              : !live.sharing.adminRevoked
                ? "Shares are not finalized (admin_revoked is false). This page does not send update_fee_shares_v2."
                : !pumpDistributeReady(live)
                  ? live.ammTokenAmount.gtn(0) && live.ammTokenAmount.lt(live.tokenAccountRent)
                    ? `AMM wSOL ${groupedSol(live.ammTokenAmount)} is under Token-account rent, so transfer_creator_fees_to_pump would skip. Vault payout ${groupedSol(live.minimum.distributableFees)} is dust.`
                    : live.vaultLamports.add(live.ammTokenAmount).lt(live.minimum.minimumRequired)
                      ? `Pump vault plus AMM wSOL is still below the on-chain minimum (${groupedSol(live.minimum.minimumRequired)} required). Sending now would waste a fee.`
                      : live.minimum.distributableFees.gtn(0)
                        ? `Vault payout ${groupedSol(live.minimum.distributableFees)} does not clear a send fee after splitting across ${String(live.sharing.shareholders.length)} shareholders.`
                        : `Nothing to pay. Vault payout ${groupedSol(live.minimum.distributableFees)}; AMM wSOL ${groupedSol(live.ammTokenAmount)}.`
                  : !wallet.publicKey
                    ? "Connect a wallet to send. You are the fee payer only. This does not pay you."
                    : null;

  async function distribute(): Promise<void> {
    setError(null);
    setPreview(null);
    try {
      if (!mint) {
        throw new Error("verified Config kekbullMint is required");
      }
      if (!wallet.publicKey) {
        throw new Error("connect a wallet before building distribute_creator_fees");
      }
      const measured = await measurePumpCreatorFees(connection, mint);
      if ("missing" in measured) {
        throw new Error(
          measured.missing === "sharing-config"
            ? "SharingConfig is not on this mint"
            : "bonding curve is not on this mint",
        );
      }
      const built = await buildPumpDistribute({
        connection,
        mint,
        payer: wallet.publicKey,
        live: measured,
      });
      const shareLines = measured.sharing.shareholders.map(
        (row) => `${row.address.toBase58()} · ${String(row.shareBps)} bps`,
      );
      setPreview(
        [
          built.includesTransfer
            ? `Includes transfer_creator_fees_to_pump (${measured.ammTokenAmount.toString(10)} AMM wSOL → pump vault), then distribute.`
            : null,
          `get_minimum_distributable_fee: ${measured.minimum.distributableFees.toString(10)} of ${measured.minimum.minimumRequired.toString(10)} (${measured.variant}).`,
          built.initializeAta ? "v2 will create missing quote ATAs; the sender pays that rent." : null,
          `Live shareholders: ${shareLines.join("; ")}.`,
          "Anyone can send this. You are not paid.",
        ]
          .filter((line): line is string => line !== null)
          .join(" "),
      );
      props.onRequestSend({
        label: built.includesTransfer
          ? "transfer PumpSwap creator fees to the pump vault, then distribute to live shareholders"
          : "distribute Pump creator fees to the live SharingConfig shareholders",
        instructions: built.instructions,
        derivedAddresses: {
          mint,
          sharingConfig: measured.sharingConfigAddress,
          bondingCurve: measured.bondingCurve,
          creatorVault: measured.creatorVault,
          ammVaultAta: measured.ammVaultAta,
        },
        holderSummary: {
          kind: "other",
          headline: built.includesTransfer
            ? "Move AMM creator fees into the pump vault, then pay shareholders"
            : "Push Pump creator fees to the live shareholders",
          details: [
            "Anyone can send this. You pay the network fee only.",
            "This is not ICHOR Collect and does not use the creator keystore.",
            ...shareLines,
          ],
        },
      });
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  const policyLive =
    live !== null && expectedTreasury !== null
      ? sharesMatchKekbullPolicy(live.sharing.shareholders, expectedTreasury, expectedOperator)
      : false;
  const lookedUp = mint !== null ? sharingConfigAddress(mint).toBase58() : null;
  const vaultLabel = live
    ? groupedSol(live.vaultLamports)
    : missing !== null
      ? "none"
      : busy
        ? "reading chain"
        : "unread";
  const readyLabel = live
    ? pumpDistributeReady(live)
      ? ammTransferCanUnlock(live) &&
        !pumpVaultCanPay(live.minimum, live.sharing.shareholders.length)
        ? `${groupedSol(live.ammTokenAmount)} in AMM, not yet moved`
        : groupedSol(live.minimum.distributableFees)
      : "below payout"
    : missing !== null
      ? "none"
      : busy
        ? "reading chain"
        : "unread";
  const splitLabel = live
    ? live.sharing.status !== "Active"
      ? "paused"
      : !live.sharing.adminRevoked
        ? "not finalized"
        : policyLive
          ? "75 / 25"
          : `${String(live.sharing.shareholders.length)} shareholder${live.sharing.shareholders.length === 1 ? "" : "s"}`
    : missing !== null
      ? "none"
      : busy
        ? "reading chain"
        : "unread";
  const vaultNote = live
    ? `creator-vault ${live.creatorVault.toBase58()} seeded by bonding_curve.creator ${live.curve.creator.toBase58()}`
    : missing === "sharing-config"
      ? `SharingConfig ${lookedUp ?? ""} has no account. There is no vault to read.`
      : missing === "bonding-curve"
        ? "Bonding curve account is absent on this cluster. Nothing to seed a vault from."
        : "Measured from the creator-vault account, not estimated.";
  const readyNote = live
    ? `get_minimum_distributable_fee: minimum ${live.minimum.minimumRequired.toString(10)}, reported ${live.minimum.distributableFees.toString(10)}, can_distribute ${String(live.minimum.canDistribute)}. AMM wSOL ${live.ammTokenAmount.toString(10)} at ${live.ammVaultAta.toBase58()} (rent ${live.tokenAccountRent.toString(10)}; transfer ${live.transferEligible ? "eligible" : "not eligible"}). ${live.variant === "v1" ? "Native SOL path (v1, no instruction signer)." : `Quote-token path (v2). Quote mint ${live.curve.quoteMint.toBase58()}${live.curve.quoteMint.equals(WSOL_MINT) ? " (wrapped SOL)" : ""}.`}`
    : missing !== null
      ? "get_minimum_distributable_fee needs a SharingConfig. Not simulated."
      : "Simulated from get_minimum_distributable_fee. Not a guessed threshold.";
  const splitNote = live
    ? live.sharing.shareholders
        .map((row) => {
          const role = expectedTreasury !== null && row.address.equals(expectedTreasury)
            ? "treasury"
            : row.address.equals(expectedOperator)
              ? "operator"
              : "shareholder";
          return `${role} ${row.address.toBase58()} · ${String(row.shareBps)} bps`;
        })
        .join(" · ")
    : missing !== null
      ? "SharingConfig account is absent. This page does not invent 75/25."
      : "Read from SharingConfig. This page does not invent 75/25.";

  return (
    <div className="fee-live">
      <div className="fee-live-head">
        <div>
          <h3>Pump creator fees</h3>
          <p className="muted">
            Anyone can send this. After sharing, PumpSwap fees sit in the AMM wSOL vault until
            transfer_creator_fees_to_pump, then distribute_creator_fees pays the live list. This
            click sends that hop when it is needed. You are not paid. If the button is unused,
            anyone else can still call both instructions.
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => void refresh()}
          disabled={!mint || busy}
        >
          {busy ? "Reading" : "Refresh Pump fees"}
        </button>
      </div>
      {error ? (
        <div className="gate-fail">
          <pre>{error}</pre>
        </div>
      ) : null}
      <div className="stats">
        <div className="stat">
          <div className="k">
            <span>Vault (lamports)</span>
          </div>
          <div className="v">{vaultLabel}</div>
          <div className="n">{vaultNote}</div>
        </div>
        <div className="stat">
          <div className="k">
            <span>Ready to distribute</span>
          </div>
          <div className="v">{readyLabel}</div>
          <div className="n">{readyNote}</div>
        </div>
        <div className="stat kek">
          <div className="k">
            <span>Live split</span>
          </div>
          <div className="v">{splitLabel}</div>
          <div className="n">{splitNote}</div>
        </div>
      </div>
      {preview ? <p className="gate-pass">{preview}</p> : null}
      <button
        type="button"
        className="collect-action"
        disabled={blocked !== null}
        onClick={() => void distribute()}
      >
        Distribute Pump creator fees
      </button>
      <p className="field-note">
        {blocked ??
          "Anyone can send this. The connected wallet pays the network fee and is not a shareholder unless it is already on the live list. Simulate, then confirm. Phantom signs only after you confirm."}
      </p>
    </div>
  );
}
