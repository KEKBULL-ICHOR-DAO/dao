import {
  buildConvertInstruction,
  deriveVerifiedNativeTreasury,
  ichorFromKekbull,
  requirePositiveBn,
} from "@kekbull/ichor-client";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useState } from "react";
import { readBurnLiveState, type BurnLiveState, type TokenAccountRead } from "../chain.ts";
import { formatBaseUnits, formatError, parseUiToBaseUnits } from "../format.ts";
import { useThrottledLiveRefresh } from "../live-refresh.ts";
import type { UnsignedPayload } from "../send.ts";
import type { PreflightState } from "./Preflight.tsx";

/*
 * Redesign 2026-08-25. Logic is byte-for-byte the original: same reads, same
 * ratio maths, same guards, same payload. Only the render changed.
 *
 *  - Two columns, `.burn-grid`: the form on the left, the consequences on the
 *    right, so the effect of what you typed is beside the box you typed it in.
 *  - The two-step ladder becomes `.effect` lines: destroyed (green, negative),
 *    received (violet, positive), and the irreversibility box under them.
 *  - The recipient dropdown stays operator-only, unchanged.
 *
 * On the transfer fee, deliberately: this panel does NOT show a computed
 * post-fee voting figure. Minting is not a transfer, so no fee is taken here,
 * and the panel never reads the mint's transfer-fee rate - printing a net it
 * did not measure would be inventing a number. The disclosure is stated in
 * words and the exact figure belongs to the deposit builder, which does read
 * it. If you want the number here, `readBurnLiveState` would have to return the
 * Token-2022 transfer-fee config as well; that is a chain.ts change, not a
 * copy change.
 */

interface PreparedConvertAmounts {
  readonly kekbullAmount: ReturnType<typeof parseUiToBaseUnits>;
  readonly minIchorAmount: ReturnType<typeof parseUiToBaseUnits>;
  readonly kekbullDecimals: number;
  readonly ichorDecimals: number;
  readonly expectedIchorAmount?: ReturnType<typeof parseUiToBaseUnits>;
  readonly sourceLabel: string;
}

function sourceMintLabel(name: BurnLiveState["sourceMintName"] | null | undefined): string {
  if (name && name.name.length > 0 && name.symbol.length > 0) {
    return `${name.name} (${name.symbol})`;
  }
  return "source mint";
}

function tokenLines(label: string, read: TokenAccountRead | null, mintConfigured: boolean): string {
  if (!mintConfigured) {
    return `${label}: mint not configured, no token read attempted`;
  }
  if (!read) {
    return `${label}: wallet or treasury identity missing, no token read attempted`;
  }
  if (!read.present || !read.amount || read.decimals === null) {
    return `${label}: no ATA at ${read.ata.toBase58()} (mint decimals ${String(read.mintDecimals)} from mint account)`;
  }
  const ui = formatBaseUnits(read.amount, read.decimals);
  return `${label}: ${read.amount.toString(10)} base units (${ui} @ mint decimals ${String(read.decimals)}); ATA ${read.ata.toBase58()}`;
}

function grouped(ui: string): string {
  const [whole, fraction] = ui.split(".");
  const withCommas = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (!fraction) {
    return withCommas;
  }
  const trimmed = fraction.replace(/0+$/, "").slice(0, 4);
  return trimmed.length > 0 ? `${withCommas}.${trimmed}` : withCommas;
}

function baseToUi(baseUnits: bigint, decimals: number): string {
  const s = baseUnits.toString(10).padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const fraction = decimals > 0 ? s.slice(s.length - decimals) : "";
  return grouped(decimals > 0 ? `${whole}.${fraction}` : whole);
}

/* One consequence of this burn. The receive figure is the minted amount that
   lands in the wallet. Deposit fees belong on the Vote panel, not here. */
function EffectLine(props: {
  label: string;
  value: string | null;
  unit: string;
  sign: "out" | "in";
  body: React.ReactNode;
}) {
  return (
    <div className="effect-line">
      <div className="line">
        <span>{props.label}</span>
        <span className={props.sign}>
          {props.value === null ? (
            <span className="pending">type an amount</span>
          ) : (
            <>
              {props.sign === "out" ? "\u2212" : "+"}
              {props.value} <span className="u">{props.unit}</span>
            </>
          )}
        </span>
      </div>
      <p className="muted">{props.body}</p>
    </div>
  );
}

export function BurnPanel(props: {
  preflight: PreflightState;
  onRequestSend: (payload: UnsignedPayload) => void;
  operatorView?: boolean;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const operatorView = props.operatorView ?? true;
  const [kekbullUi, setKekbullUi] = useState("");
  const [live, setLive] = useState<BurnLiveState | null>(null);
  const [prepared, setPrepared] = useState<PreparedConvertAmounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recipientKind, setRecipientKind] = useState<"wallet" | "treasury">("wallet");
  const passed = props.preflight.status === "passed" ? props.preflight : null;
  const verifiedConfig = passed?.verifiedIchorConfig ?? null;
  const ichorReason = passed?.ichorReason ?? null;
  const rpcRateLimited = Boolean(ichorReason && /429|rate limit/i.test(ichorReason));
  const unpublished =
    !verifiedConfig &&
    (!ichorReason || ichorReason.includes("ICHOR_PREFLIGHT_SKIPPED"));
  const convertPaused = Boolean(verifiedConfig?.config.paused);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    setLive(null);
    if (!passed || !verifiedConfig) {
      setError(
        passed?.ichorReason ??
          "The burn program could not be read from the chain, so no balances were fetched.",
      );
      return;
    }
    setBusy(true);
    try {
      setLive(
        await readBurnLiveState({
          connection,
          verified: passed.verified,
          owner: wallet.publicKey,
          kekbullMint: verifiedConfig.config.kekbullMint.toBase58(),
          ichorMint: verifiedConfig.config.ichorMint.toBase58(),
          treasury: passed.verifiedNativeTreasury?.toBase58() ?? null,
        }),
      );
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [connection, passed, verifiedConfig, wallet.publicKey]);

  useThrottledLiveRefresh(Boolean(verifiedConfig), refresh);

  async function prepareAmounts(): Promise<PreparedConvertAmounts> {
    if (!passed || !verifiedConfig) {
      throw new Error(
        passed?.ichorReason ??
          "The burn program could not be read from the chain, so burning stays closed.",
      );
    }
    if (!wallet.publicKey) {
      throw new Error("connect a wallet; this app never receives private keys");
    }
    const snapshot = await readBurnLiveState({
      connection,
      verified: passed.verified,
      owner: wallet.publicKey,
      kekbullMint: verifiedConfig.config.kekbullMint.toBase58(),
      ichorMint: verifiedConfig.config.ichorMint.toBase58(),
      treasury: passed.verifiedNativeTreasury?.toBase58() ?? null,
    });
    setLive(snapshot);
    if (!snapshot.kekbullMint || !snapshot.ichorMint) {
      throw new Error("KEKBULL and ICHOR mint accounts must exist on the bound connection");
    }
    const kekbullAmount = requirePositiveBn(
      parseUiToBaseUnits(kekbullUi, snapshot.kekbullMint.decimals),
      "kekbullAmount",
    );
    const minIchorAmount = ichorFromKekbull({
      kekbullAmount,
      kekbullDecimals: snapshot.kekbullMint.decimals,
      ichorDecimals: snapshot.ichorMint.decimals,
      numerator: verifiedConfig.config.emissionNumerator,
      denominator: verifiedConfig.config.emissionDenominator,
    });
    const next: PreparedConvertAmounts = {
      kekbullAmount,
      minIchorAmount,
      kekbullDecimals: snapshot.kekbullMint.decimals,
      ichorDecimals: snapshot.ichorMint.decimals,
      sourceLabel: sourceMintLabel(snapshot.sourceMintName),
    };
    setPrepared(next);
    return next;
  }

  async function buildConvert(): Promise<void> {
    setError(null);
    setPrepared(null);
    if (convertPaused) {
      return;
    }
    try {
      if (!wallet.publicKey || !verifiedConfig) {
        throw new Error(
          passed?.ichorReason ??
            "Connect a wallet, and wait for the burn program to be read, before burning.",
        );
      }
      const amounts = await prepareAmounts();
      const recipient =
        recipientKind === "treasury"
          ? passed?.verifiedGovernanceIdentity
            ? await deriveVerifiedNativeTreasury(passed.verifiedGovernanceIdentity)
            : null
          : wallet.publicKey;
      if (!recipient) {
        throw new Error(
          passed?.governanceReason ??
            "VerifiedGovernanceIdentity is required to receive ICHOR in the Realms treasury",
        );
      }
      const built = await buildConvertInstruction({
        connection,
        verifiedConfig,
        burner: wallet.publicKey,
        recipient,
        kekbullAmount: amounts.kekbullAmount,
        minIchorAmount: amounts.minIchorAmount,
      });
      setPrepared({ ...amounts, expectedIchorAmount: built.expectedIchorAmount });
      const sourceLabel = amounts.sourceLabel;
      const burnUi = grouped(formatBaseUnits(amounts.kekbullAmount, amounts.kekbullDecimals));
      const receiveUi = grouped(
        formatBaseUnits(built.expectedIchorAmount, amounts.ichorDecimals),
      );
      props.onRequestSend({
        label: `${sourceLabel} → ICHOR convert`,
        instructions: built.unsigned.instructions,
        derivedAddresses: {
          program: built.programId,
          config: built.config,
          kekbullMint: built.kekbullMint.mint,
          ichorMint: built.ichorMint.mint,
          bondingCurve: built.bondingCurve.address,
          kekbullFrom: built.kekbullFrom,
          ichorTo: built.ichorTo,
        },
        holderSummary: {
          kind: "burn",
          headline: `Burn ${sourceLabel} for ICHOR`,
          details: [
            `Destroy ${burnUi} ${sourceLabel}. This cannot be undone.`,
            `Create ${receiveUi} ICHOR in the same transaction.`,
            `Mint ${built.kekbullMint.mint.toBase58()}. Phantom labels this throwaway from its Token-2022 metadata.`,
            `Live Config is ${verifiedConfig.config.emissionNumerator.toString(10)} ICHOR per ${verifiedConfig.config.emissionDenominator.toString(10)} source unit.`,
            "Minting is not a transfer, so the 0.25% fee is not charged on this step.",
          ],
        },
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  const kekbullDecimals = prepared?.kekbullDecimals ?? live?.kekbullMint?.decimals ?? null;
  const ichorDecimals = prepared?.ichorDecimals ?? live?.ichorMint?.decimals ?? null;
  let liveQuote: { kekbullAmount: ReturnType<typeof parseUiToBaseUnits>; ichorAmount: ReturnType<typeof parseUiToBaseUnits> } | null =
    null;
  if (
    verifiedConfig &&
    kekbullDecimals !== null &&
    ichorDecimals !== null &&
    kekbullUi.trim().length > 0
  ) {
    try {
      const kekbullAmount = parseUiToBaseUnits(kekbullUi, kekbullDecimals);
      if (!kekbullAmount.isZero()) {
        liveQuote = {
          kekbullAmount,
          ichorAmount: ichorFromKekbull({
            kekbullAmount,
            kekbullDecimals,
            ichorDecimals,
            numerator: verifiedConfig.config.emissionNumerator,
            denominator: verifiedConfig.config.emissionDenominator,
          }),
        };
      }
    } catch {
      liveQuote = null;
    }
  }
  const expectedBase =
    liveQuote?.ichorAmount.toString(10) ?? prepared?.expectedIchorAmount?.toString(10) ?? null;
  const feesBound = verifiedConfig?.config.feeBeneficiariesBound === true;

  const burnDisplay =
    liveQuote !== null
      ? grouped(formatBaseUnits(liveQuote.kekbullAmount, kekbullDecimals ?? 0))
      : kekbullUi.trim().length > 0
        ? grouped(kekbullUi.trim())
        : null;
  const receiveDisplay =
    expectedBase !== null && ichorDecimals !== null
      ? baseToUi(BigInt(expectedBase), ichorDecimals)
      : null;
  const sourceLabel = prepared?.sourceLabel ?? sourceMintLabel(live?.sourceMintName);
  const heldLabel =
    live?.walletKekbull?.present && live.walletKekbull.amount && live.walletKekbull.decimals !== null
      ? grouped(formatBaseUnits(live.walletKekbull.amount, live.walletKekbull.decimals))
      : null;

  return (
    <section className="panel kek">
      <div className="panel-head">
        <div>
          <h2>
            Burn {sourceLabel} for ICHOR
            <span className="pill bad">Irreversible</span>
          </h2>
          <p className="muted">
            Burning is permanent and it is the only way ICHOR is created. The two happen in one
            transaction, so nobody hands ICHOR out and nobody can withhold it. The source mint
            does not go to us or into a reserve. It stops existing. Phantom labels this throwaway
            from its Token-2022 metadata, not from the KEKBULL product name.
          </p>
        </div>
        <div className="panel-actions">
          <button type="button" className="secondary" onClick={() => void refresh()} disabled={!verifiedConfig || busy}>
            {busy ? "Reading" : "Refresh balances"}
          </button>
        </div>
      </div>

      {!verifiedConfig ? (
        <div className="empty">
          <h3>
            {rpcRateLimited
              ? "Burn is waiting on official-devnet RPC"
              : unpublished
                ? "Burn opens when ICHOR exists"
                : "Burn is closed until Config verifies"}
          </h3>
          <p className="muted">
            {rpcRateLimited
              ? "The contracts are on this page, but the public Solana endpoint is rate-limiting us, so the burn program could not be read. Balances stay blank rather than showing a number we did not read. Try again in a moment."
              : unpublished
                ? "ICHOR is created only by burning KEKBULL, and that program is not published on this page yet. The form below is the real one. The button stays closed until the contracts exist."
                : "The burn program is listed on this page, but reading it from the chain did not succeed. Burning stays closed until it does. This page will not build a transaction against something it could not verify."}
          </p>
          {ichorReason ? <pre>{ichorReason}</pre> : null}
        </div>
      ) : convertPaused ? (
        <div className="empty">
          <h3>The first conversion establishes the defensive stake</h3>
          <p>
            Burning is switched off on-chain right now, deliberately. The first conversion after
            graduation is an atomic defensive stake; holder convert opens later. The ICHOR/SOL
            pool and its permanent lock come after that first stake, not before. Until the pool
            exists there is nowhere to sell ICHOR, so a holder burn would leave you with a token
            you could not trade yet.
          </p>
          <p className="muted">
            The wallet that deployed this program can switch burning on and off without a vote,
            and will be able to until config authority moves to the DAO. Every change is a
            public transaction.
          </p>
        </div>
      ) : null}
      {error ? (
        <div className="gate-fail">
          <pre>{error}</pre>
        </div>
      ) : null}

      <div className="burn-grid">
        <div className="build">
          <label>
            {sourceLabel} to burn
            <input
              value={kekbullUi}
              onChange={(event) => setKekbullUi(event.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </label>
          <p className="field-note">
            {heldLabel !== null
              ? `You hold ${heldLabel} ${sourceLabel}.`
              : wallet.publicKey
                ? "Refresh balances to read what you hold."
                : "Connect a wallet to read what you hold."}
            {verifiedConfig
              ? ` Live Config is ${verifiedConfig.config.emissionNumerator.toString(10)} ICHOR per ${verifiedConfig.config.emissionDenominator.toString(10)} KEKBULL. The signed floor is that output, not a second box.`
              : " Live Config ratio is unread until the on-chain config is verified."}
          </p>

          {/* Minting the new ICHOR to the treasury instead of yourself is how the
              DAO seeds its own ICHOR from KEKBULL it already holds. For a holder
              it is a donation with no receipt: your KEKBULL is destroyed, the
              voting weight lands in the treasury, and nothing comes back. That
              does not belong one dropdown click away from the normal path, with
              an irreversible burn behind it. The program still allows an
              arbitrary recipient; only this control is operator-only. */}
          {operatorView ? (
            <>
              <label>
                Send the ICHOR to
                <select
                  value={recipientKind}
                  onChange={(event) =>
                    setRecipientKind(event.target.value === "treasury" ? "treasury" : "wallet")
                  }
                >
                  <option value="wallet">My wallet</option>
                  <option value="treasury" disabled={!passed?.verifiedNativeTreasury}>
                    The community treasury
                  </option>
                </select>
              </label>
              {recipientKind === "treasury" ? (
                <p className="field-note">
                  You burn your own source mint and the new ICHOR goes straight to the treasury
                  instead of to you. The treasury address is derived from the verified governance
                  identity, not pasted into this page.
                </p>
              ) : null}
            </>
          ) : null}

          <button
            type="button"
            className="primary"
            onClick={() => void buildConvert()}
            disabled={!verifiedConfig || !wallet.publicKey || convertPaused}
          >
            {!verifiedConfig
              ? rpcRateLimited
                ? "Waiting on official-devnet RPC"
                : unpublished
                  ? "Opens when the DAO is published"
                  : "Opens when Config verifies"
              : convertPaused
                ? "Holder convert opens later"
                : !wallet.publicKey
                  ? "Connect a wallet to burn"
                  : "Preview this burn"}
          </button>
          <p className="field-note">
            Nothing is sent yet. The figures beside this update as you type, using the ratio read
            from the chain. Preview builds the transaction; your wallet asks you to approve it as a
            separate step.
          </p>
        </div>

        <div className="effect">
          <p className="k">What this burn does</p>
          <EffectLine
            label={`${sourceLabel} destroyed`}
            value={burnDisplay}
            unit={sourceLabel}
            sign="out"
            body="Destroyed in the same transaction that creates your ICHOR. This cannot be undone and cannot be reversed by anyone, including us."
          />
          <EffectLine
            label="ICHOR you receive"
            value={receiveDisplay}
            unit="ICHOR"
            sign="in"
            body={
              verifiedConfig
                ? `Computed as you type from the verified Config ratio ${verifiedConfig.config.emissionNumerator.toString(10)}/${verifiedConfig.config.emissionDenominator.toString(10)}. Minting is not a transfer, so this burn does not take the 0.25% transfer fee and does not send ICHOR to the treasury.`
                : "Computed as you type from the ratio in the on-chain config. Minting is not a transfer, so this burn does not take the 0.25% transfer fee and does not send ICHOR to the treasury."
            }
          />
          <p className="muted flow-note">
            This burn credits the full minted ICHOR to your wallet. Depositing later to vote is a
            separate transfer on the Vote panel, and that is when the mint withholds its 0.25%
            transfer fee, so the weight you end up voting with is smaller than the amount you
            burned. The
            deposit builder shows gross, withheld fee and credited net from the live mint.
            {feesBound
              ? " Harvest then splits those withheld tokens 25% to the token dev's bound wallet and 75% to the community treasury."
              : " Fee beneficiaries are not bound on this Config yet, so withheld tokens sit on the token accounts. Nothing arrives at the treasury or the token dev's wallet from this burn."}
          </p>
          <p className="irreversible">
            Burning is irreversible. There is no route from ICHOR back to {sourceLabel}, and no one
            can reverse it for you.
          </p>
        </div>
      </div>

      <details className="raw">
        <summary>Exact values read from chain</summary>
        {live ? (
          <dl className="dl">
            <dt>Source mint (Config kekbullMint)</dt>
            <dd>
              {live.kekbullMint
                ? `${live.kekbullMint.mint.toBase58()} · ${live.kekbullMint.tokenProgramKind} · decimals ${String(live.kekbullMint.decimals)} · supply ${live.kekbullMint.supply.toString(10)} base (${formatBaseUnits(live.kekbullMint.supply, live.kekbullMint.decimals)} UI)`
                : "not configured, no mint read attempted"}
            </dd>
            <dt>ICHOR mint</dt>
            <dd>
              {live.ichorMint
                ? `${live.ichorMint.mint.toBase58()} · ${live.ichorMint.tokenProgramKind} · decimals ${String(live.ichorMint.decimals)} · supply ${live.ichorMint.supply.toString(10)} base (${formatBaseUnits(live.ichorMint.supply, live.ichorMint.decimals)} UI)`
                : "not configured, no mint read attempted"}
            </dd>
            <dt>Wallet KEKBULL</dt>
            <dd>{tokenLines("wallet KEKBULL", live.walletKekbull, Boolean(verifiedConfig))}</dd>
            <dt>Wallet ICHOR</dt>
            <dd>{tokenLines("wallet ICHOR", live.walletIchor, Boolean(verifiedConfig))}</dd>
            <dt>Treasury KEKBULL</dt>
            <dd>
              {passed?.verifiedNativeTreasury
                ? tokenLines("treasury KEKBULL", live.treasuryKekbull, Boolean(verifiedConfig))
                : "verified native treasury unavailable, no treasury read attempted"}
            </dd>
            <dt>Treasury ICHOR</dt>
            <dd>
              {passed?.verifiedNativeTreasury
                ? tokenLines("treasury ICHOR", live.treasuryIchor, Boolean(verifiedConfig))
                : "verified native treasury unavailable, no treasury read attempted"}
            </dd>
            <dt>Program config totals</dt>
            <dd>
              {verifiedConfig
                ? `${verifiedConfig.config.totalKekbullBurned.toString(10)} KEKBULL base units burned; ${verifiedConfig.config.totalIchorMinted.toString(10)} ICHOR base units minted`
                : "unread until the on-chain config is verified"}
            </dd>
          </dl>
        ) : (
          <p className="muted">Refresh balances to read the mints and token accounts.</p>
        )}
        {prepared ? (
          <dl className="dl">
            <dt>Prepared KEKBULL</dt>
            <dd>
              {prepared.kekbullAmount.toString(10)} base units (
              {formatBaseUnits(prepared.kekbullAmount, prepared.kekbullDecimals)} UI @ decimals{" "}
              {String(prepared.kekbullDecimals)})
            </dd>
            <dt>Signed min ICHOR (live Config output)</dt>
            <dd>
              {prepared.minIchorAmount.toString(10)} base units (
              {formatBaseUnits(prepared.minIchorAmount, prepared.ichorDecimals)} UI @ decimals{" "}
              {String(prepared.ichorDecimals)})
            </dd>
            <dt>Expected ICHOR at observed ratio</dt>
            <dd>
              {prepared.expectedIchorAmount
                ? `${prepared.expectedIchorAmount.toString(10)} base units (${formatBaseUnits(prepared.expectedIchorAmount, prepared.ichorDecimals)} UI)`
                : "preview the burn to see the exact amount"}
            </dd>
            <dt>Fee beneficiaries bound</dt>
            <dd>{String(feesBound)}</dd>
          </dl>
        ) : null}
        <p className="muted">
          Protocol initialization is intentionally absent from this page: that is
          upgrade-authority deployment work, not a public holder action.
        </p>
      </details>
    </section>
  );
}
