import {
  GOVERNANCE_UI_PREVIEW_HOST,
  canonicalizeHostname,
  isGovernanceSigningAllowed,
  isKekbullPublicHost,
  isLocalGovernanceDevHost,
  isOfficialGovernanceHost,
} from "../config.ts";

export function HostWarning() {
  const host = typeof window === "undefined" ? "" : window.location.hostname;
  const forbidden = isKekbullPublicHost(host);

  if (forbidden) {
    return (
      <section className="banner critical" role="alert">
        <h2>Do not host this UI on {host || "this kekbull.com name"}</h2>
        <p>
          This page is being served from <span className="mono">{host}</span>. Wallet, preflight,
          transaction panels, and the send path are not mounted.{" "}
          <strong>kekbull.com must never ship a wallet widget</strong>. Telegram moderators treat
          an in-site connect control as a scam, and the public site CSP is
          <code>{" connect-src 'self'"}</code> only.
        </p>
        <p>
          The only named public host is <span className="mono">dao.kekbull.com</span>. Root
          kekbull.com and www stay wallet-free marketing. Other{" "}
          <span className="mono">*.kekbull.com</span> names stay fail-closed unless explicitly
          named. Same VPS is allowed; do not fold this origin into SolCreatorHub. This app never
          receives private keys.
        </p>
      </section>
    );
  }

  if (isOfficialGovernanceHost(host)) {
    if (canonicalizeHostname(host) === GOVERNANCE_UI_PREVIEW_HOST) {
      return (
        <section className="banner" role="note">
          <h2>Official-devnet preview</h2>
          <p>
            This is <span className="mono">{GOVERNANCE_UI_PREVIEW_HOST}</span>, a named preview of
            the same app against official Solana devnet. Nothing here is real money. The mainnet
            origin is <span className="mono">dao.kekbull.com</span>. This app never receives
            private keys.
          </p>
        </section>
      );
    }
    return (
      <section className="banner" role="note">
        <h2>Official DAO origin</h2>
        <p>
          This is <span className="mono">dao.kekbull.com</span>, the mainnet host for this app.
          Marketing at kekbull.com stays wallet-free. This origin has its own static root. No
          analytics. No backend secrets. This app never receives private keys.
        </p>
      </section>
    );
  }

  if (isLocalGovernanceDevHost(host)) {
    return (
      <section className="banner" role="note">
        <h2>Local development origin</h2>
        <p>
          Loopback only. The public signing host is <span className="mono">dao.kekbull.com</span>.
          Do not copy <span className="mono">dist/</span> to an IP or staging hostname. Those
          origins do not mount the wallet.
        </p>
      </section>
    );
  }

  if (!isGovernanceSigningAllowed(host)) {
    return (
      <section className="banner critical" role="alert">
        <h2>Unauthorized origin</h2>
        <p>
          This page is being served from <span className="mono">{host || "(empty host)"}</span>.
          Wallet, preflight, transaction panels, and the send path are not mounted. The only
          public signing host is <span className="mono">dao.kekbull.com</span>. A rehosted copy
          of this bundle is not the DAO.
        </p>
      </section>
    );
  }

  return null;
}
