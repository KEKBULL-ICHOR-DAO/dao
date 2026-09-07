/**
 * Executable DAO destination commitment matcher.
 * Uses published Realms program IDs and official native-treasury PDA math.
 * No RPC. No branded proofs. No invented treasuries.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClientValidationError,
  REALMS_INSTANCES,
  assertDaoDestinationMatchesCommitment,
  daoDestinationActionsEnabled,
  deriveAccountGovernanceAddress,
  deriveNativeTreasuryAddress,
  readCommittedDaoDestination,
  requirePublicKey,
  type CommittedDaoDestination,
  type DaoDestinationIdentity,
} from "../src/index.ts";

const GOVER5 = requirePublicKey(REALMS_INSTANCES["default-shared"].id, "GovER5");
const GTEST = requirePublicKey(REALMS_INSTANCES.test.id, "GTesT");
const ICHOR = requirePublicKey("So11111111111111111111111111111111111111112", "ichor");
const OTHER_MINT = requirePublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "otherMint");
const REALM = requirePublicKey("Config1111111111111111111111111111111111111", "realm");
const GOVERNED = requirePublicKey("Vote111111111111111111111111111111111111111", "governed");
const OTHER_REALM = requirePublicKey("Stake11111111111111111111111111111111111111", "otherRealm");

async function issuedGovEr5(): Promise<{
  commitment: CommittedDaoDestination;
  identity: DaoDestinationIdentity;
}> {
  const governance = deriveAccountGovernanceAddress(GOVER5, REALM, GOVERNED);
  const nativeTreasury = await deriveNativeTreasuryAddress(GOVER5, governance);
  const commitment: CommittedDaoDestination = {
    realm: REALM,
    governance,
    realmsProgram: GOVER5,
    nativeTreasury,
  };
  const identity: DaoDestinationIdentity = {
    realm: REALM,
    governance,
    realmsProgram: GOVER5,
    nativeTreasury,
    communityMint: ICHOR,
  };
  return { commitment, identity };
}

describe("readCommittedDaoDestination", () => {
  it("accepts an exact GovER5 commitment tuple", async () => {
    const { commitment } = await issuedGovEr5();
    assert.deepEqual(
      readCommittedDaoDestination({
        realmsRealm: commitment.realm,
        realmsProgram: commitment.realmsProgram,
        realmsGovernance: commitment.governance,
        realmsNativeTreasury: commitment.nativeTreasury,
      }),
      commitment,
    );
  });

  it("fails closed when any commitment field is missing or default", () => {
    assert.throws(
      () =>
        readCommittedDaoDestination({
          realmsRealm: null,
          realmsProgram: GOVER5,
          realmsGovernance: GOVER5,
          realmsNativeTreasury: GOVER5,
        }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "DAO_DESTINATION_UNCOMMITTED",
    );
    assert.throws(
      () =>
        readCommittedDaoDestination({
          realmsRealm: requirePublicKey("11111111111111111111111111111111", "default"),
          realmsProgram: GOVER5,
          realmsGovernance: GOVER5,
          realmsNativeTreasury: GOVER5,
        }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "DAO_DESTINATION_UNCOMMITTED",
    );
  });
});

describe("assertDaoDestinationMatchesCommitment", () => {
  it("accepts the exact issued GovER5 proof and derived treasury", async () => {
    const { commitment, identity } = await issuedGovEr5();
    assertDaoDestinationMatchesCommitment({
      commitment,
      identity,
      ichorMint: ICHOR,
    });
    assert.equal(
      daoDestinationActionsEnabled({
        committed: commitment,
        identity,
        ichorMint: ICHOR,
      }),
      true,
    );
  });

  it("rejects a substituted realm", async () => {
    const { commitment, identity } = await issuedGovEr5();
    assert.throws(
      () =>
        assertDaoDestinationMatchesCommitment({
          commitment,
          identity: { ...identity, realm: OTHER_REALM },
          ichorMint: ICHOR,
        }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "DAO_DESTINATION_MISMATCH",
    );
  });

  it("rejects a substituted Governance PDA", async () => {
    const { commitment, identity } = await issuedGovEr5();
    const otherGov = deriveAccountGovernanceAddress(GOVER5, OTHER_REALM, GOVERNED);
    assert.throws(
      () =>
        assertDaoDestinationMatchesCommitment({
          commitment,
          identity: { ...identity, governance: otherGov },
          ichorMint: ICHOR,
        }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "DAO_DESTINATION_MISMATCH",
    );
  });

  it("rejects a consistent GTesT realm/governance/treasury identity", async () => {
    const governance = deriveAccountGovernanceAddress(GTEST, REALM, GOVERNED);
    const nativeTreasury = await deriveNativeTreasuryAddress(GTEST, governance);
    const commitment: CommittedDaoDestination = {
      realm: REALM,
      governance,
      realmsProgram: GTEST,
      nativeTreasury,
    };
    const identity: DaoDestinationIdentity = {
      realm: REALM,
      governance,
      realmsProgram: GTEST,
      nativeTreasury,
      communityMint: ICHOR,
    };
    assert.throws(
      () =>
        assertDaoDestinationMatchesCommitment({
          commitment,
          identity,
          ichorMint: ICHOR,
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "GTEST_REFUSED",
    );
    assert.equal(
      daoDestinationActionsEnabled({
        committed: commitment,
        identity,
        ichorMint: ICHOR,
      }),
      false,
    );
    assert.throws(
      () =>
        readCommittedDaoDestination({
          realmsRealm: REALM,
          realmsProgram: GTEST,
          realmsGovernance: governance,
          realmsNativeTreasury: nativeTreasury,
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "GTEST_REFUSED",
    );
  });

  it("rejects GTesT substituted for GovER5 and a GTesT-derived treasury", async () => {
    const { commitment, identity } = await issuedGovEr5();
    const gtestGov = deriveAccountGovernanceAddress(GTEST, REALM, GOVERNED);
    const gtestTreasury = await deriveNativeTreasuryAddress(GTEST, gtestGov);
    assert.throws(
      () =>
        assertDaoDestinationMatchesCommitment({
          commitment,
          identity: {
            ...identity,
            realmsProgram: GTEST,
            governance: gtestGov,
            nativeTreasury: gtestTreasury,
          },
          ichorMint: ICHOR,
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "GTEST_REFUSED",
    );
    assert.throws(
      () =>
        assertDaoDestinationMatchesCommitment({
          commitment,
          identity: { ...identity, realmsProgram: GTEST },
          ichorMint: ICHOR,
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "GTEST_REFUSED",
    );
  });

  it("rejects a substituted native treasury", async () => {
    const { commitment, identity } = await issuedGovEr5();
    const otherGov = deriveAccountGovernanceAddress(GOVER5, OTHER_REALM, GOVERNED);
    const otherTreasury = await deriveNativeTreasuryAddress(GOVER5, otherGov);
    assert.throws(
      () =>
        assertDaoDestinationMatchesCommitment({
          commitment,
          identity: { ...identity, nativeTreasury: otherTreasury },
          ichorMint: ICHOR,
        }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "DAO_DESTINATION_MISMATCH",
    );
  });

  it("rejects community mint that is not ICHOR", async () => {
    const { commitment, identity } = await issuedGovEr5();
    assert.throws(
      () =>
        assertDaoDestinationMatchesCommitment({
          commitment,
          identity: { ...identity, communityMint: OTHER_MINT },
          ichorMint: ICHOR,
        }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "COMMUNITY_MINT_MISMATCH",
    );
  });

  it("disables irreversible actions when commitment is missing or mismatched", async () => {
    const { commitment, identity } = await issuedGovEr5();
    assert.equal(
      daoDestinationActionsEnabled({
        committed: null,
        identity,
        ichorMint: ICHOR,
      }),
      false,
    );
    assert.equal(
      daoDestinationActionsEnabled({
        committed: commitment,
        identity: { ...identity, realm: OTHER_REALM },
        ichorMint: ICHOR,
      }),
      false,
    );
  });
});
