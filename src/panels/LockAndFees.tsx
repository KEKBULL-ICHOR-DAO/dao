import {
  buildClaimPositionFeeToTreasury,
  buildHandoffPositionRightsToTreasury,
  requirePublicKey,
  verifyPositionRightsHandoff,
  type CanonicalPumpSwapReserves,
  type LockedDammPoolTokens,
  type PermanentLockVerification,
} from "@kekbull/ichor-client";
import { irreversibleDaoActionsEnabled } from "./Preflight.tsx";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import {
  readLockedDammReserves,
  readSourceAmmReserves,
  readToken2022MintDisplayName,
  type MintDisplayName,
} from "../chain.ts";
import type { DeploymentConfig } from "../config.ts";
import { formatBaseUnits, formatError, groupUiAmount, parsePositiveDecimalIntegerString } from "../format.ts";
import { useThrottledLiveRefresh } from "../live-refresh.ts";
import type { StagedGovernanceAction, UnsignedPayload } from "../send.ts";
import type { PreflightState } from "./Preflight.tsx";

function lpFeeSharePercent(protocolFeePercent: number): number {
  return 100 - protocolFeePercent;
}

function lpFeeShareSentence(protocolFeePercent: number): string {
  return `The DAO's position receives 100% of the LP fee share (${String(lpFeeSharePercent(protocolFeePercent))}% of trading fees). Meteora keeps a ${String(protocolFeePercent)}% protocol fee.`;
}

export function LockAndFees(props: {
  config: DeploymentConfig;
  preflight: PreflightState;
  onRequestSend: (payload: UnsignedPayload) => void;
  onStageAction: (payload: StagedGovernanceAction) => void;
  operatorView?: boolean;
  onLockVerified?: (verified: boolean | null) => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const operatorView = props.operatorView ?? true;
  const [expected, setExpected] = useState(props.config.expectedLockedLiquidityBaseUnits ?? "");
  const [proof, setProof] = useState<PermanentLockVerification | null>(null);
  const [damm, setDamm] = useState<LockedDammPoolTokens | null>(null);
  const [sourceAmm, setSourceAmm] = useState<CanonicalPumpSwapReserves | null>(null);
  const [sourceAmmName, setSourceAmmName] = useState<MintDisplayName | null>(null);
  const [sourceAmmError, setSourceAmmError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState<
    Awaited<ReturnType<typeof verifyPositionRightsHandoff>> | null
  >(null);
  const [pendingClaimInsert1, setPendingClaimInsert1] = useState<StagedGovernanceAction | null>(
    null,
  );
  const passed = props.preflight.status === "passed" ? props.preflight : null;
  const destinationReady = irreversibleDaoActionsEnabled({
    committed: passed?.committedDaoDestination ?? null,
    identityMatches: passed?.daoDestinationMatches === true,
  });
  const expectedUnits = (expected.trim() || props.config.expectedLockedLiquidityBaseUnits || "").trim();
  const lockPublished =
    Boolean(props.config.meteoraPosition) &&
    Boolean(props.config.meteoraPositionNftMint) &&
    expectedUnits.length > 0;

  useEffect(() => {
    const published = props.config.expectedLockedLiquidityBaseUnits ?? "";
    setExpected(published);
  }, [props.config.expectedLockedLiquidityBaseUnits]);

  const readLock = useCallback(async (): Promise<void> => {
    setError(null);
    setProof(null);
    setDamm(null);
    setSourceAmm(null);
    setSourceAmmName(null);
    setSourceAmmError(null);
    props.onLockVerified?.(null);
    if (!passed) {
      setError("preflight has not passed");
      return;
    }
    if (!props.config.meteoraPosition || !props.config.meteoraPositionNftMint) {
      setError(
        operatorView
          ? "meteoraPosition and meteoraPositionNftMint must be configured before the lock can be read"
          : "This page has no published lock position yet.",
      );
      props.onLockVerified?.(null);
      return;
    }
    if (!passed.verifiedGovernanceIdentity) {
      setError(
        passed.governanceReason ??
          "VerifiedGovernanceIdentity is required before the lock can be read; the treasury ATA cannot be derived without it.",
      );
      props.onLockVerified?.(null);
      return;
    }
    let expectedBn;
    try {
      expectedBn = parsePositiveDecimalIntegerString(
        expectedUnits,
        "expectedLockedLiquidityBaseUnits",
      );
    } catch (err) {
      setError(
        `${formatError(err)}. This must be the measured bootstrap liquidityDelta, not an estimate.`,
      );
      return;
    }
    const ichorMint = passed.verifiedIchorConfig?.config.ichorMint.toBase58() ?? null;
    if (!ichorMint) {
      setError("verified ICHOR mint is required before pool vaults can be read");
      return;
    }
    setBusy(true);
    try {
      const reserves = await readLockedDammReserves({
        connection,
        verified: passed.verified,
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        position: props.config.meteoraPosition,
        positionNftMint: props.config.meteoraPositionNftMint,
        expectedLockedLiquidityBaseUnits: expectedBn.toString(10),
        ichorMint,
      });
      setDamm(reserves);
      setProof(reserves.lock);
      props.onLockVerified?.(reserves.lock.isFullyPermanentlyLocked === true);
      if (passed.verifiedIchorConfig) {
        try {
          const source = await readSourceAmmReserves({
            connection,
            verifiedConfig: passed.verifiedIchorConfig,
          });
          setSourceAmm(source);
          if (source) {
            setSourceAmmName(
              await readToken2022MintDisplayName({
                connection,
                verified: passed.verified,
                mint: source.baseMint.mint,
              }),
            );
          }
        } catch (err) {
          setSourceAmmError(formatError(err));
        }
      }
    } catch (err) {
      setError(formatError(err));
      props.onLockVerified?.(null);
    } finally {
      setBusy(false);
    }
  }, [
    connection,
    expectedUnits,
    operatorView,
    passed,
    props.config.meteoraPosition,
    props.config.meteoraPositionNftMint,
    props.onLockVerified,
  ]);

  useThrottledLiveRefresh(
    !operatorView && Boolean(passed) && lockPublished,
    readLock,
  );

  function requireHandoffInputs() {
    if (!passed?.verifiedGovernanceIdentity || !destinationReady || !passed.verifiedIchorConfig) {
      throw new Error(
        passed?.governanceReason ??
          "committed DAO destination must match the issued Governance identity before position-rights handoff",
      );
    }
    if (!wallet.publicKey) {
      throw new Error("connect the current position owner wallet");
    }
    if (
      !props.config.meteoraPool ||
      !props.config.meteoraPosition ||
      !props.config.meteoraPositionNftMint
    ) {
      throw new Error("Meteora pool, position, and position NFT mint must be configured");
    }
    return {
      verifiedConfig: passed.verifiedIchorConfig,
      verifiedGovernance: passed.verifiedGovernanceIdentity,
      owner: wallet.publicKey,
      pool: requirePublicKey(props.config.meteoraPool, "meteoraPool"),
      position: requirePublicKey(props.config.meteoraPosition, "meteoraPosition"),
      positionNftMint: requirePublicKey(
        props.config.meteoraPositionNftMint,
        "meteoraPositionNftMint",
      ),
    };
  }

  async function buildHandoff(): Promise<void> {
    setError(null);
    setHandoff(null);
    try {
      if (!proof?.isFullyPermanentlyLocked) {
        throw new Error(
          "read and pass the permanent-lock proof before transferring position fee rights",
        );
      }
      const inputs = requireHandoffInputs();
      const built = await buildHandoffPositionRightsToTreasury({
        connection,
        verifiedConfig: inputs.verifiedConfig,
        verifiedGovernance: inputs.verifiedGovernance,
        positionNftMint: inputs.positionNftMint,
        position: inputs.position,
        pool: inputs.pool,
        currentOwner: inputs.owner,
        payer: inputs.owner,
      });
      props.onRequestSend({
        label: "handoff permanently locked Meteora position rights to Realms",
        instructions: built.unsigned.instructions,
        derivedAddresses: {
          treasury: built.treasury,
          sourcePositionNftAccount: built.sourcePositionNftAccount,
          treasuryPositionNftAta: built.treasuryAta,
          positionNftMint: built.positionNftMint,
        },
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  function requireClaimInputs() {
    if (!passed?.verifiedGovernanceIdentity) {
      throw new Error(
        passed?.governanceReason ??
          "VerifiedGovernanceIdentity is required; community activation is not required",
      );
    }
    if (!handoff?.handedOff) {
      throw new Error(
        "verified position-rights handoff is required before staging a treasury fee claim",
      );
    }
    if (
      !props.config.meteoraPool ||
      !props.config.meteoraPosition ||
      !props.config.meteoraPositionNftMint
    ) {
      throw new Error("Meteora pool, position, and position NFT mint must be configured");
    }
    return {
      verifiedGovernance: passed.verifiedGovernanceIdentity,
      pool: requirePublicKey(props.config.meteoraPool, "meteoraPool"),
      position: requirePublicKey(props.config.meteoraPosition, "meteoraPosition"),
      positionNftMint: requirePublicKey(
        props.config.meteoraPositionNftMint,
        "meteoraPositionNftMint",
      ),
      treasuryAta: handoff.treasuryAta,
    };
  }

  async function stageFeeClaim(): Promise<void> {
    setError(null);
    setPendingClaimInsert1(null);
    try {
      const inputs = requireClaimInputs();
      const built = await buildClaimPositionFeeToTreasury({
        connection,
        verifiedGovernance: inputs.verifiedGovernance,
        pool: inputs.pool,
        position: inputs.position,
        positionNftMint: inputs.positionNftMint,
      });
      const insert0 = built.insert0.instructions.slice();
      const insert1 = built.insert1.instructions.slice();
      if (insert0.length === 0 || insert1.length === 0) {
        throw new Error("fee-claim builder returned empty insert0 or insert1");
      }
      if (!built.positionNftAccount.equals(inputs.treasuryAta)) {
        throw new Error("fee-claim treasury ATA does not match the verified handoff ATA");
      }
      const derivedAddresses = {
        treasury: built.receiver,
        owner: built.owner,
        pool: built.pool,
        position: inputs.position,
        positionNftMint: inputs.positionNftMint,
        positionNftAccount: built.positionNftAccount,
      };
      props.onStageAction({
        label: "Meteora fee claim insert 0: ATA creates (treasury payer)",
        instructions: insert0,
        derivedAddresses,
      });
      setPendingClaimInsert1({
        label: "Meteora fee claim insert 1: claim + unwrap",
        instructions: insert1,
        derivedAddresses,
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  function stageFeeClaimInsert1(): void {
    setError(null);
    if (pendingClaimInsert1 === null) {
      setError("stage insert 0 first; insert 1 is claim + unwrap on the same proposal");
      return;
    }
    props.onStageAction(pendingClaimInsert1);
    setPendingClaimInsert1(null);
  }

  async function verifyHandoff(): Promise<void> {
    setError(null);
    setHandoff(null);
    setBusy(true);
    try {
      const inputs = requireHandoffInputs();
      setHandoff(
        await verifyPositionRightsHandoff({
          connection,
          verifiedConfig: inputs.verifiedConfig,
          verifiedGovernance: inputs.verifiedGovernance,
          positionNftMint: inputs.positionNftMint,
          position: inputs.position,
          pool: inputs.pool,
          previousOwner: inputs.owner,
        }),
      );
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  const locked = proof?.isFullyPermanentlyLocked === true;

  return (
    <section className="panel ichor">
      <div className="panel-head">
        <div>
          <h2>Locked liquidity</h2>
          {/* A first-time reader arriving at the word "locked" assumes it is
              their money. It is not, and saying so is worth more than the
              figure underneath it. */}
          <p className="muted">
            <strong>This is the Meteora DAMM pool liquidity, not your tokens and not your deposit.</strong>{" "}
            ICHOR and SOL in that pool are locked forever by the exchange. Nobody can withdraw the
            principal, including us, and no vote can release it. Your own ICHOR stays yours and you
            can sell it whenever you want. Spendable treasury is a separate pot, not these pool vaults.
          </p>
          <p className="muted">
            <strong>
              {damm
                ? lpFeeShareSentence(damm.protocolFeePercent)
                : "The DAO's position receives 100% of the LP fee share; Meteora keeps a protocol fee."}
            </strong>{" "}
            They accrue as SOL on this ICHOR/SOL position. A passed proposal claims them; Collect
            fees do not touch this pot. Pump creator-fee sharing is a separate vault;
            the live split is on Collect's sibling and is not invented here.
          </p>
        </div>
        <div className="panel-actions">
          <span className={`pill ${locked ? "ok" : "dead"}`}>
            {locked
              ? "PERMANENT LOCK VERIFIED"
              : busy && !operatorView
                ? "READING LOCK"
                : "NOT VERIFIED YET"}
          </span>
          {!operatorView ? (
            <button
              type="button"
              className="secondary"
              onClick={() => void readLock()}
              disabled={!passed || busy || !lockPublished}
            >
              {busy ? "Reading position" : "Refresh lock"}
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="gate-fail">
          <pre>{error}</pre>
        </div>
      ) : null}

      {proof && damm ? (
        <>
          <h3>Meteora DAMM ICHOR / SOL</h3>
          <div className="stats">
            <div className="stat ichor">
              <div className="k">
                <img src="/ichor-mark.png" alt="" width={18} height={18} />
                <span>ICHOR in the pool</span>
              </div>
              <div className="v">{groupUiAmount(formatBaseUnits(damm.ichorAmount, damm.ichorDecimals))}</div>
              <div className="n">
                {damm.positionOwnsFullPool
                  ? "vault balance; this locked position is the whole pool"
                  : "vault balance read from the DAMM token A account"}
              </div>
            </div>
            <div className="stat">
              <div className="k">
                <span>SOL in the pool</span>
              </div>
              <div className="v">{groupUiAmount(formatBaseUnits(damm.solAmount, damm.solDecimals))}</div>
              <div className="n">vault balance; wSOL in the DAMM token B account</div>
            </div>
            <div className="stat">
              <div className="k">
                <span>Principal locked</span>
              </div>
              <div className="v" style={{ color: locked ? "var(--green)" : "var(--danger)" }}>
                {locked ? "yes" : "no"}
              </div>
              <div className="n">
                {proof.unlockedLiquidity.isZero()
                  ? "unlocked liquidity is 0"
                  : `${proof.unlockedLiquidity.toString(10)} liquidity units still unlocked`}
              </div>
            </div>
          </div>
          <div className="stat damm-fees">
            <div className="k">
              <span>DAMM trading fees</span>
            </div>
            <div className="v">
              {damm.treasuryHoldsPositionNft
                ? `${String(lpFeeSharePercent(damm.protocolFeePercent))}% to the DAO position`
                : "unread"}
            </div>
            <div className="n">
              {lpFeeShareSentence(damm.protocolFeePercent)} Claimed SOL unwraps to the Realms
              native treasury. Not Collect. Pump creator-fee sharing is a separate vault; the
              holder Distribute button reads that SharingConfig live, transfers AMM wSOL when
              that hop is needed, and does not invent the split.
            </div>
          </div>
          <h3>Source AMM (PumpSwap)</h3>
          {sourceAmm ? (
            <>
              <p className="muted">
                The graduated {sourceAmmName?.symbol ?? "source"} / SOL market. Those tokens sit in
                PumpSwap vaults locked by pump.fun&apos;s migrate. The DAO does not hold that LP
                NFT. Those trading fees follow the coin-creator / fee-sharing path. They are not
                DAMM fees.{" "}
                {damm.treasuryHoldsPositionNft
                  ? lpFeeShareSentence(damm.protocolFeePercent)
                  : "The DAO's position receives 100% of the LP fee share; Meteora keeps a protocol fee."}
              </p>
              <div className="stats">
                <div className="stat kek">
                  <div className="k">
                    <span>{sourceAmmName?.symbol ?? "Source"} in the pool</span>
                  </div>
                  <div className="v">
                    {groupUiAmount(
                      formatBaseUnits(sourceAmm.pool.baseVaultAmount, sourceAmm.baseMint.decimals),
                    )}
                  </div>
                  <div className="n">
                    {sourceAmmName
                      ? `${sourceAmmName.name} · ${sourceAmm.pool.address.toBase58()}`
                      : sourceAmm.pool.address.toBase58()}
                  </div>
                </div>
                <div className="stat">
                  <div className="k">
                    <span>SOL in the pool</span>
                  </div>
                  <div className="v">
                    {groupUiAmount(
                      formatBaseUnits(sourceAmm.pool.quoteVaultAmount, sourceAmm.quoteMint.decimals),
                    )}
                  </div>
                  <div className="n">quote vault; wSOL</div>
                </div>
              </div>
            </>
          ) : (
            <p className="muted">
              {sourceAmmError
                ? sourceAmmError
                : "Canonical PumpSwap pool is not on this cluster yet. On mainnet that is the KEKBULL / SOL market after graduation."}
            </p>
          )}
        </>
      ) : operatorView ? (
        <p className="muted">
          The lock has not been read from chain yet. Nothing is claimed about it until it has been.
        </p>
      ) : !lockPublished ? (
        <div className="empty">
          <h3>Lock figures appear after the pool is published</h3>
          <p className="muted">
            The Meteora DAMM ICHOR/SOL vaults are unread until the published position is read.
            This page will not invent a number for them.
          </p>
        </div>
      ) : (
        <p className="muted">
          {busy
            ? "Reading the permanently locked position from chain."
            : "The lock has not been read from chain yet."}
        </p>
      )}

      {operatorView ? (
        <>
          <div className="row read-lock">
            <label>
              Expected locked liquidity (base units from bootstrap liquidityDelta)
              <input value={expected} onChange={(event) => setExpected(event.target.value)} />
            </label>
            <button type="button" className="secondary" onClick={() => void readLock()} disabled={!passed || busy}>
              {busy ? "Reading position" : "Read lock from position"}
            </button>
          </div>
          {!props.config.meteoraPosition ? (
            <p className="muted">Position address not configured.</p>
          ) : null}
        </>
      ) : null}

      <details className="raw">
        <summary>Exact lock proof read from chain</summary>
        {proof ? (
          <dl className="dl">
            <dt>Position</dt>
            <dd>{proof.position.toBase58()}</dd>
            <dt>Pool</dt>
            <dd>{proof.pool.toBase58()}</dd>
            <dt>Liquidity</dt>
            <dd>{proof.liquidity.toString(10)}</dd>
            <dt>Unlocked</dt>
            <dd>{proof.unlockedLiquidity.toString(10)}</dd>
            <dt>Vested</dt>
            <dd>{proof.vestedLiquidity.toString(10)}</dd>
            <dt>Permanent locked</dt>
            <dd>{proof.permanentLockedLiquidity.toString(10)}</dd>
            <dt>Expected</dt>
            <dd>{proof.expectedLiquidity.toString(10)}</dd>
            <dt>Fully permanently locked</dt>
            <dd>{String(proof.isFullyPermanentlyLocked)}</dd>
            {damm ? (
              <>
                <dt>ICHOR vault</dt>
                <dd>
                  {damm.ichorVault.toBase58()} · {damm.ichorAmount.toString(10)} raw
                </dd>
                <dt>SOL vault</dt>
                <dd>
                  {damm.solVault.toBase58()} · {damm.solAmount.toString(10)} raw
                </dd>
                <dt>Position owns full pool</dt>
                <dd>{String(damm.positionOwnsFullPool)}</dd>
                <dt>Protocol fee percent</dt>
                <dd>{String(damm.protocolFeePercent)}</dd>
                <dt>LP fee share percent</dt>
                <dd>{String(lpFeeSharePercent(damm.protocolFeePercent))}</dd>
                <dt>Position NFT mint</dt>
                <dd>{damm.positionNftMint.toBase58()}</dd>
                <dt>Treasury position NFT ATA</dt>
                <dd>{damm.treasuryPositionNftAta.toBase58()}</dd>
                <dt>Treasury holds position NFT</dt>
                <dd>{String(damm.treasuryHoldsPositionNft)}</dd>
              </>
            ) : null}
            {sourceAmm ? (
              <>
                <dt>PumpSwap pool</dt>
                <dd>{sourceAmm.pool.address.toBase58()}</dd>
                <dt>PumpSwap base vault</dt>
                <dd>
                  {sourceAmm.pool.baseVault.toBase58()} · {sourceAmm.pool.baseVaultAmount.toString(10)}{" "}
                  raw
                </dd>
                <dt>PumpSwap quote vault</dt>
                <dd>
                  {sourceAmm.pool.quoteVault.toBase58()} · {sourceAmm.pool.quoteVaultAmount.toString(10)}{" "}
                  raw
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="muted">No lock proof until the position is read from chain.</p>
        )}
        {handoff ? (
          <dl className="dl">
            <dt>Realms treasury</dt>
            <dd>{handoff.treasury.toBase58()}</dd>
            <dt>Treasury position NFT ATA</dt>
            <dd>{handoff.treasuryAta.toBase58()}</dd>
            <dt>Meteora source token account</dt>
            <dd>{handoff.sourcePositionNftAccount.toBase58()}</dd>
            <dt>Treasury NFT amount</dt>
            <dd>{handoff.treasuryAmount.toString(10)}</dd>
            <dt>Former source amount</dt>
            <dd>{handoff.sourceAmount.toString(10)}</dd>
            <dt>Fee rights handed off</dt>
            <dd>{String(handoff.handedOff)}</dd>
          </dl>
        ) : null}
      </details>

      {/* Operator actions. These are one-way custody transfers and proposal
          staging, not holder actions, so they sit behind a fold rather than
          next to the figures a holder came to read. */}
      {operatorView ? (
        <details className="operator">
          <summary>Operator actions: position rights and fee claim</summary>
          <h3>Transfer position fee rights to Realms</h3>
          <p>
            After the permanent lock passes, transfer the Token-2022 position NFT from Meteora&apos;s
            canonical <code>position_nft_account</code> PDA to the ATA owned by the verified Realms
            native treasury. This transfers fee control; it cannot unlock the permanent principal.
            Governance identity is sufficient during council bootstrap. Community voting does not need
            to be active yet.
          </p>
          {!destinationReady ? (
            <div className="blocked">
              <p>
                Position-rights handoff requires a committed DAO destination that matches the issued
                Governance identity.
              </p>
              <pre>{passed?.governanceReason ?? "Run preflight after commit_dao_destination lands."}</pre>
            </div>
          ) : null}
          {!props.config.meteoraPositionNftMint ? (
            <p className="muted">Position NFT mint not configured.</p>
          ) : null}
          <div className="row">
            <button
              type="button"
              onClick={() => void buildHandoff()}
              disabled={!proof?.isFullyPermanentlyLocked || !destinationReady || !wallet.publicKey}
            >
              Build position-rights handoff
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void verifyHandoff()}
              disabled={!destinationReady || !wallet.publicKey || busy}
            >
              {busy ? "Reading custody" : "Verify treasury owns fee rights"}
            </button>
          </div>

          <h3>Stage DAMM fee claim</h3>
          <p>
            {damm
              ? lpFeeShareSentence(damm.protocolFeePercent)
              : "The DAO's position receives 100% of the LP fee share; Meteora keeps a protocol fee."}{" "}
            After VerifiedGovernanceIdentity and a verified position-rights handoff, stage two
            ProposalTransactions on one proposal: insert 0 is the treasury-paid ATA creates; insert 1
            is treasury-owned <code>claimPositionFee2</code> + unwrap. One 4-ix insert overflows
            (1573 &gt; 1232). The Realms native treasury must sign via execute. This panel does not
            queue a fee claim for direct wallet send. This is not a holder Create-proposal template
            like Pay SOL or Pay ICHOR.
          </p>
          <div className="row">
            <button
              type="button"
              onClick={() => void stageFeeClaim()}
              disabled={!destinationReady || !handoff?.handedOff || busy}
            >
              Stage Meteora fee claim insert 0
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => stageFeeClaimInsert1()}
              disabled={!destinationReady || pendingClaimInsert1 === null || busy}
            >
              Stage Meteora fee claim insert 1
            </button>
          </div>

          <h3>25 / 75 Pump creator-fee policy (not DAMM)</h3>
          <p>
            After the Realms treasury exists, Pump curve and PumpSwap creator fees are intended to
            finalize at <strong>75% Realms DAO treasury / 25% token dev</strong>. Create and update
            stay on the SolCreatorHub console. This page only distributes whatever SharingConfig
            is already on chain. It is not the DAMM path.{" "}
            {damm
              ? lpFeeShareSentence(damm.protocolFeePercent)
              : "The DAO's position receives 100% of the LP fee share; Meteora keeps a protocol fee."}{" "}
            Cashback stays off so creator fees continue to accrue. The live shareholder list must be
            simulated and read back from chain before that transaction, from the SolCreatorHub
            console, not from invented numbers here.
          </p>
          <p className="muted">
            This paragraph is policy text. It is not a live read of the Pump fee-sharing config. This
            SPA does not fetch or display fabricated share amounts.
          </p>
          {props.config.meteoraPool ? (
            <p className="mono">Configured pool (identity only): {props.config.meteoraPool}</p>
          ) : (
            <p className="muted">Pool address not configured.</p>
          )}
        </details>
      ) : null}
    </section>
  );
}
