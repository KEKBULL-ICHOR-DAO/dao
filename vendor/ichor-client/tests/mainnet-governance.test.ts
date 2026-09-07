import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MintMaxVoteWeightSource } from "@realms-today/spl-governance";
import BN from "bn.js";
import {
  MAINNET_BASE_VOTING_TIME,
  MAINNET_COMMUNITY_VOTE_THRESHOLD_PERCENT,
  MAINNET_COMMUNITY_VOTE_TIPPING,
  MAINNET_DEPOSIT_EXEMPT_PROPOSAL_COUNT,
  MAINNET_GOVERNANCE_DERIVED,
  MAINNET_MIN_COMMUNITY_TOKENS_TO_CREATE_PROPOSAL_HUMAN,
  MAINNET_MIN_INSTRUCTION_HOLD_UP_TIME,
  MAINNET_NATIVE_TREASURY_DERIVED,
  MAINNET_REALM_DERIVED,
  MAINNET_REALM_NAME,
  MAINNET_SUPPLY_FRACTION_DENOMINATOR,
  MAINNET_VOTING_COOL_OFF_TIME,
  assertMainnetCommunityActivation,
  assertMainnetVoteWeightSource,
  mainnetMinCommunityTokensToCreateProposal,
  mainnetSupplyFractionValue,
} from "../src/mainnet-governance.ts";
import { ClientValidationError, type CommunityActivationConfig } from "../src/types.ts";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(clientRoot, "../e2e/fixtures");

/**
 * These two assertions cross-check the pins in this module against the
 * fixture the e2e harness feeds to the real bootstrap. The harness is
 * operator-side and is not published, so a public clone has no fixture to
 * compare against and these skip there -- see governance-ui
 * tests/operator-tree.ts for the same reasoning at length.
 *
 * The check is not weakened. Where the fixture exists -- the only place the
 * bootstrap can actually be run with the wrong numbers -- it still runs and
 * still fails loudly.
 */
const withFixtures: { skip?: string } = existsSync(join(fixtures, "mainnet-dao-governance.json"))
  ? {}
  : { skip: "e2e fixtures not present (published repo)" };

function activation(overrides: Partial<CommunityActivationConfig> = {}): CommunityActivationConfig {
  return {
    communityVoteThresholdPercent: MAINNET_COMMUNITY_VOTE_THRESHOLD_PERCENT,
    minCommunityTokensToCreateProposal: mainnetMinCommunityTokensToCreateProposal(6),
    minCouncilTokensToCreateProposal: new BN(1),
    baseVotingTime: MAINNET_BASE_VOTING_TIME,
    minInstructionHoldUpTime: MAINNET_MIN_INSTRUCTION_HOLD_UP_TIME,
    votingCoolOffTime: MAINNET_VOTING_COOL_OFF_TIME,
    depositExemptProposalCount: MAINNET_DEPOSIT_EXEMPT_PROPOSAL_COUNT,
    ...overrides,
  };
}

describe("mainnet governance pins [OPERATOR 2026-08-26]", () => {
  it("matches the e2e policy fixture", withFixtures, () => {
    const fixture = JSON.parse(
      readFileSync(join(fixtures, "mainnet-dao-governance.json"), "utf8"),
    ) as {
      cluster: string;
      realmName: string;
      communityVoteThresholdPercent: number;
      effectiveYesOfMintPercent: number;
      minCommunityTokensToCreateProposalHuman: string;
      baseVotingTime: number;
      votingCoolOffTime: number;
      minInstructionHoldUpTime: number;
      depositExemptProposalCount: number;
      communityVoteTipping: string;
      communityMintMaxVoteWeightSource: { type: string; supplyFractionDenominator: number };
    };
    assert.equal(fixture.cluster, "mainnet-beta");
    assert.equal(fixture.realmName, MAINNET_REALM_NAME);
    assert.equal(MAINNET_REALM_NAME, "KEKBULL DAO");
    assert.equal(MAINNET_REALM_DERIVED, "EJQ83ay57EH84wmqBk8r1dsqN7PSVmP83mY1DArq7ft9");
    assert.equal(MAINNET_GOVERNANCE_DERIVED, "H9hwaXvV5bXGrVRtrbd9n8PUmheAGeA7dDmvmwC45WnC");
    assert.equal(MAINNET_NATIVE_TREASURY_DERIVED, "Dn2cjgXaHLju8Gc5fRpvHX3AzeKAi3JwSjusPCoAYWGJ");
    assert.equal(fixture.communityVoteThresholdPercent, MAINNET_COMMUNITY_VOTE_THRESHOLD_PERCENT);
    assert.equal(fixture.effectiveYesOfMintPercent, 5);
    assert.equal(
      fixture.minCommunityTokensToCreateProposalHuman,
      String(MAINNET_MIN_COMMUNITY_TOKENS_TO_CREATE_PROPOSAL_HUMAN),
    );
    assert.equal(fixture.baseVotingTime, MAINNET_BASE_VOTING_TIME);
    assert.equal(fixture.votingCoolOffTime, MAINNET_VOTING_COOL_OFF_TIME);
    assert.equal(fixture.minInstructionHoldUpTime, MAINNET_MIN_INSTRUCTION_HOLD_UP_TIME);
    assert.equal(fixture.depositExemptProposalCount, MAINNET_DEPOSIT_EXEMPT_PROPOSAL_COUNT);
    assert.equal(fixture.communityVoteTipping, MAINNET_COMMUNITY_VOTE_TIPPING);
    assert.equal(fixture.communityMintMaxVoteWeightSource.type, "supply-fraction");
    assert.equal(
      fixture.communityMintMaxVoteWeightSource.supplyFractionDenominator,
      MAINNET_SUPPLY_FRACTION_DENOMINATOR,
    );
  });

  it("does not rewrite official-devnet rehearsal numbers", withFixtures, () => {
    const official = JSON.parse(
      readFileSync(join(fixtures, "official-devnet-dao-bootstrap-governance.json"), "utf8"),
    ) as {
      communityVoteThresholdPercent: number;
      baseVotingTime: number;
      minInstructionHoldUpTime: number;
      votingCoolOffTime: number;
      communityMintMaxVoteWeightSource: { type: string; value: string };
    };
    assert.equal(official.communityVoteThresholdPercent, 60);
    assert.equal(official.baseVotingTime, 300);
    assert.equal(official.minInstructionHoldUpTime, 1);
    assert.equal(official.votingCoolOffTime, 0);
    assert.equal(official.communityMintMaxVoteWeightSource.type, "absolute");
    assert.equal(official.communityMintMaxVoteWeightSource.value, "1");
  });

  it("scales 10000 ICHOR from live decimals, not a hardcoded raw amount", () => {
    assert.equal(mainnetMinCommunityTokensToCreateProposal(6).toString(10), "10000000000");
    assert.equal(mainnetMinCommunityTokensToCreateProposal(0).toString(10), "10000");
    assert.equal(mainnetMinCommunityTokensToCreateProposal(9).toString(10), "10000000000000");
  });

  it("derives the 10% SupplyFraction from the SDK FULL_SUPPLY constant", () => {
    const full = MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value;
    const tenth = mainnetSupplyFractionValue(full);
    assert.equal(tenth.mul(new BN(10)).toString(10), full.toString(10));
    assert.ok(tenth.lt(full));
  });

  it("is a no-op off mainnet so official-devnet 60/300/1 stays legal", () => {
    const rehearsal: CommunityActivationConfig = {
      communityVoteThresholdPercent: 60,
      minCommunityTokensToCreateProposal: new BN(1),
      minCouncilTokensToCreateProposal: new BN(1),
      baseVotingTime: 300,
      minInstructionHoldUpTime: 1,
      votingCoolOffTime: 0,
      depositExemptProposalCount: 10,
    };
    assert.doesNotThrow(() =>
      assertMainnetCommunityActivation({ cluster: "devnet", config: rehearsal }),
    );
    assert.doesNotThrow(() =>
      assertMainnetCommunityActivation({ cluster: "localnet", config: rehearsal }),
    );
    assert.doesNotThrow(() =>
      assertMainnetVoteWeightSource({
        cluster: "devnet",
        source: { type: "absolute", value: new BN(1) },
        fullSupplyFractionValue: MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value,
      }),
    );
  });

  it("accepts the ratified package on mainnet-beta", () => {
    assert.doesNotThrow(() =>
      assertMainnetCommunityActivation({
        cluster: "mainnet-beta",
        config: activation(),
        ichorDecimals: 6,
      }),
    );
    assert.doesNotThrow(() =>
      assertMainnetVoteWeightSource({
        cluster: "mainnet-beta",
        source: {
          type: "supply-fraction",
          value: mainnetSupplyFractionValue(MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value),
        },
        fullSupplyFractionValue: MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value,
      }),
    );
  });

  it("refuses mainnet activation without live decimals", () => {
    assert.throws(
      () =>
        assertMainnetCommunityActivation({
          cluster: "mainnet-beta",
          config: activation(),
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "MAINNET_GOVERNANCE_PINS" &&
        err.details.some((d) => d.includes("decimals")),
    );
  });

  it("reports every mainnet activation mismatch, not the first", () => {
    assert.throws(
      () =>
        assertMainnetCommunityActivation({
          cluster: "mainnet-beta",
          config: activation({
            communityVoteThresholdPercent: 60,
            baseVotingTime: 300,
            minInstructionHoldUpTime: 1,
            votingCoolOffTime: 0,
            depositExemptProposalCount: 10,
            minCommunityTokensToCreateProposal: new BN(1),
          }),
          ichorDecimals: 6,
        }),
      (err: unknown) => {
        if (!(err instanceof ClientValidationError) || err.code !== "MAINNET_GOVERNANCE_PINS") {
          return false;
        }
        const blob = err.details.join(" ");
        return (
          blob.includes("communityVoteThresholdPercent") &&
          blob.includes("baseVotingTime") &&
          blob.includes("minInstructionHoldUpTime") &&
          blob.includes("votingCoolOffTime") &&
          blob.includes("depositExemptProposalCount") &&
          blob.includes("minCommunityTokensToCreateProposal")
        );
      },
    );
  });

  it("refuses Absolute(1) and FULL_SUPPLY as the mainnet weight source", () => {
    const full = MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value;
    assert.throws(
      () =>
        assertMainnetVoteWeightSource({
          cluster: "mainnet-beta",
          source: { type: "absolute", value: new BN(1) },
          fullSupplyFractionValue: full,
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "MAINNET_GOVERNANCE_PINS" &&
        err.details.length === 2,
    );
    assert.throws(
      () =>
        assertMainnetVoteWeightSource({
          cluster: "mainnet-beta",
          source: { type: "supply-fraction", value: full },
          fullSupplyFractionValue: full,
        }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "MAINNET_GOVERNANCE_PINS",
    );
    assert.throws(
      () =>
        assertMainnetVoteWeightSource({
          cluster: "mainnet-beta",
          source: { type: "absolute", value: new BN("18446744073709551615") },
          fullSupplyFractionValue: full,
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "MAINNET_GOVERNANCE_PINS" &&
        err.details.some((d) => d.includes("absolute")),
    );
  });
});
