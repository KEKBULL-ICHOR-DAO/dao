import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { readCurveComplete } from "../chain.ts";
import type { DeploymentConfig } from "../config.ts";
import { resolveDaoState } from "../dao-state.ts";
import type { PreflightState } from "./Preflight.tsx";

/**
 * The headline slot on the holder page: where the project is, in one block.
 *
 * This replaced a `!published` boolean that could not distinguish "has not
 * graduated" from "graduated, pool being built". See `dao-state.ts` for the
 * timeline and for the three states this still cannot tell apart.
 */
export function DaoStateBanner(props: {
  config: DeploymentConfig;
  preflight: PreflightState;
  lockVerified: boolean | null;
}) {
  const { connection } = useConnection();
  const [curveComplete, setCurveComplete] = useState<boolean | null>(null);

  const passed = props.preflight.status === "passed" ? props.preflight : null;
  const verifiedConfig = passed?.verifiedIchorConfig ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!passed || !verifiedConfig) {
      setCurveComplete(null);
      return;
    }
    void (async () => {
      try {
        const complete = await readCurveComplete({
          connection,
          verified: passed.verified,
          kekbullMint: verifiedConfig.config.kekbullMint,
          bondingCurve: verifiedConfig.config.bondingCurve,
        });
        if (!cancelled) setCurveComplete(complete);
      } catch {
        // Unknown, not false. resolveDaoState fails backwards on null.
        if (!cancelled) setCurveComplete(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, passed, verifiedConfig]);

  const state = resolveDaoState({
    ichorProgramPublished: props.config.ichorProgram !== null,
    configVerified: verifiedConfig !== null,
    paused: verifiedConfig?.config.paused ?? null,
    daoDestinationCommitted: passed?.committedDaoDestination != null,
    curveComplete,
    poolPublished: props.config.meteoraPool !== null,
    lockVerified: props.lockVerified,
  });

  return (
    <div id="awaiting" data-state={state.id}>
      <p className="status-line">
        <span>SOLANA</span>
        <span className="sep">/</span>
        <span>{props.config.cluster === "mainnet-beta" ? "MAINNET" : "DEVNET"}</span>
        <span className="sep">/</span>
        <span>{state.status}</span>
      </p>
      <h1>{state.heading}</h1>
      <p className="body">{state.body}</p>
      {state.caution ? <p className="state-caution">{state.caution}</p> : null}
      {state.id === "prelaunch" && props.config.cluster === "mainnet-beta" ? (
        <p className="state-you-can">
          <a href="https://devnet.dao.kekbull.com">See the interface working on official-devnet.</a>
        </p>
      ) : null}
      <p className="state-you-can">
        <strong>You can:</strong> {state.youCan}
      </p>
    </div>
  );
}
