import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { ClientValidationError } from "../src/types.ts";
import {
  COMMUNITY_PROPOSAL_DISABLED,
  assertBootstrapCouncil,
  assertCommunityActivation,
  assertExpectedLock,
  assertFeePlan,
  assertMintSnapshot,
  assertNoSecretMaterial,
  collectForbiddenKeyFields,
  ichorFromKekbull,
  requireBn,
  requireConfiguredDeploymentAddress,
  requirePositiveBn,
  requirePublicKey,
  requireReachableMintMaxVoteWeightSource,
  requireU64Bn,
  tenPowU8,
  U64_MAX,
} from "../src/validation.ts";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("secret-material rejection", () => {
  it("flags raw key fields anywhere in an input tree", () => {
    const hits = collectForbiddenKeyFields({
      payer: "safe",
      nested: { privateKeyBase58: "nope" },
    });
    assert.deepEqual(hits, ["nested.privateKeyBase58"]);
  });

  it("throws when a Keypair-shaped object is supplied", () => {
    assert.throws(
      () => assertNoSecretMaterial({ secretKey: new Uint8Array(64) }, "params"),
      (err: unknown) => err instanceof ClientValidationError && err.code === "SECRET_MATERIAL_REJECTED",
    );
  });

  it("does not throw walking a Connection or a null-prototype object", () => {
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");
    assert.deepEqual(collectForbiddenKeyFields({ connection, amount: new BN(1) }), []);
    assert.deepEqual(collectForbiddenKeyFields(Object.create(null)), []);
    assertNoSecretMaterial({ connection, amount: new BN(1) }, "params");
  });

  it("does not recurse into a Connection-shaped object from another web3.js copy", () => {
    const alien = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getAccountInfo: async () => null,
    };
    (alien as { self?: unknown }).self = alien;
    assert.equal(alien instanceof Connection, false);
    assert.deepEqual(collectForbiddenKeyFields({ connection: alien }), []);
  });

  it("does not stack-overflow on a circular params graph and still finds secretKey", () => {
    const params: Record<string, unknown> = { amount: new BN(1) };
    params.self = params;
    assert.deepEqual(collectForbiddenKeyFields(params), []);
    const nested: Record<string, unknown> = { child: {} };
    const child = nested.child as Record<string, unknown>;
    child.parent = nested;
    child.secretKey = new Uint8Array(64);
    assert.deepEqual(collectForbiddenKeyFields(nested), ["child.secretKey"]);
  });
});

describe("amount validation", () => {
  it("rejects JavaScript numbers for token amounts", () => {
    assert.throws(
      () => requireBn(1_000_000, "amount"),
      (err: unknown) => err instanceof ClientValidationError && err.code === "AMOUNT_MUST_BE_BN",
    );
  });

  it("rejects zero and non-BN values", () => {
    assert.throws(
      () => requirePositiveBn(new BN(0), "amount"),
      (err: unknown) => err instanceof ClientValidationError && err.code === "AMOUNT_NOT_POSITIVE",
    );
    assert.throws(
      () => requirePositiveBn("100", "amount"),
      (err: unknown) => err instanceof ClientValidationError && err.code === "AMOUNT_MUST_BE_BN",
    );
  });

  it("accepts a positive BN", () => {
    assert.equal(requirePositiveBn(new BN("1000000000"), "amount").toString(), "1000000000");
  });
});

describe("pubkey validation", () => {
  it("accepts a PublicKey and valid base58", () => {
    const pk = new PublicKey("So11111111111111111111111111111111111111112");
    assert.equal(requirePublicKey(pk, "mint").toBase58(), pk.toBase58());
    assert.equal(
      requirePublicKey("So11111111111111111111111111111111111111112", "mint").toBase58(),
      pk.toBase58(),
    );
    assert.equal(
      requirePublicKey({ toBase58: () => pk.toBase58() }, "foreignPublicKey").toBase58(),
      pk.toBase58(),
    );
    assert.ok(
      requirePublicKey({ toBase58: () => pk.toBase58() }, "foreignPublicKey") instanceof PublicKey,
    );
  });

  it("rejects junk", () => {
    assert.throws(
      () => requirePublicKey("not-a-key", "mint"),
      (err: unknown) => err instanceof ClientValidationError && err.code === "INVALID_PUBKEY",
    );
  });
});

describe("u64 and emission math", () => {
  it("rejects amounts that do not fit u64", () => {
    assert.equal(requireU64Bn(new BN(0), "min").toString(), "0");
    assert.throws(
      () => requireU64Bn(U64_MAX.add(new BN(1)), "amount"),
      (err: unknown) => err instanceof ClientValidationError && err.code === "AMOUNT_EXCEEDS_U64",
    );
  });

  it("rejects reserved protocol addresses as ICHOR program identity", () => {
    assert.throws(
      () => requireConfiguredDeploymentAddress(undefined, "ichorProgramId", []),
      (err: unknown) => err instanceof ClientValidationError && err.code === "PROGRAM_ID_UNCONFIGURED",
    );
    assert.throws(
      () => requireConfiguredDeploymentAddress(PublicKey.default, "ichorProgramId", []),
      (err: unknown) => err instanceof ClientValidationError && err.code === "PROGRAM_ID_UNCONFIGURED",
    );
    const reserved = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    assert.throws(
      () => requireConfiguredDeploymentAddress(reserved, "ichorProgramId", [reserved]),
      (err: unknown) => err instanceof ClientValidationError && err.code === "PROGRAM_ID_RESERVED",
    );
  });

  it("matches on-chain human-unit conversion including 255==255", () => {
    assert.equal(
      ichorFromKekbull({
        kekbullAmount: new BN(1_000_000),
        kekbullDecimals: 6,
        ichorDecimals: 9,
        numerator: new BN(1),
        denominator: new BN(1),
      }).toString(),
      "1000000000",
    );
    assert.equal(
      ichorFromKekbull({
        kekbullAmount: new BN(100),
        kekbullDecimals: 255,
        ichorDecimals: 255,
        numerator: new BN(1),
        denominator: new BN(1),
      }).toString(),
      "100",
    );
    assert.throws(
      () =>
        ichorFromKekbull({
          kekbullAmount: new BN(1),
          kekbullDecimals: 9,
          ichorDecimals: 6,
          numerator: new BN(1),
          denominator: new BN(1),
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "CONVERSION_FLOORS_TO_ZERO",
    );
    assert.throws(
      () =>
        ichorFromKekbull({
          kekbullAmount: new BN(1),
          kekbullDecimals: 6,
          ichorDecimals: 6,
          numerator: new BN(2),
          denominator: new BN(1),
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "RATIO_ABOVE_CEILING",
    );
    assert.throws(
      () => tenPowU8(39),
      (err: unknown) => err instanceof ClientValidationError && err.code === "ARITHMETIC_OVERFLOW",
    );
    assert.equal(tenPowU8(0).toString(), "1");
    assert.ok(tenPowU8(38).gt(new BN(0)));
  });
});

describe("fee plan", () => {
  it("rejects RateLimiter-shaped scheduler names", () => {
    assert.throws(
      () =>
        assertFeePlan({
          startingFeeBps: 25,
          endingFeeBps: 25,
          numberOfPeriod: 0,
          totalDuration: 0,
          scheduler: "rateLimiter" as "linear",
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "FEE_SCHEDULER",
    );
  });

  it("accepts a constant linear schedule", () => {
    assertFeePlan({
      startingFeeBps: 25,
      endingFeeBps: 25,
      numberOfPeriod: 0,
      totalDuration: 0,
      scheduler: "linear",
    });
  });

  it("rejects flat plans with nonzero schedule fields", () => {
    assert.throws(
      () =>
        assertFeePlan({
          startingFeeBps: 25,
          endingFeeBps: 25,
          numberOfPeriod: 50,
          totalDuration: 300,
          scheduler: "linear",
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "FEE_PLAN_SHAPE",
    );
  });

  it("rejects decaying plans with zero schedule fields", () => {
    assert.throws(
      () =>
        assertFeePlan({
          startingFeeBps: 200,
          endingFeeBps: 25,
          numberOfPeriod: 0,
          totalDuration: 0,
          scheduler: "linear",
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "FEE_PLAN_SHAPE",
    );
  });

  it("rejects endingFeeBps above startingFeeBps", () => {
    assert.throws(
      () =>
        assertFeePlan({
          startingFeeBps: 25,
          endingFeeBps: 50,
          numberOfPeriod: 10,
          totalDuration: 100,
          scheduler: "linear",
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "FEE_PLAN_SHAPE",
    );
  });

  it("rejects decaying plans whose duration is not divisible by period count", () => {
    // SDK: new BN(totalDuration / numberOfPeriod) truncates - 300/46 → 6.
    assert.throws(
      () =>
        assertFeePlan({
          startingFeeBps: 200,
          endingFeeBps: 25,
          numberOfPeriod: 46,
          totalDuration: 300,
          scheduler: "linear",
        }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "FEE_PLAN_PERIOD_FREQUENCY",
    );
  });

  it("accepts a decaying plan with exact period frequency", () => {
    assertFeePlan({
      startingFeeBps: 200,
      endingFeeBps: 25,
      numberOfPeriod: 50,
      totalDuration: 300,
      scheduler: "linear",
    });
  });
});

describe("mint decimals", () => {
  it("accepts a valid u8 including 255 and does not cap at 18", () => {
    const mint = new PublicKey("So11111111111111111111111111111111111111112");
    assertMintSnapshot(
      {
        mint,
        ownerProgram: mint,
        tokenProgramKind: "legacy-spl",
        decimals: 255,
        supply: new BN(0),
        mintAuthority: null,
        freezeAuthority: null,
        isInitialized: true,
        dataLength: 82,
      },
      "ichor",
    );
    assert.throws(
      () =>
        assertMintSnapshot(
          {
            mint,
            ownerProgram: mint,
            tokenProgramKind: "legacy-spl",
            decimals: 256,
            supply: new BN(0),
            mintAuthority: null,
            freezeAuthority: null,
            isInitialized: true,
            dataLength: 82,
          },
          "ichor",
        ),
      (err: unknown) => err instanceof ClientValidationError && err.code === "MINT_DECIMALS",
    );
  });
});

describe("bootstrap community lock", () => {
  const councilMint = new PublicKey("So11111111111111111111111111111111111111112");
  const base = {
    councilMint,
    councilVoteThresholdPercent: 60,
    councilVetoVoteThresholdPercent: 50,
    minCouncilTokensToCreateProposal: new BN(1),
    minCommunityWeightToCreateGovernance: new BN(1),
    baseVotingTime: 86_400,
    minInstructionHoldUpTime: 3_600,
    votingCoolOffTime: 0,
    depositExemptProposalCount: 1,
  };

  it("rejects caller-configurable community threshold on bootstrap", () => {
    assert.throws(
      () =>
        assertBootstrapCouncil({
          ...base,
          communityVoteThresholdPercent: 60,
        } as typeof base),
      (err: unknown) => err instanceof ClientValidationError && err.code === "BOOTSTRAP_COMMUNITY_LOCKED",
    );
  });

  it("rejects YesVotePercentage(0) for council thresholds (SPL Governance)", () => {
    assert.throws(
      () => assertBootstrapCouncil({ ...base, councilVoteThresholdPercent: 0 }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "INVALID_YES_VOTE_PERCENT",
    );
    assert.throws(
      () => assertBootstrapCouncil({ ...base, councilVetoVoteThresholdPercent: 0 }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "INVALID_YES_VOTE_PERCENT",
    );
    assert.doesNotThrow(() => assertBootstrapCouncil(base));
  });

  it("rejects YesVotePercentage(0) on community activation council and community percents", () => {
    const activationBase = {
      communityVoteThresholdPercent: 60,
      minCommunityTokensToCreateProposal: new BN(1),
      councilVoteThresholdPercent: 60,
      councilVetoVoteThresholdPercent: 50,
      minCouncilTokensToCreateProposal: new BN(1),
      baseVotingTime: 86_400,
      minInstructionHoldUpTime: 3_600,
      votingCoolOffTime: 0,
      depositExemptProposalCount: 1,
    };
    assert.throws(
      () => assertCommunityActivation({ ...activationBase, communityVoteThresholdPercent: 0 }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "INVALID_YES_VOTE_PERCENT",
    );
    assert.throws(
      () => assertCommunityActivation({ ...activationBase, councilVoteThresholdPercent: 0 }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "INVALID_YES_VOTE_PERCENT",
    );
    assert.throws(
      () => assertCommunityActivation({ ...activationBase, councilVetoVoteThresholdPercent: 0 }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "INVALID_YES_VOTE_PERCENT",
    );
    const { councilVoteThresholdPercent: _c, councilVetoVoteThresholdPercent: _v, ...withoutCouncilPercents } =
      activationBase;
    assert.doesNotThrow(() => assertCommunityActivation(withoutCouncilPercents));
  });

  it("keeps community proposal creation at u64 max until activation", () => {
    assert.equal(COMMUNITY_PROPOSAL_DISABLED.toString(), "18446744073709551615");
    assert.throws(
      () =>
        assertCommunityActivation({
          communityVoteThresholdPercent: 60,
          minCommunityTokensToCreateProposal: COMMUNITY_PROPOSAL_DISABLED,
          councilVoteThresholdPercent: 60,
          councilVetoVoteThresholdPercent: 50,
          minCouncilTokensToCreateProposal: new BN(1),
          baseVotingTime: 86_400,
          minInstructionHoldUpTime: 3_600,
          votingCoolOffTime: 0,
          depositExemptProposalCount: 1,
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "COMMUNITY_ACTIVATION",
    );
  });
});

describe("reachable community mint max vote weight source", () => {
  // Caller supplies the SDK FULL_SUPPLY constant. Tests use a stand-in, not an ICHOR fraction.
  const fullSupply = new BN("99");

  it("refuses a supply-fraction equal to the SDK full-supply constant", () => {
    assert.throws(
      () =>
        requireReachableMintMaxVoteWeightSource(
          { type: "supply-fraction", value: new BN("99") },
          fullSupply,
        ),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "UNREACHABLE_QUORUM_DENOMINATOR",
    );
    assert.throws(
      () =>
        requireReachableMintMaxVoteWeightSource(
          { type: "supply-fraction", value: new BN("100") },
          fullSupply,
        ),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "UNREACHABLE_QUORUM_DENOMINATOR",
    );
  });

  it("uses Absolute(1) and a bounded supply-fraction", () => {
    const absolute = requireReachableMintMaxVoteWeightSource(
      { type: "absolute", value: new BN(1) },
      fullSupply,
    );
    assert.equal(absolute.type, "absolute");
    assert.equal(absolute.value.toString(), "1");
    const fraction = requireReachableMintMaxVoteWeightSource(
      { type: "supply-fraction", value: new BN(1) },
      fullSupply,
    );
    assert.equal(fraction.type, "supply-fraction");
    assert.equal(fraction.value.toString(), "1");
    assert.ok(fraction.value.lt(fullSupply));
  });

  it("rejects zero, missing type, and unknown fields", () => {
    assert.throws(
      () =>
        requireReachableMintMaxVoteWeightSource(
          { type: "absolute", value: new BN(0) },
          fullSupply,
        ),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "AMOUNT_NOT_POSITIVE",
    );
    assert.throws(
      () => requireReachableMintMaxVoteWeightSource({ value: new BN(1) }, fullSupply),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "INVALID_MINT_MAX_VOTE_WEIGHT_SOURCE",
    );
    assert.throws(
      () =>
        requireReachableMintMaxVoteWeightSource(
          { type: "absolute", value: new BN(1), extra: true },
          fullSupply,
        ),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "INVALID_MINT_MAX_VOTE_WEIGHT_SOURCE",
    );
  });
});

describe("permanent lock predicate", () => {
  it("requires permanent lock to equal expected liquidity with zero unlocked", () => {
    const expected = new BN("123456789");
    assert.equal(
      assertExpectedLock({
        permanentLockedLiquidity: expected,
        unlockedLiquidity: new BN(0),
        expectedLiquidity: expected,
      }),
      true,
    );
    assert.throws(
      () =>
        assertExpectedLock({
          permanentLockedLiquidity: new BN("1"),
          unlockedLiquidity: new BN(0),
          expectedLiquidity: expected,
        }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "LOCK_MISMATCH",
    );
    assert.throws(
      () =>
        assertExpectedLock({
          permanentLockedLiquidity: expected,
          unlockedLiquidity: new BN(1),
          expectedLiquidity: expected,
        }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "LOCK_MISMATCH",
    );
  });
});

describe("chain stub package", () => {
  it("has no scripts and no exports", () => {
    const stub = JSON.parse(
      readFileSync(join(clientRoot, "vendor/chain-stub/package.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(stub.name, "chain");
    assert.equal("scripts" in stub, false);
    assert.equal("exports" in stub, false);
    assert.equal("main" in stub, false);
    assert.equal("module" in stub, false);
  });
});
