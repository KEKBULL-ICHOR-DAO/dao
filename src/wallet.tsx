import { WalletAdapterNetwork, type Adapter } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { ConnectionConfig } from "@solana/web3.js";
import type { ReactNode } from "react";
import { useMemo } from "react";
import {
  isGovernanceSigningAllowed,
  OFFICIAL_HTTP_RPC,
  type DeploymentConfig,
  type UiClusterName,
} from "./config.ts";
import { createOfficialFallbackFetch } from "./rpc-failover.ts";

const WALLET_STANDARD_ONLY: Adapter[] = [];

export function walletNetworkForCluster(
  cluster: DeploymentConfig["cluster"],
): WalletAdapterNetwork {
  return cluster === "mainnet-beta" ? WalletAdapterNetwork.Mainnet : WalletAdapterNetwork.Devnet;
}

/**
 * HTTP reads only. `new Connection(httpUrl)` otherwise derives a `wss://`
 * twin and keeps it. On loopback `/rpc` that WS cannot upgrade; on public
 * official-devnet it 429s and retries. Either way every remount added
 * another Phantom contentscript stream (`MaxListenersExceededWarning` on
 * `close`/`end`, then `ERR_INSUFFICIENT_RESOURCES`). Port 9 refuses the
 * socket immediately so the client cannot accumulate those emitters.
 */
const HTTP_ONLY: ConnectionConfig = {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
  wsEndpoint: "ws://127.0.0.1:9",
};

export function WalletRoot(props: {
  rpcUrl: string;
  cluster: UiClusterName;
  children: ReactNode;
}) {
  const wallets = useMemo(() => WALLET_STANDARD_ONLY, []);
  const host = typeof window === "undefined" ? "" : window.location.hostname;
  if (!isGovernanceSigningAllowed(host)) {
    throw new Error(
      "FORBIDDEN_HOST: WalletRoot may mount on a named governance origin or loopback, not an unsigned host",
    );
  }
  const connectionConfig = useMemo(
    () => ({
      ...HTTP_ONLY,
      fetch: createOfficialFallbackFetch({
        fallbackUrl: OFFICIAL_HTTP_RPC[props.cluster],
      }),
    }),
    [props.cluster],
  );
  // ConnectionProvider memoizes `new Connection(endpoint, config)` on
  // `[endpoint, config]`. An inline `{ commitment: "confirmed" }` is a new
  // object every render, so the Connection identity churns and live reads
  // fail CONNECTION_MISMATCH against the preflight-bound instance.
  //
  // autoConnect is off on purpose. Vite HMR and React remounts were calling
  // Phantom `connect` again without dropping the previous multiplex. The
  // operator clicks Connect once.
  return (
    <ConnectionProvider endpoint={props.rpcUrl} config={connectionConfig}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>{props.children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
