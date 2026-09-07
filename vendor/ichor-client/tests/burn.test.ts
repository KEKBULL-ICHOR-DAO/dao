import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const burnSrc = readFileSync(join(clientRoot, "src/burn.ts"), "utf8");
const validationSrc = readFileSync(join(clientRoot, "src/validation.ts"), "utf8");
const typesSrc = readFileSync(join(clientRoot, "src/types.ts"), "utf8");

function sha256Prefix(preimage: string): Buffer {
  return createHash("sha256").update(preimage).digest().subarray(0, 8);
}

function u64Le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function encodeConvert(kekbullAmount: bigint, minIchorAmount: bigint): Buffer {
  return Buffer.concat([sha256Prefix("global:convert"), u64Le(kekbullAmount), u64Le(minIchorAmount)]);
}

function encodeInitialize(num: bigint, den: bigint, lock: bigint, decay: bigint): Buffer {
  return Buffer.concat([
    sha256Prefix("global:initialize"),
    u64Le(num),
    u64Le(den),
    u64Le(lock),
    u64Le(decay),
  ]);
}

function tenPow(exp: number): bigint {
  let v = 1n;
  for (let i = 0; i < exp; i++) {
    v *= 10n;
    if (v >= 1n << 128n) {
      throw new Error("overflow");
    }
  }
  return v;
}

function ichorFromKekbull(
  kek: bigint,
  kekDecimals: number,
  ichorDecimals: number,
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (kek === 0n) throw new Error("zero");
  if (numerator === 0n || denominator === 0n) throw new Error("ratio");
  if (numerator > denominator) throw new Error("RATIO_ABOVE_CEILING");
  const scaleUp = ichorDecimals > kekDecimals ? tenPow(ichorDecimals - kekDecimals) : 1n;
  const scaleDown = ichorDecimals < kekDecimals ? tenPow(kekDecimals - ichorDecimals) : 1n;
  const minted = (kek * numerator * scaleUp) / (denominator * scaleDown);
  if (minted === 0n) throw new Error("floor");
  if (minted > 0xffff_ffff_ffff_ffffn) throw new Error("overflow");
  return minted;
}

function pinnedUint8Const(name: string): Buffer {
  const match = burnSrc.match(new RegExp(`export const ${name} = new Uint8Array\\(\\[([^\\]]+)\\]\\)`));
  assert.ok(match, `missing pinned ${name}`);
  return Buffer.from(
    match[1]
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((n) => !Number.isNaN(n)),
  );
}

describe("convert instruction data", () => {
  it("pins convert/initialize/Config discriminators to sha256 prefixes", () => {
    assert.deepEqual(pinnedUint8Const("CONVERT_DISCRIMINATOR"), sha256Prefix("global:convert"));
    assert.deepEqual(pinnedUint8Const("INITIALIZE_DISCRIMINATOR"), sha256Prefix("global:initialize"));
    assert.deepEqual(pinnedUint8Const("CONFIG_ACCOUNT_DISCRIMINATOR"), sha256Prefix("account:Config"));
    assert.notDeepEqual(pinnedUint8Const("CONVERT_DISCRIMINATOR"), sha256Prefix("global:initialize"));
  });

  it("uses Anchor global sighash plus two little-endian u64 args", () => {
    const data = encodeConvert(1_000_000n, 500_000_000n);
    assert.equal(data.length, 24);
    assert.deepEqual(data.subarray(0, 8), sha256Prefix("global:convert"));
    assert.equal(data.readBigUInt64LE(8), 1_000_000n);
    assert.equal(data.readBigUInt64LE(16), 500_000_000n);
    assert.notDeepEqual(data.subarray(0, 8), sha256Prefix("global:initialize"));
  });

  it("initialize data is sighash plus four u64 args including a zero timelock and positive decay", () => {
    const data = encodeInitialize(1n, 1n, 0n, 86_400n);
    assert.equal(data.length, 40);
    assert.deepEqual(data.subarray(0, 8), sha256Prefix("global:initialize"));
    assert.equal(data.readBigUInt64LE(24), 0n);
    assert.equal(data.readBigUInt64LE(32), 86_400n);
    assert.match(burnSrc, /creatorDecaySecs/);
    assert.match(burnSrc, /requirePositiveBn\(params\.creatorDecaySecs/);
  });

  it("config account discriminator is account:Config, not a convert sighash", () => {
    assert.deepEqual(sha256Prefix("account:Config"), pinnedUint8Const("CONFIG_ACCOUNT_DISCRIMINATOR"));
    assert.notDeepEqual(sha256Prefix("account:Config"), sha256Prefix("global:convert"));
    assert.match(burnSrc, /CONFIG_ACCOUNT_DISCRIMINATOR/);
  });
});

describe("emission identity", () => {
  it("applies the human-unit ratio after reading both decimal widths", () => {
    assert.equal(ichorFromKekbull(1_000_000n, 6, 9, 1n, 1n), 1_000_000_000n);
    assert.equal(ichorFromKekbull(1_000_000_000n, 9, 6, 1n, 1n), 1_000_000n);
    assert.equal(ichorFromKekbull(100n, 255, 255, 1n, 1n), 100n);
    assert.equal(ichorFromKekbull(7n, 255, 255, 1n, 1n), 7n);
    assert.throws(() => ichorFromKekbull(7n, 255, 255, 3n, 1n), /RATIO_ABOVE_CEILING/);
    assert.throws(() => ichorFromKekbull(1n, 9, 6, 1n, 1n), /floor/);
    assert.throws(() => tenPow(39), /overflow/);
    assert.equal(tenPow(0), 1n);
  });
});

describe("program-source account order", () => {
  it("convert keys follow Convert accounts: burner through token_program", () => {
    const start = burnSrc.indexOf("export async function composeConvertInstructionsFromIssuedConfig");
    assert.notEqual(start, -1);
    const fn = burnSrc.slice(start, burnSrc.indexOf("export async function buildConvertTransaction"));
    const publicConvert = burnSrc.slice(
      burnSrc.indexOf("export async function buildConvertTransaction"),
      burnSrc.indexOf("export async function buildConvertInstruction"),
    );
    assert.match(publicConvert, /config\.paused/);
    assert.match(publicConvert, /"PAUSED"/);
    assert.match(publicConvert, /composeConvertInstructionsFromIssuedConfig/);
    assert.doesNotMatch(fn, /config\.paused/);
    const keysPos = fn.indexOf("verifiedProgram.programId");
    const keys = fn.slice(keysPos);
    assert.match(fn, /assertIchorIsToken2022/);
    assert.match(fn, /assertKekbullIsToken2022/);
    const order = [
      "burner",
      "config.config",
      "kekbullMint.mint",
      "ichorMint.mint",
      "kekbullFrom",
      "ichorTo",
      "bondingCurve.address",
      "kekbullMint.ownerProgram",
      "ichorMint.ownerProgram",
    ];
    let cursor = 0;
    for (const name of order) {
      const next = keys.indexOf(name, cursor);
      assert.notEqual(next, -1, `missing ${name} after previous convert account`);
      cursor = next + name.length;
    }
  });

  it("initialize keys include upgrade-authority program and ProgramData", () => {
    const start = burnSrc.indexOf("export async function buildInitializeTransaction");
    assert.notEqual(start, -1);
    const fn = burnSrc.slice(start);
    assert.match(fn, /params\.verifiedProgram\.programId/);
    assert.match(fn, /params\.verifiedProgram\.programData/);
    assert.match(fn, /SystemProgram\.programId/);
    assert.match(fn, /authority/);
    assert.match(fn, /configAddress/);
    assert.match(fn, /withdrawWithheldPda/);
    assert.match(fn, /creatorEscrowPda/);
    assert.match(fn, /assertIchorIsToken2022/);
    const keysStart = fn.indexOf("const ix = instruction(");
    assert.notEqual(keysStart, -1);
    const keys = fn.slice(keysStart);
    const order = [
      "authority",
      "configAddress",
      "kekbullMint.mint",
      "ichorMint.mint",
      "withdraw.address",
      "escrow.address",
      "bondingCurve.address",
      "params.verifiedProgram.programId",
      "params.verifiedProgram.programData",
      "SystemProgram.programId",
    ];
    let cursor = 0;
    for (const name of order) {
      const next = keys.indexOf(name, cursor);
      assert.notEqual(next, -1, `missing initialize account ${name}`);
      cursor = next + name.length;
    }
    const revokePos = fn.indexOf("UPGRADE_AUTHORITY_REVOKED");
    const mismatchPos = fn.indexOf("NOT_UPGRADE_AUTHORITY");
    const ixPos = fn.indexOf("const ix = instruction(");
    assert.notEqual(revokePos, -1);
    assert.notEqual(mismatchPos, -1);
    assert.notEqual(ixPos, -1);
    assert.ok(revokePos < ixPos, "revoked-authority gate must run before instruction encode");
    assert.ok(mismatchPos < ixPos, "authority equality gate must run before instruction encode");
  });
});

describe("loader v3 ProgramData", () => {
  it("parses disc, slot, Option tag 0/1, and Some pubkey; brands those fields", () => {
    assert.match(burnSrc, /LOADER_STATE_PROGRAM_DATA = 3/);
    assert.match(burnSrc, /MIN_PROGRAMDATA_NONE_LEN = 13/);
    assert.match(burnSrc, /MIN_PROGRAMDATA_SOME_LEN = 45/);
    assert.match(burnSrc, /readU64\(data, 4, "programdata.slot"\)/);
    assert.match(burnSrc, /data\[12\]/);
    assert.match(burnSrc, /readPubkey\(data, 13, "programdata.upgrade_authority"\)/);
    assert.match(burnSrc, /only 0 or 1 are valid/);
    assert.match(typesSrc, /readonly upgradeAuthority: PublicKey \| null/);
    assert.match(typesSrc, /readonly deploymentSlot: BN/);
    assert.match(burnSrc, /samePubkey\(this\.upgradeAuthority, this\.#upgradeAuthority\)/);
    assert.match(burnSrc, /this\.deploymentSlot\.eq\(this\.#deploymentSlot\)/);
  });

  it("stays browser-safe: no node builtins and no Buffer identifier", () => {
    assert.doesNotMatch(burnSrc, /\bBuffer\b/);
    assert.doesNotMatch(burnSrc, /from ["']node:/);
    assert.doesNotMatch(burnSrc, /createHash|createHmac|node:crypto/);
    assert.doesNotMatch(burnSrc, /\.toBuffer\(/);
  });
});

describe("fail-closed configuration", () => {
  it("refuses an unset or reserved ICHOR program id before any encode", () => {
    assert.match(validationSrc, /PROGRAM_ID_UNCONFIGURED/);
    assert.match(validationSrc, /PROGRAM_ID_RESERVED/);
    assert.match(burnSrc, /requireConfiguredDeploymentAddress/);
    assert.match(burnSrc, /PROGRAM_NOT_DEPLOYED/);
    assert.match(burnSrc, /CONFIG_NOT_INITIALIZED/);
    assert.match(typesSrc, /Do not construct this type by hand/);
  });

  it("does not hardcode mint decimals, supply, or a placeholder program id", () => {
    assert.doesNotMatch(burnSrc, /declare_id!/);
    assert.doesNotMatch(burnSrc, /KEKBULL_ICHOR_PROGRAM_ID\s*=\s*["']/);
    assert.doesNotMatch(burnSrc, /decimals:\s*6|decimals:\s*9/);
    assert.doesNotMatch(burnSrc, /supply:\s*new BN/);
    assert.doesNotMatch(burnSrc, /BURN_BUILDER_BLOCKED/);
    assert.match(burnSrc, /kekbullMint\.decimals/);
    assert.match(burnSrc, /ichorMint\.decimals/);
  });
});
