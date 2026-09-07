import { measureCanonicalHarvestSources, splitHarvestedFees } from "@kekbull/ichor-client";
import { useConnection } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { useCallback, useState } from "react";
import { readBurnLiveState, readTreasuryLiveState, type BurnLiveState, type TreasuryLiveState } from "../chain.ts";
import { formatBaseUnits, formatError } from "../format.ts";
import { useThrottledLiveRefresh } from "../live-refresh.ts";
import type { PreflightState } from "./Preflight.tsx";

/**
 * What the DAO owns, grouped by whether it can be spent.
 *
 * Deliberately NOT a single "treasury value" chart. The treasury holds SOL,
 * KEKBULL and ICHOR - three units with no shared denominator on this page. A
 * combined figure would need prices we do not read, and this page will not
 * present an estimate as a measurement. Each asset is therefore shown in its
 * own unit, and the only charts drawn are part-to-whole within a single mint.
 *
 * Colour is emphasis, not categorical: the treasury's share carries the gold
 * accent in both bars, everything else is de-emphasis grey separated by
 * lightness. Gold against the brand green failed CVD separation as adjacent
 * segments (protan ΔE ~5); grey-by-lightness survives every CVD type. Validated
 * with the dataviz palette script against surface #0c110c -
 * #3c423a / #767c6e / #c6a04d, protan ΔE 15.4, normal 17.5. The darkest segment
 * sits under 3:1 on its own, which is why every segment carries a visible label.
 */

const SEG_REST = "#3c423a";
const SEG_MID = "#767c6e";
const SEG_TREASURY = "#c6a04d";

interface Seg {
  readonly key: string;
  readonly label: string;
  readonly amount: BN;
  readonly color?: string;
  /** Burned supply is absence, not a holding. Hatched, struck through, no hue. */
  readonly gone?: boolean;
}

function pct(part: BN, whole: BN): number {
  if (whole.isZero()) return 0;
  return Number(part.muln(10000).div(whole).toString(10)) / 100;
}

/** Part-to-whole within one mint. Never across mints - the units differ. */
function SupplyBar(props: {
  title: string;
  total: BN;
  decimals: number;
  unit: string;
  segments: readonly Seg[];
}) {
  const shown = props.segments.filter((s) => !s.amount.isZero());
  return (
    <figure className="supply-bar">
      <figcaption>
        <span className="k">{props.title}</span>
        <span>
          <b>{formatBaseUnits(props.total, props.decimals)}</b> {props.unit}
        </span>
      </figcaption>
      <div
        className="track"
        role="img"
        aria-label={shown
          .map((s) => `${s.label} ${pct(s.amount, props.total).toFixed(1)}%`)
          .join(", ")}
      >
        {shown.map((s) => (
          <span
            key={s.key}
            className={s.gone ? "seg gone" : "seg"}
            style={{
              width: `${pct(s.amount, props.total)}%`,
              ...(s.gone ? {} : { background: s.color }),
            }}
          />
        ))}
      </div>
      <ul className="seg-key">
        {shown.map((s) => (
          <li key={s.key} className={s.gone ? "gone" : undefined}>
            <i className={s.gone ? "gone" : undefined} style={s.gone ? undefined : { background: s.color }} aria-hidden="true" />
            <span className="lbl">{s.label}</span>
            <span className="mono val">{formatBaseUnits(s.amount, props.decimals)}</span>
            <span className="mono pc">{pct(s.amount, props.total).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function Row(props: {
  label: string;
  value: string | null;
  unit?: string;
  note?: string;
  mark?: "kek" | "ichor";
  word?: boolean;
}) {
  return (
    <li>
      <span className="lbl">
        {props.mark ? (
          <img
            src={props.mark === "kek" ? "/logo.png" : "/ichor-mark.png"}
            className={props.mark === "kek" ? "kek" : undefined}
            alt=""
            width={15}
            height={15}
          />
        ) : null}
        {props.label}
      </span>
      <span className={props.word ? "val locked-word" : "val"}>
        {props.value === null ? <span className="pending">not read yet</span> : props.value}
        {props.value !== null && props.unit ? <span className="u"> {props.unit}</span> : null}
      </span>
      {props.note ? <span className="note">{props.note}</span> : null}
    </li>
  );
}

export function TreasuryAssets(props: {
  preflight: PreflightState;
  lockVerified?: boolean | null;
}) {
  const { connection } = useConnection();
  const [treasury, setTreasury] = useState<TreasuryLiveState | null>(null);
  const [burn, setBurn] = useState<BurnLiveState | null>(null);
  const [harvestWithheld, setHarvestWithheld] = useState<BN | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const passed = props.preflight.status === "passed" ? props.preflight : null;
  const config = passed?.verifiedIchorConfig?.config ?? null;
  const nativeTreasury = passed?.verifiedNativeTreasury?.toBase58() ?? null;

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    if (!passed || !config || !nativeTreasury) return;
    setBusy(true);
    try {
      const kekbullMint = config.kekbullMint.toBase58();
      const ichorMint = config.ichorMint.toBase58();
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
      setBurn(
        await readBurnLiveState({
          connection,
          verified: passed.verified,
          owner: null,
          kekbullMint,
          ichorMint,
          treasury: nativeTreasury,
        }),
      );
      if (passed.verifiedIchorConfig) {
        const measured = await measureCanonicalHarvestSources({
          connection,
          verifiedConfig: passed.verifiedIchorConfig,
        });
        setHarvestWithheld(measured.totalWithheld);
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [connection, passed, config, nativeTreasury]);

  useThrottledLiveRefresh(Boolean(passed), refresh);

  const kekMint = burn?.kekbullMint ?? null;
  const ichorMint = burn?.ichorMint ?? null;
  const amt = (r: { present: boolean; amount: BN | null } | null): BN =>
    r?.present && r.amount ? r.amount : new BN(0);

  const treasuryKek = amt(treasury?.kekbull ?? null);
  const treasuryIchor = amt(treasury?.ichor ?? null);
  const votingIchor = amt(treasury?.realmDeposit ?? null);

  /* Burned KEKBULL left the mint supply, so the original is supply + burned.
     Both are read; neither is the hardcoded 1,000,000,000. */
  const kekBurned = config?.totalKekbullBurned ?? new BN(0);
  const kekOriginal = kekMint ? kekMint.supply.add(kekBurned) : null;
  const kekHolders =
    kekMint && kekOriginal ? kekOriginal.sub(kekBurned).sub(treasuryKek) : null;

  const ichorSupply = ichorMint?.supply ?? null;
  const ichorHolders = ichorSupply ? ichorSupply.sub(treasuryIchor).sub(votingIchor) : null;

  const fmt = (v: BN | null, d: number | null | undefined): string | null =>
    v && d !== null && d !== undefined ? formatBaseUnits(v, d) : null;

  const pendingTreasury =
    harvestWithheld !== null && !harvestWithheld.isZero()
      ? splitHarvestedFees(harvestWithheld).realmsAmount
      : null;
  const withheldDecimals = ichorMint?.decimals ?? treasury?.ichor?.mintDecimals ?? null;
  const treasuryIchorNote =
    pendingTreasury !== null && withheldDecimals !== null && harvestWithheld !== null
      ? `Spendable only by a passed vote. A further ${formatBaseUnits(pendingTreasury, withheldDecimals)} ICHOR is owed to the treasury and not collected yet: its 75% share of the ${formatBaseUnits(harvestWithheld, withheldDecimals)} held back in fees so far. It is not counted above until someone collects it, and anyone can.`
      : "Spendable only by a passed vote. No fees are waiting to be collected.";

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>What the DAO owns</h2>
          <p className="muted">
            On-chain mint totals first, then what the treasury can spend. Three tokens,
            each in its own units. There is no combined figure because that would need
            prices this page does not read.
          </p>
        </div>
        <div className="panel-actions">
          <button type="button" className="secondary" onClick={() => void refresh()} disabled={!passed || busy}>
            {busy ? "Reading" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="gate-fail">
          <pre>{error}</pre>
        </div>
      ) : null}

      <p className="k">On-chain totals</p>
      {kekMint && kekOriginal && kekHolders && !kekOriginal.isZero() ? (
        <SupplyBar
          title="KEKBULL. Supply can only fall"
          total={kekOriginal}
          decimals={kekMint.decimals}
          unit="KEKBULL"
          segments={[
            { key: "burned", label: "Burned for ICHOR", amount: kekBurned, gone: true },
            { key: "holders", label: "Held by holders", amount: kekHolders, color: SEG_MID },
            { key: "treasury", label: "Treasury", amount: treasuryKek, color: SEG_TREASURY },
          ]}
        />
      ) : (
        <p className="muted">KEKBULL supply bar unread until mint and burn totals verify.</p>
      )}

      {ichorMint && ichorSupply && ichorHolders && !ichorSupply.isZero() ? (
        <SupplyBar
          title="ICHOR. All of it created by burning KEKBULL"
          total={ichorSupply}
          decimals={ichorMint.decimals}
          unit="ICHOR"
          segments={[
            { key: "held", label: "Held by holders", amount: ichorHolders, color: SEG_REST },
            { key: "voting", label: "Deposited to vote", amount: votingIchor, color: SEG_MID },
            { key: "treasury", label: "Treasury", amount: treasuryIchor, color: SEG_TREASURY },
          ]}
        />
      ) : (
        <p className="muted">ICHOR supply bar unread until mint and treasury verifies.</p>
      )}

      <p className="k">DAO treasury holdings</p>
      <div className="owns">
        <div className="owns-group">
          <h3>Spendable by a passed vote</h3>
          <ul>
            <Row
              label="Treasury SOL"
              value={treasury ? formatBaseUnits(treasury.solLamports, treasury.nativeMintDecimals) : null}
              unit="SOL"
            />
            <Row
              label="Treasury KEKBULL"
              mark="kek"
              value={treasury ? fmt(treasuryKek, kekMint?.decimals) : null}
              note="Bought on the public curve, not granted. This is what the treasury burns to create its own ICHOR."
            />
            <Row
              label="Treasury ICHOR"
              mark="ichor"
              value={treasury ? fmt(treasuryIchor, ichorMint?.decimals) : null}
              note={treasury ? treasuryIchorNote : undefined}
            />
          </ul>
        </div>

        <div className="owns-group locked">
          <h3>Held, and locked forever</h3>
          <ul>
            <Row
              label="Initial ICHOR/SOL liquidity"
              mark="ichor"
              word
              value={props.lockVerified === true ? "PERMANENT LOCK" : null}
              note={
                props.lockVerified === true
                  ? "The DAO holds the DAMM position NFT. The DAO's position receives 100% of the LP fee share; Meteora keeps a protocol fee. No vote can withdraw the principal, including ours. Figures are on the Liquidity section."
                  : "Unread until the lock and treasury NFT custody are verified from chain."
              }
            />
          </ul>
        </div>

        <div className="owns-group not-ours">
          <h3>Not the DAO&apos;s money</h3>
          <ul>
            <Row
              label="ICHOR deposited to vote"
              mark="ichor"
              value={treasury ? fmt(votingIchor, ichorMint?.decimals) : null}
              note="Everyone's voting weight. The DAO cannot spend it. Each holder takes their own back out."
            />
          </ul>
        </div>
      </div>
    </section>
  );
}
