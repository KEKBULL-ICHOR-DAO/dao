import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROPOSAL_HASH_PREFIX,
  proposalFromHash,
  proposalHashFor,
} from "../src/proposal-deep-link.ts";

/**
 * The hash is the only user-supplied value that reaches a proposal read, so
 * its shape check is a guard, not a convenience. A malformed hash must return
 * null rather than being handed to the chain as if it were an address.
 */
describe("proposal deep link", () => {
  const REAL = "7T3cpP1bVRPcXUUXutHpEyGVr61u7CkF1NjZrH5CEkEB";

  it("round-trips a real proposal address", () => {
    assert.equal(proposalFromHash(proposalHashFor(REAL)), REAL);
  });

  it("ignores every other hash the app already uses", () => {
    for (const other of ["#vote", "#start", "#treasury", "#handbook", "", "#"]) {
      assert.equal(proposalFromHash(other), null, other);
    }
  });

  it("refuses a malformed address rather than passing it to a chain read", () => {
    for (const bad of [
      `${PROPOSAL_HASH_PREFIX}not-base58!`,
      `${PROPOSAL_HASH_PREFIX}0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl`, // base58 excludes 0 O I l
      `${PROPOSAL_HASH_PREFIX}tooshort`,
      `${PROPOSAL_HASH_PREFIX}${"1".repeat(45)}`,
      `${PROPOSAL_HASH_PREFIX}`,
    ]) {
      assert.equal(proposalFromHash(bad), null, bad);
    }
  });

  it("tolerates surrounding whitespace from a pasted link", () => {
    assert.equal(proposalFromHash(`${PROPOSAL_HASH_PREFIX}  ${REAL}  `), REAL);
  });

  it("does not match a prefix that merely starts the same", () => {
    assert.equal(proposalFromHash(`#proposals/${REAL}`), null);
  });
});
