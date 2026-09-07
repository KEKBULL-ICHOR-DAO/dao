import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { operatorOnly, readWebsite, websiteRoot } from "./operator-tree.ts";
import { fileURLToPath } from "node:url";
import {
  harvestSourceLinesPresent,
  parseHarvestSourceLines,
} from "../src/harvest-sources.ts";
import {
  OPERATOR_CREATOR_FEE_BENEFICIARY,
  requireOperatorCreatorBeneficiary,
} from "../src/creator-beneficiary.ts";
import { groupUiAmount, parseUiToBaseUnits } from "../src/format.ts";
import {
  isOperatorConsoleUnlocked,
  operatorAuthoritiesFromProofs,
} from "../src/operator-access.ts";
import { PublicKey } from "@solana/web3.js";
import {
  THROWAWAY_Q3B_TOKEN_2022_PROGRAM_ID,
  THROWAWAY_Q3B_TRANSFER_FEE_BASIS_POINTS,
  parseThrowawayMintInputs,
  throwawayMintInputsPresent,
} from "../src/throwaway-mint-inputs.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set(["node_modules", "dist"]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, acc);
    } else {
      acc.push(path);
    }
  }
  return acc;
}

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function textSources(): Array<{ rel: string; text: string }> {
  return walk(root)
    .filter((path) => /\.(ts|tsx|js|jsx|json|html|css|md)$/.test(path))
    .map((path) => ({ rel: relative(root, path), text: readFileSync(path, "utf8") }));
}

function exportedFn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing export async function ${name}`);
  let next = source.indexOf("\nexport async function ", start + 1);
  if (next === -1) {
    next = source.indexOf("\nexport function ", start + 1);
  }
  return source.slice(start, next === -1 ? undefined : next);
}

function assertBoundBeforeRpc(fn: string, name: string, rpcNeedle: string): void {
  const assertPos = fn.indexOf("assertBoundConnection");
  const rpcPos = fn.indexOf(rpcNeedle);
  assert.notEqual(assertPos, -1, `${name} must call assertBoundConnection`);
  assert.notEqual(rpcPos, -1, `${name} must call ${rpcNeedle}`);
  assert.ok(assertPos < rpcPos, `${name} must assertBoundConnection before ${rpcNeedle}`);
}

describe("governance-ui source hygiene", () => {
  it("pins the audited dependency set and no install hooks", () => {
    const pkg = JSON.parse(read("package.json")) as {
      private?: boolean;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };
    assert.equal(pkg.private, true);
    assert.deepEqual(Object.keys(pkg.scripts ?? {}).sort(), ["build", "dev", "preview", "test", "typecheck"]);
    assert.equal(pkg.scripts?.dev, "vite --host 127.0.0.1 --port 5180 --strictPort");
    assert.equal(pkg.scripts?.build, "vite build");
    assert.equal(pkg.scripts?.preview, "vite preview --host 127.0.0.1 --port 5181 --strictPort");
    assert.equal(pkg.scripts?.test, "node --experimental-strip-types --test tests/*.test.ts");
    assert.equal(pkg.scripts?.typecheck, "tsc --noEmit");
    for (const name of ["preinstall", "install", "postinstall", "prepare", "prepublish"]) {
      assert.equal(pkg.scripts?.[name], undefined);
    }
    assert.deepEqual(pkg.dependencies, {
      "@kekbull/ichor-client": "file:../client",
      "@solana/spl-token": "0.4.15",
      "@solana/wallet-adapter-base": "0.9.27",
      "@solana/wallet-adapter-react": "0.15.39",
      "@solana/wallet-adapter-react-ui": "0.9.39",
      "@solana/web3.js": "1.98.4",
      "bn.js": "5.2.5",
      react: "19.2.8",
      "react-dom": "19.2.8",
    });
    assert.deepEqual(pkg.devDependencies, {
      "@types/bn.js": "5.2.0",
      "@types/react": "19.2.18",
      "@types/react-dom": "19.2.4",
      "@vitejs/plugin-react": "6.1.0",
      typescript: "7.0.2",
      vite: "8.2.2",
    });
    assert.deepEqual(pkg.overrides, {
      chain: "file:../client/vendor/chain-stub",
      axios: "1.19.0",
      "@solana-mobile/wallet-adapter-mobile": "2.2.5",
      "@solana/wallet-standard-wallet-adapter-react": "1.1.6",
    });
  });

  it("binds Vite to 127.0.0.1 and supplies Buffer/process without npm polyfill plugins", () => {
    const vite = read("vite.config.ts");
    assert.match(vite, /host:\s*"127\.0\.0\.1"/);
    assert.match(vite, /port:\s*5180/);
    assert.match(vite, /port:\s*5181/);
    assert.doesNotMatch(vite, /0\.0\.0\.0/);
    assert.doesNotMatch(vite, /node-polyfill|node-stdlib-browser|vite-plugin-node-polyfills|process\/browser/);
    assert.match(vite, /plugin-react/);
    assert.match(vite, /function nodeGlobals/);
    assert.match(vite, /globalThis\.Buffer/);
    assert.match(vite, /globalThis\.process/);
    assert.doesNotMatch(vite, /HELIUS_/);
    assert.match(vite, /apply:\s*"serve"/);
    assert.match(vite, /official-devnet-kekbull\.json/);
    assert.doesNotMatch(vite, /official-devnet-throwaway\.json/);
    assert.match(vite, /https:\/\/api\.devnet\.solana\.com/);
    assert.match(vite, /const LOOPBACK_RPC = "\/rpc"/);
    assert.match(vite, /ICHOR_DEVNET_RPC/);
    assert.match(vite, /rpcUrl: LOOPBACK_RPC/);
    assert.match(read("src/config.ts"), /export function resolveBrowserRpcUrl/);
    assert.match(read("src/config.ts"), /relative rpcUrl is a named governance origin or loopback only/);
    assert.match(read("src/config.ts"), /ERR_INSUFFICIENT_RESOURCES/);
    assert.match(read("src/App.tsx"), /resolveBrowserRpcUrl\(/);
    assert.doesNotMatch(vite, /deployment\.json[\s\S]{0,400}HELIUS_/);
    const published = JSON.parse(read("public/deployment.json")) as {
      cluster: unknown;
      ichorProgram: unknown;
      ichorMint: unknown;
      kekbullMint: unknown;
      realm: unknown;
      voteProgram: unknown;
      rpcUrl: unknown;
    };
    const mainnetNamed = JSON.parse(read("public/deployment.mainnet.json")) as {
      cluster: unknown;
      ichorProgram: unknown;
      ichorMint: unknown;
      kekbullMint: unknown;
      realm: unknown;
    };
    const devnetNamed = JSON.parse(read("public/deployment.devnet.json")) as {
      cluster: unknown;
      ichorProgram: unknown;
      realm: unknown;
      rpcUrl: unknown;
    };
    const fixture = JSON.parse(read("fixtures/official-devnet-kekbull.json")) as {
      cluster: unknown;
      ichorProgram: unknown;
      realm: unknown;
      rpcUrl: unknown;
    };
    assert.equal(published.cluster, "mainnet-beta");
    assert.equal(published.ichorProgram, "DmnfCzQNbx4ZAWEwBoAKqTALgwuUXwYxZL1dRqXoZ1Md");
    assert.equal(published.ichorMint, "61fHeSXmBuJMbqsYKVqgXifJDV8v9zzF7rFpysNT3Mq2");
    assert.equal(published.kekbullMint, "CKFvy16Gd8kadtCmNyu9r91TYgyvrbJnsJey8McFpump");
    assert.equal(published.realm, "EJQ83ay57EH84wmqBk8r1dsqN7PSVmP83mY1DArq7ft9");
    assert.equal(published.voteProgram, "2uNHeSLiNn6dLLtiGrpCd8UZKBfV36kap57eg9kV39Fj");
    assert.equal(published.rpcUrl, "");
    assert.equal(mainnetNamed.cluster, "mainnet-beta");
    assert.equal(mainnetNamed.ichorProgram, published.ichorProgram);
    assert.equal(mainnetNamed.ichorMint, published.ichorMint);
    assert.equal(mainnetNamed.kekbullMint, published.kekbullMint);
    assert.equal(mainnetNamed.realm, published.realm);
    assert.deepEqual(published, JSON.parse(read("public/deployment.mainnet.json")));
    assert.equal(devnetNamed.cluster, "devnet");
    assert.equal(devnetNamed.ichorProgram, fixture.ichorProgram);
    assert.equal(devnetNamed.realm, fixture.realm);
    assert.equal(devnetNamed.rpcUrl, "/rpc");
    assert.equal(fixture.rpcUrl, "https://api.devnet.solana.com");
    assert.notEqual(published.cluster, devnetNamed.cluster);
    assert.match(vite, /function refuseWrongDistDeployment/);
    assert.match(vite, /assertShippedDeploymentJson/);
    assert.match(vite, /apply:\s*"build"/);
    assert.match(vite, /function stripNamedDeploymentJson/);
    assert.match(vite, /deployment\.devnet\.json/);
    assert.match(vite, /deployment\.mainnet\.json/);
    assert.match(vite, /unlinkSync/);
    assert.match(vite, /config\.build\.outDir/);
    assert.match(vite, /only guarded \$\{GUARDED_DEPLOYMENT_JSON\} may ship|only guarded deployment\.json may ship/);
    assert.match(read("scripts/deployment-guard.ts"), /must stay null until PLAN §15\.3 D/);
    assert.match(read("scripts/deployment-guard.ts"), /arbitrary non-null values are refused/);
    assert.match(read("scripts/deployment-guard.ts"), /EJQ83ay57EH84wmqBk8r1dsqN7PSVmP83mY1DArq7ft9/);
    assert.match(read("scripts/publish-deployment.ts"), /getMultipleAccountsInfo/);
    assert.match(read("scripts/publish-deployment.ts"), /"finalized"/);
    assert.doesNotMatch(read("scripts/publish-deployment.ts"), /mock|placeholder|TODO/i);
    const publishTest = read("tests/publish-deployment.test.ts");
    const sdkLoadStart = publishTest.indexOf("const INSTALLED_CLIENT_PACKAGE_JSON");
    const sdkLoadEnd = publishTest.indexOf("const ICHOR_DECIMALS");
    const sdkSuiteStart = publishTest.indexOf('describe("independent SDK cross-check"');
    assert.notEqual(sdkLoadStart, -1, "publish-deployment test must load the installed client SDK");
    assert.notEqual(sdkLoadEnd, -1, "SDK load must stay a top-level require");
    assert.notEqual(sdkSuiteStart, -1, "independent SDK cross-check suite must register");
    assert.ok(sdkLoadStart < sdkLoadEnd && sdkLoadEnd < sdkSuiteStart, "SDK load must run before the suite registers");
    const sdkLoad = publishTest.slice(sdkLoadStart, sdkLoadEnd);
    assert.match(sdkLoad, /createRequire\(INSTALLED_CLIENT_PACKAGE_JSON\)/);
    assert.match(sdkLoad, /"client", "package\.json"/);
    assert.match(sdkLoad, /requireInstalledClientSdk\(\["@realms-today", "spl-governance"\]\.join\("\/"\)\)/);
    assert.doesNotMatch(sdkLoad, /\btry\b|\bcatch\b|\.skip\b|MODULE_NOT_FOUND/);
    assert.doesNotMatch(publishTest, /createRequire\(import\.meta\.url\)/);
    const sdkSuite = publishTest.slice(sdkSuiteStart, publishTest.indexOf('describe("source shape"'));
    assert.match(sdkSuite, /it\("matches installed Realms PDA helpers/);
    assert.match(sdkSuite, /it\("matches the installed SPL Token mint decoder/);
    assert.doesNotMatch(sdkSuite, /\bit\.skip\b|\bdescribe\.skip\b|\.skip\(/);
    assert.doesNotMatch(sdkSuite, /\btry\b|\bcatch\b/);
    const throwaway = JSON.parse(read("fixtures/official-devnet-throwaway.json")) as {
      cluster: string;
      realmsInstance: string;
      rpcUrl: string;
      ichorProgram: string;
      kekbullMint: unknown;
    };
    assert.equal(throwaway.cluster, "devnet");
    assert.equal(throwaway.realmsInstance, "default-shared");
    assert.equal(throwaway.rpcUrl, "https://api.devnet.solana.com");
    assert.equal(throwaway.ichorProgram, "EYmwwr14Te83LWPkiv7UdmqygK7QrFWYt5incCjwTy6E");
    assert.equal(throwaway.kekbullMint, null);
    assert.equal(existsSync(join(root, "public", "official-devnet-throwaway.json")), false);
  });

  it("is a client-only Wallet Standard SPA", () => {
    const wallet = read("src/wallet.tsx");
    const html = read("index.html");
    const app = read("src/App.tsx");
    assert.match(wallet, /wallets=\{wallets\}/);
    assert.match(wallet, /const WALLET_STANDARD_ONLY:\s*Adapter\[\]\s*=\s*\[\]/);
    assert.match(app, /WalletProvider wallets=\{\[\]\}/);
    assert.match(html, /<title>ICHOR Governance<\/title>/);
    assert.match(app, /document\.title = operatorView \? "ICHOR Console" : "ICHOR Governance"/);
    assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//);
    assert.doesNotMatch(html, /unpkg|jsdelivr|cdnjs|cdn\./);
    assert.doesNotMatch(html, /next\/|react-router/);
  });

  it("does not auto-reconnect Phantom or open a real RPC websocket", () => {
    const wallet = read("src/wallet.tsx");
    const main = read("src/main.tsx");
    const vite = read("vite.config.ts");
    assert.match(wallet, /autoConnect=\{false\}/);
    assert.doesNotMatch(wallet, /<WalletProvider[^>]*\bautoConnect(?!\s*=\{false\})/);
    assert.match(wallet, /disableRetryOnRateLimit:\s*true/);
    assert.match(wallet, /wsEndpoint:\s*"ws:\/\/127\.0\.0\.1:9"/);
    assert.doesNotMatch(main, /<StrictMode|from ["']react["'].*StrictMode/);
    assert.match(vite, /upgrade.*websocket/);
    assert.match(vite, /statusCode = 426/);
  });

  it("fail-closes unnamed kekbull.com hosts before any wallet or send mount", () => {
    const config = read("src/config.ts");
    const app = read("src/App.tsx");
    const wallet = read("src/wallet.tsx");
    const warning = read("src/panels/HostWarning.tsx");
    assert.match(config, /export const GOVERNANCE_UI_HOST = "dao\.kekbull\.com"/);
    assert.match(config, /export const GOVERNANCE_UI_PREVIEW_HOST = "devnet\.dao\.kekbull\.com"/);
    assert.match(config, /GOVERNANCE_UI_HOST,\s*GOVERNANCE_UI_PREVIEW_HOST/);
    assert.match(config, /if \(NAMED_GOVERNANCE_HOSTS\.has\(host\)\) \{\s*return false;/);
    assert.match(config, /host === KEKBULL_APEX \|\| host\.endsWith\(`\.\$\{KEKBULL_APEX\}`\)/);
    assert.match(config, /canonicalizeHostname/);
    assert.doesNotMatch(
      config,
      /return host === "kekbull\.com" \|\| host\.endsWith\("\.kekbull\.com"\);/,
    );
    const gateStart = app.indexOf("if (!isGovernanceSigningAllowed(host))");
    assert.notEqual(gateStart, -1);
    const allowed = app.indexOf("return <AllowedHostApp", gateStart);
    assert.notEqual(allowed, -1);
    const gate = app.slice(gateStart, allowed);
    assert.match(gate, /return <HostWarning \/>;/);
    assert.doesNotMatch(
      gate,
      /WalletRoot|ConnectedApp|ConfirmSend|sendWithConnectedWallet|WalletProvider|BurnPanel/,
    );
    assert.match(app, /if \(!isGovernanceSigningAllowed\(host\)\)/);
    assert.match(wallet, /FORBIDDEN_HOST/);
    assert.match(wallet, /named governance origin or loopback/);
    assert.match(wallet, /isGovernanceSigningAllowed\(host\)/);
    assert.match(warning, /kekbull\.com must never ship a wallet widget/);
    assert.match(warning, /transaction panels, and the send path are not mounted/);
    assert.match(warning, /dao\.kekbull\.com/);
    assert.match(warning, /isOfficialGovernanceHost/);
    assert.match(warning, /Unauthorized origin/);
    assert.match(config, /export function isGovernanceSigningAllowed/);
    assert.match(config, /isOfficialGovernanceHost\(hostname\) \|\| isLocalGovernanceDevHost/);

    const cases: Array<[string, boolean, boolean, boolean]> = [
      ["dao.kekbull.com", false, true, true],
      ["DAO.kekbull.com.", false, true, true],
      ["devnet.dao.kekbull.com", false, true, true],
      ["kekbull.com", true, false, false],
      ["www.kekbull.com", true, false, false],
      ["app.kekbull.com", true, false, false],
      ["www.dao.kekbull.com", true, false, false],
      ["dao.kekbull.com.evil.com", false, false, false],
      ["devnet.dao.kekbull.com.evil.com", false, false, false],
      ["203.0.113.10", false, false, false],
      ["127.0.0.1", false, false, true],
      ["localhost", false, false, true],
    ];
    for (const [host, forbidden, official, signing] of cases) {
      const canonical = host.trim().toLowerCase().replace(/\.$/, "");
      const isOfficial =
        canonical === "dao.kekbull.com" || canonical === "devnet.dao.kekbull.com";
      const isForbidden =
        !isOfficial &&
        (canonical === "kekbull.com" || canonical.endsWith(".kekbull.com"));
      const isLocal =
        canonical === "localhost" ||
        canonical === "127.0.0.1" ||
        canonical === "[::1]" ||
        canonical === "::1";
      const isSigning = isOfficial || isLocal;
      assert.equal(isForbidden, forbidden, `${host} forbidden`);
      assert.equal(isOfficial, official, `${host} official`);
      assert.equal(isSigning, signing, `${host} signing`);
    }
  });

  it("does not claim the browser never holds a key", () => {
    const hits: string[] = [];
    for (const file of textSources()) {
      if (file.rel === "tests/source-hygiene.test.ts") {
        continue;
      }
      if (
        /browser never holds|never holds a (private )?key|does not hold a private key|never holds keys/i.test(
          file.text,
        )
      ) {
        hits.push(file.rel);
      }
    }
    assert.deepEqual(hits, []);
    assert.match(read("src/App.tsx"), /This app never receives private keys/);
    assert.match(read("README.md"), /This app never receives private keys/);
  });

  it("uses the verified burn builder and does not fake vote or treasury data", () => {
    const burn = read("src/panels/Burn.tsx");
    const gov = read("src/panels/Governance.tsx");
    const live = read("src/panels/LiveState.tsx");
    const lock = read("src/panels/LockAndFees.tsx");
    const app = read("src/App.tsx");
    assert.match(burn, /buildConvertInstruction/);
    assert.match(burn, /verifiedConfig/);
    assert.match(burn, /built\.expectedIchorAmount/);
    assert.match(burn, /built\.unsigned\.instructions/);
    assert.match(burn, /deriveVerifiedNativeTreasury/);
    // The treasury option must say the address is DERIVED, not typed. This used
    // to pin the operator-register label "Verified Realms native treasury"; the
    // holder copy now states the property in plain language, which is a stronger
    // disclosure. Assert the guarantee, not the wording.
    assert.match(burn, /derived from the verified governance/);
    assert.match(burn, /recipientKind/);
    assert.doesNotMatch(burn, /buildInitializeInstruction|Build initialize/);
    assert.match(burn, /Protocol initialization is intentionally absent/);
    assert.match(burn, /parseUiToBaseUnits/);
    assert.match(burn, /readBurnLiveState/);
    assert.match(burn, /sourceMintName|sourceLabel/);
    assert.match(read("src/chain.ts"), /tokenMetadata/);
    assert.match(burn, /minIchorAmount|Signed min ICHOR/);
    assert.match(burn, /ichorFromKekbull/);
    assert.match(burn, /as you type from the verified Config ratio/);
    assert.match(burn, /burn-grid/);
    assert.match(burn, /className="build"/);
    assert.match(burn, /className="effect"/);
    assert.match(burn, /Preview this burn/);
    // Minting is not a transfer - Design keeps fee math off this panel.
    assert.match(burn, /Minting is not a transfer/);
    assert.match(burn, /deposit builder shows gross/);
    assert.match(read("src/chain.ts"), /calculateToken2022TransferFee|parseIchorTransferFeeConfig/);
    assert.match(burn, /irreversible/);
    assert.doesNotMatch(burn, /computed when you preview/);
    assert.doesNotMatch(burn, /Least ICHOR you will accept/);
    assert.doesNotMatch(burn, /minIchorUi/);
    assert.match(burn, /onRequestSend/);
    assert.match(burn, /Expected ICHOR at observed ratio/);
    assert.match(burn, /totalKekbullBurned/);
    assert.doesNotMatch(burn, /BURN_BUILDER_BLOCKED|CONVERT_BUILDER_PARAMS/);
    assert.doesNotMatch(burn, /900000/);
    assert.doesNotMatch(burn, /ichor_from_kekbull/);
    assert.doesNotMatch(burn, /you will receive/i);
    assert.doesNotMatch(burn, /You vote with less than you burned/);
    assert.doesNotMatch(burn, /title="You vote with"/);
    assert.doesNotMatch(burn, /FEE_BASIS_POINTS|function feeOn/);
    assert.match(burn, /This burn credits the full minted ICHOR/);
    assert.match(burn, /Fee beneficiaries are not bound on this Config yet/);
    assert.doesNotMatch(burn, /new\s+TransactionInstruction/);
    assert.doesNotMatch(burn, /discriminator\s*[:=]/);
    assert.match(app, /<BurnPanel/);
    assert.match(app, /onRequestSend=\{queuePayload\}/);
    assert.match(burn, /const convertPaused = Boolean\(verifiedConfig\?\.config\.paused\)/);
    assert.match(burn, /disabled=\{!verifiedConfig \|\| !wallet\.publicKey \|\| convertPaused\}/);
    const buildConvert = burn.slice(burn.indexOf("async function buildConvert"));
    assert.match(buildConvert, /if \(convertPaused\)/);
    const pausedStart = burn.indexOf("convertPaused ? (");
    const pausedEmptyClose = burn.indexOf("</div>", burn.indexOf("public transaction."));
    const pausedBranch = burn.slice(pausedStart, pausedEmptyClose);
    assert.match(pausedBranch, /className="empty"/);
    assert.doesNotMatch(pausedBranch, /gate-fail/);
    assert.match(burn, /className="burn-grid"/);
    assert.ok(
      burn.indexOf('className="burn-grid"') > burn.indexOf("convertPaused ? ("),
      "burn-grid must stay outside the paused empty branch",
    );
    assert.match(read("src/dao-state.ts"), /Burning opens after graduation/);
    assert.match(burn, /Holder convert opens later/);
    assert.doesNotMatch(burn, /Burning opens when the pool is live/);
    assert.doesNotMatch(gov, /VOTE_BUILDER_UNAVAILABLE/);
    assert.doesNotMatch(gov, /withCastVote/);
    assert.match(lock, /buildHandoffPositionRightsToTreasury/);
    assert.match(lock, /verifyPositionRightsHandoff/);
    assert.match(lock, /verifiedGovernanceIdentity/);
    assert.match(lock, /sourcePositionNftAccount/);
    assert.match(lock, /buildClaimPositionFeeToTreasury/);
    assert.match(lock, /onStageAction/);
    assert.match(app, /<LockAndFees/);
    assert.match(app, /<Handbook/);
    assert.match(app, /id="handbook"/);
    assert.ok(
      app.indexOf('id="weight"') < app.indexOf('id="handbook"') &&
        app.indexOf('id="handbook"') < app.indexOf('id="burn"'),
      "handbook sits after Three steps and before Burn",
    );
    assert.match(read("src/panels/Handbook.tsx"), /export function Handbook/);
    assert.match(app, /<Succession/);
    // Pins the disclosure, not the wording: the panel must tell a holder the DAO
    // survives without the token dev, and must not re-adopt "operator" for them.
    assert.match(app, /community needs to take over/);
    assert.doesNotMatch(read("src/panels/Succession.tsx"), /without the operator\b/);
    assert.match(read("src/panels/Succession.tsx"), /className="topic"/);
    assert.match(read("src/panels/Succession.tsx"), /className="topic-grid topic-grid-two"/);
    assert.match(read("src/panels/Succession.tsx"), /className="topic-grid topic-grid-three"/);
    assert.match(read("src/panels/Succession.tsx"), /className="dl"/);
    assert.doesNotMatch(read("src/panels/Succession.tsx"), /className="dl prose"/);
    assert.doesNotMatch(read("src/panels/Succession.tsx"), /className="panel"/);
    assert.match(read("src/styles.redesign.css"), /#succession \.topic/);
    assert.match(read("src/styles.redesign.css"), /border-left: 2px solid var\(--gold\)/);
    assert.match(read("src/styles.redesign.css"), /#succession \.topic-grid/);
    assert.match(read("src/styles.redesign.css"), /max-width: none;/);
    assert.match(read("src/styles.css"), /#root \{\s*max-width: var\(--shell\)/);
    assert.match(read("src/styles.redesign.css"), /#root \{\s*max-width: var\(--shell\)/);
    assert.match(read("src/panels/Succession.tsx"), /unforeseen/);
    assert.doesNotMatch(read("src/panels/Succession.tsx"), /lost interest/);
    assert.doesNotMatch(
      read("src/panels/Succession.tsx"),
      /deliberately dull|Stated plainly|question worth answering/,
    );
    assert.match(read("src/panels/Succession.tsx"), /app\.realms\.today/);
    assert.match(read("src/panels/Succession.tsx"), /kekbull_governance/);
    assert.match(read("src/panels/Succession.tsx"), /published sunset/);
    assert.match(app, /onRequestSend=\{queuePayload\}/);
    assert.match(app, /onStageAction=\{stageAction\}/);
    assert.match(live, /no token read attempted/);
    assert.match(lock, /policy text/);
    assert.match(lock, /verifyPermanentLock|readPermanentLock|readLockedDammReserves/);
    assert.match(lock, /readSourceAmmReserves/);
    assert.match(
      lock,
      /useThrottledLiveRefresh\(\s*!operatorView && Boolean\(passed\) && lockPublished/,
    );
    assert.match(lock, /Refresh lock/);
    assert.doesNotMatch(lock, /900000/);
    assert.doesNotMatch(live, /900000/);
  });

  it("operates the one-way ICHOR fee binding, harvest, and fixed distribution", () => {
    const app = read("src/App.tsx");
    const fees = read("src/panels/TransferFees.tsx");
    const harvestSrc = read("src/harvest-sources.ts");
    assert.match(app, /<TransferFees/);
    assert.match(fees, /buildSetFeeDistribution/);
    assert.match(fees, /buildCollectTransferFees/);
    assert.match(fees, /buildHarvestWithheldTokensToMint/);
    assert.match(fees, /buildDistributeTransferFees/);
    assert.match(fees, /Collect fees/);
    assert.match(fees, /className="collect-action"/);
    assert.match(fees, /measureCanonicalHarvestSources/);
    assert.match(fees, /previewDistributeTransferFees/);
    assert.match(fees, /creatorSecondHop\.expectedNet/);
    assert.match(fees, /realmsSecondHop\.expectedNet/);
    assert.match(fees, /Ready to collect/);
    assert.match(fees, /embedded/);
    assert.match(app, /<TransferFees/);
    assert.match(app, /<PumpCreatorFees/);
    assert.match(app, /<PumpCreatorFees/);
    assert.match(read("src/styles.css"), /button\.collect-action:disabled/);
    assert.match(fees, /permanently bind ICHOR fee beneficiaries/);
    assert.match(fees, /25% creator \/ 75% Realms/);
    assert.match(fees, /program escrow/);
    assert.match(fees, /buildAcceptAuthority/);
    assert.match(fees, /buildClaimCreatorFees/);
    assert.match(fees, /buildSweepUnclaimedCreatorFees/);
    assert.match(fees, /buildSetCreatorBeneficiary/);
    assert.match(fees, /does not scan wallets or invent sources/);
    assert.match(fees, /harvest sources are required before bind/);
    assert.match(fees, /OPERATOR_CREATOR_FEE_BENEFICIARY/);
    assert.match(fees, /requireOperatorCreatorBeneficiary/);
    assert.equal(
      OPERATOR_CREATOR_FEE_BENEFICIARY,
      "5E6eeUqF2UunqwGDavfCgh28smQe88JSN7MXGvCdh4Zd",
    );
    assert.equal(
      requireOperatorCreatorBeneficiary(OPERATOR_CREATOR_FEE_BENEFICIARY).toBase58(),
      OPERATOR_CREATOR_FEE_BENEFICIARY,
    );
    assert.throws(
      () => requireOperatorCreatorBeneficiary("9WTrAXbq3vpWNqmHcBNpjGC3E9jMebVByFDKYZTVTf6A"),
      /pinned operator wallet/,
    );
    assert.match(fees, /expectedCreatorNet/);
    assert.match(fees, /expectedRealmsNet/);
    assert.match(fees, /parseHarvestSourceLines/);
    assert.match(fees, /harvestSourceLinesPresent\(harvestSources\)/);
    assert.match(harvestSrc, /export function parseHarvestSourceLines/);
    assert.match(harvestSrc, /paste at least one known Token-2022 ICHOR account to harvest/);
    assert.doesNotMatch(harvestSrc, /from ["']react["']/);
    assert.doesNotMatch(fees, /getProgramAccounts|getTokenAccountsByOwner|getTokenLargestAccounts/);
    const bindStart = fees.indexOf("async function bindDistribution");
    const harvestStart = fees.indexOf("async function harvest");
    assert.notEqual(bindStart, -1, "missing bindDistribution");
    const bindFn = fees.slice(bindStart, harvestStart === -1 ? undefined : harvestStart);
    const parsedPos = bindFn.indexOf("parsedSources()");
    const buildPos = bindFn.indexOf("buildSetFeeDistribution");
    assert.notEqual(parsedPos, -1, "bindDistribution must call parsedSources");
    assert.notEqual(buildPos, -1, "bindDistribution must call buildSetFeeDistribution");
    assert.ok(
      parsedPos < buildPos,
      "bindDistribution must call parsedSources before buildSetFeeDistribution",
    );
    assert.match(bindFn, /onStageAction/);
    assert.match(bindFn, /onRequestSend/);
    assert.match(bindFn, /CONFIG_AUTHORITY_MISMATCH/);
  });

  it("exposes permissionless Pump creator-fee distribute without the creator keystore", () => {
    const app = read("src/App.tsx");
    const panel = read("src/panels/PumpCreatorFees.tsx");
    const builder = read("src/pump-distribute.ts");
    const lock = read("src/panels/LockAndFees.tsx");
    assert.match(app, /<PumpCreatorFees/);
    assert.match(app, /<TransferFees/);
    assert.match(panel, /Distribute Pump creator fees/);
    assert.match(panel, /get_minimum_distributable_fee/);
    assert.match(panel, /measurePumpCreatorFees/);
    assert.match(panel, /buildPumpDistribute/);
    assert.match(panel, /You are not paid/);
    assert.match(panel, /does not invent 75\/25/);
    assert.match(panel, /SharingConfig account is absent/);
    assert.match(panel, /missing !== null/);
    assert.match(panel, /\? "none"/);
    assert.match(panel, /This is not ICHOR Collect and does not use the creator keystore/);
    assert.doesNotMatch(panel, /Keystore|privateKey|SecretKeypair/);
    assert.match(builder, /IX_GET_MINIMUM_DISTRIBUTABLE_FEE/);
    assert.match(builder, /distributeVariant/);
    assert.match(builder, /buildDistributeCreatorFeesV2/);
    assert.match(builder, /buildTransferCreatorFeesToPump/);
    assert.match(builder, /IX_TRANSFER_CREATOR_FEES_TO_PUMP/);
    assert.match(builder, /Prefer v1 when the bonding-curve quote mint is the default pubkey/);
    assert.match(panel, /transfer_creator_fees_to_pump/);
    assert.match(panel, /built\.instructions/);
    assert.match(panel, /OPERATOR_CREATOR_FEE_BENEFICIARY/);
    assert.match(panel, /verifiedNativeTreasury/);
    assert.match(builder, /expectedTreasury/);
    assert.match(builder, /PUMP_DISTRIBUTE_MIN_PAYOUT_LAMPORTS/);
    assert.doesNotMatch(builder, /900000/);
    assert.match(lock, /holder Distribute button reads that SharingConfig live/);
    assert.match(lock, /policy text/);
  });

  it("CALL parseHarvestSourceLines: empty throws, nonempty returns", () => {
    const emptyMessage = "paste at least one known Token-2022 ICHOR account to harvest";
    assert.throws(() => parseHarvestSourceLines(""), { message: emptyMessage });
    assert.throws(() => parseHarvestSourceLines("  \n\t ,  "), { message: emptyMessage });
    assert.equal(harvestSourceLinesPresent(""), false);
    assert.equal(harvestSourceLinesPresent("  \n\t ,  "), false);
    assert.deepEqual(parseHarvestSourceLines("abc"), ["abc"]);
    assert.deepEqual(parseHarvestSourceLines("abc\ndef"), ["abc", "def"]);
    assert.deepEqual(parseHarvestSourceLines("abc, def"), ["abc", "def"]);
    assert.equal(harvestSourceLinesPresent("abc"), true);
  });

  it("CALL parseThrowawayMintInputs: empty/zero throw, nonempty return", () => {
    assert.throws(() => parseThrowawayMintInputs("", "1"));
    assert.throws(() => parseThrowawayMintInputs("6", ""));
    assert.throws(() => parseThrowawayMintInputs("6", "0"));
    assert.throws(() => parseThrowawayMintInputs("", ""));
    assert.throws(() => parseThrowawayMintInputs("6", "1.5"));
    assert.throws(() => parseThrowawayMintInputs("256", "1"));
    assert.throws(() => parseThrowawayMintInputs("06", "1"));
    assert.equal(throwawayMintInputsPresent("", "1"), false);
    assert.equal(throwawayMintInputsPresent("6", "0"), false);
    assert.deepEqual(parseThrowawayMintInputs("0", "1"), { decimals: 0, amountRaw: "1" });
    assert.deepEqual(parseThrowawayMintInputs("9", "1000000"), {
      decimals: 9,
      amountRaw: "1000000",
    });
    assert.deepEqual(parseThrowawayMintInputs("255", "1"), { decimals: 255, amountRaw: "1" });
    assert.equal(throwawayMintInputsPresent("0", "1"), true);
  });

  it("requires issued VerifiedRealm and client vote lifecycle builders", () => {
    const preflight = read("src/panels/Preflight.tsx");
    const gov = read("src/panels/Governance.tsx");
    const hits: string[] = [];
    for (const file of textSources()) {
      if (
        file.rel === "tests/source-hygiene.test.ts" ||
        file.rel === "package-lock.json"
      ) {
        continue;
      }
      if (file.text.includes("@realms-today/spl-governance")) {
        hits.push(`${file.rel}: direct Realms import`);
      }
    }
    assert.deepEqual(hits, []);
    assert.match(preflight, /preflightHasResolvedRpc/);
    assert.doesNotMatch(preflight, /Boolean\(props\.config\.rpcUrl\)/);
    assert.match(preflight, /verifyIchorProgramDeployment/);
    assert.match(preflight, /verifyIchorConfigDeployment/);
    assert.match(preflight, /verifiedIchorConfig/);
    assert.match(preflight, /verifyGovernanceIdentity/);
    assert.match(preflight, /verifiedGovernanceIdentity/);
    assert.match(preflight, /NATIVE_TREASURY_MISMATCH/);
    assert.match(preflight, /verifiedNativeTreasury/);
    assert.match(preflight, /verifyRealmDeployment/);
    assert.match(preflight, /verifyGovernanceDeployment/);
    assert.match(preflight, /verifiedRealm/);
    assert.match(preflight, /verifiedGovernance/);
    assert.match(preflight, /REALM_PREFLIGHT_SKIPPED|community actions stay disabled/);
    assert.match(preflight, /GOVERNANCE_NOT_BOUND_TREASURY/);
    assert.match(preflight, /feeBeneficiariesBound/);
    assert.match(preflight, /Bound Realms Governance/);
    assert.doesNotMatch(
      preflight,
      /type="checkbox"|communityActivated|COMMUNITY_ACTIVATION_UNCONFIRMED/,
    );
    assert.match(gov, /verifiedRealm/);
    assert.match(gov, /verifiedGovernance/);
    assert.match(gov, /buildDepositIchorVotes/);
    assert.match(gov, /buildCreateCommunityProposal/);
    assert.match(gov, /buildCastCommunityVote/);
    assert.match(gov, /buildRelinquishCommunityVote/);
    assert.match(gov, /buildWithdrawIchorVotes/);
    assert.match(
      gov,
      /buildDepositIchorVotes\(\{[\s\S]*?connection,[\s\S]*?verifiedRealm,/,
    );
    assert.match(
      gov,
      /buildWithdrawIchorVotes\(\{[\s\S]*?connection,[\s\S]*?verifiedRealm,/,
    );
    assert.match(gov, /expected withheld fee/);
    assert.match(gov, /voting weight credited/);
    assert.match(gov, /buildInsertProposalTransaction/);
    assert.match(gov, /buildCommunityActivationInstruction/);
    assert.match(gov, /buildTransferRealmAuthorityToGovernance/);
    assert.match(gov, /Build Realm authority handoff/);
    assert.match(gov, /Direct wallet send \(not a proposal\)/);
    assert.match(gov, /buildRemoveCouncilInstruction/);
    assert.match(gov, /Stage permanent council removal/);
    assert.match(gov, /council deposits remain/);
    assert.match(gov, /Proposal-only and irreversible/);
    assert.match(gov, /onRequestSend/);
    assert.match(gov, /onStageAction/);
    const handoffStart = gov.indexOf("async function buildBootstrapAuthorityHandoff");
    const insertStart = gov.indexOf("async function buildInsert");
    const handoffFn = gov.slice(
      handoffStart,
      insertStart === -1 ? undefined : insertStart,
    );
    assert.match(handoffFn, /buildTransferRealmAuthorityToGovernance/);
    assert.match(handoffFn, /onRequestSend/);
    assert.doesNotMatch(handoffFn, /onStageAction/);
    assert.match(
      handoffFn,
      /currentAuthority:\s*owner/,
    );
    const stageRemovalStart = gov.indexOf("async function stageCouncilRemoval");
    const stageRemovalFn = gov.slice(
      stageRemovalStart,
      handoffStart === -1 ? undefined : handoffStart,
    );
    assert.match(stageRemovalFn, /buildRemoveCouncilInstruction/);
    assert.match(stageRemovalFn, /onStageAction/);
    assert.doesNotMatch(stageRemovalFn, /onRequestSend/);
    assert.match(gov, /buildExecuteProposalTransaction/);
    assert.match(gov, /requireGovernanceIdentity/);
    assert.doesNotMatch(gov, /buildCreateProposal\(/);
    assert.doesNotMatch(gov, /ichorMint:/);
    assert.doesNotMatch(gov, /governingTokenMint:/);
    assert.doesNotMatch(gov, /realm:\s*requirePublicKey/);
    assert.match(gov, /verifiedRealm\.communityMint/);
    assert.doesNotMatch(gov, /COMMUNITY_ACTIVATION_UNCONFIRMED/);
    assert.doesNotMatch(gov, /communityActivated/);
    assert.doesNotMatch(gov, /type="checkbox"/);
    assert.doesNotMatch(gov, /Operator confirms/);
    assert.match(gov, /EXECUTE_PAYLOAD_MISSING/);
    assert.match(gov, /EXECUTE_IDENTITY_CHANGED/);
    assert.match(gov, /voteRecord/);
    assert.match(gov, /choice,\s*$|choice,/m);
    const createStart = gov.indexOf("async function buildProposal");
    const signOffStart = gov.indexOf("async function buildSignOff");
    const voteStart = gov.indexOf("async function buildVote");
    const createFn = gov.slice(createStart, signOffStart === -1 ? undefined : signOffStart);
    const voteFn = gov.slice(voteStart, gov.indexOf("async function buildRelinquish"));
    assert.match(createFn, /verifiedGovernance/);
    assert.doesNotMatch(createFn, /governance:/);
    assert.doesNotMatch(createFn, /realm:/);
    assert.match(voteFn, /verifiedGovernance/);
    assert.doesNotMatch(voteFn, /governance:/);
    assert.doesNotMatch(voteFn, /realm:/);
    const signOffFn = gov.slice(signOffStart, voteStart === -1 ? undefined : voteStart);
    const relinquishFn = gov.slice(
      gov.indexOf("async function buildRelinquish"),
      gov.indexOf("async function stageCommunityActivation"),
    );
    const executeFn = gov.slice(gov.indexOf("async function buildExecute"));
    assert.match(signOffFn, /requireGovernanceIdentity/);
    assert.match(relinquishFn, /requireGovernanceIdentity/);
    assert.match(executeFn, /requireGovernanceIdentity/);
    assert.doesNotMatch(signOffFn, /requirePublicKey\([^,]+,\s*"governance"\)/);
    assert.doesNotMatch(relinquishFn, /requirePublicKey\([^,]+,\s*"governance"\)/);
    assert.doesNotMatch(executeFn, /requirePublicKey\([^,]+,\s*"governance"\)/);
  });

  it("fail-closes bound Config pins to issued Realms proofs; no boolean-and skip", () => {
    const preflight = read("src/panels/Preflight.tsx");
    assert.doesNotMatch(
      preflight,
      /feeBeneficiariesBound\s*&&\s*(?:[\s\S]{0,120})?realmsGovernance\s*&&\s*(?:[\s\S]{0,120})?props\.config\.governance/,
    );
    assert.doesNotMatch(preflight, /feeBeneficiariesBound\s*&&/);
    assert.match(preflight, /feeBeneficiariesBound === true/);
    assert.match(preflight, /readCommittedDaoDestination/);
    assert.match(preflight, /DAO_DESTINATION_MISMATCH|GOVERNANCE_NOT_BOUND_TREASURY/);
    assert.match(
      preflight,
      /deployment governance is required when Config has a committed DAO destination/,
    );
    assert.match(preflight, /GOVERNANCE_NOT_BOUND_TREASURY/);
    assert.match(preflight, /NATIVE_TREASURY_MISMATCH/);
    assert.match(preflight, /REALMS_PROGRAM_MISMATCH/);
    assert.match(preflight, /GOVERNANCE_REALM/);
    assert.match(preflight, /KEKBULL_MINT_MISMATCH/);
    assert.match(preflight, /ICHOR_MINT_MISMATCH/);
    assert.match(
      preflight,
      /uncommitted: a pasted realm is not the treasury until commit_dao_destination lands/,
    );
    assert.match(preflight, /function requireBoundFeePins/);
    assert.match(preflight, /function assertIssuedIdentityMatchesBoundConfig/);
    const mintKekbull = preflight.indexOf("KEKBULL_MINT_MISMATCH");
    const mintIchor = preflight.indexOf("ICHOR_MINT_MISMATCH");
    const pinsCall = preflight.indexOf("boundFeePins = requireBoundFeePins");
    const identityCall = preflight.indexOf(
      "verifiedGovernanceIdentity = await verifyGovernanceIdentity",
    );
    const deriveCall = preflight.indexOf(
      "const derivedNativeTreasury = await deriveVerifiedNativeTreasury",
    );
    const pinAssert = preflight.indexOf("assertIssuedIdentityMatchesBoundConfig({");
    assert.notEqual(pinsCall, -1);
    assert.notEqual(identityCall, -1);
    assert.notEqual(deriveCall, -1);
    assert.notEqual(pinAssert, -1);
    assert.ok(mintKekbull < pinsCall, "mint mismatch checks must stay before bound-pin fail-closed");
    assert.ok(mintIchor < pinsCall, "mint mismatch checks must stay before bound-pin fail-closed");
    assert.ok(pinsCall < identityCall, "bound pins must be required before identity issuance");
    assert.ok(identityCall < deriveCall, "identity must be issued before treasury derive");
    assert.ok(deriveCall < pinAssert, "issued identity/treasury/program must be pinned after derive");
    const assertFn = preflight.slice(
      preflight.indexOf("function assertIssuedIdentityMatchesBoundConfig"),
      preflight.indexOf("export type PreflightState"),
    );
    assert.match(assertFn, /params\.identity\.governance\.equals\(params\.pins\.realmsGovernance\)/);
    assert.match(
      assertFn,
      /params\.derivedTreasury\.equals\(params\.pins\.realmsNativeTreasury\)/,
    );
    assert.match(
      assertFn,
      /params\.verified\.network\.realmsProgramId\.equals\(params\.pins\.realmsProgram\)/,
    );
    assert.match(assertFn, /NATIVE_TREASURY_MISMATCH/);
    assert.match(assertFn, /REALMS_PROGRAM_MISMATCH/);
    assert.match(assertFn, /verifiedRealm\.realm\.equals\(params\.identity\.realm\)/);
    const requireFn = preflight.slice(
      preflight.indexOf("function requireBoundFeePins"),
      preflight.indexOf("function assertIssuedIdentityMatchesBoundConfig"),
    );
    assert.match(requireFn, /readCommittedDaoDestination/);
    assert.match(requireFn, /if \(!governance\)/);
    assert.match(requireFn, /GOVERNANCE_NOT_BOUND_TREASURY/);
    assert.doesNotMatch(requireFn, /feeBeneficiariesBound\s*&&/);
  });

  it("stages fee claim and activation for insert, then executes original inner bytes", () => {
    const app = read("src/App.tsx");
    const gov = read("src/panels/Governance.tsx");
    const lock = read("src/panels/LockAndFees.tsx");
    const send = read("src/send.ts");
    assert.match(send, /export type StagedGovernanceAction/);
    assert.match(send, /export interface InsertedProposalSession/);
    assert.match(send, /export function sameInstructionBytes/);
    assert.match(app, /const \[stagedAction, setStagedAction\]/);
    assert.match(app, /const \[insertedSession, setInsertedSession\]/);
    assert.match(app, /useEffect\(\(\) => \{/);
    assert.match(app, /\[connection,\s*governanceIdentity\]/);
    assert.match(app, /onStageAction=\{stageAction\}/);
    assert.match(app, /onClearStagedAction=\{clearStagedAction\}/);
    assert.match(app, /onInsertedSession=\{setInsertedSession\}/);
    assert.match(app, /stagedAction=\{stagedAction\}/);
    assert.match(app, /insertedSession=\{insertedSession\}/);
    assert.match(gov, /Insert proposal transaction/);
    assert.match(gov, /Recover inserted transaction/);
    assert.match(gov, /recoverProposalTransaction/);
    assert.match(gov, /getAllInstructions|recovered\.transactionInstructions/);
    assert.match(gov, /async function buildInsert/);
    assert.match(gov, /async function stageCommunityActivation/);
    assert.match(lock, /async function stageFeeClaim/);
    assert.match(lock, /Stage Meteora fee claim/);
    assert.match(lock, /100% of the LP fee share/);
    assert.match(lock, /Meteora keeps a/);
    assert.match(lock, /protocol fee/);
    assert.match(lock, /100 - damm\.protocolFeePercent|lpFeeSharePercent/);
    assert.match(lock, /not a holder Create-proposal template/);
    const claimFn = lock.slice(
      lock.indexOf("function requireClaimInputs"),
      lock.indexOf("async function verifyHandoff"),
    );
    assert.match(claimFn, /buildClaimPositionFeeToTreasury/);
    assert.match(claimFn, /verifiedGovernanceIdentity|verifiedGovernance:/);
    assert.match(claimFn, /handedOff/);
    assert.match(claimFn, /built\.insert0\.instructions/);
    assert.match(claimFn, /built\.insert1\.instructions/);
    assert.match(claimFn, /onStageAction/);
    assert.match(claimFn, /insert 0/);
    assert.match(claimFn, /insert 1/);
    assert.doesNotMatch(claimFn, /built\.transaction\.instructions/);
    assert.doesNotMatch(claimFn, /onRequestSend/);
    assert.doesNotMatch(lock, /queuePayload/);
    assert.doesNotMatch(lock, /sendWithConnectedWallet/);
    const activationFn = gov.slice(
      gov.indexOf("async function stageCommunityActivation"),
      gov.indexOf("async function sendCommunityActivation"),
    );
    const sendActivationFn = gov.slice(
      gov.indexOf("async function sendCommunityActivation"),
      gov.indexOf("async function stageCouncilRemoval"),
    );
    assert.match(activationFn, /buildCommunityActivationInstruction/);
    assert.match(activationFn, /communityActivationFromForm/);
    assert.match(activationFn, /onStageAction/);
    assert.doesNotMatch(activationFn, /onRequestSend/);
    assert.match(sendActivationFn, /buildCommunityActivationInstruction/);
    assert.match(sendActivationFn, /communityActivationFromForm/);
    assert.match(sendActivationFn, /onRequestSend/);
    assert.match(sendActivationFn, /recovery window/);
    assert.match(gov, /YesVotePercentage\(0\)|1-100|1-100/);
    assert.match(gov, /communityActivationFromForm/);
    assert.match(gov, /requireYesVotePercent/);
    assert.match(gov, /communityVoteThresholdPercent/);
    assert.match(gov, /minCommunityTokensToCreateProposal/);
    assert.match(gov, /councilVoteThresholdPercent/);
    assert.match(gov, /councilVetoVoteThresholdPercent/);
    assert.match(gov, /minCouncilTokensToCreateProposal/);
    assert.match(gov, /baseVotingTime/);
    assert.match(gov, /minInstructionHoldUpTime/);
    assert.match(gov, /votingCoolOffTime/);
    assert.match(gov, /depositExemptProposalCount/);
    assert.doesNotMatch(activationFn, /placeholder=/);
    const councilRemovalFn = gov.slice(
      gov.indexOf("async function stageCouncilRemoval"),
      gov.indexOf("async function buildBootstrapAuthorityHandoff"),
    );
    assert.match(councilRemovalFn, /buildRemoveCouncilInstruction/);
    assert.match(councilRemovalFn, /onStageAction/);
    assert.doesNotMatch(councilRemovalFn, /onRequestSend/);
    const stageUpgradeFn = gov.slice(
      gov.indexOf("async function stageIchorProgramUpgrade"),
      gov.indexOf("async function stageTransferUpgradeAuthorityToGovernance"),
    );
    const stageAuthFn = gov.slice(
      gov.indexOf("async function stageTransferUpgradeAuthorityToGovernance"),
      gov.indexOf("async function sendIchorProgramUpgrade"),
    );
    const sendUpgradeFn = gov.slice(
      gov.indexOf("async function sendIchorProgramUpgrade"),
      gov.indexOf("async function sendSetPendingAuthorityToGovernance"),
    );
    const sendPendingFn = gov.slice(
      gov.indexOf("async function sendSetPendingAuthorityToGovernance"),
      gov.indexOf("async function stageAcceptAuthorityAsGovernance"),
    );
    const stageAcceptFn = gov.slice(
      gov.indexOf("async function stageAcceptAuthorityAsGovernance"),
      gov.indexOf("async function stageGenericInstruction"),
    );
    const stageGenericFn = gov.slice(
      gov.indexOf("async function stageGenericInstruction"),
      gov.indexOf("async function dispatchSetPaused"),
    );
    assert.match(stageUpgradeFn, /buildUpgradeIchorProgram/);
    assert.match(stageUpgradeFn, /verifiedIchorProgram/);
    assert.match(stageUpgradeFn, /onStageAction/);
    assert.doesNotMatch(stageUpgradeFn, /onRequestSend/);
    assert.match(stageAuthFn, /buildTransferProgramUpgradeAuthorityToGovernance/);
    assert.match(stageAuthFn, /onStageAction/);
    assert.doesNotMatch(stageAuthFn, /onRequestSend/);
    assert.match(sendUpgradeFn, /buildUpgradeIchorProgram/);
    assert.match(sendUpgradeFn, /onRequestSend/);
    assert.doesNotMatch(sendUpgradeFn, /onStageAction/);
    assert.match(gov, /Send Upgrade/);
    assert.match(sendPendingFn, /buildSetPendingAuthorityToGovernance/);
    assert.match(sendPendingFn, /onRequestSend/);
    assert.doesNotMatch(sendPendingFn, /onStageAction/);
    assert.match(sendPendingFn, /recovery window/);
    assert.match(stageAcceptFn, /buildAcceptAuthorityAsGovernance/);
    assert.match(stageAcceptFn, /onStageAction/);
    assert.doesNotMatch(stageAcceptFn, /onRequestSend/);
    assert.match(stageAcceptFn, /unproven until a Realms execute rehearsal/);
    assert.match(stageGenericFn, /parseGenericInnerInstruction/);
    assert.match(stageGenericFn, /onStageAction/);
    assert.doesNotMatch(stageGenericFn, /onRequestSend/);
    assert.match(gov, /buildSetPaused/);
    const setPausedFn = gov.slice(
      gov.indexOf("async function dispatchSetPaused"),
      gov.indexOf("async function dispatchProposeEmissionRatio"),
    );
    assert.match(setPausedFn, /if \(!paused\)/);
    assert.match(setPausedFn, /assertWalletUnpauseAllowed\(unpauseIdentity\)/);
    assert.ok(
      setPausedFn.indexOf("assertWalletUnpauseAllowed") < setPausedFn.indexOf("buildSetPaused"),
      "dispatchSetPaused must refuse mainnet unpause before buildSetPaused",
    );
    assert.ok(
      setPausedFn.indexOf("assertWalletUnpauseAllowed") < setPausedFn.indexOf("dispatchConfigAdmin"),
      "dispatchSetPaused must refuse mainnet unpause before dispatchConfigAdmin",
    );
    assert.match(setPausedFn, /async function dispatchPauseConvert/);
    assert.match(setPausedFn, /dispatchSetPaused\(true\)/);
    assert.doesNotMatch(setPausedFn, /dispatchSetPaused\(paused\)/);
    assert.match(gov, /CLUSTER_GENESIS_HASH/);
    assert.match(gov, /MAINNET_UNPAUSE_REFUSED/);
    assert.match(gov, /ichor_mainnet_f_signer/);
    assert.match(gov, /open-conversion/);
    assert.match(gov, /walletUnpauseAvailable/);
    assert.match(gov, /dispatchPauseConvert\(\)/);
    assert.match(gov, /showWalletUnpause/);
    assert.match(gov, /buildProposeEmissionRatio/);
    assert.match(gov, /buildApplyEmissionRatio/);
    assert.match(gov, /buildFreezeRatioUpdates/);
    assert.match(gov, /buildRevokeTransferFeeAuthority/);
    assert.match(gov, /resolveConfigAdminAuthority/);
    assert.match(gov, /dispatchConfigAdmin/);
    const applyFn = gov.slice(
      gov.indexOf("async function sendApplyEmissionRatio"),
      gov.indexOf("async function dispatchCancelPendingRatio"),
    );
    assert.match(applyFn, /onRequestSend/);
    assert.doesNotMatch(applyFn, /onStageAction/);
    assert.match(gov, /function parseGenericInnerInstruction/);
    assert.match(gov, /INVALID_JSON/);
    assert.match(gov, /INVALID_ACCOUNT_META/);
    assert.match(gov, /INVALID_HEX/);
    assert.match(gov, /requirePublicKey\(params\.programId, "programId"\)/);
    assert.doesNotMatch(gov, /eval\(|new Function/);
    assert.match(gov, /Send set pending authority to Governance/);
    assert.match(gov, /Stage accept authority as proposal/);
    assert.match(gov, /Stage generic instruction/);
    assert.match(gov, /verifiedIchorConfig && verifiedGovernanceIdentity/);
    assert.match(gov, /Stage Upgrade/);
    assert.match(gov, /Stage transfer upgrade authority to Governance PDA/);
    assert.match(gov, /verifiedIchorProgram && verifiedGovernanceIdentity/);
    const handoffFn = gov.slice(
      gov.indexOf("async function buildBootstrapAuthorityHandoff"),
      gov.indexOf("async function buildInsert"),
    );
    assert.match(handoffFn, /buildTransferRealmAuthorityToGovernance/);
    assert.match(handoffFn, /onRequestSend/);
    assert.doesNotMatch(handoffFn, /onStageAction/);
    assert.match(gov, /value=\{communityVoteThresholdPercent\}/);
    assert.match(gov, /value=\{minCommunityTokensToCreateProposal\}/);
    assert.match(gov, /value=\{councilVoteThresholdPercent\}/);
    assert.match(gov, /value=\{councilVetoVoteThresholdPercent\}/);
    assert.match(gov, /value=\{minCouncilTokensToCreateProposal\}/);
    assert.match(gov, /value=\{baseVotingTime\}/);
    assert.match(gov, /value=\{minInstructionHoldUpTime\}/);
    assert.match(gov, /value=\{votingCoolOffTime\}/);
    assert.match(gov, /value=\{depositExemptProposalCount\}/);
    assert.match(gov, /parseStrictNonNegativeInteger/);
    assert.match(gov, /\/\^\(0\|\[1-9\]\[0-9\]\*\)\$\//);
    const insertFn = gov.slice(
      gov.indexOf("async function buildInsert"),
      gov.indexOf("async function buildExecute"),
    );
    assert.match(insertFn, /buildInsertProposalTransaction/);
    assert.match(insertFn, /props\.stagedAction/);
    assert.match(
      insertFn,
      /stage a fee claim, community activation, council removal, program upgrade, config-authority accept, Config admin action, or generic instruction before insert/,
    );
    assert.match(insertFn, /transactionInstructions:\s*innerInstructions/);
    assert.match(insertFn, /parseStrictNonNegativeInteger\(insertIndex,\s*"index"\)/);
    assert.match(insertFn, /parseStrictNonNegativeInteger\(optionIndex,\s*"optionIndex"\)/);
    assert.match(insertFn, /parseStrictNonNegativeInteger\(holdUpTime,\s*"holdUpTime"\)/);
    assert.match(insertFn, /requirePublicKey\(tokenOwnerRecord,\s*"tokenOwnerRecord"\)/);
    assert.doesNotMatch(insertFn, /councilTokenOwnerRecord/);
    assert.match(insertFn, /requireGovernanceIdentity/);
    assert.match(insertFn, /verifiedGovernance,/);
    assert.match(insertFn, /staged:\s*built\.staged/);
    assert.match(insertFn, /onInsertedSession/);
    assert.match(insertFn, /instructions:\s*innerInstructions/);
    assert.match(insertFn, /onRequestSend/);
    assert.match(insertFn, /insert proposal transaction/);
    assert.doesNotMatch(insertFn, /requirePublicKey\([^,]+,\s*"governance"\)/);
    assert.doesNotMatch(insertFn, /verified:/);
    assert.doesNotMatch(insertFn, /^\s*governance:/m);
    const executeFn = gov.slice(gov.indexOf("async function buildExecute"));
    assert.match(executeFn, /props\.insertedSession/);
    assert.match(executeFn, /session\.action\.instructions/);
    assert.match(executeFn, /session\.staged/);
    assert.match(executeFn, /staged:\s*session\.staged/);
    assert.match(executeFn, /transactionInstructions:\s*\[\.\.\.session\.action\.instructions\]/);
    assert.match(executeFn, /sameInstructionBytes/);
    assert.match(executeFn, /EXECUTE_IDENTITY_CHANGED/);
    assert.match(executeFn, /EXECUTE_PAYLOAD_MISSING/);
    assert.doesNotMatch(executeFn, /verified:/);
    assert.doesNotMatch(executeFn, /^\s*governance:/m);
    assert.doesNotMatch(executeFn, /sessionInstructions/);
    assert.doesNotMatch(executeFn, /label !== "insert proposal transaction"/);
    assert.doesNotMatch(
      executeFn,
      /transactionInstructions:\s*\[\.\.\.(?:props\.)?stagedAction\.instructions\]/,
    );
    const claimHits: string[] = [];
    for (const file of textSources()) {
      if (file.rel === "tests/source-hygiene.test.ts") {
        continue;
      }
      if (
        /onRequestSend\(\{[\s\S]{0,400}claimPositionFee|onRequestSend\(\{[\s\S]{0,400}fee claim/i.test(
          file.text,
        )
      ) {
        claimHits.push(`${file.rel}: direct treasury claim send`);
      }
    }
    assert.deepEqual(claimHits, []);
  });

  it("binds every Connection+VerifiedNetwork live read before RPC", () => {
    const chain = read("src/chain.ts");
    const gov = read("src/panels/Governance.tsx");
    const live = read("src/panels/LiveState.tsx");
    assertBoundBeforeRpc(exportedFn(chain, "fetchBoundMintSnapshot"), "fetchBoundMintSnapshot", "fetchMintSnapshot");
    assert.match(exportedFn(chain, "fetchBoundMintSnapshot"), /LIVE_MINT_SNAPSHOT_TTL_MS/);
    assert.match(chain, /export const LIVE_MINT_SNAPSHOT_TTL_MS = 15_000/);
    assert.match(chain, /export function invalidateLiveMintCache/);
    assert.match(read("src/live-refresh.ts"), /export const LIVE_REFRESH_TTL_MS = 15_000/);
    assert.match(read("src/panels/LiveState.tsx"), /useThrottledLiveRefresh/);
    assert.match(read("src/App.tsx"), /invalidateLiveMintCache\(\)/);
    {
      const vite = read("vite.config.ts");
      assert.match(vite, /RPC_READ_TTL_MS = 15_000/);
      assert.match(vite, /RPC_UPSTREAM_CONCURRENCY = 2/);
      assert.match(vite, /"getAccountInfo"/);
      assert.match(vite, /function proxyOfficialDevnetRpc/);
      assert.doesNotMatch(vite, /const RPC_CACHEABLE = new Set\(\[[\s\S]*?sendTransaction/);
    }
    assertBoundBeforeRpc(exportedFn(chain, "readLamportsBn"), "readLamportsBn", "fetch(");
    assertBoundBeforeRpc(exportedFn(chain, "readWalletLiveState"), "readWalletLiveState", "fetchBoundMintSnapshot");
    assertBoundBeforeRpc(exportedFn(chain, "readTreasuryLiveState"), "readTreasuryLiveState", "fetchBoundMintSnapshot");
    assert.match(exportedFn(chain, "readTreasuryLiveState"), /communityGoverningTokenHoldingAddress/);
    assert.match(exportedFn(chain, "readTreasuryLiveState"), /REALM_MINT_MISMATCH/);
    assertBoundBeforeRpc(exportedFn(chain, "readIchorMint"), "readIchorMint", "fetchBoundMintSnapshot");
    assertBoundBeforeRpc(exportedFn(chain, "readPermanentLock"), "readPermanentLock", "verifyPermanentLock");
    assertBoundBeforeRpc(exportedFn(chain, "readLockedDammReserves"), "readLockedDammReserves", "readLockedDammPoolTokens");
    assert.match(exportedFn(chain, "readLockedDammReserves"), /verifiedGovernance/);
    assert.match(exportedFn(chain, "readLockedDammReserves"), /positionNftMint/);
    assertBoundBeforeRpc(exportedFn(chain, "readSourceAmmReserves"), "readSourceAmmReserves", "readCanonicalPumpSwapPoolSnapshot");
    assertBoundBeforeRpc(exportedFn(chain, "readBurnLiveState"), "readBurnLiveState", "fetchBoundMintSnapshot");
    assertBoundBeforeRpc(exportedFn(chain, "readHolderVoteBalances"), "readHolderVoteBalances", "fetchBoundMintSnapshot");
    assert.match(exportedFn(chain, "readHolderVoteBalances"), /readCommunityGoverningTokenDeposit/);
    assert.match(exportedFn(chain, "readHolderVoteBalances"), /verifiedRealm\.communityMint/);
    assert.match(exportedFn(chain, "readHolderVoteBalances"), /liveMintTransferQuote/);
    assert.match(exportedFn(chain, "readHolderVoteBalances"), /withdrawQuote/);
    const quoteStart = chain.indexOf("async function liveMintTransferQuote");
    assert.notEqual(quoteStart, -1);
    const quoteFn = chain.slice(quoteStart, chain.indexOf("export async function readHolderVoteBalances"));
    assertBoundBeforeRpc(quoteFn, "liveMintTransferQuote", "getAccountInfo");
    assert.match(quoteFn, /getCurrentMintFee/);
    assert.match(quoteFn, /getEpochInfo/);
    assert.match(live, /verifiedIchorConfig/);
    assert.match(live, /verifiedNativeTreasury/);
    assert.match(live, /ICHOR deposited to vote/);
    assert.match(live, /your-position/);
    assert.match(live, /statgrid/);
    assert.match(live, /className="hero"/);
    assert.match(live, /Open proposals/);
    assert.match(live, /readHolderVoteBalances/);
    assert.match(live, /Deposited in the realm/);
    assert.match(read("src/panels/Proposals.tsx"), /readHolderVoteBalances/);
    // Uncollected treasury fees sit with DAO holdings, not the on-chain headlines.
    const owns = read("src/panels/TreasuryAssets.tsx");
    assert.match(owns, /On-chain totals/);
    assert.match(owns, /DAO treasury holdings/);
    assert.match(owns, /not collected yet/);
    assert.match(owns, /not counted above until someone collects it/);
    assert.match(owns, /75% share/);
    assert.match(owns, /splitHarvestedFees/);
    assert.match(owns, /measureCanonicalHarvestSources/);
    assert.doesNotMatch(live, /walletState\?\.ichor/);
    assert.doesNotMatch(live, /75% of every 0.25% transfer fee/);
    assert.doesNotMatch(live, /props\.config\.(?:ichorMint|nativeTreasury)/);
    assert.doesNotMatch(chain, /getTokenLargestAccounts|getProgramAccounts|getTokenAccountsByOwner/);
    const burnRead = exportedFn(chain, "readBurnLiveState");
    assert.doesNotMatch(burnRead, /borsh|discriminator|total_kekbull_burned|total_ichor_minted/);
    assert.match(gov, /fetchBoundMintSnapshot\(/);
    assert.doesNotMatch(gov, /fetchMintSnapshot\(/);
    const tokenFnStart = chain.indexOf("async function readTokenAccount");
    assert.notEqual(tokenFnStart, -1);
    const tokenFn = chain.slice(tokenFnStart, chain.indexOf("export async function readWalletLiveState"));
    assert.match(tokenFn, /assertBoundConnection/);
    assert.match(tokenFn, /getAccountInfo/);
    assert.match(tokenFn, /info === null/);
    assert.match(tokenFn, /unpackAccount/);
    assert.match(tokenFn, /readWithheld/);
    assert.match(tokenFn, /parseIchorTransferFeeAmount/);
    assert.match(tokenFn, /TOKEN_ACCOUNT_PROGRAM|TOKEN_ACCOUNT_MINT|TOKEN_ACCOUNT_AUTHORITY/);
    assert.doesNotMatch(tokenFn, /getTokenAccountBalance/);
    assert.doesNotMatch(tokenFn, /catch \{/);
    assert.doesNotMatch(tokenFn, /catch \(/);
  });

  it("parses lock liquidity as a strict positive decimal integer and pubkeys at load", () => {
    const format = read("src/format.ts");
    const config = read("src/config.ts");
    assert.match(format, /export function parsePositiveDecimalIntegerString/);
    assert.match(format, /\/\^\[1-9\]\[0-9\]\*\$\//);
    assert.doesNotMatch(format.match(/export function parsePositiveDecimalIntegerString[\s\S]+?\n\}/)?.[0] ?? "", /\.trim\(/);
    assert.match(config, /optionalPublicKey/);
    assert.match(config, /requirePublicKey\(value, label\)/);
    assert.match(config, /optionalPositiveDecimalInteger/);
    assert.match(config, /parsePositiveDecimalIntegerString\(value, label\)/);
    assert.doesNotMatch(config, /optionalBase58/);
    assert.match(
      config,
      /expectedLockedLiquidityBaseUnits:\s*optionalPositiveDecimalInteger/,
    );
    assert.match(config, /ichorProgram:\s*optionalPublicKey/);
    assert.match(config, /meteoraPositionNftMint:\s*optionalPublicKey/);
  });

  it("simulates with sigVerify false, never sends on failure, and confirms the same blockhash", () => {
    const send = read("src/send.ts");
    const confirm = read("src/panels/ConfirmSend.tsx");
    const app = read("src/App.tsx");
    assert.match(send, /assertBoundConnection\(verified, connection\)/);
    assert.match(send, /getGenesisHash\(\)/);
    assert.match(send, /CLUSTER_GENESIS_HASH/);
    assert.match(send, /getLatestBlockhash\("confirmed"\)/);
    assert.match(send, /sigVerify:\s*false/);
    assert.match(send, /simulateTransaction/);
    assert.match(send, /SIMULATION_UNAVAILABLE/);
    assert.match(send, /SIMULATION_FAILED/);
    assert.match(send, /signTransaction/);
    assert.match(send, /sendRawTransaction/);
    assert.match(send, /skipPreflight:\s*true/);
    assert.match(send, /confirmTransaction/);
    assert.match(send, /lastValidBlockHeight/);
    assert.match(send, /getTransaction/);
    assert.match(send, /isBlockhashValid/);
    assert.match(send, /CONFIRM_EXPIRED/);
    assert.match(send, /SIGNED_MESSAGE_CHANGED/);
    assert.match(send, /serializeMessage/);
    assert.match(send, /readonly dataHex: string/);
    assert.match(send, /byte\.toString\(16\)\.padStart\(2, "0"\)/);
    assert.doesNotMatch(send, /wallet\.sendTransaction/);
    assert.match(confirm, /Every instruction/);
    assert.match(confirm, /data \{ix\.dataHex \|\| "\(empty\)"\}/);
    assert.match(confirm, /Every derived address/);
    assert.match(confirm, /There is no auto-send/);
    assert.match(confirm, /Simulate \(sigVerify false\)/);
    assert.match(confirm, /disabled=\{props\.busy \|\| !genesisReady \|\| !simPassed\}/);
    assert.match(confirm, /operatorView/);
    assert.match(confirm, /Approve this burn/);
    assert.match(confirm, /Approve this deposit/);
    assert.match(confirm, /holderSummary/);
    assert.match(confirm, /kind === "burn"/);
    assert.match(confirm, /kind === "deposit"/);
    assert.match(read("src/panels/Proposals.tsx"), /This is a transfer, not a burn/);
    assert.match(read("src/panels/Proposals.tsx"), /grossUi/);
    assert.match(read("src/panels/Proposals.tsx"), /Human ICHOR from the mint/);
    assert.match(read("src/panels/Proposals.tsx"), /readHolderVoteBalances/);
    assert.match(read("src/panels/Proposals.tsx"), /ICHOR to deposit/);
    assert.match(read("src/panels/Proposals.tsx"), /ICHOR your wallet receives on withdraw/);
    assert.match(read("src/panels/Proposals.tsx"), /deposit-balances/);
    assert.match(read("src/panels/Proposals.tsx"), /groupUiAmount/);
    assert.match(read("src/panels/Proposals.tsx"), /lastConfirmedSignature/);
    assert.match(read("src/panels/Proposals.tsx"), /withdrawQuote\?\.net/);
    assert.match(read("src/format.ts"), /value\.split\("\."\)/);
    assert.equal(groupUiAmount("9950.0625"), "9,950.0625");
    assert.equal(groupUiAmount("9975"), "9,975");
    assert.notEqual(groupUiAmount("9950.0625"), "9,950.0,625");
    assert.equal(
      parseUiToBaseUnits("497,814.064453", 6).toString(10),
      parseUiToBaseUnits("497814.064453", 6).toString(10),
    );
    assert.ok(read("src/format.ts").includes("replace(/,/g, \"\")"));
    assert.match(read("src/panels/Proposals.tsx"), /Use wallet balance/);
    assert.match(read("src/panels/Proposals.tsx"), /Your deposit record/);
    assert.match(
      read("src/panels/Proposals.tsx"),
      /Derived from the connected wallet \(Realms TokenOwnerRecord PDA\)/,
    );
    assert.match(read("src/styles.css"), /input:read-only/);
    // Create/vote TOR fields must not accept paste - only balance refresh sets them.
    {
      const proposals = read("src/panels/Proposals.tsx");
      const createLabel = proposals.indexOf("Write a proposal");
      const createTor = proposals.indexOf("Your deposit record", createLabel);
      const createTorBlock = proposals.slice(createTor, createTor + 500);
      assert.match(createTorBlock, /readOnly/);
      assert.doesNotMatch(createTorBlock, /onChange=\{/);
    }
    assert.match(read("src/panels/Proposals.tsx"), /TokenOwnerRecord/);
    assert.match(read("src/panels/Proposals.tsx"), /options: \["Approve"\]/);
    assert.doesNotMatch(read("src/panels/Proposals.tsx"), /Options, one per line/);
    assert.match(read("src/panels/Proposals.tsx"), /lastConfirmedSignature/);
    assert.match(
      read("src/panels/Proposals.tsx"),
      /lastConfirmedSignature[\s\S]*?void refreshProposal\(\)/,
    );
    assert.match(read("src/panels/Proposals.tsx"), /Open proposals/);
    assert.match(read("src/panels/Proposals.tsx"), /Voting is not open yet/);
    assert.match(read("src/panels/Proposals.tsx"), /Voting time has ended/);
    assert.match(read("src/panels/Proposals.tsx"), /proposalVotingAcceptsCast/);
    assert.match(read("src/panels/Proposals.tsx"), /VOTING ENDED/);
    assert.match(read("src/panels/Proposals.tsx"), /Advanced: open by address/);
    assert.match(read("src/panels/Proposals.tsx"), /pinProposalMarkdown/);
    assert.match(read("src/panels/Proposals.tsx"), /readCommunityProposal/);
    assert.match(read("src/panels/Proposals.tsx"), /buildExecuteProposalTransaction/);
    assert.match(read("src/panels/Proposals.tsx"), /buildFinalizeVote/);
    assert.match(read("src/panels/Proposals.tsx"), /Insert action \(recovery\)/);
    assert.match(read("src/panels/Proposals.tsx"), /Create proposal \+ insert action/);
    assert.match(
      read("src/panels/Proposals.tsx"),
      /create community proposal \+ insert action/,
    );
    assert.match(
      read("src/panels/Proposals.tsx"),
      /Create and Insert are packed in this one confirmation/,
    );
    assert.match(read("src/panels/Proposals.tsx"), /Voting window is only/);
    assert.match(read("src/panels/Proposals.tsx"), /shortVoteWindow/);
    assert.match(read("src/panels/Proposals.tsx"), /Execute action/);
    assert.match(read("src/panels/Proposals.tsx"), /actionSummary\.kind === "unknown"/);
    assert.match(read("src/panels/Proposals.tsx"), /summarizeRecoveredProposalTransactions/);
    assert.match(read("src/panels/Proposals.tsx"), /instructionsCount/);
    assert.match(read("src/panels/Proposals.tsx"), /disabled=\{!voteReady \|\| !votingAcceptsCast \|\| !instructionsReviewed\}/);
    assert.match(
      read("src/panels/Proposals.tsx"),
      /disabled=\{!identityReady \|\| !voteReady \|\| !hasProposal \|\| !instructionsReviewed\}/,
    );
    assert.match(read("src/panels/Proposals.tsx"), /proposalInstructionsReviewedForVote/);
    assert.match(read("src/proposal-actions.ts"), /pay-token/);
    assert.match(read("src/proposal-actions.ts"), /recoveryComplete/);
    assert.match(read("src/proposal-actions.ts"), /proposalVotingAcceptsCast/);
    assert.match(read("src/proposal-actions.ts"), /proposalVotingEndsAtSecs/);
    assert.match(read("src/proposal-actions.ts"), /TOKEN_TRANSFER_CHECKED/);
    assert.match(read("src/proposal-actions.ts"), /classifyProposalInstruction/);
    assert.match(read("src/proposal-actions.ts"), /summarizeRecoveredProposalTransactions/);
    assert.match(read("src/proposal-actions.ts"), /summarizeProposalInstructionsForReview/);
    assert.match(read("src/proposal-actions.ts"), /assertBufferFrozenToGovernance/);
    assert.match(read("src/proposal-actions.ts"), /reviewLoaderUpgrades/);
    assert.match(read("src/proposal-actions.ts"), /frozenBuffers/);
    assert.match(read("src/proposal-actions.ts"), /multipleUpgrades/);
    assert.match(read("src/proposal-actions.ts"), /proposalInstructionsReviewedForVote/);
    assert.match(read("src/proposal-markdown.ts"), /PROPOSAL_MARKDOWN_MAX_BYTES/);
    assert.match(read("src/proposal-markdown.ts"), /renderStrictMarkdown/);
    assert.match(read("src/proposal-markdown.ts"), /createElement/);
    assert.doesNotMatch(read("src/proposal-markdown.ts"), /PINATA_JWT/);
    assert.match(read("src/proposal-actions.ts"), /buildTreasuryIchorTransfer/);
    assert.match(read("src/proposal-actions.ts"), /buildTreasurySolTransfer/);
    assert.match(read("src/proposal-actions.ts"), /buildUpgradeIchorProgram/);
    assert.match(read("vite.config.ts"), /pin-proposal-server\.cjs/);
    assert.match(read("vite.config.ts"), /\/api\/pin-proposal/);
    assert.match(read("vite.config.ts"), /proposal-chat-server\.cjs/);
    assert.match(read("vite.config.ts"), /\/api\/proposal-chat/);
    assert.doesNotMatch(read("vite.config.ts"), /PINATA_JWT\s*=/);
    assert.ok(existsSync(join(root, "scripts/pin-proposal-server.cjs")));
    assert.ok(existsSync(join(root, "scripts/proposal-chat-server.cjs")));
    // Masthead nav (2026-08-25 redesign): Fees left the topbar; collect still
    // lives under #treasury via TransferFees id="fees". Addresses stay later.
    assert.match(read("src/panels/Masthead.tsx"), /href="#start"/);
    assert.match(read("src/panels/Masthead.tsx"), /href="#deposit"/);
    {
      const mast = read("src/panels/Masthead.tsx");
      assert.ok(
        mast.indexOf('href="#treasury"') < mast.indexOf('href="#liquidity"') &&
          mast.indexOf('href="#liquidity"') < mast.indexOf('href="#handbook"') &&
          mast.indexOf('href="#handbook"') < mast.indexOf('href="#burn"'),
        "nav follows page order: Treasury, Liquidity, Handbook, then Burn",
      );
    }
    assert.match(read("src/holder-section.tsx"), /className="section section-fold"/);
    assert.match(read("src/panels/Proposals.tsx"), /id="deposit"/);
    assert.match(read("src/panels/Proposals.tsx"), /id="vote"/);
    assert.match(read("src/panels/LiveState.tsx"), /className="hero" id="start"/);
    assert.doesNotMatch(app, /<(span|div)[^>]*\bid="start"/);
    assert.match(read("src/panels/Masthead.tsx"), /href="#addresses"/);
    assert.doesNotMatch(read("src/panels/Masthead.tsx"), /href="#fees"/);
    assert.match(read("src/panels/TransferFees.tsx"), /id="fees"/);
    assert.match(read("src/panels/Burn.tsx"), /kind: "burn"/);
    assert.doesNotMatch(
      confirm.slice(confirm.indexOf("function HolderReview")),
      /Simulate \(sigVerify false\)/,
    );
    assert.match(send, /reusePassedSimulation/);
    assert.match(send, /wallet mutated the message|ComputeBudget/);
    assert.match(app, /simulateBoundPayload/);
    assert.match(app, /refusing send: simulation has not passed/);
    assert.match(app, /reusePassedSimulation:\s*true/);
    assert.match(app, /operatorView=\{localDev\}/);
    assert.match(app, /sendLock/);
    assert.match(app, /showOperatorConsole/);
    assert.match(app, /<OperatorLock/);
    assert.match(app, /isOperatorConsoleUnlocked/);
    assert.match(read("src/panels/OperatorLock.tsx"), /CONSOLE LOCKED/);
    assert.match(read("src/panels/OperatorLock.tsx"), /does not list those/);
    assert.match(read("src/operator-access.ts"), /bootstrap-operator/);
    assert.match(read("src/operator-access.ts"), /upgradeAuthority/);
    assert.doesNotMatch(read("src/operator-access.ts"), /Du1JPvJ8bcuExKUx7ngwShYzFRkxLnVoCN95pWmKR2rq/);
  });

  it("CALL operator console unlock: live proofs only, bootstrap only before a program exists", () => {
    const upgrade = new PublicKey("5E6eeUqF2UunqwGDavfCgh28smQe88JSN7MXGvCdh4Zd");
    const other = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const bootstrap = operatorAuthoritiesFromProofs({
      programConfigured: false,
      upgradeAuthority: null,
      configAuthority: null,
      pendingAuthority: null,
      creatorBeneficiary: null,
    });
    assert.equal(bootstrap.length, 1);
    assert.equal(bootstrap[0]?.role, "bootstrap-operator");
    assert.equal(bootstrap[0]?.key.toBase58(), OPERATOR_CREATOR_FEE_BENEFICIARY);
    assert.equal(
      isOperatorConsoleUnlocked({ connected: upgrade, authorities: bootstrap }),
      true,
    );
    assert.equal(
      isOperatorConsoleUnlocked({ connected: other, authorities: bootstrap }),
      false,
    );
    const live = operatorAuthoritiesFromProofs({
      programConfigured: true,
      upgradeAuthority: upgrade,
      configAuthority: other,
      pendingAuthority: null,
      creatorBeneficiary: upgrade,
    });
    assert.deepEqual(
      live.map((row) => row.role),
      ["upgrade-authority", "config-authority"],
    );
    assert.equal(isOperatorConsoleUnlocked({ connected: upgrade, authorities: live }), true);
    assert.equal(isOperatorConsoleUnlocked({ connected: other, authorities: live }), true);
    assert.equal(isOperatorConsoleUnlocked({ connected: null, authorities: live }), false);
    const empty = operatorAuthoritiesFromProofs({
      programConfigured: true,
      upgradeAuthority: null,
      configAuthority: null,
      pendingAuthority: null,
      creatorBeneficiary: null,
    });
    assert.equal(empty.length, 0);
    assert.equal(isOperatorConsoleUnlocked({ connected: upgrade, authorities: empty }), false);
  });

  it("rejects secrets, remote code, adapters, and SSR in first-party sources", () => {
    const hits: string[] = [];
    const forbidden = [
      "dangerouslySetInnerHTML",
      "eval(",
      "new Function",
      "Keypair.fromSecretKey",
      "Keypair.fromSeed",
      "privateKeyBase58",
      "seedPhrase",
      "@solana/wallet-adapter-wallets",
      "PhantomWalletAdapter",
      "SolflareWalletAdapter",
      "react-router",
      "next/",
      "gtag(",
      "googletagmanager",
      "plausible",
      "mixpanel",
      "unpkg.com",
      "jsdelivr.net",
      "cdnjs.cloudflare.com",
    ];
    for (const file of textSources()) {
      if (file.rel === "README.md") {
        continue;
      }
      if (file.rel === "tests/source-hygiene.test.ts") {
        continue;
      }
      for (const needle of forbidden) {
        if (file.text.includes(needle)) {
          hits.push(`${file.rel}: ${needle}`);
        }
      }
    }
    assert.deepEqual(hits, []);
  });

  it("gates throwaway Q3b mint on loopback, 25 bps Token-2022, extra mint signer, not ICHOR", () => {
    const app = read("src/App.tsx");
    const panel = read("src/panels/ThrowawayMint.tsx");
    const builder = read("src/throwaway-mint.ts");
    const send = read("src/send.ts");
    const inputs = read("src/throwaway-mint-inputs.ts");
    const extensions = read("../client/src/extensions.ts");
    const network = read("../client/src/network.ts");

    assert.equal(THROWAWAY_Q3B_TRANSFER_FEE_BASIS_POINTS, 25);
    assert.match(
      extensions,
      new RegExp(
        `export const TRANSFER_FEE_BASIS_POINTS = ${String(THROWAWAY_Q3B_TRANSFER_FEE_BASIS_POINTS)}`,
      ),
    );
    assert.match(network, new RegExp(`id: "${THROWAWAY_Q3B_TOKEN_2022_PROGRAM_ID}"`));
    assert.match(builder, /TRANSFER_FEE_BASIS_POINTS/);
    assert.match(builder, /TOKEN_2022_PROGRAM/);
    assert.match(builder, /createInitializeTransferFeeConfigInstruction/);
    assert.match(builder, /createInitializeMint2Instruction\(mint\.publicKey, decimals, payer, null,/);
    assert.match(builder, /createAssociatedTokenAccountInstruction/);
    assert.match(builder, /createMintToCheckedInstruction/);
    assert.match(builder, /Keypair\.generate\(\)/);
    assert.match(builder, /proveOfficialDevnetConnection/);
    assert.match(builder, /CLUSTER_GENESIS_HASH\.devnet/);
    assert.match(builder, /isLocalGovernanceDevHost/);
    assert.doesNotMatch(builder, /Keypair\.fromSecretKey|Keypair\.fromSeed/);
    assert.doesNotMatch(builder, /kekbull_ichor|assertVerifiedIchorProgram|configPda\(/);
    assert.doesNotMatch(builder, /from ["']react["']/);
    assert.doesNotMatch(inputs, /from ["']react["']/);

    assert.match(app, /isLocalGovernanceDevHost\(host\)/);
    // The Q3b throwaway-mint panel must be unreachable on dao.kekbull.com.
    //
    // This used to assert the literal `tab === "q3b" && localDev`. That broke
    // when the console was hoisted behind a single `if (localDev)` early return
    // -- the guard got STRONGER and the string test failed anyway. Assert the
    // property instead: the panel only ever mounts inside the loopback-only
    // branch, and `localDev` traces back to the host check.
    const throwawayFirst = app.indexOf("<ThrowawayMint");
    const throwawayLast = app.lastIndexOf("<ThrowawayMint");
    const operatorGate = app.indexOf("if (localDev) {");
    const holderPage = app.indexOf("// ---- holder page:");
    assert.ok(throwawayFirst > 0, "ThrowawayMint must be mounted somewhere");
    assert.equal(throwawayFirst, throwawayLast, "ThrowawayMint must mount exactly once");
    assert.ok(operatorGate > 0, "operator console must sit behind `if (localDev) {`");
    assert.ok(holderPage > operatorGate, "holder page must render after the operator console");
    assert.ok(
      throwawayFirst > operatorGate && throwawayFirst < holderPage,
      "ThrowawayMint must mount only inside the loopback-only operator console",
    );
    assert.match(app, /const localDev = props\.operatorView;/);
    assert.match(app, /const operatorView = localDev && !holderPreview;/);
    assert.match(app, /const localDev = isLocalGovernanceDevHost\(host\);/);
    assert.match(app, /<ThrowawayMint/);
    assert.doesNotMatch(app, /isOfficialGovernanceHost/);
    assert.doesNotMatch(
      app,
      /isOfficialGovernanceHost\([^)]*\)[\s\S]{0,400}<ThrowawayMint/,
    );
    assert.doesNotMatch(app, /dao\.kekbull\.com[\s\S]{0,200}<ThrowawayMint/);

    assert.match(panel, /isLocalGovernanceDevHost\(host\)/);
    assert.match(panel, /return null/);
    assert.match(panel, /throwaway Q3b mint/);
    assert.match(panel, /not ICHOR/);
    assert.match(panel, /0\.25%/);
    assert.match(panel, /app\.realms\.today\/realms\?cluster=devnet/);
    assert.doesNotMatch(panel, /isOfficialGovernanceHost/);
    assert.doesNotMatch(panel, /kekbull_ichor|assertVerifiedIchorProgram|configPda\(/);

    assert.match(send, /partialSign/);
    assert.match(send, /dropExtraSigners/);
    assert.match(send, /secretKey\.fill/);
    assert.match(send, /proveOfficialDevnetConnection/);
    assert.match(send, /CLUSTER_GENESIS_HASH\.devnet/);
    assert.match(send, /SIGNED_MESSAGE_CHANGED/);
    assert.match(send, /signTransaction/);
    assert.match(send, /sendRawTransaction/);
    assert.doesNotMatch(send, /wallet\.sendTransaction/);
    assert.doesNotMatch(send, /Keypair\.fromSecretKey|Keypair\.fromSeed/);
    assert.match(send, /payloadReview/);
    assert.doesNotMatch(
      send.match(/export function payloadReview[\s\S]+?\n\}/)?.[0] ?? "",
      /extraSigners|secretKey/,
    );
  });

  it("holder page only removes operator surface; builders stay in source", () => {
    const app = read("src/App.tsx");
    const gov = read("src/panels/Governance.tsx");
    const fees = read("src/panels/TransferFees.tsx");
    const lock = read("src/panels/LockAndFees.tsx");
    assert.match(lock, /stat damm-fees/);
    const holderPage = app.indexOf("// ---- holder page:");
    assert.ok(holderPage > 0, "holder page marker must exist");
    const holder = app.slice(holderPage);
    // Holders get <Proposals>, which carries only deposit / withdraw / create /
    // sign off / vote / relinquish. This used to assert <Governance> with
    // operatorView={false}, i.e. the operator console mounted but self-censoring.
    // Not mounting it at all is the stronger guarantee, so assert that instead:
    // the console component must be absent from the holder page entirely.
    assert.ok(
      holder.indexOf('id="treasury"') < holder.indexOf('id="liquidity"') &&
        holder.indexOf('id="liquidity"') < holder.indexOf('id="burn"'),
      "DAO treasury sits above locked liquidity, both above Burn / Deposit / Vote",
    );
    assert.match(holder, /<Proposals/);
    assert.doesNotMatch(holder, /<Governance/);
    // Bound each check to the element's OWN props. `<TransferFees[\s\S]*?prop`
    // is unbounded, so it happily matched a prop belonging to a LATER element:
    // deleting operatorView={false} from <TransferFees> still passed because the
    // match ran on to <LockAndFees>. Slice the element and assert inside it.
    const holderElement = (tag: string): string => {
      const open = holder.indexOf(`<${tag}`);
      assert.ok(open >= 0, `${tag} must be mounted on the holder page`);
      const close = holder.indexOf("/>", open);
      assert.ok(close > open, `${tag} must be self-closing on the holder page`);
      return holder.slice(open, close + 2);
    };
    assert.match(holderElement("TransferFees"), /operatorView=\{false\}/);
    assert.match(holderElement("PumpCreatorFees"), /onRequestSend=\{queuePayload\}/);
    assert.match(holderElement("LockAndFees"), /operatorView=\{false\}/);
    assert.doesNotMatch(holder, /<ThrowawayMint/);
    assert.doesNotMatch(holder, /<ConfigForm/);
    // Pinned to the structure, not the wording. An earlier version asserted
    // the literal headline, so rewriting the copy failed a test that was
    // meant to guard that the newcomer explainer is mounted at all.
    assert.match(holder, /group="New here"/);
    assert.match(holder, /className="ladder"/);
    assert.match(holder, /id="weight"/);
    assert.match(holder, /DaoStateBanner/);
    assert.match(holder, /lockVerified=\{lockVerified\}/);
    assert.match(holder, /stateBanner=\{/);
    assert.match(read("src/dao-state.ts"), /readonly lockVerified: boolean \| null/);
    assert.match(read("src/dao-state.ts"), /input\.lockVerified !== true/);
    assert.match(read("src/panels/TreasuryAssets.tsx"), /lockVerified === true \? "PERMANENT LOCK"/);
    assert.match(read("src/panels/DeploymentFacts.tsx"), /sourceMintLabel/);
    assert.doesNotMatch(read("src/panels/DeploymentFacts.tsx"), /\["KEKBULL mint"/);
    assert.match(read("src/panels/DeploymentFacts.tsx"), /\["Voting program"/);
    assert.match(read("src/panels/DeploymentFacts.tsx"), /passed\.verified\.realms\.programId/);
    assert.match(read("src/panels/Succession.tsx"), /passed\?\.verified\.realms\.programId/);
    assert.doesNotMatch(read("src/panels/Succession.tsx"), /REALMS_INSTANCES/);
    assert.match(read("src/panels/Proposals.tsx"), /reviewedProposalAddress === proposalAddress\.trim\(\)/);
    assert.match(read("src/panels/Proposals.tsx"), /Staged execute receipt is not this proposal/);
    assert.match(read("src/proposal-actions.ts"), /Pay ICHOR from the treasury \(\$\{String\(payCount\)\} transfers\)/);
    assert.match(read("src/panels/Proposals.tsx"), /openProposalFromList/);
    assert.match(read("src/panels/Proposals.tsx"), /buildRelinquishStandingCommunityVotes/);
    assert.match(read("src/panels/Proposals.tsx"), /buildReleaseStandingAndWithdrawIchorVotes/);
    assert.match(read("src/panels/Proposals.tsx"), /buildReleaseVotesOnClosedProposal/);
    assert.match(read("src/panels/Proposals.tsx"), /Release voter deposits/);
    assert.match(read("src/panels/Proposals.tsx"), /Checking withdraw/);
    assert.match(read("src/format.ts"), /ACTIVE_VOTES_BLOCK_WITHDRAW/);
    assert.match(read("src/format.ts"), /Can't withdraw while you have an active vote/);
    assert.match(read("src/panels/Proposals.tsx"), /Relinquish all standing votes/);
    assert.match(read("src/panels/Proposals.tsx"), /id="proposal-detail"/);
    assert.match(read("src/panels/Proposals.tsx"), /className="proposal"/);
    assert.match(read("src/panels/Proposals.tsx"), /votebar/);
    assert.match(read("src/panels/Proposals.tsx"), /vote-closed/);
    assert.match(read("src/panels/Proposals.tsx"), /buildVoteFromCard/);
    assert.match(gov, /operatorView\?: boolean;/);
    assert.match(gov, /const operatorView = props\.operatorView \?\? true;/);
    assert.match(gov, /\{operatorView \? \(<>/);
    assert.match(gov, /<h3>Community activation<\/h3>/);
    assert.doesNotMatch(gov, /GovER5 548/);
    assert.doesNotMatch(gov, /CastVote is broken/);
    assert.match(gov, /<h3>Generic inner instruction \(stage only\)<\/h3>/);
    assert.match(gov, /<h3>Deposit \/ withdraw ICHOR<\/h3>/);
    assert.match(fees, /\{operatorView \? \(/);
    assert.match(fees, /Build permanent fee binding/);
    assert.match(fees, /Build harvest to mint/);
    assert.match(lock, /\{operatorView \? \(/);
    assert.match(lock, /Refresh lock/);
    assert.match(lock, /Build position-rights handoff/);
    assert.match(lock, /Verify treasury owns fee rights/);
    assert.match(lock, /Stage Meteora fee claim/);
    assert.match(lock, /100% of the LP fee share/);
    assert.match(lock, /protocol fee/);
    assert.match(holder, /100% of the LP fee share/);
    assert.match(holder, /Meteora keeps a protocol fee/);
  });

  it("living holder and public copy rejects retired sequence phrases", () => {
    const living: Array<{ rel: string; text: string }> = [
      { rel: "src/panels/Handbook.tsx", text: read("src/panels/Handbook.tsx") },
      { rel: "src/panels/Succession.tsx", text: read("src/panels/Succession.tsx") },
      { rel: "src/panels/Burn.tsx", text: read("src/panels/Burn.tsx") },
      { rel: "src/dao-state.ts", text: read("src/dao-state.ts") },
    ];
    if (websiteRoot !== null) {
      living.push({ rel: "website/index.html", text: readWebsite("index.html") });
    }

    // Living surfaces only. Dated Fable / red-team reports may keep the old
    // phrases as 2026-09-02 evidence.
    const stale = [
      /no later than 90/i,
      /Deadline is 90 days/i,
      /Within 90 days of voting/,
      /up to 90 days after/i,
      /after an initialized PumpSwap pool exists/i,
      /After the PumpSwap pool exists,\s*Pump fee shares/,
      /handed over afterwards/,
      /75% of the KEKBULL portion is handed over/,
      /75% of those KEKBULL-specific fees is then transferred/,
      /75% of the KEKBULL-specific portion is transferred afterwards/,
      /The pool and its permanent lock come first/,
      /Holder burning opens once the pool exists/,
      /The first burn after graduation is the treasury/,
      /Burning opens for everyone once the pool exists/,
      /Burning opens when the pool is live/,
    ];
    for (const { rel, text } of living) {
      for (const pattern of stale) {
        assert.doesNotMatch(text, pattern, `${rel} still carries ${String(pattern)}`);
      }
    }

    const handbook = read("src/panels/Handbook.tsx");
    assert.match(handbook, /Day 90 is a checkpoint to stop and\s+re-decide/);
    assert.match(handbook, /atomic defensive stake/);
    assert.match(handbook, /no retroactive 75% transfer/);
    assert.match(handbook, /while the curve is still open/);
    assert.match(handbook, /Vote-program upgrade authority is a later, separate review/);
    assert.match(handbook, /config\.authority/);

    assert.match(read("src/panels/Burn.tsx"), /come after that first stake, not before/);
    assert.match(read("src/dao-state.ts"), /Day 90 is a checkpoint to stop and re-decide/);
    assert.match(read("src/panels/Succession.tsx"), /Vote-program\s+upgrade authority is a later, separate review/);

    if (websiteRoot !== null) {
      const site = readWebsite("index.html");
      assert.match(site, /config\.authority/);
      assert.match(site, /pause and unpause conversion without a vote/);
      assert.match(site, /Day 90 is a checkpoint to stop and re-decide/);
      assert.match(site, /no retroactive 75% transfer/);
      assert.match(site, /while the curve is still open|while KEKBULL is still on the curve/);
      assert.match(site, /defensive stake/);
    }
  });

  it("PLAN §16.1 and §13.4 supersede pool-gated unpause with a dated note", () => {
    const planPath = join(root, "..", "..", "docs/PLAN_KEKBULL_DAO_TREASURY.md");
    assert.equal(existsSync(planPath), true, "PLAN is living architecture in this checkout");
    const plan = readFileSync(planPath, "utf8");
    const section16 = plan.slice(plan.indexOf("### 16.1 The decision"), plan.indexOf("### 16.2"));
    assert.match(section16, /\[OPERATOR, 2026-08-25\]/);
    assert.match(section16, /Superseded 2026-09-02 \[OPERATOR\]/);
    assert.match(section16, /atomic E-stage defensive stake/);
    assert.match(section16, /\*\*before\*\* the ICHOR\/SOL pool/);
    assert.match(section16, /Later F-stage/);
    assert.match(section16, /open-conversion/);
    assert.match(section16, /G creates and permanently locks/);
    assert.match(section16, /The pool-gated unpause\s+does not/);
    const beforeSupersession = section16.slice(0, section16.indexOf("Superseded 2026-09-02"));
    assert.doesNotMatch(
      beforeSupersession,
      /until\s+the ICHOR\/SOL pool exists and its liquidity is permanently locked/,
    );

    const section134 = plan.slice(plan.indexOf("### 13.4 Revised order"), plan.indexOf("### 13.5"));
    const step1 = section134.slice(section134.indexOf("1. Bootstrap"), section134.indexOf("2. Council"));
    assert.match(step1, /Superseded 2026-09-02 \[OPERATOR\]/);
    assert.match(step1, /atomic E-stage\s+defensive stake/);
    assert.match(step1, /before the ICHOR\/SOL pool/);
    assert.match(step1, /Later F opens\s+holder convert; G creates and locks the DAMM/);
    const step1Current = step1.slice(0, step1.indexOf("Superseded 2026-09-02"));
    assert.match(step1Current, /treasury, and fee bind/);
    assert.doesNotMatch(step1Current, /treasury burn, pool, and permanent lock/);
  });

  it("hosts only exact dao.kekbull.com on the existing VPS with origin isolation", operatorOnly, () => {
    const readme = read("README.md");
    const website = join(root, "..", "..", "website");
    const caddy = readFileSync(join(website, "Caddyfile"), "utf8");
    const deploy = readFileSync(join(website, "deploy.sh"), "utf8");
    const deployDao = readFileSync(join(website, "deploy-dao.sh"), "utf8");
    const preflight = readFileSync(join(website, "preflight.sh"), "utf8");
    assert.equal(existsSync(join(root, "caddy")), false);
    assert.equal(existsSync(join(root, "caddy/Caddyfile.example")), false);
    assert.match(readme, /Official public host is exact `dao\.kekbull\.com`/);
    assert.match(readme, /website\/Caddyfile/);
    // The policy, not one phrasing of it. The README used to name the host
    // outright; it no longer does, because the publish set must not carry the
    // operator's infrastructure names. What must survive is the statement that
    // sharing the box is allowed only under origin isolation.
    assert.match(readme, /existing VPS/i);
    assert.doesNotMatch(readme, /manual-trader-eu/);
    assert.doesNotMatch(readme, /intentionally absent/);
    assert.doesNotMatch(readme, /Never Frankfurt/);
    assert.doesNotMatch(readme, /Never host this app on `kekbull\.com` or any `\*\.kekbull\.com`/);
    assert.match(caddy, /^dao\.kekbull\.com \{/m);
    assert.match(caddy, /^devnet\.dao\.kekbull\.com \{/m);
    assert.match(caddy, /^kekbull\.com \{/m);
    assert.match(caddy, /^www\.kekbull\.com \{/m);
    assert.match(caddy, /root \* \/home\/ubuntubuddha\/www\/kekbull$/m);
    assert.match(caddy, /root \* \/home\/ubuntubuddha\/www\/kekbull-dao$/m);
    assert.match(caddy, /root \* \/home\/ubuntubuddha\/www\/kekbull-dao-devnet$/m);
    assert.doesNotMatch(caddy, /0\.0\.0\.0/);
    assert.doesNotMatch(caddy, /3010|3011|3012/);
    assert.match(caddy, /# handle \/api\/pin-proposal\*/);
    assert.match(caddy, /#\s+reverse_proxy 127\.0\.0\.1:5182/);
    assert.match(caddy, /# handle \/api\/proposal-chat\*/);
    assert.match(caddy, /#\s+reverse_proxy 127\.0\.0\.1:5183/);
    const wwwStart = caddy.search(/^www\.kekbull\.com \{/m);
    const marketingStart = caddy.search(/^kekbull\.com \{/m);
    const daoStart = caddy.search(/^dao\.kekbull\.com \{/m);
    const previewStart = caddy.search(/^devnet\.dao\.kekbull\.com \{/m);
    assert.ok(wwwStart >= 0 && marketingStart > wwwStart && daoStart > marketingStart && previewStart > daoStart);
    const www = caddy.slice(wwwStart, marketingStart);
    const marketing = caddy.slice(marketingStart, daoStart);
    const dao = caddy.slice(daoStart, previewStart);
    const preview = caddy.slice(previewStart);
    const hstsHttpsOnly =
      /@https protocol https[\s\S]*?header @https Strict-Transport-Security "max-age=31536000; includeSubDomains"/;
    assert.match(www, hstsHttpsOnly);
    assert.match(marketing, hstsHttpsOnly);
    assert.match(dao, hstsHttpsOnly);
    assert.match(preview, hstsHttpsOnly);
    assert.doesNotMatch(caddy, /^:80\b/m);
    assert.doesNotMatch(caddy, /^http:\/\//m);
    assert.doesNotMatch(caddy, /includeSubDomains; preload/);
    assert.doesNotMatch(caddy, /^\s*header Strict-Transport-Security/m);
    assert.doesNotMatch(marketing, /reverse_proxy/);
    assert.match(marketing, /connect-src 'self'"/);
    assert.doesNotMatch(marketing, /solana\.com/);
    assert.match(
      dao,
      /connect-src 'self' https:\/\/api\.devnet\.solana\.com https:\/\/api\.mainnet-beta\.solana\.com wss:\/\/api\.devnet\.solana\.com wss:\/\/api\.mainnet-beta\.solana\.com https:\/\/ipfs\.io https:\/\/gold-hilarious-monkey-129\.mypinata\.cloud\{\$DAO_CONNECT_SRC_EXTRA\}"/,
    );
    const daoConnect = dao.match(/connect-src ([^"]+)/)?.[1] ?? "";
    assert.doesNotMatch(daoConnect, /\*/);
    assert.match(dao, /img-src 'self' data: blob:/);
    assert.doesNotMatch(dao.match(/img-src [^;"]+/)?.[0] ?? "", /mypinata|ipfs\.io/);
    assert.match(dao, /worker-src 'none'/);
    assert.match(dao, /script-src 'self'/);
    assert.match(dao, /style-src 'self' 'unsafe-inline'/);
    assert.doesNotMatch(dao.match(/script-src [^;"]+/)?.[0] ?? "", /unsafe-inline/);
    assert.match(deploy, /REFUSING: marketing deploy must not write the DAO root/);
    assert.match(deploy, /looks like a governance-ui \/ DAO build/);
    assert.match(preview, /X-Robots-Tag noindex/);
    assert.match(preview, /www\/kekbull-dao-devnet/);
    assert.doesNotMatch(preview, /pin-proposal/);
    assert.match(preview, /# handle \/api\/proposal-chat\*/);
    const proxyTarget = /reverse_proxy\s+(127\.0\.0\.1:\d+)/g;
    const uncomment = (block: string) =>
      block
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
    const previewProxies = [...uncomment(preview).matchAll(proxyTarget)].map((m) => m[1]);
    assert.deepEqual(previewProxies, ["127.0.0.1:5184"]);
    assert.match(preview, /handle \/rpc\*/);
    const daoProxies = [...uncomment(dao).matchAll(proxyTarget)].map((m) => m[1]);
    assert.deepEqual(daoProxies, ["127.0.0.1:5185"]);
    assert.match(dao, /handle \/rpc\*/);
    assert.match(
      preview,
      /connect-src 'self' https:\/\/api\.devnet\.solana\.com https:\/\/api\.mainnet-beta\.solana\.com/,
    );
    assert.match(deployDao, /ichor\/governance-ui\/dist/);
    assert.match(deployDao, /www\/kekbull-dao/);
    assert.match(deployDao, /www\/kekbull-dao-devnet/);
    assert.match(deployDao, /--devnet/);
    assert.match(deployDao, /refuse_cluster_mismatch/);
    assert.match(deployDao, /deny-list-mainnet\.sh/);
    assert.match(deployDao, /rm -f "\$STAGING\/deployment\.devnet\.json" "\$STAGING\/deployment\.mainnet\.json"/);
    assert.match(deployDao, /cp "\$DEVNET_JSON" "\$STAGING\/deployment\.json"/);
    assert.match(deployDao, /for leftover in deployment\.devnet\.json deployment\.mainnet\.json/);
    assert.match(deployDao, /still contains \$leftover/);
    assert.match(deployDao, /"\$DENY_LIST" "\$SHIP_DIST"/);
    assert.match(deployDao, /EXPECTED_CLUSTER=devnet/);
    assert.match(deployDao, /EXPECTED_CLUSTER=mainnet-beta/);
    assert.match(deployDao, /REFUSING: DAO deploy must write/);
    assert.match(deployDao, /will not install cluster=/);
    assert.match(deployDao, /looks like the marketing site/);
    assert.match(read("src/App.tsx"), /props\.config\.cluster === "devnet"/);
    assert.match(read("src/panels/Masthead.tsx"), /props\.cluster === "devnet"/);
    assert.match(read("src/panels/DaoStateBanner.tsx"), /devnet\.dao\.kekbull\.com/);
    assert.match(read("src/proposal-markdown.ts"), /response\.status === 404/);
    assert.doesNotMatch(deployDao, /\bnpm (?:install|ci|run)\b/);
    assert.doesNotMatch(deployDao, /\bnpx /);
    assert.doesNotMatch(deployDao, /(?:^|[;\n])\s*vite /m);
    assert.match(preflight, /marketing root looks like a DAO build/);
    assert.match(preflight, /DAO root looks like the marketing site/);
    assert.match(preflight, /bind pins present/);
    assert.match(preflight, /must not proxy pin-proposal/);
    assert.match(preflight, /marketing site must not reverse_proxy/);
    assert.match(preflight, /dedicated Pinata gateway for proposal markdown/);
    assert.match(preflight, /must not proxy proposal-chat/);
    assert.match(preflight, /\/rpc reverse_proxy to 127\.0\.0\.1:5184/);
    assert.match(preflight, /\/rpc reverse_proxy to 127\.0\.0\.1:5185/);
    assert.match(preflight, /A second target fails/);
    assert.match(preflight, /preview reverse_proxy targets drifted/);
  });

  it("proposal-chat helper is loopback, has no pin credential, and keeps SQLite off deploy roots", operatorOnly, () => {
    const helper = read("scripts/proposal-chat-server.cjs");
    const client = read("src/proposal-chat.ts");
    const runbook = read("scripts/proposal-chat-RUNBOOK.md");
    const unit = readFileSync(join(root, "..", "..", "website", "kekbull-proposal-chat.service"), "utf8");
    const preflight = readFileSync(join(root, "..", "..", "website", "preflight.sh"), "utf8");
    const caddy = readFileSync(join(root, "..", "..", "website", "Caddyfile"), "utf8");
    assert.ok(existsSync(join(root, "scripts/proposal-chat-server.cjs")));
    assert.match(helper, /listen\(PORT, HOST/);
    assert.match(helper, /const HOST = "127\.0\.0\.1"/);
    assert.doesNotMatch(helper, /0\.0\.0\.0/);
    assert.doesNotMatch(helper, /PINATA_JWT|PINATA_GATEWAY|HELIUS_/);
    assert.doesNotMatch(helper, /ICHOR_CHAT_OPERATOR/);
    assert.doesNotMatch(client, /PINATA_JWT|HELIUS_/);
    assert.match(helper, /www\/kekbull-dao-chat\.sqlite/);
    assert.match(helper, /www\/kekbull-dao-devnet-chat\.sqlite/);
    assert.match(helper, /function clusterForHost/);
    assert.match(helper, /same-origin GET/);
    assert.match(helper, /purgeExpiredNonces/);
    assert.match(helper, /nonceLimit\(clientIp\(req\)\)/);
    assert.match(read("src/panels/ProposalThread.tsx"), /Older comments/);
    assert.match(read("src/panels/ProposalThread.tsx"), /one-pager/);
    assert.doesNotMatch(helper, /www\/kekbull-dao\/.*\.sqlite/);
    assert.doesNotMatch(helper, /www\/kekbull-dao-devnet\/.*\.sqlite/);
    assert.match(read("vite.config.ts"), /proposal-chat-server\.cjs/);
    assert.match(read("vite.config.ts"), /\/api\/proposal-chat/);
    assert.doesNotMatch(read("src/panels/Proposals.tsx"), /ProposalThread/);
    assert.match(read("src/panels/Proposals.tsx"), /t\.me\/kekbull/);
    assert.match(read("src/panels/Proposals.tsx"), /does not host a comment thread/);
    assert.match(unit, /Restart=on-failure/);
    assert.match(unit, /127\.0\.0\.1/);
    assert.match(runbook, /DELETE FROM comments/);
    assert.match(runbook, /www\/kekbull-dao-chat\.sqlite/);
    assert.doesNotMatch(runbook, /www\/kekbull-dao\/chat/);
    assert.match(preflight, /\["127\.0\.0\.1:5185"\]/);
    const daoStart = caddy.search(/^dao\.kekbull\.com \{/m);
    const previewStart = caddy.search(/^devnet\.dao\.kekbull\.com \{/m);
    const dao = caddy.slice(daoStart, previewStart);
    const drifted = `${dao}\n\thandle /api/extra* {\n\t\treverse_proxy 127.0.0.1:5184\n\t}\n`;
    const targets = [
      ...drifted
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n")
        .matchAll(/reverse_proxy\s+(127\.0\.0\.1:\d+)/g),
    ].map((m) => m[1]);
    assert.deepEqual(targets, ["127.0.0.1:5185", "127.0.0.1:5184"]);
    assert.notDeepEqual(targets, ["127.0.0.1:5185"]);
  });

  it("pin-proposal helper unit is loopback and loads only Pinata keys from the env file", operatorOnly, () => {
    const helper = read("scripts/pin-proposal-server.cjs");
    const pinUnit = readFileSync(join(root, "..", "..", "website", "kekbull-pin-proposal.service"), "utf8");
    assert.ok(existsSync(join(root, "scripts/pin-proposal-server.cjs")));
    assert.match(helper, /const HOST = "127\.0\.0\.1"/);
    assert.match(helper, /listen\(PORT, HOST/);
    assert.match(helper, /function loadPinataFromEnvFile/);
    assert.match(helper, /\^\(PINATA_JWT\|PINATA_GATEWAY\)=/);
    assert.match(helper, /rateLimit\(clientIp\(req\)\)/);
    assert.doesNotMatch(helper, /rateLimit\(`\$\{clientIp\(req\)\}:\$\{wallet\}`\)/);
    assert.doesNotMatch(helper, /HELIUS_/);
    assert.match(pinUnit, /127\.0\.0\.1:5182/);
    assert.match(pinUnit, /ICHOR_PIN_ENV_FILE/);
    assert.doesNotMatch(pinUnit, /^EnvironmentFile=/m);
    assert.doesNotMatch(pinUnit, /HELIUS_/);
  });

  it("mainnet /rpc helper is loopback, has no pin credential, and refuses a named provider", operatorOnly, () => {
    const helper = read("scripts/mainnet-rpc-proxy.cjs");
    const unit = readFileSync(join(root, "..", "..", "website", "kekbull-mainnet-rpc.service"), "utf8");
    assert.ok(existsSync(join(root, "scripts/mainnet-rpc-proxy.cjs")));
    assert.match(helper, /const HOST = "127\.0\.0\.1"/);
    assert.match(helper, /listen\(PORT, HOST/);
    assert.doesNotMatch(helper, /0\.0\.0\.0/);
    assert.doesNotMatch(helper, /PINATA_JWT|PINATA_GATEWAY|HELIUS_/);
    assert.match(helper, /ICHOR_MAINNET_RPC/);
    assert.match(helper, /MAINNET_RPC_URL/);
    assert.match(helper, /refuses a devnet primary/);
    assert.match(helper, /api\.mainnet-beta\.solana\.com/);
    assert.match(unit, /127\.0\.0\.1:5185/);
    assert.match(unit, /Restart=on-failure/);
    assert.doesNotMatch(unit, /HELIUS_/);
  });

  it("official-devnet /rpc helper is loopback, has no pin credential, and refuses a named provider", operatorOnly, () => {
    const helper = read("scripts/devnet-rpc-proxy.cjs");
    const unit = readFileSync(join(root, "..", "..", "website", "kekbull-devnet-rpc.service"), "utf8");
    assert.ok(existsSync(join(root, "scripts/devnet-rpc-proxy.cjs")));
    assert.match(helper, /const HOST = "127\.0\.0\.1"/);
    assert.match(helper, /listen\(PORT, HOST/);
    assert.doesNotMatch(helper, /0\.0\.0\.0/);
    assert.doesNotMatch(helper, /PINATA_JWT|PINATA_GATEWAY|HELIUS_/);
    assert.match(helper, /ICHOR_DEVNET_RPC/);
    assert.match(helper, /DEVNET_RPC_URL/);
    assert.match(helper, /refuses a mainnet upstream/);
    assert.match(unit, /127\.0\.0\.1:5184/);
    assert.match(unit, /Restart=on-failure/);
    assert.doesNotMatch(unit, /HELIUS_/);
  });

  it("proposal-announce helper is send-only and cannot read the room it is admin in", operatorOnly, () => {
    // Topic-per-proposal mode requires the bot to be a group administrator,
    // and ANY admin right disables Telegram privacy mode -- Telegram then
    // delivers every message in the group to this bot. The guarantee that
    // nothing reads them is enforced here, over the source, rather than
    // promised in a runbook. Mirrored in tests/proposal-announce.test.ts
    // deliberately: this is the assertion that has to outlive both files.
    const helper = read("scripts/proposal-announce.cjs");
    const runbook = read("scripts/proposal-announce-RUNBOOK.md");
    assert.ok(existsSync(join(root, "scripts/proposal-announce.cjs")));
    assert.doesNotMatch(helper, /getUpdates/);
    assert.doesNotMatch(helper, /setWebhook|deleteWebhook|getWebhookInfo|allowed_updates/);
    assert.doesNotMatch(helper, /update_id|edited_message|channel_post|callback_query/);
    assert.doesNotMatch(helper, /createServer|\.listen\(/);
    assert.doesNotMatch(
      helper,
      /deleteMessage|deleteForumTopic|banChatMember|restrictChatMember|promoteChatMember|pinChatMessage/,
    );
    // One egress URL, one token use, exactly two Bot API methods, forever.
    assert.equal([...helper.matchAll(/api\.telegram\.org/g)].length, 1);
    assert.equal([...helper.matchAll(/cfg\.token/g)].length, 1);
    assert.deepEqual(
      [...helper.matchAll(/telegramApi\(cfg, "([A-Za-z]+)"/g)].map((m) => m[1]).sort(),
      ["createForumTopic", "sendMessage"],
    );
    assert.doesNotMatch(helper, /PINATA_JWT|PINATA_GATEWAY|HELIUS_/);
    assert.doesNotMatch(helper, /sendTransaction|signTransaction|Keypair|secretKey/);
    assert.match(runbook, /can_manage_topics/);
    assert.match(runbook, /can_delete_messages[^\n]*DENY/);
  });
});
