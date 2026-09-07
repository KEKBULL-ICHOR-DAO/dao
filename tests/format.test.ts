import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientValidationError } from "@kekbull/ichor-client";
import { formatGovernanceSeconds } from "../src/format.ts";

describe("formatGovernanceSeconds", () => {
  it("renders official-devnet and mainnet pin-shaped second counts", () => {
    assert.equal(formatGovernanceSeconds(0), "0 seconds");
    assert.equal(formatGovernanceSeconds(1), "1 second");
    assert.equal(formatGovernanceSeconds(300), "5 minutes");
    assert.equal(formatGovernanceSeconds(86_400), "1 day");
    assert.equal(formatGovernanceSeconds(259_200), "3 days");
  });

  it("joins mixed units without inventing a remainder", () => {
    assert.equal(formatGovernanceSeconds(90_061), "1 day 1 hour 1 minute 1 second");
    assert.equal(formatGovernanceSeconds(3_661), "1 hour 1 minute 1 second");
  });

  it("rejects values that are not non-negative integer seconds", () => {
    assert.throws(() => formatGovernanceSeconds(-1), ClientValidationError);
    assert.throws(() => formatGovernanceSeconds(1.5), ClientValidationError);
    assert.throws(() => formatGovernanceSeconds(Number.NaN), ClientValidationError);
  });
});
