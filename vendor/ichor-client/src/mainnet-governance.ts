/**
 * Operator-ratified mainnet ICHOR DAO governance pins. **[OPERATOR 2026-08-26]**
 *
 * Official-devnet rehearsal stays 60% / 300s / 1s / Absolute(1) and is not
 * this package. These numbers are policy for what mainnet initialize and
 * community activation must send. The holder handbook still reads live
 * Governance fields - it does not print this file.
 *
 * Semantics in this repo: `YesVotePercentage(N)` is N% of `max_voter_weight`,
 * not of ballots cast. Combined with SupplyFraction 10% of mint, 50% Yes
 * means 5% of ICHOR supply must vote Yes, and Yes > No.
 */

import BN from "bn.js";
import { ClientValidationError, type ClusterName, type CommunityActivationConfig, type CommunityMintMaxVoteWeightSource } from "./types.ts";
import { assertCommunityActivation, requirePositiveBn, requireU64Bn, tenPowU8 } from "./validation.ts";

/** Human ICHOR required to open a proposal. Scale by live mint decimals. */
export const MAINNET_MIN_COMMUNITY_TOKENS_TO_CREATE_PROPOSAL_HUMAN = 10_000;

/** YesVotePercentage of max_voter_weight. */
export const MAINNET_COMMUNITY_VOTE_THRESHOLD_PERCENT = 50;

/** Realms SupplyFraction denominator: 10 → 10% of mint is max voter weight. */
export const MAINNET_SUPPLY_FRACTION_DENOMINATOR = 10;

export const MAINNET_BASE_VOTING_TIME = 259_200;
export const MAINNET_VOTING_COOL_OFF_TIME = 86_400;
export const MAINNET_MIN_INSTRUCTION_HOLD_UP_TIME = 86_400;
export const MAINNET_DEPOSIT_EXEMPT_PROPOSAL_COUNT = 3;

/** Product ships Disabled. Not a CommunityActivationConfig field - builders hardcode it. */
export const MAINNET_COMMUNITY_VOTE_TIPPING = "Disabled" as const;

/**
 * CreateRealm name. **[OPERATOR 2026-08-30]** PDA seed - cannot rename after
 * send. Quote it on the CLI: `--realm-name "KEKBULL DAO"`.
 */
export const MAINNET_REALM_NAME = "KEKBULL DAO";

/**
 * Derived 2026-08-30 from `MAINNET_REALM_NAME` + `kekbull_governance`
 * `2uNHeSLi…` + ICHOR mint `61fHeSXm…`. **Not on chain** until D
 * CreateRealm. Not a `deployment.json` pin.
 */
export const MAINNET_REALM_DERIVED = "EJQ83ay57EH84wmqBk8r1dsqN7PSVmP83mY1DArq7ft9";
export const MAINNET_GOVERNANCE_DERIVED = "H9hwaXvV5bXGrVRtrbd9n8PUmheAGeA7dDmvmwC45WnC";
export const MAINNET_NATIVE_TREASURY_DERIVED = "Dn2cjgXaHLju8Gc5fRpvHX3AzeKAi3JwSjusPCoAYWGJ";

export function mainnetMinCommunityTokensToCreateProposal(ichorDecimals: number): BN {
  const scaled = new BN(MAINNET_MIN_COMMUNITY_TOKENS_TO_CREATE_PROPOSAL_HUMAN).mul(
    tenPowU8(ichorDecimals),
  );
  return requireU64Bn(scaled, "mainnet minCommunityTokensToCreateProposal");
}

/**
 * SupplyFraction value for the operator 10% pin. Caller supplies the SDK
 * FULL_SUPPLY constant - this file does not invent 10^10.
 */
export function mainnetSupplyFractionValue(fullSupplyFractionValue: BN): BN {
  const full = requirePositiveBn(fullSupplyFractionValue, "FULL_SUPPLY_FRACTION.value");
  const denom = new BN(MAINNET_SUPPLY_FRACTION_DENOMINATOR);
  if (!full.mod(denom).isZero()) {
    throw new ClientValidationError("MAINNET_GOVERNANCE_PINS", [
      `FULL_SUPPLY_FRACTION.value ${full.toString(10)} is not divisible by ${String(MAINNET_SUPPLY_FRACTION_DENOMINATOR)}`,
    ]);
  }
  return full.div(denom);
}

function collectActivationMismatches(
  config: CommunityActivationConfig,
  ichorDecimals: number,
): string[] {
  const expectedTokens = mainnetMinCommunityTokensToCreateProposal(ichorDecimals);
  const errors: string[] = [];
  if (config.communityVoteThresholdPercent !== MAINNET_COMMUNITY_VOTE_THRESHOLD_PERCENT) {
    errors.push(
      `communityVoteThresholdPercent ${String(config.communityVoteThresholdPercent)} !== ${String(MAINNET_COMMUNITY_VOTE_THRESHOLD_PERCENT)}`,
    );
  }
  if (!config.minCommunityTokensToCreateProposal.eq(expectedTokens)) {
    errors.push(
      `minCommunityTokensToCreateProposal ${config.minCommunityTokensToCreateProposal.toString(10)} !== ${expectedTokens.toString(10)} (10000 ICHOR at ${String(ichorDecimals)} decimals)`,
    );
  }
  if (config.baseVotingTime !== MAINNET_BASE_VOTING_TIME) {
    errors.push(
      `baseVotingTime ${String(config.baseVotingTime)} !== ${String(MAINNET_BASE_VOTING_TIME)}`,
    );
  }
  if (config.votingCoolOffTime !== MAINNET_VOTING_COOL_OFF_TIME) {
    errors.push(
      `votingCoolOffTime ${String(config.votingCoolOffTime)} !== ${String(MAINNET_VOTING_COOL_OFF_TIME)}`,
    );
  }
  if (config.minInstructionHoldUpTime !== MAINNET_MIN_INSTRUCTION_HOLD_UP_TIME) {
    errors.push(
      `minInstructionHoldUpTime ${String(config.minInstructionHoldUpTime)} !== ${String(MAINNET_MIN_INSTRUCTION_HOLD_UP_TIME)}`,
    );
  }
  if (config.depositExemptProposalCount !== MAINNET_DEPOSIT_EXEMPT_PROPOSAL_COUNT) {
    errors.push(
      `depositExemptProposalCount ${String(config.depositExemptProposalCount)} !== ${String(MAINNET_DEPOSIT_EXEMPT_PROPOSAL_COUNT)}`,
    );
  }
  return errors;
}

/**
 * No-op off mainnet-beta so official-devnet 60/300/1 stays legal.
 * On mainnet, reports every pin violation, not the first.
 */
export function assertMainnetCommunityActivation(params: {
  cluster: ClusterName;
  config: CommunityActivationConfig;
  ichorDecimals?: number | undefined;
}): void {
  if (params.cluster !== "mainnet-beta") {
    return;
  }
  assertCommunityActivation(params.config);
  if (params.ichorDecimals === undefined) {
    throw new ClientValidationError("MAINNET_GOVERNANCE_PINS", [
      "mainnet community activation requires live ICHOR mint decimals; do not assume 6",
    ]);
  }
  const errors = collectActivationMismatches(params.config, params.ichorDecimals);
  if (errors.length > 0) {
    throw new ClientValidationError("MAINNET_GOVERNANCE_PINS", errors);
  }
}

export function assertMainnetVoteWeightSource(params: {
  cluster: ClusterName;
  source: CommunityMintMaxVoteWeightSource;
  fullSupplyFractionValue: BN;
}): void {
  if (params.cluster !== "mainnet-beta") {
    return;
  }
  const expected = mainnetSupplyFractionValue(params.fullSupplyFractionValue);
  const errors: string[] = [];
  if (params.source.type !== "supply-fraction") {
    errors.push(`communityMintMaxVoteWeightSource.type ${params.source.type} !== supply-fraction`);
  }
  if (!params.source.value.eq(expected)) {
    errors.push(
      `communityMintMaxVoteWeightSource.value ${params.source.value.toString(10)} !== ${expected.toString(10)} (10% of mint)`,
    );
  }
  if (errors.length > 0) {
    throw new ClientValidationError("MAINNET_GOVERNANCE_PINS", errors);
  }
}
