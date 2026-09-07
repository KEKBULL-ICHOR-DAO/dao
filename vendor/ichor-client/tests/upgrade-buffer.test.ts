/**
 * buffer-freeze check - behavioural coverage.
 *
 * These invoke the real functions against crafted loader account bytes. The
 * pre-existing upgrade tests assert that identifiers appear in the source text,
 * which cannot distinguish an enforced branch from `if (false)`. The attack C1
 * describes - proposer keeps the buffer authority, rewrites the ELF after the
 * vote, hands the buffer to Governance, anyone executes - is caught by exactly
 * one comparison, so that comparison needs a test that runs it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PublicKey } from "@solana/web3.js";

import { parseUpgradeableBuffer } from "../src/burn.ts";
import { BPF_LOADER_UPGRADEABLE } from "../src/network.ts";
import { ClientValidationError } from "../src/types.ts";
import { assertBufferFrozenToGovernance } from "../src/upgrade.ts";

const LOADER = new PublicKey(BPF_LOADER_UPGRADEABLE.id);
// Distinct, indisputably valid pubkeys. Not keypairs - nothing here needs to sign.
const GOVERNANCE = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const PROPOSER = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const BUFFER = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const NOT_THE_LOADER = new PublicKey("11111111111111111111111111111111");

const HEADER = 37; // u32 disc + Option tag + pubkey

/** Loader v3 Buffer bytes: u32 disc, Option tag, pubkey if Some, then the ELF. */
function bufferData(opts: {
  disc?: number;
  tag?: number;
  authority?: PublicKey;
  programBytes?: number;
}): Uint8Array {
  const disc = opts.disc ?? 1;
  const tag = opts.tag ?? 1;
  const programBytes = opts.programBytes ?? 64;
  const data = new Uint8Array(HEADER + programBytes);
  new DataView(data.buffer).setUint32(0, disc, true);
  data[4] = tag;
  if (tag === 1 && opts.authority !== undefined) {
    data.set(opts.authority.toBytes(), 5);
  }
  return data;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ClientValidationError, `expected ClientValidationError, got ${String(err)}`);
    return err.code;
  }
  assert.fail("expected a throw, got none");
}

describe("parseUpgradeableBuffer", () => {
  it("reads the authority out of a Some buffer", () => {
    const parsed = parseUpgradeableBuffer(bufferData({ authority: GOVERNANCE }));
    assert.ok(parsed.authority !== null);
    assert.equal(parsed.authority.toBase58(), GOVERNANCE.toBase58());
  });

  it("returns null for an authority-less buffer", () => {
    assert.equal(parseUpgradeableBuffer(bufferData({ tag: 0 })).authority, null);
  });

  it("refuses ProgramData(3) passed off as a buffer", () => {
    // Buffer is discriminant 1. 3 is ProgramData - a plausible confusion, and
    // the reason this check reads the discriminant rather than trusting the caller.
    assert.equal(codeOf(() => parseUpgradeableBuffer(bufferData({ disc: 3 }))), "INVALID_LOADER_STATE");
  });

  it("refuses Program(2) and Uninitialized(0)", () => {
    assert.equal(codeOf(() => parseUpgradeableBuffer(bufferData({ disc: 2 }))), "INVALID_LOADER_STATE");
    assert.equal(codeOf(() => parseUpgradeableBuffer(bufferData({ disc: 0 }))), "INVALID_LOADER_STATE");
  });

  it("refuses a corrupt Option tag", () => {
    assert.equal(codeOf(() => parseUpgradeableBuffer(bufferData({ tag: 2 }))), "INVALID_LOADER_STATE");
  });

  it("refuses data too short to hold what it claims", () => {
    assert.equal(codeOf(() => parseUpgradeableBuffer(new Uint8Array(4))), "INVALID_LOADER_STATE");
    // Claims Some but is truncated before the pubkey ends.
    assert.equal(codeOf(() => parseUpgradeableBuffer(bufferData({}).slice(0, 20))), "INVALID_LOADER_STATE");
  });
});

describe("assertBufferFrozenToGovernance", () => {
  it("REFUSES a buffer whose authority is still the proposer", () => {
    // The finding itself. With the proposer holding the authority, the loader
    // permits Write + SetAuthority after the vote passes, so the DAO approves
    // one ELF and installs another.
    const code = codeOf(() =>
      assertBufferFrozenToGovernance(
        BUFFER,
        { owner: LOADER, data: bufferData({ authority: PROPOSER }) },
        GOVERNANCE,
      ),
    );
    assert.equal(code, "BUFFER_AUTHORITY_NOT_GOVERNANCE");
  });

  it("refuses a buffer with no authority at all", () => {
    const code = codeOf(() =>
      assertBufferFrozenToGovernance(BUFFER, { owner: LOADER, data: bufferData({ tag: 0 }) }, GOVERNANCE),
    );
    assert.equal(code, "BUFFER_AUTHORITY_NOT_GOVERNANCE");
  });

  it("refuses an account that is not loader-owned", () => {
    const code = codeOf(() =>
      assertBufferFrozenToGovernance(
        BUFFER,
        { owner: NOT_THE_LOADER, data: bufferData({ authority: GOVERNANCE }) },
        GOVERNANCE,
      ),
    );
    assert.equal(code, "BUFFER_LOADER_OWNER");
  });

  it("refuses a missing buffer", () => {
    assert.equal(codeOf(() => assertBufferFrozenToGovernance(BUFFER, null, GOVERNANCE)), "BUFFER_MISSING");
  });

  it("refuses a header-only buffer carrying no program", () => {
    const code = codeOf(() =>
      assertBufferFrozenToGovernance(
        BUFFER,
        { owner: LOADER, data: bufferData({ authority: GOVERNANCE, programBytes: 0 }) },
        GOVERNANCE,
      ),
    );
    assert.equal(code, "BUFFER_EMPTY");
  });

  it("refuses a non-buffer loader account even when the bytes at offset 5 match Governance", () => {
    // Guards against a check that compared bytes without reading the discriminant.
    const code = codeOf(() =>
      assertBufferFrozenToGovernance(
        BUFFER,
        { owner: LOADER, data: bufferData({ disc: 3, authority: GOVERNANCE }) },
        GOVERNANCE,
      ),
    );
    assert.equal(code, "INVALID_LOADER_STATE");
  });

  it("ACCEPTS a loader-owned Buffer already frozen to Governance", () => {
    assert.doesNotThrow(() =>
      assertBufferFrozenToGovernance(
        BUFFER,
        { owner: LOADER, data: bufferData({ authority: GOVERNANCE, programBytes: 4096 }) },
        GOVERNANCE,
      ),
    );
  });
});
