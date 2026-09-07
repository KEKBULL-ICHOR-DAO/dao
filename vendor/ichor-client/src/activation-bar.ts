/**
 * Activation-bar read model. Computes live quantities; does not choose
 * thresholds or declare the bar passed. Unknown stays unknown.
 *
 * Distinct positive community TOR count is unknown: a complete reliable
 * reader would need `getProgramAccounts`, which project policy refuses.
 */

import { getRealm, MintMaxVoteWeightSourceType } from "@realms-today/spl-governance";
import BN from "bn.js";
import { assertVerifiedIchorConfig } from "./burn.ts";
import { parseExplicitTokenAmount } from "./defensive-stake.ts";
import { fetchMintSnapshot } from "./mint.ts";
import { assertBoundConnection } from "./preflight.ts";
import { readCanonicalPumpSwapPoolSnapshot, solParityFromReserves } from "./pricing.ts";
import { assertVerifiedRealm, readCommunityGoverningTokenDeposit } from "./realms.ts";
import {
  ClientValidationError,
  type ActivationBarModel,
  type ActivationBarReadParams,
  type CommunityMintMaxVoteWeightSource,
} from "./types.ts";
import { assertNoSecretMaterial, requirePublicKey, requireU64Bn } from "./validation.ts";

/** Realms `SUPPLY_FRACTION_BASE` — 10^10. Same as MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION. */
export const SUPPLY_FRACTION_BASE = new BN("10000000000");

export const DISTINCT_TOR_COUNT_UNKNOWN_REASON =
  "distinct positive community TOR count requires getProgramAccounts; project policy refuses GPA discovery";

export function ceilSupplyOver20(supply: BN): BN {
  const s = requireU64Bn(supply, "ichorSupply");
  if (s.isZero()) {
    return new BN(0);
  }
  return s.add(new BN(19)).div(new BN(20));
}

export function maxVoterWeightFromSource(params: {
  supply: BN;
  source: CommunityMintMaxVoteWeightSource;
}): BN {
  const s = requireU64Bn(params.supply, "ichorSupply");
  if (params.source.type === "absolute") {
    return requireU64Bn(params.source.value, "absoluteMaxVoterWeight");
  }
  if (params.source.type !== "supply-fraction") {
    throw new ClientValidationError("INVALID_MINT_MAX_VOTE_WEIGHT_SOURCE", [
      `source.type ${String((params.source as { type: string }).type)} is not supply-fraction or absolute`,
    ]);
  }
  const fraction = requireU64Bn(params.source.value, "supplyFraction");
  if (fraction.gte(SUPPLY_FRACTION_BASE)) {
    throw new ClientValidationError("UNREACHABLE_QUORUM_DENOMINATOR", [
      "supply-fraction at or above FULL_SUPPLY_FRACTION cannot be a max voter weight",
    ]);
  }
  return s.mul(fraction).div(SUPPLY_FRACTION_BASE);
}

/**
 * Live activation-bar quantities. Does not decide whether the bar has passed.
 * `kekbullAmount` and `barHeldSinceUnixTs` are operator inputs when present.
 */
export async function readActivationBarModel(
  params: ActivationBarReadParams,
): Promise<ActivationBarModel> {
  assertNoSecretMaterial(params, "readActivationBarModel");
  assertVerifiedIchorConfig(params.verifiedConfig);
  assertVerifiedRealm(params.verifiedRealm);
  assertBoundConnection(params.verifiedConfig.verifiedProgram.verified, params.connection);
  assertBoundConnection(params.verifiedRealm.verified, params.connection);
  const creator = requirePublicKey(params.creator, "creator");
  const verified = params.verifiedConfig.verifiedProgram.verified;
  const config = params.verifiedConfig.config;

  const ichorMint = await fetchMintSnapshot(params.connection, verified.network, config.ichorMint);
  const supply = ichorMint.supply;
  const yesFloorCeilSOver20 = ceilSupplyOver20(supply);

  const realm = await getRealm(params.connection, params.verifiedRealm.realm);
  const live = realm.account.config.communityMintMaxVoteWeightSource;
  const source: CommunityMintMaxVoteWeightSource = {
    type: live.type === MintMaxVoteWeightSourceType.Absolute ? "absolute" : "supply-fraction",
    value: live.value,
  };
  const currentMaxVoterWeight = maxVoterWeightFromSource({ supply, source });

  const deposit = await readCommunityGoverningTokenDeposit({
    connection: params.connection,
    verifiedRealm: params.verifiedRealm,
    governingTokenOwner: creator,
  });

  let kekbullAmount: ActivationBarModel["kekbullAmount"];
  if (params.kekbullAmount === undefined) {
    kekbullAmount = {
      status: "unknown",
      reason: "operator did not supply an explicit KEKBULL amount",
    };
  } else {
    const kekbullMint = await fetchMintSnapshot(
      params.connection,
      verified.network,
      config.kekbullMint,
    );
    kekbullAmount = {
      status: "known",
      raw: parseExplicitTokenAmount(params.kekbullAmount, kekbullMint.decimals, "kekbullAmount"),
      decimals: kekbullMint.decimals,
    };
  }

  let solAcquisitionQuote: ActivationBarModel["solAcquisitionQuote"];
  if (kekbullAmount.status !== "known") {
    solAcquisitionQuote = {
      status: "unknown",
      reason: "SOL acquisition quote needs an explicit KEKBULL amount",
    };
  } else {
    try {
      const snap = await readCanonicalPumpSwapPoolSnapshot({
        connection: params.connection,
        verifiedConfig: params.verifiedConfig,
      });
      const lamports = solParityFromReserves({
        kekbullAmount: kekbullAmount.raw,
        effectiveQuote: snap.pool.effectiveQuoteLamports,
        baseReserves: snap.pool.baseVaultAmount,
        rounding: "ceiling",
      });
      solAcquisitionQuote = {
        status: "known",
        source: "pumpswap-reserves",
        lamports,
        pool: snap.pool.address,
        baseVaultAmount: snap.pool.baseVaultAmount,
        effectiveQuoteLamports: snap.pool.effectiveQuoteLamports,
      };
    } catch (err) {
      if (err instanceof ClientValidationError && err.code === "PUMPSWAP_POOL_MISSING") {
        solAcquisitionQuote = {
          status: "unknown",
          reason: "canonical PumpSwap pool is not present",
        };
      } else {
        throw err;
      }
    }
  }

  let barHeldSinceUnixTs: ActivationBarModel["barHeldSinceUnixTs"];
  if (params.barHeldSinceUnixTs === undefined) {
    barHeldSinceUnixTs = {
      status: "unknown",
      reason: "bar-held timestamp is an operator input, not discovered",
    };
  } else if (!Number.isInteger(params.barHeldSinceUnixTs) || params.barHeldSinceUnixTs < 0) {
    throw new ClientValidationError("BAR_HELD_TIMESTAMP", [
      "barHeldSinceUnixTs must be a non-negative integer unix timestamp when supplied",
    ]);
  } else {
    barHeldSinceUnixTs = { status: "known", unixTs: params.barHeldSinceUnixTs };
  }

  return {
    ichorSupply: supply,
    ichorDecimals: ichorMint.decimals,
    yesFloorCeilSOver20,
    communityMintMaxVoteWeightSource: source,
    currentMaxVoterWeight,
    creatorDefensiveNet: deposit.amount,
    distinctPositiveCommunityTorCount: {
      status: "unknown",
      reason: DISTINCT_TOR_COUNT_UNKNOWN_REASON,
    },
    conversionRatio: {
      numerator: config.emissionNumerator,
      denominator: config.emissionDenominator,
    },
    kekbullAmount,
    solAcquisitionQuote,
    barHeldSinceUnixTs,
  };
}
