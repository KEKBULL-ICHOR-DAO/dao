import {
  ClientValidationError,
  assertDaoDestinationMatchesCommitment,
  daoDestinationIdentityFromIssuedGovernance,
  deriveVerifiedNativeTreasury,
  readCommittedDaoDestination,
  requirePublicKey,
  resolveNetwork,
  verifyGovernanceDeployment,
  verifyGovernanceIdentity,
  verifyIchorConfigDeployment,
  verifyIchorProgramDeployment,
  verifyNetworkDeployment,
  verifyRealmDeployment,
  type CommittedDaoDestination,
  type IchorConfigSnapshot,
  type VerifiedGovernance,
  type VerifiedGovernanceIdentity,
  type VerifiedIchorConfig,
  type VerifiedIchorProgram,
  type VerifiedNetwork,
  type VerifiedRealm,
} from "@kekbull/ichor-client";
import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useRef } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { DeploymentConfig } from "../config.ts";
import { formatError } from "../format.ts";

type BoundFeePins = {
  readonly realmsRealm: PublicKey;
  readonly realmsGovernance: PublicKey;
  readonly realmsNativeTreasury: PublicKey;
  readonly realmsProgram: PublicKey;
};

function tryReadCommittedPins(config: IchorConfigSnapshot): BoundFeePins | null {
  try {
    const committed = readCommittedDaoDestination(config);
    return {
      realmsRealm: committed.realm,
      realmsGovernance: committed.governance,
      realmsNativeTreasury: committed.nativeTreasury,
      realmsProgram: committed.realmsProgram,
    };
  } catch {
    return null;
  }
}

function requireBoundFeePins(
  config: IchorConfigSnapshot,
  governance: string | null,
): BoundFeePins {
  const committed = readCommittedDaoDestination(config);
  if (!governance) {
    throw new ClientValidationError("GOVERNANCE_NOT_BOUND_TREASURY", [
      "deployment governance is required when Config has a committed DAO destination; omitting it is not a skip",
    ]);
  }
  if (!committed.governance.equals(requirePublicKey(governance, "governance"))) {
    throw new ClientValidationError("GOVERNANCE_NOT_BOUND_TREASURY", [
      "deployment governance does not match the Config-committed Realms Governance; deployment JSON cannot pick an irreversible destination",
    ]);
  }
  return {
    realmsRealm: committed.realm,
    realmsGovernance: committed.governance,
    realmsNativeTreasury: committed.nativeTreasury,
    realmsProgram: committed.realmsProgram,
  };
}

export function irreversibleDaoActionsEnabled(params: {
  committed: CommittedDaoDestination | null;
  identityMatches: boolean;
}): boolean {
  return params.committed !== null && params.identityMatches;
}

function assertIssuedIdentityMatchesBoundConfig(params: {
  readonly identity: VerifiedGovernanceIdentity;
  readonly derivedTreasury: PublicKey;
  readonly verified: VerifiedNetwork;
  readonly verifiedRealm: VerifiedRealm;
  readonly pins: BoundFeePins;
  readonly deploymentRealm: string | null;
}): void {
  if (!params.identity.realm.equals(params.pins.realmsRealm)) {
    throw new ClientValidationError("DAO_DESTINATION_MISMATCH", [
      "issued realm does not match the Config-committed realm; deployment JSON cannot pick an irreversible destination",
    ]);
  }
  if (!params.identity.governance.equals(params.pins.realmsGovernance)) {
    throw new ClientValidationError("GOVERNANCE_NOT_BOUND_TREASURY", [
      "issued governance identity does not match the Config-bound Realms Governance; 75% of ICHOR transfer fees already point at the bound treasury",
    ]);
  }
  if (!params.derivedTreasury.equals(params.pins.realmsNativeTreasury)) {
    throw new ClientValidationError("NATIVE_TREASURY_MISMATCH", [
      `derived native treasury does not match Config.realmsNativeTreasury ${params.pins.realmsNativeTreasury.toBase58()}`,
    ]);
  }
  if (!params.verified.network.realmsProgramId.equals(params.pins.realmsProgram)) {
    throw new ClientValidationError("REALMS_PROGRAM_MISMATCH", [
      `verified network Realms program does not match Config.realmsProgram ${params.pins.realmsProgram.toBase58()}`,
    ]);
  }
  if (
    params.deploymentRealm &&
    !params.verifiedRealm.realm.equals(params.identity.realm)
  ) {
    throw new ClientValidationError("GOVERNANCE_REALM", [
      "VerifiedRealm does not match the realm on the issued governance identity",
    ]);
  }
}

export type PreflightState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "failed"; message: string; code?: string }
  | {
      status: "passed";
      verified: VerifiedNetwork;
      verifiedIchorProgram: VerifiedIchorProgram | null;
      verifiedIchorConfig: VerifiedIchorConfig | null;
      ichorReason: string | null;
      verifiedRealm: VerifiedRealm | null;
      realmReason: string | null;
      verifiedGovernance: VerifiedGovernance | null;
      verifiedGovernanceIdentity: VerifiedGovernanceIdentity | null;
      verifiedNativeTreasury: PublicKey | null;
      committedDaoDestination: CommittedDaoDestination | null;
      daoDestinationMatches: boolean;
      governanceReason: string | null;
      genesisHash: string;
      rpcEndpoint: string;
    };

export function Preflight(props: {
  config: DeploymentConfig;
  state: PreflightState;
  onChange: (state: PreflightState) => void;
  /**
   * Operator presentation: show the full chain-verification wording and drive
   * the check from a button. Off (the public default) the panel runs itself on
   * arrival and reports pass or fail in plain language.
   *
   * The check is identical either way. Only who asks for it changes. Every
   * transaction builder is gated on a passed preflight, so leaving it as a
   * button meant a holder had to press something called "Run preflight" before
   * the page would do anything.
   */
  operatorView?: boolean;
}) {
  const { connection } = useConnection();
  const operatorView = props.operatorView ?? false;
  const autoStarted = useRef(false);

  async function run(): Promise<void> {
    props.onChange({ status: "running" });
    try {
      const network = resolveNetwork({
        cluster: props.config.cluster,
        realmsInstance: props.config.realmsInstance,
      });
      const verified = await verifyNetworkDeployment(connection, network);
      let verifiedIchorProgram: VerifiedIchorProgram | null = null;
      let verifiedIchorConfig: VerifiedIchorConfig | null = null;
      let ichorReason: string | null = null;
      let verifiedRealm: VerifiedRealm | null = null;
      let realmReason: string | null = null;
      let verifiedGovernance: VerifiedGovernance | null = null;
      let verifiedGovernanceIdentity: VerifiedGovernanceIdentity | null = null;
      let verifiedNativeTreasury: PublicKey | null = null;
      let committedDaoDestination: CommittedDaoDestination | null = null;
      let daoDestinationMatches = false;
      let governanceReason: string | null = null;
      let boundFeePins: BoundFeePins | null = null;
      if (!props.config.ichorProgram) {
        ichorReason =
          "ICHOR_PREFLIGHT_SKIPPED: config.ichorProgram is required before the burn program and Config PDA can be verified. Convert stays disabled.";
      } else {
        try {
          verifiedIchorProgram = await verifyIchorProgramDeployment(
            connection,
            verified,
            requirePublicKey(props.config.ichorProgram, "ichorProgram"),
          );
          verifiedIchorConfig = await verifyIchorConfigDeployment(connection, verifiedIchorProgram);
          if (
            props.config.kekbullMint &&
            !verifiedIchorConfig.config.kekbullMint.equals(
              requirePublicKey(props.config.kekbullMint, "kekbullMint"),
            )
          ) {
            throw new ClientValidationError("KEKBULL_MINT_MISMATCH", [
              "deployment kekbullMint does not match the live ICHOR Config",
            ]);
          }
          if (
            props.config.ichorMint &&
            !verifiedIchorConfig.config.ichorMint.equals(
              requirePublicKey(props.config.ichorMint, "ichorMint"),
            )
          ) {
            throw new ClientValidationError("ICHOR_MINT_MISMATCH", [
              "deployment ichorMint does not match the live ICHOR Config",
            ]);
          }
        } catch (error) {
          verifiedIchorProgram = null;
          verifiedIchorConfig = null;
          ichorReason = formatError(error);
        }
      }
      if (verifiedIchorConfig) {
        boundFeePins = tryReadCommittedPins(verifiedIchorConfig.config);
        if (boundFeePins) {
          committedDaoDestination = {
            realm: boundFeePins.realmsRealm,
            governance: boundFeePins.realmsGovernance,
            realmsProgram: boundFeePins.realmsProgram,
            nativeTreasury: boundFeePins.realmsNativeTreasury,
          };
          requireBoundFeePins(verifiedIchorConfig.config, props.config.governance);
        } else if (verifiedIchorConfig.config.feeBeneficiariesBound === true) {
          boundFeePins = requireBoundFeePins(
            verifiedIchorConfig.config,
            props.config.governance,
          );
        }
      }
      const realmIchorMint = verifiedIchorConfig?.config.ichorMint ??
        (props.config.ichorMint ? requirePublicKey(props.config.ichorMint, "ichorMint") : null);
      if (!props.config.realm || !realmIchorMint) {
        realmReason =
          "REALM_PREFLIGHT_SKIPPED: config.realm plus ICHOR mint from VerifiedIchorConfig or deployment config are required before verifyRealmDeployment. Network proof passed; community actions stay disabled.";
        governanceReason =
          "GOVERNANCE_PREFLIGHT_SKIPPED: VerifiedRealm was not issued, so verifyGovernanceDeployment did not run. Propose/vote stay disabled.";
      } else {
        try {
          verifiedRealm = await verifyRealmDeployment(
            connection,
            verified,
            requirePublicKey(props.config.realm, "realm"),
            realmIchorMint,
          );
        } catch (error) {
          realmReason = formatError(error);
          governanceReason =
            "GOVERNANCE_PREFLIGHT_SKIPPED: VerifiedRealm was not issued, so verifyGovernanceDeployment did not run. Propose/vote stay disabled.";
        }
      }
      if (verifiedRealm) {
        if (!props.config.governance) {
          governanceReason =
            "GOVERNANCE_PREFLIGHT_SKIPPED: validated config.governance is required before verifyGovernanceDeployment. Network and realm proofs may pass; propose/vote stay disabled.";
        } else {
          try {
            verifiedGovernanceIdentity = await verifyGovernanceIdentity(
              connection,
              verifiedRealm,
              requirePublicKey(props.config.governance, "governance"),
            );
            const derivedNativeTreasury = await deriveVerifiedNativeTreasury(
              verifiedGovernanceIdentity,
            );
            verifiedNativeTreasury = derivedNativeTreasury;
            if (
              props.config.nativeTreasury &&
              !derivedNativeTreasury.equals(
                requirePublicKey(props.config.nativeTreasury, "nativeTreasury"),
              )
            ) {
              throw new ClientValidationError("NATIVE_TREASURY_MISMATCH", [
                `deployment nativeTreasury does not match derived PDA ${derivedNativeTreasury.toBase58()}`,
              ]);
            }
          } catch (error) {
            verifiedGovernanceIdentity = null;
            verifiedNativeTreasury = null;
            governanceReason = formatError(error);
          }
          if (boundFeePins && verifiedGovernanceIdentity && verifiedNativeTreasury) {
            assertIssuedIdentityMatchesBoundConfig({
              identity: verifiedGovernanceIdentity,
              derivedTreasury: verifiedNativeTreasury,
              verified,
              verifiedRealm,
              pins: boundFeePins,
              deploymentRealm: props.config.realm,
            });
            if (committedDaoDestination && verifiedIchorConfig) {
              const identity = await daoDestinationIdentityFromIssuedGovernance(
                verifiedGovernanceIdentity,
              );
              assertDaoDestinationMatchesCommitment({
                commitment: committedDaoDestination,
                identity,
                ichorMint: verifiedIchorConfig.config.ichorMint,
              });
              daoDestinationMatches = true;
            }
          }
          if (verifiedGovernanceIdentity) {
            try {
              verifiedGovernance = await verifyGovernanceDeployment(
                connection,
                verifiedRealm,
                requirePublicKey(props.config.governance, "governance"),
              );
            } catch (error) {
              governanceReason = formatError(error);
            }
          }
        }
      }
      props.onChange({
        status: "passed",
        verified,
        verifiedIchorProgram,
        verifiedIchorConfig,
        ichorReason,
        verifiedRealm,
        realmReason,
        verifiedGovernance,
        verifiedGovernanceIdentity,
        verifiedNativeTreasury,
        committedDaoDestination,
        daoDestinationMatches,
        governanceReason,
        genesisHash: verified.genesisHash,
        rpcEndpoint: verified.rpcEndpoint,
      });
    } catch (error) {
      const message = formatError(error);
      const code = error instanceof ClientValidationError ? error.code : undefined;
      props.onChange({ status: "failed", message, ...(code ? { code } : {}) });
    }
  }

  // Run the check on arrival for holders. Guarded by a ref rather than an
  // effect dependency: run() is a new function every render, so depending on
  // it would restart the check in a loop. Nothing to check before the
  // addresses exist, so a not-yet-deployed DAO stays quiet instead of showing
  // a failure the reader cannot act on.
  const canRun =
    Boolean(props.config.rpcUrl) &&
    Boolean(props.config.ichorProgram) &&
    Boolean(props.config.realm);
  // Holders (and recovery after a stale issued-proof) set status back to idle
  // so this effect can re-run verify*. Vite HMR remounts the client WeakSet
  // while React still holds the old proof objects; without resetting
  // autoStarted, idle alone would never re-issue.
  useEffect(() => {
    if (props.state.status === "idle") {
      autoStarted.current = false;
    }
  }, [props.state.status]);

  useEffect(() => {
    if (operatorView || autoStarted.current) return;
    if (props.state.status !== "idle" || !canRun) return;
    autoStarted.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operatorView, canRun, props.state.status]);

  if (!operatorView) {
    // Passing is a status, not a trophy: the masthead pill carries "verified
    // against chain", "verifying" and "not deployed yet", so none of those need
    // a bordered box in the reading flow. This component stays mounted because
    // it is what actually runs the check.
    //
    // Failure is the opposite. It can mean this is not the real site, so it
    // keeps the full width and says plainly not to sign. Do not shrink this
    // into the pill.
    if (props.state.status !== "failed") {
      return null;
    }
    return (
      <section className="panel">
        <h2>Verification failed</h2>
        <div className="gate-fail">
          <strong>Do not sign anything on this page.</strong>
          <p>
            The addresses shown here could not be matched to the real KEKBULL contracts on
            Solana. That can mean the network is having trouble, or it can mean this is not the
            real site. Close the tab and come back through a link you already trust.
          </p>
          <pre>{props.state.message}</pre>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Network / genesis / program gate</h2>
      <p className="muted">
        Preflight uses the local ICHOR client. It checks the official cluster genesis hash
        before reading program accounts, then requires executable Meteora DAMM v2 and Realms
        accounts on the BPF Upgradeable Loader. After that proof,{" "}
        <code>verifyRealmDeployment</code> and then <code>verifyGovernanceDeployment</code> run
        on the same Connection when those addresses are configured. A named program ID is not a
        deployment. Disabled community voting fails governance issuance; this UI does not
        confirm activation by checkbox.
      </p>
      <div className="row">
        <button type="button" onClick={() => void run()} disabled={props.state.status === "running"}>
          {props.state.status === "running" ? "Checking chain" : "Run preflight"}
        </button>
      </div>
      {props.state.status === "idle" ? (
        <p className="muted">No preflight yet. Live reads and unsigned builders stay closed.</p>
      ) : null}
      {props.state.status === "failed" ? (
        <div className="gate-fail">
          <strong>{props.state.code ?? "PREFLIGHT_FAILED"}</strong>
          <pre>{props.state.message}</pre>
        </div>
      ) : null}
      {props.state.status === "passed" ? (
        <div className="gate-pass">
          <p>Verified against the bound RPC connection.</p>
          <dl className="dl">
            <dt>Cluster</dt>
            <dd>{props.config.cluster}</dd>
            <dt>Genesis</dt>
            <dd>{props.state.genesisHash}</dd>
            <dt>RPC</dt>
            <dd>{props.state.rpcEndpoint}</dd>
            <dt>Realms instance</dt>
            <dd>
              {props.config.realmsInstance} {props.state.verified.realms.namedId}
            </dd>
            <dt>Realms executable</dt>
            <dd>{String(props.state.verified.realms.executable)}</dd>
            <dt>Realms data length</dt>
            <dd>{String(props.state.verified.realms.dataLength)}</dd>
            <dt>Meteora</dt>
            <dd>{props.state.verified.meteora.namedId}</dd>
            <dt>Meteora executable</dt>
            <dd>{String(props.state.verified.meteora.executable)}</dd>
            <dt>Meteora data length</dt>
            <dd>{String(props.state.verified.meteora.dataLength)}</dd>
          </dl>
          {props.state.verifiedIchorConfig ? (
            <dl className="dl">
              <dt>Verified ICHOR program</dt>
              <dd>{props.state.verifiedIchorConfig.verifiedProgram.programId.toBase58()}</dd>
              <dt>Verified Config PDA</dt>
              <dd>{props.state.verifiedIchorConfig.config.config.toBase58()}</dd>
              <dt>Config KEKBULL mint</dt>
              <dd>{props.state.verifiedIchorConfig.config.kekbullMint.toBase58()}</dd>
              <dt>Config ICHOR mint</dt>
              <dd>{props.state.verifiedIchorConfig.config.ichorMint.toBase58()}</dd>
              <dt>Convert paused</dt>
              <dd>{String(props.state.verifiedIchorConfig.config.paused)}</dd>
              <dt>Emission numerator / denominator</dt>
              <dd>
                {props.state.verifiedIchorConfig.config.emissionNumerator.toString(10)} /{" "}
                {props.state.verifiedIchorConfig.config.emissionDenominator.toString(10)}
              </dd>
              <dt>Pending ratio</dt>
              <dd>{String(props.state.verifiedIchorConfig.config.hasPendingRatio)}</dd>
              <dt>Fee beneficiaries bound</dt>
              <dd>{String(props.state.verifiedIchorConfig.config.feeBeneficiariesBound)}</dd>
              <dt>Committed DAO destination</dt>
              <dd>
                {props.state.committedDaoDestination
                  ? `${props.state.committedDaoDestination.realm.toBase58()} / ${props.state.committedDaoDestination.governance.toBase58()}`
                  : "uncommitted: fee bind and position-rights handoff stay disabled"}
              </dd>
              <dt>Destination matches issued identity</dt>
              <dd>{String(props.state.daoDestinationMatches)}</dd>
              <dt>Bound Realms Governance</dt>
              <dd>
                {props.state.verifiedIchorConfig.config.realmsGovernance?.toBase58() ??
                  "uncommitted: a pasted realm is not the treasury until commit_dao_destination lands"}
              </dd>
              <dt>Bound Realms native treasury</dt>
              <dd>
                {props.state.verifiedIchorConfig.config.realmsNativeTreasury?.toBase58() ?? "uncommitted"}
              </dd>
            </dl>
          ) : (
            <div className="blocked">
              <p>Convert disabled. A live ICHOR program and Config proof were not issued.</p>
              <pre>{props.state.ichorReason ?? "VerifiedIchorConfig missing"}</pre>
            </div>
          )}
          {props.state.verifiedRealm ? (
            <dl className="dl">
              <dt>VerifiedRealm</dt>
              <dd>issued</dd>
              <dt>Realm</dt>
              <dd>{props.state.verifiedRealm.realm.toBase58()}</dd>
              <dt>Community mint</dt>
              <dd>{props.state.verifiedRealm.communityMint.toBase58()}</dd>
            </dl>
          ) : (
            <div className="blocked">
              <p>Community deposit/withdraw/relinquish disabled. VerifiedRealm was not issued.</p>
              <pre>{props.state.realmReason ?? "VerifiedRealm missing"}</pre>
            </div>
          )}
          {props.state.verifiedGovernance ? (
            <dl className="dl">
              <dt>VerifiedGovernance</dt>
              <dd>issued</dd>
              <dt>Governance</dt>
              <dd>{props.state.verifiedGovernance.governance.toBase58()}</dd>
              <dt>Proof realm</dt>
              <dd>{props.state.verifiedGovernance.realm.toBase58()}</dd>
              <dt>Proof community mint</dt>
              <dd>{props.state.verifiedGovernance.communityMint.toBase58()}</dd>
              <dt>Community threshold type</dt>
              <dd>{String(props.state.verifiedGovernance.config.communityVoteThresholdType)}</dd>
              <dt>Community threshold value</dt>
              <dd>{String(props.state.verifiedGovernance.config.communityVoteThresholdValue)}</dd>
              <dt>Min community tokens to propose</dt>
              <dd>
                {props.state.verifiedGovernance.config.minCommunityTokensToCreateProposal.toString(10)}
              </dd>
            </dl>
          ) : (
            <div className="blocked">
              <p>Propose/vote disabled. VerifiedGovernance was not issued.</p>
              <pre>{props.state.governanceReason ?? "VerifiedGovernance missing"}</pre>
            </div>
          )}
          {props.state.verifiedGovernanceIdentity ? (
            <dl className="dl">
              <dt>Verified Governance identity</dt>
              <dd>{props.state.verifiedGovernanceIdentity.governance.toBase58()}</dd>
              <dt>Bootstrap treasury identity usable</dt>
              <dd>yes, community activation is not required for custody</dd>
              <dt>Derived native treasury</dt>
              <dd>{props.state.verifiedNativeTreasury?.toBase58() ?? "unavailable"}</dd>
            </dl>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
