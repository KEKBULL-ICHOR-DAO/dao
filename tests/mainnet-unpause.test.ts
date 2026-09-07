/**
 * A-1 close: verified mainnet must not stage/send bare set_paused(false)
 * through wallet.signTransaction. Official-devnet Unpause remains available.
 * Governance.tsx is JSX — regex-over-source plus the exported helper contract.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CLUSTER_GENESIS_HASH } from "@kekbull/ichor-client";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const gov = readFileSync(join(root, "src/panels/Governance.tsx"), "utf8");

const MAINNET_GENESIS = CLUSTER_GENESIS_HASH["mainnet-beta"];

function sliceFn(source: string, name: string, nextName: string): string {
  const start = source.indexOf(name);
  const end = source.indexOf(nextName, start + 1);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing ${nextName} after ${name}`);
  return source.slice(start, end);
}

describe("Governance UI mainnet unpause unavailable", () => {
  it("fail-closes in dispatchSetPaused itself, not UI visibility alone", () => {
    const dispatch = sliceFn(
      gov,
      "async function dispatchSetPaused",
      "async function dispatchProposeEmissionRatio",
    );
    assert.match(dispatch, /if \(!paused\) \{\s*assertWalletUnpauseAllowed\(unpauseIdentity\);/s);
    assert.ok(
      dispatch.indexOf("assertWalletUnpauseAllowed") < dispatch.indexOf("resolveConfigAdminAuthority"),
      "unpause refuse must run before resolveConfigAdminAuthority",
    );
    assert.ok(
      dispatch.indexOf("assertWalletUnpauseAllowed") < dispatch.indexOf("buildSetPaused"),
      "unpause refuse must run before buildSetPaused",
    );
    assert.ok(
      dispatch.indexOf("assertWalletUnpauseAllowed") < dispatch.indexOf("dispatchConfigAdmin"),
      "unpause refuse must run before onStageAction / onRequestSend",
    );
    assert.match(gov, /MAINNET_UNPAUSE_REFUSED/);
    assert.match(gov, /wallet\.signTransaction/);
    assert.match(gov, /ichor_mainnet_f_signer/);
    assert.match(gov, /open-conversion/);
    assert.match(gov, /CLUSTER_GENESIS_HASH\["mainnet-beta"\]/);
    assert.equal(MAINNET_GENESIS, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
  });

  it("Pause stays a dedicated emergency action that cannot become unpause", () => {
    const pause = sliceFn(gov, "async function dispatchPauseConvert", "async function dispatchProposeEmissionRatio");
    assert.match(pause, /await dispatchSetPaused\(true\);/);
    assert.doesNotMatch(pause, /dispatchSetPaused\(false\)/);
    assert.doesNotMatch(pause, /dispatchSetPaused\(paused\)/);
    assert.match(gov, /onClick=\{\(\) => void dispatchPauseConvert\(\)\}/);
    assert.doesNotMatch(gov, /onClick=\{\(\) => void dispatchSetPaused\(true\)\}/);
    assert.match(gov, /Pause convert/);
  });

  it("hides Unpause on verified mainnet and keeps it for rehearsal cluster", () => {
    const helper = sliceFn(gov, "export function assertWalletUnpauseAllowed", "export function walletUnpauseAvailable");
    assert.match(helper, /params\.cluster === "mainnet-beta"/);
    assert.match(helper, /params\.verifiedCluster === "mainnet-beta"/);
    assert.match(helper, /params\.verifiedGenesis === CLUSTER_GENESIS_HASH\["mainnet-beta"\]/);
    assert.match(helper, /params\.cluster === "devnet"/);
    assert.match(helper, /params\.verifiedCluster === "devnet"/);
    assert.match(gov, /showWalletUnpause \? \(/);
    assert.match(gov, /onClick=\{\(\) => void dispatchSetPaused\(false\)\}/);
    assert.match(gov, /Unpause convert is unavailable on verified mainnet/);
    assert.match(gov, /Unpause convert/);
  });
});
