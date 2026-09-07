/**
 * Behavioural coverage for the unpause wire format.
 *
 * `initialize` now ships `paused = true` (program `state::paused_at_initialize`),
 * so every rehearsal that converts must first land `set_paused(false)`. The
 * existing admin tests assert these identifiers appear in the source; these
 * encode the bytes that actually go on the wire.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SET_PAUSED_DISCRIMINATOR,
  encodeSetPausedInstructionData,
} from "../src/admin.ts";

describe("set_paused instruction data", () => {
  it("encodes unpause as the discriminator plus a false byte", () => {
    const data = encodeSetPausedInstructionData(false);
    assert.equal(data.length, 9);
    assert.deepEqual(Array.from(data.slice(0, 8)), Array.from(SET_PAUSED_DISCRIMINATOR));
    assert.equal(data[8], 0, "unpause must encode paused=false");
  });

  it("encodes pause as the discriminator plus a true byte", () => {
    const data = encodeSetPausedInstructionData(true);
    assert.equal(data.length, 9);
    assert.equal(data[8], 1);
  });

  it("distinguishes the two, so a harness cannot unpause by accident", () => {
    assert.notDeepEqual(
      Array.from(encodeSetPausedInstructionData(false)),
      Array.from(encodeSetPausedInstructionData(true)),
    );
  });
});
