import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BPF_LOADER_UPGRADEABLE,
  CLUSTER_GENESIS_HASH,
  METEORA_CP_AMM,
  REALMS_INSTANCES,
  REALMS_PROGRAM_VERSION,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  resolveNetwork,
  assertMainnetKekbullGovernance,
} from "../src/network.ts";
import { ClientValidationError } from "../src/types.ts";
import { assertNetworkConfig } from "../src/validation.ts";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("named network config", () => {
  it("pins Realms programVersion to 3", () => {
    assert.equal(REALMS_PROGRAM_VERSION, 3);
    const network = resolveNetwork({
      cluster: "devnet",
      realmsInstance: "default-shared",
    });
    assert.equal(network.programVersion, 3);
    assertNetworkConfig(network);
  });

  it("uses the published default-shared and test instance IDs", () => {
    assert.equal(REALMS_INSTANCES["default-shared"].id, "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw");
    assert.equal(REALMS_INSTANCES.test.id, "GTesTBiEWE32WHXXE2S4XbZvA5CrEc4xs6ZgRe895dP");
    assert.ok(REALMS_INSTANCES["default-shared"].source.includes("docs.realms.today"));
  });

  it("pins the kekbull fork instance separately from GovER5 and GTesT", () => {
    assert.equal(REALMS_INSTANCES.kekbull.id, "2uNHeSLiNn6dLLtiGrpCd8UZKBfV36kap57eg9kV39Fj");
    assert.notEqual(REALMS_INSTANCES.kekbull.id, REALMS_INSTANCES["default-shared"].id);
    assert.notEqual(REALMS_INSTANCES.kekbull.id, REALMS_INSTANCES.test.id);
    assert.match(REALMS_INSTANCES.kekbull.label, /kekbull_governance/i);
    assert.doesNotMatch(REALMS_INSTANCES.kekbull.label, /^Default shared/);
    const network = resolveNetwork({ cluster: "devnet", realmsInstance: "kekbull" });
    assert.equal(network.realmsInstance, "kekbull");
    assert.equal(network.realmsProgramId.toBase58(), REALMS_INSTANCES.kekbull.id);
    assert.equal(network.programVersion, 3);
    assertNetworkConfig(network);
  });

  it("uses the published DAMM v2 program ID", () => {
    assert.equal(METEORA_CP_AMM.id, "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
    const network = resolveNetwork({
      cluster: "mainnet-beta",
      realmsInstance: "default-shared",
    });
    assert.equal(network.meteoraCpAmmProgramId.toBase58(), METEORA_CP_AMM.id);
    assert.equal(network.tokenProgramId.toBase58(), TOKEN_PROGRAM.id);
    assert.equal(network.token2022ProgramId.toBase58(), TOKEN_2022_PROGRAM.id);
  });

  it("pins official cluster genesis hashes and the upgradeable loader", () => {
    assert.equal(CLUSTER_GENESIS_HASH.devnet, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    assert.equal(
      CLUSTER_GENESIS_HASH["mainnet-beta"],
      "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    );
    assert.equal(BPF_LOADER_UPGRADEABLE.id, "BPFLoaderUpgradeab1e11111111111111111111111");
  });

  it("does not invent an unnamed Realms instance", () => {
    assert.throws(
      () =>
        resolveNetwork({
          cluster: "devnet",
          realmsInstance: "custom" as "test",
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "UNKNOWN_REALMS_INSTANCE",
    );
    assert.deepEqual(Object.keys(REALMS_INSTANCES).sort(), ["default-shared", "kekbull", "test"]);
  });

  it("refuses GovER5 as a mainnet write-once Realms instance without changing resolveNetwork", () => {
    const gover5 = resolveNetwork({ cluster: "mainnet-beta", realmsInstance: "default-shared" });
    assert.equal(gover5.realmsInstance, "default-shared");
    assert.throws(
      () => assertMainnetKekbullGovernance(gover5),
      (err: unknown) => err instanceof ClientValidationError && err.code === "MAINNET_REALMS_INSTANCE",
    );
    const kekbull = resolveNetwork({ cluster: "mainnet-beta", realmsInstance: "kekbull" });
    assert.doesNotThrow(() => assertMainnetKekbullGovernance(kekbull));
    const devnetGover5 = resolveNetwork({ cluster: "devnet", realmsInstance: "default-shared" });
    assert.doesNotThrow(() => assertMainnetKekbullGovernance(devnetGover5));
  });
});

describe("package pins", () => {
  it("declares the approved direct dependency versions and the chain override", () => {
    const pkg = JSON.parse(readFileSync(join(clientRoot, "package.json"), "utf8")) as {
      private: boolean;
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.private, true);
    assert.deepEqual(pkg.dependencies, {
      "@meteora-ag/cp-amm-sdk": "1.4.6",
      "@realms-today/spl-governance": "0.3.33",
      "@solana/spl-token": "0.4.15",
      "@solana/web3.js": "1.98.4",
      "bn.js": "5.2.5",
    });
    assert.equal("axios" in pkg.dependencies, false);
    assert.equal("@coral-xyz/anchor" in pkg.dependencies, false);
    assert.equal(pkg.overrides.chain, "file:./vendor/chain-stub");
    assert.equal(pkg.overrides.axios, "1.19.0");
    assert.equal(pkg.scripts.typecheck, "tsc --noEmit");
    assert.equal(pkg.devDependencies["@types/bn.js"], "5.2.0");
    assert.equal(pkg.devDependencies.typescript, "7.0.2");
    assert.equal("prepare" in pkg.scripts, false);
    assert.equal("preinstall" in pkg.scripts, false);
    assert.equal("postinstall" in pkg.scripts, false);
    assert.equal("install" in pkg.scripts, false);
  });
});
