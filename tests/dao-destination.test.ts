/**
 * UI DAO destination commitment: irreversible actions stay disabled until
 * the on-chain commitment matches the issued identity.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClientValidationError,
  REALMS_INSTANCES,
  assertDaoDestinationMatchesCommitment,
  daoDestinationActionsEnabled,
  deriveAccountGovernanceAddress,
  deriveNativeTreasuryAddress,
  requirePublicKey,
} from "../../client/src/index.ts";

const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const preflight = readFileSync(join(uiRoot, "src/panels/Preflight.tsx"), "utf8");
const fees = readFileSync(join(uiRoot, "src/panels/TransferFees.tsx"), "utf8");
const lock = readFileSync(join(uiRoot, "src/panels/LockAndFees.tsx"), "utf8");

const GOVER5 = requirePublicKey(REALMS_INSTANCES["default-shared"].id, "GovER5");
const GTEST = requirePublicKey(REALMS_INSTANCES.test.id, "GTesT");
const ICHOR = requirePublicKey("So11111111111111111111111111111111111111112", "ichor");
const REALM = requirePublicKey("Config1111111111111111111111111111111111111", "realm");
const GOVERNED = requirePublicKey("Vote111111111111111111111111111111111111111", "governed");

describe("governance-ui dao destination wiring", () => {
  it("disables bind and handoff until commitment matches", () => {
    assert.match(fees, /irreversibleDaoActionsEnabled/);
    assert.match(fees, /destinationReady/);
    assert.match(lock, /irreversibleDaoActionsEnabled/);
    assert.match(lock, /destinationReady/);
    assert.match(preflight, /committedDaoDestination/);
    assert.match(preflight, /daoDestinationMatches/);
    assert.match(preflight, /commit_dao_destination/);
  });

  it("keeps irreversible actions disabled on missing or mismatched commitment", async () => {
    const governance = deriveAccountGovernanceAddress(GOVER5, REALM, GOVERNED);
    const nativeTreasury = await deriveNativeTreasuryAddress(GOVER5, governance);
    const committed = {
      realm: REALM,
      governance,
      realmsProgram: GOVER5,
      nativeTreasury,
    };
    assert.match(preflight, /export function irreversibleDaoActionsEnabled/);
    assert.match(preflight, /params\.committed !== null && params\.identityMatches/);
    assert.equal(
      daoDestinationActionsEnabled({
        committed: null,
        identity: {
          realm: REALM,
          governance,
          realmsProgram: GOVER5,
          nativeTreasury,
          communityMint: ICHOR,
        },
        ichorMint: ICHOR,
      }),
      false,
    );
    const gtestGov = deriveAccountGovernanceAddress(GTEST, REALM, GOVERNED);
    const gtestTreasury = await deriveNativeTreasuryAddress(GTEST, gtestGov);
    assert.throws(
      () =>
        assertDaoDestinationMatchesCommitment({
          commitment: committed,
          identity: {
            realm: REALM,
            governance: gtestGov,
            realmsProgram: GTEST,
            nativeTreasury: gtestTreasury,
            communityMint: ICHOR,
          },
          ichorMint: ICHOR,
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "GTEST_REFUSED",
    );
    assert.throws(
      () =>
        assertDaoDestinationMatchesCommitment({
          commitment: {
            realm: REALM,
            governance: gtestGov,
            realmsProgram: GTEST,
            nativeTreasury: gtestTreasury,
          },
          identity: {
            realm: REALM,
            governance: gtestGov,
            realmsProgram: GTEST,
            nativeTreasury: gtestTreasury,
            communityMint: ICHOR,
          },
          ichorMint: ICHOR,
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "GTEST_REFUSED",
    );
  });
});
