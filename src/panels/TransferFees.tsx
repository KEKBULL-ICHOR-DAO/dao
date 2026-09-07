import {
  buildAcceptAuthority,
  buildClaimCreatorFees,
  buildCollectTransferFees,
  buildDistributeTransferFees,
  buildHarvestWithheldTokensToMint,
  buildSetCreatorBeneficiary,
  buildSetFeeDistribution,
  buildSweepUnclaimedCreatorFees,
  measureCanonicalHarvestSources,
  parseIchorTransferFeeConfig,
  previewDistributeTransferFees,
  requirePublicKey,
} from "@kekbull/ichor-client";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { useCallback, useState } from "react";
import { readIchorMint, readTreasuryLiveState } from "../chain.ts";
import {
  OPERATOR_CREATOR_FEE_BENEFICIARY,
  requireOperatorCreatorBeneficiary,
} from "../creator-beneficiary.ts";
import { formatBaseUnits, formatError, groupUiAmount } from "../format.ts";
import { useThrottledLiveRefresh } from "../live-refresh.ts";
import { harvestSourceLinesPresent, parseHarvestSourceLines } from "../harvest-sources.ts";
import type { StagedGovernanceAction, UnsignedPayload } from "../send.ts";
import { irreversibleDaoActionsEnabled, type PreflightState } from "./Preflight.tsx";

interface CollectableLive {
  readonly harvestable: BN;
  readonly atMint: BN;
  readonly ready: BN;
  readonly creator: BN;
  readonly realms: BN;
  readonly decimals: number;
  readonly sourceCount: number;
}

function groupedIchor(amount: BN, decimals: number): string {
  return `${groupUiAmount(formatBaseUnits(amount, decimals))} ICHOR`;
}

export function TransferFees(props: {
  preflight: PreflightState;
  onRequestSend: (payload: UnsignedPayload) => void;
  onStageAction: (payload: StagedGovernanceAction) => void;
  operatorView?: boolean;
  embedded?: boolean;
  lastConfirmedSignature?: string | null;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const operatorView = props.operatorView ?? true;
  const [creatorBeneficiary, setCreatorBeneficiary] = useState(OPERATOR_CREATOR_FEE_BENEFICIARY);
  const [newBeneficiary, setNewBeneficiary] = useState("");
  const [harvestSources, setHarvestSources] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collectable, setCollectable] = useState<CollectableLive | null>(null);
  const [collectableError, setCollectableError] = useState<string | null>(null);
  const [collectableBusy, setCollectableBusy] = useState(false);
  const passed = props.preflight.status === "passed" ? props.preflight : null;
  const destinationReady = irreversibleDaoActionsEnabled({
    committed: passed?.committedDaoDestination ?? null,
    identityMatches: passed?.daoDestinationMatches === true,
  });
  const collectBlocked =
    !passed?.verifiedIchorConfig
      ? "This page has not verified the published contract yet."
      : passed.verifiedIchorConfig.config.feeBeneficiariesBound !== true
        ? "Fee destinations are not bound yet."
        : !wallet.publicKey
          ? "Connect a wallet to collect."
          : null;

  const refreshCollectable = useCallback(async (): Promise<void> => {
    if (!passed?.verifiedIchorConfig) {
      setCollectable(null);
      setCollectableError(null);
      return;
    }
    setCollectableBusy(true);
    setCollectableError(null);
    try {
      const verifiedConfig = passed.verifiedIchorConfig;
      const extra = harvestSourceLinesPresent(harvestSources) ? parsedSources() : [];
      const [measured, mint, treasury] = await Promise.all([
        measureCanonicalHarvestSources({
          connection,
          verifiedConfig,
          extraSources: extra,
        }),
        readIchorMint({
          connection,
          verified: passed.verified,
          ichorMint: verifiedConfig.config.ichorMint.toBase58(),
        }),
        passed.verifiedNativeTreasury
          ? readTreasuryLiveState({
              connection,
              verified: passed.verified,
              treasury: passed.verifiedNativeTreasury.toBase58(),
              ichorMint: verifiedConfig.config.ichorMint.toBase58(),
              // This panel is about ICHOR fees. The treasury's KEKBULL balance
              // is read by the assets panel, not here.
              kekbullMint: null,
              verifiedRealm:
                passed.verifiedRealm ?? passed.verifiedGovernanceIdentity?.verifiedRealm ?? null,
            })
          : Promise.resolve(null),
      ]);
      const atMint = treasury?.mintWithheld ?? new BN(0);
      const ready = measured.totalWithheld.add(atMint);
      const mintInfo = await connection.getAccountInfo(mint.mint, "confirmed");
      if (mintInfo === null) {
        throw new Error(`ICHOR mint ${mint.mint.toBase58()} has no account`);
      }
      const feeConfig = parseIchorTransferFeeConfig(
        mintInfo.data instanceof Uint8Array ? mintInfo.data : new Uint8Array(mintInfo.data),
      );
      const epochInfo = await connection.getEpochInfo("confirmed");
      if (!Number.isSafeInteger(epochInfo.epoch) || epochInfo.epoch < 0) {
        throw new Error("confirmed epoch is not a safe non-negative integer");
      }
      const preview = previewDistributeTransferFees({
        vaultDistributed: ready,
        config: feeConfig,
        currentEpoch: new BN(epochInfo.epoch),
      });
      setCollectable({
        harvestable: measured.totalWithheld,
        atMint,
        ready,
        creator: preview.creatorSecondHop.expectedNet,
        realms: preview.realmsSecondHop.expectedNet,
        decimals: mint.decimals,
        sourceCount: measured.sources.length,
      });
    } catch (cause) {
      setCollectable(null);
      setCollectableError(formatError(cause));
    } finally {
      setCollectableBusy(false);
    }
  }, [connection, harvestSources, passed]);

  useThrottledLiveRefresh(
    Boolean(passed?.verifiedIchorConfig),
    refreshCollectable,
    props.lastConfirmedSignature,
  );

  function requireConfig() {
    if (!passed?.verifiedIchorConfig) {
      throw new Error("verified ICHOR Config is required; run passing preflight first");
    }
    return passed.verifiedIchorConfig;
  }

  function requireWallet() {
    if (!wallet.publicKey) {
      throw new Error("connect a wallet before building a fee transaction");
    }
    return wallet.publicKey;
  }

  function parsedSources() {
    return parseHarvestSourceLines(harvestSources).map((value, index) =>
      requirePublicKey(value, `harvest source ${index + 1}`),
    );
  }

  async function bindDistribution(): Promise<void> {
    setError(null);
    setPreview(null);
    try {
      parsedSources();
      const verifiedConfig = requireConfig();
      if (!passed?.verifiedGovernanceIdentity || !destinationReady) {
        throw new Error(
          "committed DAO destination must match the issued Governance identity before binding fee destinations",
        );
      }
      const walletAuthority = requireWallet();
      const liveAuthority = verifiedConfig.config.authority;
      const governance = passed.verifiedGovernanceIdentity.governance;
      const authority = liveAuthority.equals(governance) ? governance : walletAuthority;
      if (!liveAuthority.equals(authority)) {
        throw new Error(
          `CONFIG_AUTHORITY_MISMATCH: live config.authority ${liveAuthority.toBase58()} is neither the connected wallet nor Governance ${governance.toBase58()}`,
        );
      }
      const built = await buildSetFeeDistribution({
        connection,
        verifiedConfig,
        authority,
        verifiedGovernance: passed.verifiedGovernanceIdentity,
        creatorBeneficiary: requireOperatorCreatorBeneficiary(creatorBeneficiary),
      });
      const payload = {
        label: "permanently bind ICHOR fee beneficiaries: 25% creator / 75% Realms",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      };
      if (liveAuthority.equals(governance)) {
        props.onStageAction(payload);
        return;
      }
      props.onRequestSend(payload);
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  async function collect(): Promise<void> {
    setError(null);
    setPreview(null);
    try {
      const caller = requireWallet();
      const extra = harvestSourceLinesPresent(harvestSources) ? parsedSources() : [];
      const built = await buildCollectTransferFees({
        connection,
        verifiedConfig: requireConfig(),
        caller,
        extraSources: extra,
      });
      setPreview(
        [
          built.harvestedSources.length > 0
            ? `Harvesting ${built.harvestedSources.length} known account${built.harvestedSources.length === 1 ? "" : "s"} (${built.harvestedWithheld.toString(10)} withheld base units).`
            : "Mint already holds the withheld fees.",
          `25% to the token dev's wallet (expected net ${built.expectedCreatorNet.toString(10)}).`,
          `75% to the community treasury (expected net ${built.expectedRealmsNet.toString(10)}).`,
          "This does not pay the wallet that sends it.",
        ].join(" "),
      );
      props.onRequestSend({
        label: "collect ICHOR transfer fees: 25% token dev wallet / 75% treasury",
        instructions: built.unsigned.instructions,
        derivedAddresses: built.unsigned.derivedAddresses,
      });
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  async function harvest(): Promise<void> {
    setError(null);
    setPreview(null);
    try {
      requireWallet();
      const built = await buildHarvestWithheldTokensToMint({
        connection,
        verifiedConfig: requireConfig(),
        sources: parsedSources(),
      });
      setPreview(
        `Known sources: ${built.sources.length}; measured withheld total ${built.totalWithheld.toString(10)} base units.`,
      );
      props.onRequestSend({
        label: "harvest known ICHOR transfer fees to mint",
        instructions: built.unsigned.instructions,
        derivedAddresses: built.unsigned.derivedAddresses,
      });
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  async function distribute(): Promise<void> {
    setError(null);
    setPreview(null);
    try {
      const caller = requireWallet();
      const built = await buildDistributeTransferFees({
        connection,
        verifiedConfig: requireConfig(),
        caller,
      });
      setPreview(
        [
          `Vault gross ${built.expectedVaultDistributed.toString(10)} base units.`,
          `Creator wallet expected net ${built.expectedCreatorNet.toString(10)}.`,
          `Realms expected net ${built.expectedRealmsNet.toString(10)}.`,
          "The transaction idempotently creates the canonical fee-vault, creator, and Realms ATAs before distribution.",
        ].join(" "),
      );
      props.onRequestSend({
        label: "distribute harvested ICHOR fees: 25% creator escrow / 75% Realms",
        instructions: built.unsigned.instructions,
        derivedAddresses: built.unsigned.derivedAddresses,
      });
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  async function acceptPendingAuthority(): Promise<void> {
    setError(null);
    setPreview(null);
    try {
      const pendingAuthority = requireWallet();
      const verifiedConfig = requireConfig();
      const pending = verifiedConfig.config.pendingAuthority;
      if (pending === null || !pending.equals(pendingAuthority)) {
        throw new Error(
          pending === null
            ? "no pending Config authority to accept"
            : `connected wallet is not pending authority ${pending.toBase58()}`,
        );
      }
      const built = await buildAcceptAuthority({
        connection,
        verifiedConfig,
        pendingAuthority,
      });
      setPreview(`Accept Config authority as ${pendingAuthority.toBase58()}.`);
      props.onRequestSend({
        label: "accept ICHOR Config authority as the connected creator wallet",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  async function claim(): Promise<void> {
    setError(null);
    setPreview(null);
    try {
      const creatorBeneficiaryKey = requireWallet();
      const built = await buildClaimCreatorFees({
        connection,
        verifiedConfig: requireConfig(),
        creatorBeneficiary: creatorBeneficiaryKey,
      });
      setPreview(
        `Escrow amount ${built.escrowAmount.toString(10)} base units; expected net ${built.expectedNet.toString(10)}. Claim is a separate instruction from distribute.`,
      );
      props.onRequestSend({
        label: "claim ICHOR creator-escrow fees to beneficiary ATA",
        instructions: built.unsigned.instructions,
        derivedAddresses: built.unsigned.derivedAddresses,
      });
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  async function sweep(): Promise<void> {
    setError(null);
    setPreview(null);
    try {
      const caller = requireWallet();
      const built = await buildSweepUnclaimedCreatorFees({
        connection,
        verifiedConfig: requireConfig(),
        caller,
      });
      setPreview(
        `Escrow amount ${built.escrowAmount.toString(10)} base units; expected Realms net ${built.expectedNet.toString(10)}. Sweep is permissionless after creator decay.`,
      );
      props.onRequestSend({
        label: "sweep unclaimed ICHOR creator-escrow fees to Realms treasury",
        instructions: built.unsigned.instructions,
        derivedAddresses: built.unsigned.derivedAddresses,
      });
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  async function rotateBeneficiary(): Promise<void> {
    setError(null);
    setPreview(null);
    try {
      const built = await buildSetCreatorBeneficiary({
        connection,
        verifiedConfig: requireConfig(),
        creatorBeneficiary: requireWallet(),
        newBeneficiary: requirePublicKey(newBeneficiary, "new beneficiary"),
      });
      props.onRequestSend({
        label: "rotate ICHOR creator beneficiary (current beneficiary only)",
        instructions: built.instructions,
        derivedAddresses: built.derivedAddresses,
      });
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  const readyLabel = collectable
    ? groupedIchor(collectable.ready, collectable.decimals)
    : collectableBusy
      ? "reading chain"
      : "unread";
  const creatorLabel = collectable ? groupedIchor(collectable.creator, collectable.decimals) : "unread";
  const realmsLabel = collectable ? groupedIchor(collectable.realms, collectable.decimals) : "unread";

  const liveFigures = (
    <div className="fee-live">
      <div className="fee-live-head">
        {props.embedded ? (
          <div>
            <h3>Uncollected transfer fees</h3>
            <p className="muted">
              Anyone can send this. 25% token dev wallet, 75% community treasury. The sender is not
              paid.
            </p>
          </div>
        ) : (
          <h3>Live withheld, ready to collect</h3>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => void refreshCollectable()}
          disabled={!passed?.verifiedIchorConfig || collectableBusy}
        >
          {collectableBusy ? "Reading" : "Refresh fees"}
        </button>
      </div>
      {collectableError ? (
        <div className="gate-fail">
          <pre>{collectableError}</pre>
        </div>
      ) : null}
      <div className="stats">
        <div className="stat ichor">
          <div className="k">
            <img src="/ichor-mark.png" alt="" width={18} height={18} />
            <span>Ready to collect</span>
          </div>
          <div className="v">{readyLabel}</div>
          <div className="n">
            {collectable
              ? `${groupedIchor(collectable.harvestable, collectable.decimals)} withheld on ${String(collectable.sourceCount)} derived sink${collectable.sourceCount === 1 ? "" : "s"}; ${groupedIchor(collectable.atMint, collectable.decimals)} already at the mint. Collect also pushes any ICHOR already in the fee vault.`
              : "Measured from the exact accounts Collect draws from, not by scanning wallets."}
          </div>
        </div>
        <div className="stat ichor">
          <div className="k">
            <span>25% token dev</span>
          </div>
          <div className="v">{creatorLabel}</div>
          <div className="n">Pushed to the token dev's bound wallet in the same transaction.</div>
        </div>
        <div className="stat ichor">
          <div className="k">
            <span>75% treasury</span>
          </div>
          <div className="v">{realmsLabel}</div>
          <div className="n">Pushed to the Realms native treasury in the same transaction.</div>
        </div>
      </div>
    </div>
  );

  const collectControls = (
    <>
      {preview ? <p className="gate-pass">{preview}</p> : null}
      {error ? (
        <div className="gate-fail">
          <pre>{error}</pre>
        </div>
      ) : null}
      <button
        type="button"
        className="collect-action"
        disabled={collectBlocked !== null}
        onClick={() => void collect()}
      >
        Collect fees
      </button>
      <p className="field-note">
        {collectBlocked ??
          "Anyone can send this. 75% goes to the community treasury and 25% to the token dev's wallet. You are not paid. Simulate, then confirm. Phantom signs only after you confirm."}
      </p>
    </>
  );

  const body = (
    <>
      {props.embedded ? null : (
        <>
          <div className="panel-head">
            <div>
              <h2>The 0.25% ICHOR transfer fee</h2>
              <p className="muted">
                Charged at 0.25% every time ICHOR moves, including sending it to your own second
                wallet, and including depositing it to vote and taking it back out again. On $100 of
                ICHOR that is 25 cents.
              </p>
            </div>
          </div>
          <div className="split-bars">
            <div className="pair">
              <div className="bar">
                <i style={{ width: "25%" }} />
              </div>
              <span>
                <strong>25%</strong> to the token dev
              </span>
            </div>
            <div className="pair">
              <div className="bar alt">
                <i style={{ width: "75%" }} />
              </div>
              <span>
                <strong>75%</strong> to the community treasury
              </span>
            </div>
          </div>
        </>
      )}
      {liveFigures}
      {collectControls}
      {props.embedded ? (
        <p className="muted">
          The 0.25% fee is collected by the token program on every transfer. Collect harvests the
          derived sinks and pushes the split in one transaction. Deposits and withdrawals are not
          exempt.
        </p>
      ) : (
        <p className="muted">
          The 0.25% fee is collected by the token program on every transfer. Anyone can send the
          already-collected fees: 75% goes to the community treasury and 25% goes to the token dev
          wallet in the same transaction. The sender is not paid. Governance deposits and withdrawals
          are not exempt from the fee.
        </p>
      )}

      {/* Everything below moves other people's money or is irreversible. None
          of it is a holder action, so it does not sit in the reading flow. */}
      {operatorView ? (
        <details className="operator">
          <summary>Operator actions: bind, harvest, distribute, claim, sweep, rotate</summary>
          <p className="muted">
            Binding is one-way; harvest sources are required before bind. If Config authority is
            already Governance, bind stages as a proposal; otherwise the current authority wallet
            sends it in the recovery window. The holder button harvests derived sinks (vote vault,
            the token dev's ATA, leftover program escrow, treasury, fee vault) with no PDA paste. Extra
            known token-account addresses can be pasted below; this UI does not scan wallets or invent sources. Distribution pushes 25% to the token dev's wallet and 75% to Realms.
            Claim and sweep remain only for leftover program escrow from the previous pull path.
            Only the current creator beneficiary can rotate that wallet. After Build, a review
            dialog opens. Simulate, then Confirm. Phantom is asked only then.
          </p>

          <label>
            Creator beneficiary (official-devnet and mainnet)
            <input
              value={creatorBeneficiary}
              onChange={(event) => setCreatorBeneficiary(event.target.value.trim())}
              placeholder={OPERATOR_CREATOR_FEE_BENEFICIARY}
            />
          </label>
          <p className="field-note">
            25% of harvested ICHOR transfer fees. Pinned to {OPERATOR_CREATOR_FEE_BENEFICIARY}.
            Binding is one-way. The 75% Realms cut is the committed treasury PDA, not a wallet.
          </p>
          <label>
            New creator beneficiary (rotation)
            <input
              value={newBeneficiary}
              onChange={(event) => setNewBeneficiary(event.target.value.trim())}
              placeholder="new creator wallet pubkey"
            />
          </label>
          <label>
            Known ICHOR token accounts with withheld fees
            <textarea
              value={harvestSources}
              onChange={(event) => setHarvestSources(event.target.value)}
              placeholder="one token-account pubkey per line"
              rows={5}
            />
          </label>
          <button
            type="button"
            disabled={
              !passed?.verifiedIchorConfig ||
              passed.verifiedIchorConfig.config.feeBeneficiariesBound === true ||
              !passed.verifiedGovernanceIdentity ||
              !destinationReady ||
              !wallet.publicKey ||
              !harvestSourceLinesPresent(harvestSources)
            }
            onClick={() => void bindDistribution()}
          >
            Build permanent fee binding
          </button>
          <div className="row">
            <button
              type="button"
              disabled={
                !passed?.verifiedIchorConfig ||
                !wallet.publicKey ||
                passed.verifiedIchorConfig.config.pendingAuthority === null ||
                !wallet.publicKey.equals(passed.verifiedIchorConfig.config.pendingAuthority)
              }
              onClick={() => void acceptPendingAuthority()}
            >
              Accept Config authority
            </button>
            <button
              type="button"
              className={harvestSourceLinesPresent(harvestSources) ? undefined : "secondary"}
              disabled={!passed?.verifiedIchorConfig || !wallet.publicKey || !harvestSourceLinesPresent(harvestSources)}
              onClick={() => void harvest()}
            >
              Build harvest to mint
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!passed?.verifiedIchorConfig || !wallet.publicKey}
              onClick={() => void distribute()}
            >
              Build 25/75 distribution
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!passed?.verifiedIchorConfig || !wallet.publicKey}
              onClick={() => void claim()}
            >
              Build creator claim
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!passed?.verifiedIchorConfig || !wallet.publicKey}
              onClick={() => void sweep()}
            >
              Build permissionless sweep
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!passed?.verifiedIchorConfig || !wallet.publicKey || newBeneficiary.length === 0}
              onClick={() => void rotateBeneficiary()}
            >
              Build beneficiary rotation
            </button>
          </div>
        </details>
      ) : null}
    </>
  );

  if (props.embedded) {
    return (
      <div className="fee-collect" id="fees">
        {body}
      </div>
    );
  }
  return <section className="panel ichor">{body}</section>;
}
