import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CLUSTER_GENESIS_HASH } from "@kekbull/ichor-client";
import {
  EMPTY_DEPLOYMENT,
  isGovernanceSigningAllowed,
  isLocalGovernanceDevHost,
  loadDeploymentFile,
  OFFICIAL_HTTP_RPC,
  resolveBrowserRpcUrl,
  type DeploymentConfig,
} from "./config.ts";
import { invalidateLiveMintCache } from "./chain.ts";
import { formatError } from "./format.ts";
import {
  isOperatorConsoleUnlocked,
  operatorAuthoritiesFromPreflight,
} from "./operator-access.ts";
import { OperatorLock } from "./panels/OperatorLock.tsx";
import { BurnPanel } from "./panels/Burn.tsx";
import { ConfirmSend } from "./panels/ConfirmSend.tsx";
import { DeploymentFacts } from "./panels/DeploymentFacts.tsx";
import { Governance } from "./panels/Governance.tsx";
import { Handbook } from "./panels/Handbook.tsx";
import { HostWarning } from "./panels/HostWarning.tsx";
import { LiveState } from "./panels/LiveState.tsx";
import { LockAndFees } from "./panels/LockAndFees.tsx";
import { Masthead } from "./panels/Masthead.tsx";
import { Preflight, type PreflightState } from "./panels/Preflight.tsx";
import { Proposals } from "./panels/Proposals.tsx";
import { Succession } from "./panels/Succession.tsx";
import { ThrowawayMint } from "./panels/ThrowawayMint.tsx";
import { TransferFees } from "./panels/TransferFees.tsx";
import { PumpCreatorFees } from "./panels/PumpCreatorFees.tsx";
import {
  dropExtraSigners,
  sendWithConnectedWallet,
  simulateBoundPayload,
  type InsertedProposalSession,
  type SimulationReview,
  type StagedGovernanceAction,
  type UnsignedPayload,
} from "./send.ts";
import { DaoStateBanner } from "./panels/DaoStateBanner.tsx";
import { HolderSection } from "./holder-section.tsx";
import { TreasuryAssets } from "./panels/TreasuryAssets.tsx";
import { WalletRoot, walletNetworkForCluster } from "./wallet.tsx";

/* "config" is new: the deployment form used to render unconditionally below
   the tabs, so it sat under whatever task the operator was doing. It is a
   page now, in the Deployment group with the proofs it invalidates. */
type Tab = "state" | "burn" | "governance" | "fees" | "lock" | "q3b" | "config";

interface NavItem {
  readonly id: Tab;
  readonly label: string;
  readonly badge?: string;
}

interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

/* Grouped so the irreversible work is not adjacent to the daily work. The
   six-tab strip put "Q3b throwaway mint" one pixel from "Governance" and gave
   an operator who did not write this app no way to tell which was safe.

   Governance.tsx is still one page. Splitting its Config-admin, handoff and
   generic-instruction sections into their own pages is worth doing and is a
   change to that file, not to this one. See handoff/IMPLEMENTATION.md §8. */
const NAV: readonly NavGroup[] = [
  {
    label: "Deployment",
    items: [
      { id: "state", label: "Status and live state" },
      { id: "config", label: "Addresses" },
    ],
  },
  {
    label: "Operations",
    items: [
      { id: "burn", label: "Burn and supply" },
      { id: "governance", label: "Governance" },
      { id: "fees", label: "ICHOR fees" },
      { id: "lock", label: "Liquidity and lock" },
    ],
  },
  {
    label: "Advanced",
    items: [{ id: "q3b", label: "Throwaway mint", badge: "Q3b" }],
  },
];

const PAGE_TITLE: Record<Tab, string> = {
  state: "Status and live state",
  config: "Deployment addresses",
  burn: "Burn and supply",
  governance: "Governance",
  fees: "ICHOR fees",
  lock: "Liquidity and lock",
  q3b: "Throwaway mint",
};

/* Holder sections are <HolderSection> folds. Index + group label still
   group burn/deposit/vote and treasury/liquidity. The page stays one
   scrolling reading order; each fold is closed until opened or hashed. */

export function App() {
  const host = typeof window === "undefined" ? "" : window.location.hostname;
  if (!isGovernanceSigningAllowed(host)) {
    return <HostWarning />;
  }
  return <AllowedHostApp />;
}

function AllowedHostApp() {
  const host = typeof window === "undefined" ? "" : window.location.hostname;
  const localDev = isLocalGovernanceDevHost(host);
  // On loopback, ?preview=holder renders exactly what dao.kekbull.com serves,
  // so the operator can review the holder page without deploying it.
  //
  // This can only ever REMOVE surface. operatorView requires localDev, so no
  // query string on the public origin can turn the deployment form back on;
  // the worst a crafted dao.kekbull.com/?preview=holder link can do is show
  // the page that host already shows.
  const holderPreview =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("preview") === "holder";
  const operatorView = localDev && !holderPreview;
  useEffect(() => {
    document.title = operatorView ? "ICHOR Console" : "ICHOR Governance";
  }, [operatorView]);
  const [config, setConfig] = useState<DeploymentConfig>(EMPTY_DEPLOYMENT);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightState>({ status: "idle" });
  const pageRpc = resolveBrowserRpcUrl(
    config.rpcUrl,
    config.cluster,
    typeof window === "undefined" ? "" : window.location.origin,
  );
  const published = Boolean(config.ichorProgram);

  const loadFile = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      setConfig(await loadDeploymentFile());
      setPreflight({ status: "idle" });
    } catch (error) {
      setLoadError(formatError(error));
    }
  }, []);

  // Load the published addresses on arrival. This used to sit behind a button,
  // which made a holder press "Load deployment.json" before anything on the
  // page worked. deployment.json ships with the bundle and is the canonical
  // source for every address here, so there is nothing to decide: read it.
  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  // The masthead needs wallet context, and it sits above everything, so the
  // provider wraps the whole page. An empty deployment.json rpcUrl resolves
  // to same-origin /rpc on a named governance host (keyed helper on
  // loopback). Official cluster HTTP is the browser fallback if /rpc is
  // down. That is a read endpoint, not a claim that the DAO exists.
  return (
    <WalletRoot rpcUrl={pageRpc} cluster={config.cluster}>
      <AllowedHostBody
        config={config}
        loadError={loadError}
        preflight={preflight}
        operatorView={operatorView}
        published={published}
        onPreflight={setPreflight}
        onConfigChange={(next) => {
          setConfig(next);
          setPreflight({ status: "idle" });
        }}
        onLoadFile={() => void loadFile()}
      />
    </WalletRoot>
  );
}

function AllowedHostBody(props: {
  config: DeploymentConfig;
  loadError: string | null;
  preflight: PreflightState;
  operatorView: boolean;
  published: boolean;
  onPreflight: (state: PreflightState) => void;
  onConfigChange: (config: DeploymentConfig) => void;
  onLoadFile: () => void;
}) {
  const wallet = useWallet();
  const operatorUnlocked = isOperatorConsoleUnlocked({
    connected: wallet.publicKey,
    authorities: operatorAuthoritiesFromPreflight(props.preflight, props.published),
  });
  const showOperatorConsole = props.operatorView && operatorUnlocked;

  // The operator console owns its own full-height shell, so it is returned
  // whole rather than threaded through the holder page's wrappers.
  if (showOperatorConsole) {
    return (
      <>
        <ConnectedApp
          config={props.config}
          preflight={props.preflight}
          onPreflight={props.onPreflight}
          operatorView
          loadError={props.loadError}
          onConfigChange={props.onConfigChange}
          onLoadFile={props.onLoadFile}
        />
      </>
    );
  }

  if (props.operatorView && !operatorUnlocked) {
    return (
      <>
        <Masthead
          operatorView
          preflight={props.preflight}
          deployed={props.published}
          walletMounted
          cluster={props.config.cluster}
        />
        <Preflight
          config={props.config}
          state={props.preflight}
          onChange={props.onPreflight}
          operatorView={false}
        />
        <OperatorLock preflight={props.preflight} programConfigured={props.published} />
      </>
    );
  }

  return (
    <>
      <Masthead
        operatorView={false}
        preflight={props.preflight}
        deployed={props.published}
        walletMounted
        cluster={props.config.cluster}
      />
      <div className="shell">
        {props.config.cluster === "devnet" ? (
          <p className="state-caution">
            <span className="pill warn">Devnet</span> These figures are official Solana
            devnet. Nothing here is real money.{" "}
            <a href="https://dao.kekbull.com">Open the KEKBULL DAO</a>
          </p>
        ) : null}
        <p className="lede">
          Burn KEKBULL to get ICHOR, deposit ICHOR to vote, and vote on what the treasury does.{" "}
          <strong>Your own wallet signs every transaction. This app never receives private keys.</strong>
        </p>
        {props.loadError ? (
          <div className="gate-fail">
            <strong>Could not read the published addresses</strong>
            <pre>{props.loadError}</pre>
          </div>
        ) : null}
        <ConnectedApp
          config={props.config}
          preflight={props.preflight}
          onPreflight={props.onPreflight}
          operatorView={false}
          loadError={props.loadError}
          onConfigChange={props.onConfigChange}
          onLoadFile={props.onLoadFile}
        />
        <footer>
          KEKBULL is a meme coin. There is no company behind it and no asset backing its price.
          Only spend what you can afford to lose. Official address:{" "}
          <span className="mono">dao.kekbull.com</span>
        </footer>
      </div>
    </>
  );
}

function ConfigForm(props: {
  config: DeploymentConfig;
  loadError: string | null;
  onChange: (config: DeploymentConfig) => void;
  onLoadFile: () => void;
}) {
  const cfg = props.config;

  function set<K extends keyof DeploymentConfig>(key: K, value: DeploymentConfig[K]): void {
    props.onChange({ ...cfg, [key]: value });
  }

  function setAddr<K extends keyof DeploymentConfig>(key: K, value: string): void {
    const trimmed = value.trim();
    props.onChange({ ...cfg, [key]: trimmed.length === 0 ? null : trimmed } as DeploymentConfig);
  }

  return (
    <section className="panel">
      <h2>Deployment addresses</h2>
      <p className="muted">
        Identities only. Paste pubkeys after they exist on chain. Null / empty means unread, not
        zero. Loading deployment.json validates PublicKey syntax and the lock integer. Changing
        any field here clears every issued proof.
      </p>
      <div className="row">
        <button type="button" className="secondary" onClick={props.onLoadFile}>
          Load deployment.json
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => set("rpcUrl", OFFICIAL_HTTP_RPC[cfg.cluster])}
        >
          Use official {cfg.cluster} HTTP RPC
        </button>
      </div>
      {props.loadError ? (
        <div className="gate-fail">
          <pre>{props.loadError}</pre>
        </div>
      ) : null}
      <div className="row">
        <label>
          Cluster
          <select
            value={cfg.cluster}
            onChange={(event) => {
              const cluster = event.target.value === "mainnet-beta" ? "mainnet-beta" : "devnet";
              props.onChange({ ...cfg, cluster, rpcUrl: "" });
            }}
          >
            <option value="devnet">devnet</option>
            <option value="mainnet-beta">mainnet-beta</option>
          </select>
        </label>
        <label>
          Realms instance
          <select
            value={cfg.realmsInstance}
            onChange={(event) =>
              set(
                "realmsInstance",
                event.target.value === "default-shared" ? "default-shared" : "test",
              )
            }
          >
            <option value="test">test</option>
            <option value="default-shared">default-shared</option>
          </select>
        </label>
        <label>
          RPC URL
          <input value={cfg.rpcUrl} onChange={(event) => set("rpcUrl", event.target.value.trim())} />
        </label>
        <label>
          ICHOR program
          <input
            value={cfg.ichorProgram ?? ""}
            onChange={(event) => setAddr("ichorProgram", event.target.value)}
          />
        </label>
        <label>
          ICHOR mint
          <input value={cfg.ichorMint ?? ""} onChange={(event) => setAddr("ichorMint", event.target.value)} />
        </label>
        <label>
          KEKBULL mint
          <input
            value={cfg.kekbullMint ?? ""}
            onChange={(event) => setAddr("kekbullMint", event.target.value)}
          />
        </label>
        <label>
          Realm
          <input value={cfg.realm ?? ""} onChange={(event) => setAddr("realm", event.target.value)} />
        </label>
        <label>
          Governance
          <input
            value={cfg.governance ?? ""}
            onChange={(event) => setAddr("governance", event.target.value)}
          />
        </label>
        <label>
          Native treasury
          <input
            value={cfg.nativeTreasury ?? ""}
            onChange={(event) => setAddr("nativeTreasury", event.target.value)}
          />
        </label>
        <label>
          Token owner record
          <input
            value={cfg.communityTokenOwnerRecord ?? ""}
            onChange={(event) => setAddr("communityTokenOwnerRecord", event.target.value)}
          />
        </label>
        <label>
          Meteora pool
          <input
            value={cfg.meteoraPool ?? ""}
            onChange={(event) => setAddr("meteoraPool", event.target.value)}
          />
        </label>
        <label>
          Meteora position
          <input
            value={cfg.meteoraPosition ?? ""}
            onChange={(event) => setAddr("meteoraPosition", event.target.value)}
          />
        </label>
        <label>
          Meteora position NFT mint
          <input
            value={cfg.meteoraPositionNftMint ?? ""}
            onChange={(event) => setAddr("meteoraPositionNftMint", event.target.value)}
          />
        </label>
        <label>
          Expected locked liquidity (base)
          <input
            value={cfg.expectedLockedLiquidityBaseUnits ?? ""}
            onChange={(event) => setAddr("expectedLockedLiquidityBaseUnits", event.target.value)}
          />
        </label>
      </div>
    </section>
  );
}

function ConnectedApp(props: {
  config: DeploymentConfig;
  preflight: PreflightState;
  onPreflight: (state: PreflightState) => void;
  operatorView: boolean;
  loadError: string | null;
  onConfigChange: (config: DeploymentConfig) => void;
  onLoadFile: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const localDev = props.operatorView;
  const [tab, setTab] = useState<Tab>("state");
  const [pending, setPending] = useState<UnsignedPayload | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendPhase, setSendPhase] = useState<"idle" | "signing" | "landing">("idle");
  const [checking, setChecking] = useState(false);
  const sendLock = useRef(false);
  const autoSimLock = useRef(false);
  const [simulation, setSimulation] = useState<SimulationReview | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [stagedAction, setStagedAction] = useState<StagedGovernanceAction | null>(null);
  const [insertedSession, setInsertedSession] = useState<InsertedProposalSession | null>(null);
  const [lockVerified, setLockVerified] = useState<boolean | null>(null);
  const passed = props.preflight.status === "passed" ? props.preflight : null;
  const governanceIdentity = passed?.verifiedGovernanceIdentity ?? null;
  const genesis =
    pending?.genesisMode === "official-devnet"
      ? (pending.measuredGenesisHash ?? CLUSTER_GENESIS_HASH.devnet)
      : passed
        ? passed.genesisHash
        : null;
  const rpcEndpoint =
    pending?.genesisMode === "official-devnet"
      ? connection.rpcEndpoint
      : passed
        ? passed.rpcEndpoint
        : connection.rpcEndpoint;

  useEffect(() => {
    setPending((prev) => {
      dropExtraSigners(prev?.extraSigners);
      return null;
    });
    setSimulation(null);
    setSimulationError(null);
    setStagedAction(null);
    setInsertedSession(null);
    setLockVerified(null);
  }, [connection, governanceIdentity]);

  const onLockVerified = useCallback((verified: boolean | null) => {
    setLockVerified(verified);
  }, []);

  const runSimulation = useCallback(async () => {
    if (!pending) {
      setSimulation(null);
      setSimulationError("no unsigned payload to simulate");
      return;
    }
    if (pending.genesisMode !== "official-devnet" && !passed) {
      setSimulation(null);
      setSimulationError("preflight has not passed; refusing simulation");
      return;
    }
    setSimulation(null);
    setSimulationError(null);
    setChecking(true);
    try {
      setSimulation(
        await simulateBoundPayload({
          connection,
          verified: passed?.verified ?? null,
          wallet,
          payload: pending,
        }),
      );
    } catch (error) {
      setSimulationError(formatError(error));
    } finally {
      setChecking(false);
    }
  }, [connection, passed, pending, wallet]);

  useEffect(() => {
    if (localDev || !pending || simulation || simulationError || checking || autoSimLock.current) {
      return;
    }
    autoSimLock.current = true;
    void runSimulation().finally(() => {
      autoSimLock.current = false;
    });
  }, [checking, localDev, pending, runSimulation, simulation, simulationError]);

  const markProofStale = useCallback(() => {
    props.onPreflight({ status: "idle" });
  }, [props.onPreflight]);

  const queuePayload = useCallback((payload: UnsignedPayload) => {
    setSignature(null);
    setSendError(null);
    setSimulation(null);
    setSimulationError(null);
    setPending((prev) => {
      dropExtraSigners(prev?.extraSigners);
      return payload;
    });
  }, []);

  const stageAction = useCallback((payload: StagedGovernanceAction) => {
    setStagedAction(payload);
    setInsertedSession(null);
  }, []);

  const clearStagedAction = useCallback(() => {
    setStagedAction(null);
  }, []);

  const confirmSend = useCallback(async () => {
    if (sendLock.current) {
      return;
    }
    if (!pending) {
      return;
    }
    if (pending.genesisMode !== "official-devnet" && !passed) {
      return;
    }
    if (!simulation || simulationError) {
      setSendError("refusing send: simulation has not passed");
      return;
    }
    sendLock.current = true;
    setSending(true);
    setSendPhase("signing");
    setSendError(null);
    const droppingMint = pending.extraSigners !== undefined;
    try {
      const result = await sendWithConnectedWallet({
        connection,
        verified: passed?.verified ?? null,
        wallet,
        payload: pending,
        reusePassedSimulation: true,
        onPhase: setSendPhase,
      });
      invalidateLiveMintCache();
      setSignature(result.signature);
      setSimulation({ logs: result.simulationLogs, unitsConsumed: null });
      setPending(null);
    } catch (error) {
      setSendError(formatError(error));
      if (droppingMint) {
        setPending(null);
      }
    } finally {
      sendLock.current = false;
      setSending(false);
      setSendPhase("idle");
    }
  }, [connection, passed, pending, simulation, simulationError, wallet]);

  const sendState = (
    <>
      {sendError ? (
        <div className="gate-fail">
          <pre>{sendError}</pre>
        </div>
      ) : null}
      {signature ? <p className="mono">Last signature: {signature}</p> : null}
    </>
  );

  const confirm = (
    <ConfirmSend
      payload={pending}
      busy={sending}
      cluster={props.config.cluster}
      genesisHash={genesis}
      rpcEndpoint={rpcEndpoint}
      simulation={simulation}
      simulationError={simulationError}
      operatorView={localDev}
      sendPhase={sendPhase}
      checking={checking}
      sendError={sendError}
      onCancel={() => {
        if (sendLock.current) {
          return;
        }
        setPending((prev) => {
          dropExtraSigners(prev?.extraSigners);
          return null;
        });
        setSimulation(null);
        setSimulationError(null);
      }}
      onSimulate={runSimulation}
      onConfirm={() => void confirmSend()}
    />
  );

  // ---- operator console: sidebar and one workspace ----
  //
  // The six-tab strip is gone. Every builder that existed under those tabs is
  // still mounted by exactly the same component with exactly the same props;
  // only which one is on screen, and how it is grouped, has changed.
  if (localDev) {
    const walletPanel = (
      <section className="panel wallet-bar">
        <div>
          <h2>Wallet Standard</h2>
          <p className="muted">
            <code>{"WalletProvider wallets={[]}"}</code>. No per-wallet adapters. Confirm the
            wallet is on <span className="mono">{props.config.cluster}</span> (
            {walletNetworkForCluster(props.config.cluster)}) before signing. This app never
            receives private keys.
          </p>
        </div>
        <WalletMultiButton />
      </section>
    );

    return (
      <div className="console">
        <aside className="console-nav">
          <div className="head">
            <div className="brand">
              <img src="/logo.png" className="kek" alt="" width={24} height={24} />
              <span className="wordmark">KEKBULL</span>
              <span className="pill bad">Console</span>
            </div>
            <div className="facts">
              <div>
                <span>cluster</span>
                <span>{props.config.cluster}</span>
              </div>
              <div>
                <span>preflight</span>
                <span>{props.preflight.status}</span>
              </div>
            </div>
          </div>
          <nav aria-label="Console sections">
            {NAV.map((group) => (
              <div className="group" key={group.label}>
                <p>{group.label}</p>
                {group.items.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-current={tab === item.id ? "page" : undefined}
                    onClick={() => setTab(item.id)}
                  >
                    <span>{item.label}</span>
                    {item.badge ? <span className="badge">{item.badge}</span> : null}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="who">
            <p className="key mono">
              {wallet.publicKey ? wallet.publicKey.toBase58() : "not connected"}
            </p>
            <p className="role">operator authority</p>
          </div>
        </aside>

        <main className="console-main">
          <div className="console-strip">
            <span>
              <span className="lbl">host</span>{" "}
              {typeof window === "undefined" ? "" : window.location.host}
            </span>
            <span>
              <span className="lbl">cluster</span> {props.config.cluster}
            </span>
            <span>
              <span className="lbl">preflight</span> {props.preflight.status}
            </span>
            <span>
              <span className="lbl">rpc</span> {rpcEndpoint}
            </span>
            <span className="who">
              <span className="mono">
                {wallet.publicKey ? wallet.publicKey.toBase58().slice(0, 4) + "…" : "unset"}
              </span>
              <span className="dot" />
            </span>
          </div>

          <div className="console-body">
            <h1>{PAGE_TITLE[tab]}</h1>
            {walletPanel}
            <Preflight
              config={props.config}
              state={props.preflight}
              onChange={props.onPreflight}
              operatorView
            />
            {sendState}

            {tab === "state" ? (
              <LiveState preflight={props.preflight} lastConfirmedSignature={signature} />
            ) : null}
            {tab === "config" ? (
              <ConfigForm
                config={props.config}
                loadError={props.loadError}
                onChange={props.onConfigChange}
                onLoadFile={props.onLoadFile}
              />
            ) : null}
            {tab === "burn" ? (
              <BurnPanel preflight={props.preflight} onRequestSend={queuePayload} />
            ) : null}
            {tab === "governance" ? (
              <Governance
                config={props.config}
                preflight={props.preflight}
                stagedAction={stagedAction}
                insertedSession={insertedSession}
                onStageAction={stageAction}
                onClearStagedAction={clearStagedAction}
                onInsertedSession={setInsertedSession}
                onRequestSend={queuePayload}
              />
            ) : null}
            {tab === "fees" ? (
              <>
                <TransferFees
                  preflight={props.preflight}
                  onRequestSend={queuePayload}
                  onStageAction={stageAction}
                  lastConfirmedSignature={signature}
                />
                <PumpCreatorFees
                  preflight={props.preflight}
                  onRequestSend={queuePayload}
                  lastConfirmedSignature={signature}
                />
              </>
            ) : null}
            {tab === "lock" ? (
              <LockAndFees
                config={props.config}
                preflight={props.preflight}
                onRequestSend={queuePayload}
                onStageAction={stageAction}
                onLockVerified={onLockVerified}
              />
            ) : null}
            {tab === "q3b" ? (
              <ThrowawayMint config={props.config} onRequestSend={queuePayload} />
            ) : null}

            {confirm}
          </div>
        </main>
      </div>
    );
  }

  // ---- holder page: one scrolling page, fixed reading order ----
  //
  // No wallet panel: connecting is chrome, not a step, so it lives in the
  // masthead. Preflight stays mounted here because it still runs the check and
  // still owns the failure screen, but it renders nothing while things are fine.
  //
  // Order changed 2026-08-25. Addresses moved above Succession: it is reference
  // material a holder is sent to check, so it should not be the last thing on
  // the page. Section markers carry a repeating group label so pairs of
  // sections read as belonging together.
  return (
    <>
      <Preflight
        config={props.config}
        state={props.preflight}
        onChange={props.onPreflight}
        operatorView={false}
      />
      {sendState}

      {/* Masthead Start here jumps to the LiveState hero. A hidden marker
          here used to win getElementById / hash nav and scroll nowhere. */}
      <LiveState
        preflight={props.preflight}
        lastConfirmedSignature={signature}
        stateBanner={
          <DaoStateBanner
            config={props.config}
            preflight={props.preflight}
            lockVerified={lockVerified}
          />
        }
      />

      <HolderSection
        id="treasury"
        idx="01"
        group="DAO treasury"
        kicker="What the DAO owns"
        note="On-chain mint totals first, then spendable treasury holdings. Your deposit is not part of the spendable pot."
      >
        <TreasuryAssets preflight={props.preflight} lockVerified={lockVerified} />
        <TransferFees
          preflight={props.preflight}
          onRequestSend={queuePayload}
          onStageAction={stageAction}
          operatorView={false}
          embedded
          lastConfirmedSignature={signature}
        />
        <PumpCreatorFees
          preflight={props.preflight}
          onRequestSend={queuePayload}
          embedded
          lastConfirmedSignature={signature}
        />
      </HolderSection>

      <HolderSection
        id="liquidity"
        idx="02"
        group="On chain"
        kicker="Locked liquidity"
        note="On-chain pool vaults. Meteora DAMM ICHOR/SOL is the locked position. The DAO's position receives 100% of the LP fee share; Meteora keeps a protocol fee. The source PumpSwap market is also shown when it exists. Those vaults are migrate-locked, not a DAO-held LP, and their fees are not this DAMM pot."
      >
        <LockAndFees
          config={props.config}
          preflight={props.preflight}
          onRequestSend={queuePayload}
          onStageAction={stageAction}
          operatorView={false}
          onLockVerified={onLockVerified}
        />
      </HolderSection>

      {/* The newcomer explainer: the whole path from holding KEKBULL to
          holding a vote. No figure is quoted here on purpose - the burn
          ratio is read from chain by the panels below. The 0.25% transfer
          fee is stated outright here by operator decision (2026-08-26):
          holders should never have to hunt for what a step costs. */}
      <HolderSection
        id="weight"
        idx="03"
        group="New here"
        kicker="Three steps from KEKBULL to a vote"
        note="Burning KEKBULL is what creates ICHOR. Depositing ICHOR is what creates a vote. The deposit is the one step that costs you anything: a 0.25% transfer fee, shown to the exact token on the Vote panel before you sign."
      >
        <div className="ladder">
          <div className="step">
            <span className="n">1</span>
            <h3>Burn</h3>
            <p className="fig">
              Your KEKBULL is destroyed for good, and you receive ICHOR in the same transaction.
            </p>
          </div>
          <div className="step net">
            <span className="n">2</span>
            <h3>Deposit</h3>
            <p className="fig">
              You move ICHOR to the DAO to vote with it. The token withholds a 0.25% transfer fee
              as it moves, so 1,000 ICHOR deposits as 997.50.
            </p>
          </div>
          <div className="step weight">
            <span className="n">3</span>
            <h3>Vote weight</h3>
            <p className="fig">
              You vote with the ICHOR that arrives, so 997.50 rather than the 1,000 you sent. You
              can withdraw it later, and the same 0.25% applies on the way out.
            </p>
          </div>
        </div>
      </HolderSection>

      <HolderSection
        id="handbook"
        idx="04"
        kicker="How this DAO works"
        note="Open a question. Every figure in here is read live, not typed into the page."
      >
        <Handbook
          config={props.config}
          preflight={props.preflight}
          lockVerified={lockVerified}
        />
      </HolderSection>

      <HolderSection
        id="burn"
        idx="05"
        group="What you can do"
        kicker="Burn KEKBULL for ICHOR"
        note="One transaction. Burning is permanent and the only way ICHOR is created."
        token="kek"
      >
        <BurnPanel
          preflight={props.preflight}
          onRequestSend={queuePayload}
          operatorView={false}
        />
      </HolderSection>

      <Proposals
        config={props.config}
        preflight={props.preflight}
        onRequestSend={queuePayload}
        lastConfirmedSignature={signature}
        onProofStale={markProofStale}
      />

      <HolderSection
        id="addresses"
        idx="08"
        kicker="Published addresses"
        note="Check these on an explorer rather than taking this page's word for them."
      >
        <DeploymentFacts config={props.config} preflight={props.preflight} />
      </HolderSection>

      <HolderSection
        id="continuity"
        idx="09"
        group="Check it yourself"
        kicker="If the community needs to take over"
        note="Voting happens on-chain, and this site is not the only door to it."
      >
        <Succession config={props.config} preflight={props.preflight} />
      </HolderSection>

      {confirm}
    </>
  );
}
