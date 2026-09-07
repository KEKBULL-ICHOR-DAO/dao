import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import BN from "bn.js";
import {
  DISTINCT_TOR_COUNT_UNKNOWN_REASON,
  SUPPLY_FRACTION_BASE,
  ceilSupplyOver20,
  maxVoterWeightFromSource,
} from "../src/activation-bar.ts";
import { ClientValidationError } from "../src/types.ts";
import { U64_MAX } from "../src/validation.ts";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/activation-bar.ts"),
  "utf8",
);

describe("activation-bar arithmetic", () => {
  it("computes ceil(S/20) without inventing a threshold", () => {
    assert.equal(ceilSupplyOver20(new BN(0)).toString(), "0");
    assert.equal(ceilSupplyOver20(new BN(1)).toString(), "1");
    assert.equal(ceilSupplyOver20(new BN(20)).toString(), "1");
    assert.equal(ceilSupplyOver20(new BN(21)).toString(), "2");
  });

  it("computes max voter weight from live source + supply", () => {
    const s = new BN(1_000_000);
    const tenPercent = SUPPLY_FRACTION_BASE.div(new BN(10));
    assert.equal(
      maxVoterWeightFromSource({
        supply: s,
        source: { type: "supply-fraction", value: tenPercent },
      }).toString(),
      "100000",
    );
    assert.ok(
      maxVoterWeightFromSource({
        supply: s,
        source: { type: "absolute", value: U64_MAX },
      }).eq(U64_MAX),
    );
    assert.throws(
      () =>
        maxVoterWeightFromSource({
          supply: s,
          source: { type: "supply-fraction", value: SUPPLY_FRACTION_BASE },
        }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "UNREACHABLE_QUORUM_DENOMINATOR",
    );
  });
});

describe("activation-bar policy", () => {
  it("does not choose thresholds or call getProgramAccounts", () => {
    assert.match(src, /DISTINCT_TOR_COUNT_UNKNOWN_REASON/);
    assert.match(src, /getProgramAccounts/);
    assert.match(src, /project policy refuses GPA/);
    assert.match(src, /ichorDecimals: ichorMint.decimals/);
    assert.match(src, /communityMintMaxVoteWeightSource: source/);
    assert.match(src, /baseVaultAmount: snap.pool.baseVaultAmount/);
    assert.match(src, /decimals: kekbullMint.decimals/);
    assert.doesNotMatch(src, /connection\.getProgramAccounts/);
    assert.doesNotMatch(src, /barPassed|thresholdReached|handoffNow/);
    assert.doesNotMatch(src, /Keypair\.fromSecretKey|sendRawTransaction/);
    assert.doesNotMatch(src, /decimals:\s*[69]\b/);
    assert.equal(
      DISTINCT_TOR_COUNT_UNKNOWN_REASON.includes("getProgramAccounts"),
      true,
    );
  });
});
