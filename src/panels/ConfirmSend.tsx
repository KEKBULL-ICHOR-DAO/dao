import { useEffect, useRef, useState } from "react";
import { payloadReview, type SimulationReview, type UnsignedPayload } from "../send.ts";

/**
 * AUDIT_20260824_ICHOR_DAO.md B2 - the holder dialog used to say
 * "official-devnet" on every cluster, on the one screen where a signer decides
 * whether to approve. The operator view already showed cluster and RPC; the
 * holder view dropped both. Copy is now derived from the live cluster.
 */
function clusterName(cluster: string): string {
  const value = cluster.trim();
  return value.length > 0 ? value : "an unidentified cluster";
}

function isMainnetCluster(cluster: string): boolean {
  return cluster.trim() === "mainnet-beta";
}

/**
 * Host only. RPC endpoints carry API keys in the query string, and this dialog
 * is the most screenshotted surface in the app.
 */
function rpcHost(endpoint: string): string {
  const value = endpoint.trim();
  if (value.length === 0) {
    return "an unnamed endpoint";
  }
  try {
    return new URL(value).host;
  } catch {
    return "an unparseable endpoint";
  }
}

function OperatorReview(props: {
  payload: UnsignedPayload;
  busy: boolean;
  cluster: string;
  genesisHash: string | null;
  rpcEndpoint: string;
  simulation: SimulationReview | null;
  simulationError: string | null;
  sendPhase: "idle" | "signing" | "landing";
  sendError: string | null;
  onCancel: () => void;
  onSimulate: () => Promise<void>;
  onConfirm: () => void;
}) {
  const review = payloadReview(props.payload);
  const [awaitingSimulate, setAwaitingSimulate] = useState(false);
  const genesisReady = props.genesisHash !== null && props.genesisHash.length > 0;
  const simPassed = props.simulation !== null && props.simulationError === null;

  async function runSimulate(): Promise<void> {
    setAwaitingSimulate(true);
    try {
      await props.onSimulate();
    } finally {
      setAwaitingSimulate(false);
    }
  }

  return (
    <>
      <p className="kicker">Nothing has been sent</p>
      <h2>Review unsigned transaction</h2>
      <p>
        This app never receives private keys. Review every program, account, and derived
        address, then simulate. A wallet signature is requested only after you confirm a
        passing simulation. There is no auto-send.
      </p>
      <dl className="dl">
        <dt>Label</dt>
        <dd>{review.label}</dd>
        <dt>Cluster</dt>
        <dd>{props.cluster}</dd>
        <dt>Genesis</dt>
        <dd>{props.genesisHash ?? "unavailable, confirmation disabled"}</dd>
        <dt>RPC</dt>
        <dd>{props.rpcEndpoint}</dd>
      </dl>
      <h3>Every instruction</h3>
      <ol className="compact">
        {review.instructions.map((ix) => (
          <li key={ix.index}>
            <div className="mono">program {ix.program}</div>
            <div className="mono">data {ix.dataHex || "(empty)"}</div>
            <ul className="compact mono">
              {ix.accounts.map((account, accountIndex) => (
                <li key={`${ix.index}:${accountIndex}:${account.pubkey}`}>
                  {account.pubkey}
                  {account.isSigner ? " signer" : ""}
                  {account.isWritable ? " writable" : " readonly"}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <h3>Every derived address</h3>
      {review.derived.length === 0 ? (
        <p className="muted">None returned by the client builder.</p>
      ) : (
        <ul className="compact mono">
          {review.derived.map((row) => (
            <li key={`${row.name}:${row.address}`}>
              {row.name}: {row.address}
            </li>
          ))}
        </ul>
      )}
      <h3>Simulation logs</h3>
      {props.simulationError ? (
        <div className="gate-fail">
          <pre>{props.simulationError}</pre>
        </div>
      ) : null}
      {props.sendError ? (
        <div className="gate-fail">
          <pre>{props.sendError}</pre>
        </div>
      ) : null}
      {props.simulation ? (
        <div className="gate-pass">
          {props.simulation.unitsConsumed ? (
            <p>unitsConsumed {props.simulation.unitsConsumed}</p>
          ) : null}
          <pre>{props.simulation.logs.join("\n")}</pre>
        </div>
      ) : (
        <p className="muted">
          Simulation has not passed. Wallet send stays disabled until logs are reviewed.
        </p>
      )}
      <div className="row">
        <button type="button" className="secondary" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => void runSimulate()}
          disabled={props.busy || awaitingSimulate || !genesisReady}
        >
          {awaitingSimulate ? "Simulating" : "Simulate (sigVerify false)"}
        </button>
        <button
          type="button"
          onClick={props.onConfirm}
          disabled={props.busy || !genesisReady || !simPassed}
        >
          {props.sendPhase === "landing"
            ? `Landing on ${clusterName(props.cluster)}`
            : props.busy
              ? "Approve in your wallet"
              : "Request wallet signature"}
        </button>
      </div>
    </>
  );
}

function holderActionCopy(
  payload: UnsignedPayload,
  cluster: string,
): {
  readonly simFail: string;
  readonly sendFail: string;
  readonly checking: string;
  readonly confirmLabel: string;
} {
  const kind = payload.holderSummary?.kind;
  if (kind === "burn") {
    return {
      simFail: "This burn was not sent. The check failed before your wallet was asked.",
      sendFail: "Your wallet signed, but this page did not land the burn. ICHOR was not created.",
      checking: `Checking this burn against ${clusterName(cluster)}. Your wallet has not been asked yet.`,
      confirmLabel: "Approve this burn",
    };
  }
  if (kind === "deposit") {
    return {
      simFail: "This deposit was not sent. The check failed before your wallet was asked.",
      sendFail:
        "Your wallet signed, but this page did not land the deposit. Your ICHOR is still in your wallet.",
      checking: `Checking this deposit against ${clusterName(cluster)}. Your wallet has not been asked yet.`,
      confirmLabel: "Approve this deposit",
    };
  }
  if (kind === "withdraw") {
    return {
      simFail: "This withdrawal was not sent. The check failed before your wallet was asked.",
      sendFail: "Your wallet signed, but this page did not land the withdrawal.",
      checking:
        `Checking this withdrawal against ${clusterName(cluster)}. Your wallet has not been asked yet.`,
      confirmLabel: "Approve this withdrawal",
    };
  }
  if (kind === "propose") {
    return {
      simFail: "This proposal was not sent. The check failed before your wallet was asked.",
      sendFail: "Your wallet signed, but this page did not land the proposal.",
      checking: `Checking this proposal against ${clusterName(cluster)}. Your wallet has not been asked yet.`,
      confirmLabel: "Approve this proposal",
    };
  }
  if (kind === "vote") {
    return {
      simFail: "This vote was not sent. The check failed before your wallet was asked.",
      sendFail: "Your wallet signed, but this page did not land the vote.",
      checking: `Checking this vote against ${clusterName(cluster)}. Your wallet has not been asked yet.`,
      confirmLabel: "Approve this vote",
    };
  }
  return {
    simFail: "This transaction was not sent. The check failed before your wallet was asked.",
    sendFail: "Your wallet signed, but this page did not land the transaction.",
    checking: `Checking this transaction against ${clusterName(cluster)}. Your wallet has not been asked yet.`,
    confirmLabel: "Approve this transaction",
  };
}

function HolderReview(props: {
  payload: UnsignedPayload;
  busy: boolean;
  cluster: string;
  rpcEndpoint: string;
  checking: boolean;
  simulation: SimulationReview | null;
  simulationError: string | null;
  sendPhase: "idle" | "signing" | "landing";
  sendError: string | null;
  genesisReady: boolean;
  onCancel: () => void;
  onSimulate: () => Promise<void>;
  onConfirm: () => void;
}) {
  const summary = props.payload.holderSummary;
  const copy = holderActionCopy(props.payload, props.cluster);
  const mainnet = isMainnetCluster(props.cluster);
  const simPassed = props.simulation !== null && props.simulationError === null;

  return (
    <>
      <p className="kicker">Nothing has been sent</p>
      <h2>{summary?.headline ?? props.payload.label}</h2>
      {mainnet ? (
        <div className="gate-fail">
          <p>
            <strong>This is mainnet-beta. Real funds.</strong> Approving this signs a
            transaction against live value, not a test cluster.
          </p>
        </div>
      ) : null}
      <p className="field-note">
        Cluster <strong>{clusterName(props.cluster)}</strong> · RPC {rpcHost(props.rpcEndpoint)}
      </p>
      {summary ? (
        <ul>
          {summary.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p>
          Your wallet will ask you to approve this. This app never receives private keys.
        </p>
      )}
      {props.simulationError ? (
        <div className="gate-fail">
          <p>{copy.simFail}</p>
          <pre>{props.simulationError}</pre>
          <button type="button" className="secondary" onClick={() => void props.onSimulate()}>
            Check again
          </button>
        </div>
      ) : null}
      {props.sendError ? (
        <div className="gate-fail">
          <p>{copy.sendFail}</p>
          <pre>{props.sendError}</pre>
        </div>
      ) : null}
      {props.checking && !simPassed && !props.simulationError ? (
        <p className="muted">{copy.checking}</p>
      ) : null}
      {simPassed && !props.busy ? (
        <p className="muted">
          The check passed. Approve once in your wallet. Do not approve a second time unless
          this page asks again.
        </p>
      ) : null}
      {props.sendPhase === "signing" ? (
        <p className="muted">Approve this once in Phantom. That is the only signature.</p>
      ) : null}
      {props.sendPhase === "landing" ? (
        <p className="muted">
          Signed. Waiting for {clusterName(props.cluster)} to confirm. Do not sign again.
        </p>
      ) : null}
      <div className="row">
        <button type="button" className="secondary" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </button>
        <button
          type="button"
          onClick={props.onConfirm}
          disabled={props.busy || !props.genesisReady || !simPassed}
        >
          {props.sendPhase === "landing"
            ? `Landing on ${clusterName(props.cluster)}`
            : props.busy
              ? "Approve in your wallet"
              : copy.confirmLabel}
        </button>
      </div>
    </>
  );
}

export function ConfirmSend(props: {
  payload: UnsignedPayload | null;
  busy: boolean;
  cluster: string;
  genesisHash: string | null;
  rpcEndpoint: string;
  simulation: SimulationReview | null;
  simulationError: string | null;
  onCancel: () => void;
  onSimulate: () => Promise<void>;
  onConfirm: () => void;
  operatorView?: boolean;
  sendPhase?: "idle" | "signing" | "landing";
  checking?: boolean;
  sendError?: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const operatorView = props.operatorView ?? true;
  const sendPhase = props.sendPhase ?? "idle";
  const genesisReady = props.genesisHash !== null && props.genesisHash.length > 0;

  useEffect(() => {
    const node = dialog.current;
    if (!node) {
      return;
    }
    if (props.payload && !node.open) {
      node.showModal();
    }
    if (!props.payload && node.open) {
      node.close();
    }
  }, [props.payload]);

  return (
    <dialog ref={dialog} onCancel={props.onCancel} className="confirm">
      {props.payload && operatorView ? (
        <OperatorReview
          payload={props.payload}
          busy={props.busy}
          cluster={props.cluster}
          genesisHash={props.genesisHash}
          rpcEndpoint={props.rpcEndpoint}
          simulation={props.simulation}
          simulationError={props.simulationError}
          sendPhase={sendPhase}
          sendError={props.sendError ?? null}
          onCancel={props.onCancel}
          onSimulate={props.onSimulate}
          onConfirm={props.onConfirm}
        />
      ) : null}
      {props.payload && !operatorView ? (
        <HolderReview
          payload={props.payload}
          busy={props.busy}
          cluster={props.cluster}
          rpcEndpoint={props.rpcEndpoint}
          checking={props.checking ?? false}
          simulation={props.simulation}
          simulationError={props.simulationError}
          sendPhase={sendPhase}
          sendError={props.sendError ?? null}
          genesisReady={genesisReady}
          onCancel={props.onCancel}
          onSimulate={props.onSimulate}
          onConfirm={props.onConfirm}
        />
      ) : null}
    </dialog>
  );
}
