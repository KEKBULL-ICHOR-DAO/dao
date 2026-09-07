import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import {
  composeSetPausedInstruction,
  encodeSetPausedInstructionData,
} from "../src/admin.ts";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const adminSrc = readFileSync(join(clientRoot, "src/admin.ts"), "utf8");
const burnSrc = readFileSync(join(clientRoot, "src/burn.ts"), "utf8");
const typesSrc = readFileSync(join(clientRoot, "src/types.ts"), "utf8");
const indexSrc = readFileSync(join(clientRoot, "src/index.ts"), "utf8");

function sha256Prefix(preimage: string): Buffer {
  return createHash("sha256").update(preimage).digest().subarray(0, 8);
}

function u64Le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function pinnedUint8Const(name: string): Buffer {
  const match = adminSrc.match(new RegExp(`export const ${name} = new Uint8Array\\(\\[([^\\]]+)\\]\\)`));
  assert.ok(match, `missing pinned ${name}`);
  return Buffer.from(
    match[1]
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((n) => !Number.isNaN(n)),
  );
}

function exportedFn(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = src.indexOf("\nexport async function ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

function exportedSyncFn(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const nextExport = src.indexOf("\nexport ", start + 1);
  return src.slice(start, nextExport === -1 ? undefined : nextExport);
}

/** Encode happens via `instruction(` / `encode*InstructionData(` or the set_paused composer. */
const ENCODE_MARKER = /instruction\(|encode\w+InstructionData\(|composeSetPausedInstruction\(/;

function encodePosOf(fn: string): number {
  return fn.search(ENCODE_MARKER);
}

function assertCodesBeforeEncode(fn: string, codes: readonly string[]): void {
  const encodePos = encodePosOf(fn);
  assert.notEqual(encodePos, -1, "builder must encode an instruction");
  for (const code of codes) {
    const pos = fn.indexOf(`"${code}"`);
    assert.notEqual(pos, -1, `missing precondition ${code}`);
    assert.ok(pos < encodePos, `${code} must run before instruction encode`);
  }
}

function fixturePubkey(n: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[31] = n;
  return new PublicKey(bytes);
}

const ADMIN_IX = [
  ["SET_PAUSED_DISCRIMINATOR", "global:set_paused"],
  ["PROPOSE_EMISSION_RATIO_DISCRIMINATOR", "global:propose_emission_ratio"],
  ["APPLY_EMISSION_RATIO_DISCRIMINATOR", "global:apply_emission_ratio"],
  ["CANCEL_PENDING_RATIO_DISCRIMINATOR", "global:cancel_pending_ratio"],
  ["FREEZE_RATIO_UPDATES_DISCRIMINATOR", "global:freeze_ratio_updates"],
  ["INCREASE_RATIO_TIMELOCK_DISCRIMINATOR", "global:increase_ratio_timelock"],
  ["SET_PENDING_AUTHORITY_DISCRIMINATOR", "global:set_pending_authority"],
  ["ACCEPT_AUTHORITY_DISCRIMINATOR", "global:accept_authority"],
] as const;

describe("admin instruction discriminators", () => {
  it("pins every admin sighash to sha256(global:<name>) independently of source bytes", () => {
    for (const [name, preimage] of ADMIN_IX) {
      assert.deepEqual(pinnedUint8Const(name), sha256Prefix(preimage), name);
    }
    assert.notDeepEqual(pinnedUint8Const("SET_PAUSED_DISCRIMINATOR"), sha256Prefix("global:initialize"));
    assert.notDeepEqual(
      pinnedUint8Const("APPLY_EMISSION_RATIO_DISCRIMINATOR"),
      pinnedUint8Const("PROPOSE_EMISSION_RATIO_DISCRIMINATOR"),
    );
  });
});

describe("Borsh bool / option / u64 encoding", () => {
  it("encodes bool as a single 0/1 byte, not a 4-byte tag", () => {
    assert.deepEqual(Buffer.from([0]), Buffer.from([false ? 1 : 0]));
    assert.deepEqual(Buffer.from([1]), Buffer.from([true ? 1 : 0]));
    assert.match(adminSrc, /new Uint8Array\(\[value \? 1 : 0\]\)/);
    assert.match(exportedSyncFn(adminSrc, "encodeSetPausedInstructionData"), /encodeBool\(paused, "paused"\)/);
    assert.doesNotMatch(adminSrc, /writeUInt32/);
    assert.doesNotMatch(adminSrc, /\[1,\s*0,\s*0,\s*0\]/);
    assert.equal(Buffer.concat([sha256Prefix("global:set_paused"), Buffer.from([1])]).length, 9);
    assert.equal(Buffer.concat([sha256Prefix("global:set_paused"), Buffer.from([0])]).length, 9);
  });

  it("encodes Option<Pubkey> as Borsh 1-byte tag + 32 bytes, not COption", () => {
    const none = Buffer.from([0]);
    const some = Buffer.concat([Buffer.from([1]), Buffer.alloc(32, 7)]);
    assert.equal(none.length, 1);
    assert.equal(some.length, 33);
    assert.equal(some[0], 1);
    assert.notEqual(some.length, 36);
    assert.match(adminSrc, /OPTION_NONE = 0/);
    assert.match(adminSrc, /OPTION_SOME = 1/);
    assert.match(adminSrc, /new Uint8Array\(\[OPTION_NONE\]\)/);
    assert.match(adminSrc, /concatBytes\(new Uint8Array\(\[OPTION_SOME\]\), pubkeyBytes\(key\)\)/);
    assert.match(adminSrc, /INVALID_PENDING_AUTHORITY/);
    assert.match(adminSrc, /PublicKey\.default/);
    assert.doesNotMatch(adminSrc, /\[1,\s*0,\s*0,\s*0\]/);
    const setPending = exportedSyncFn(adminSrc, "encodeSetPendingAuthorityInstructionData");
    assert.match(setPending, /encodeOptionPubkey\(pending, "pending"\)/);
  });

  it("encodes u64 args little-endian after the propose/increase sighash", () => {
    const propose = Buffer.concat([
      sha256Prefix("global:propose_emission_ratio"),
      u64Le(3n),
      u64Le(2n),
    ]);
    assert.equal(propose.length, 24);
    assert.equal(propose.readBigUInt64LE(8), 3n);
    assert.equal(propose.readBigUInt64LE(16), 2n);
    const increase = Buffer.concat([sha256Prefix("global:increase_ratio_timelock"), u64Le(86_400n)]);
    assert.equal(increase.length, 16);
    assert.equal(increase.readBigUInt64LE(8), 86_400n);
    assert.match(adminSrc, /toArray\("le", 8\)/);
    assert.match(adminSrc, /ZERO_RATIO/);
    const proposeFn = exportedSyncFn(adminSrc, "encodeProposeEmissionRatioInstructionData");
    assert.match(proposeFn, /u64LeBytes\(numerator, "numerator"\)/);
    assert.match(proposeFn, /u64LeBytes\(denominator, "denominator"\)/);
  });
});

describe("program-source account order and mutability", () => {
  it("Admin accounts are authority signer readonly then config writable", () => {
    const programId = fixturePubkey(2);
    const authority = fixturePubkey(3);
    const config = fixturePubkey(4);
    const unpause = composeSetPausedInstruction({
      programId,
      authority,
      config,
      paused: false,
    });
    const pause = composeSetPausedInstruction({
      programId,
      authority,
      config,
      paused: true,
    });
    for (const ix of [unpause, pause]) {
      assert.ok(ix.programId.equals(programId));
      assert.equal(ix.keys.length, 2, "Admin: authority then config");
      assert.ok(ix.keys[0]!.pubkey.equals(authority));
      assert.equal(ix.keys[0]!.isSigner, true, "authority is the Admin signer");
      assert.equal(ix.keys[0]!.isWritable, false, "authority is readonly");
      assert.ok(ix.keys[1]!.pubkey.equals(config));
      assert.equal(ix.keys[1]!.isSigner, false, "config is not a signer");
      assert.equal(ix.keys[1]!.isWritable, true, "config is writable");
    }
    assert.deepEqual(Array.from(unpause.data), Array.from(encodeSetPausedInstructionData(false)));
    assert.deepEqual(Array.from(pause.data), Array.from(encodeSetPausedInstructionData(true)));
    assert.match(exportedFn(adminSrc, "buildSetPaused"), /composeSetPausedInstruction/);
    assert.match(
      exportedSyncFn(adminSrc, "composeSetPausedInstruction"),
      /adminAccounts\(params\.authority, params\.config\)/,
    );
    for (const name of [
      "buildProposeEmissionRatio",
      "buildCancelPendingRatio",
      "buildFreezeRatioUpdates",
      "buildIncreaseRatioTimelock",
      "buildSetPendingAuthority",
      "buildSetPendingAuthorityToGovernance",
    ]) {
      const fn = exportedFn(adminSrc, name);
      assert.match(fn, /adminAccounts\(authority, configAddress\)/);
    }
    assert.match(
      adminSrc,
      /function adminAccounts[\s\S]*isSigner: true, isWritable: false[\s\S]*isSigner: false, isWritable: true/,
    );
    const adminFn = adminSrc.slice(adminSrc.indexOf("function adminAccounts"), adminSrc.indexOf("function applyAccounts"));
    const authorityPos = adminFn.indexOf("authority");
    const configPos = adminFn.indexOf("config");
    assert.ok(authorityPos !== -1 && authorityPos < configPos);
  });

  it("Apply accounts are config writable only; no invented signer", () => {
    const apply = exportedFn(adminSrc, "buildApplyEmissionRatio");
    assert.match(apply, /applyAccounts\(configAddress\)/);
    assert.doesNotMatch(apply, /isSigner: true/);
    assert.match(adminSrc, /function applyAccounts[\s\S]*isSigner: false, isWritable: true/);
    assert.match(apply, /CALLER_SIGNER|assertNoCallerApplySigner/);
    const tx = exportedFn(adminSrc, "buildApplyEmissionRatioTransaction");
    assert.match(tx, /requiredSignerPubkeys: \[payer\]/);
    assert.match(tx, /transaction\.feePayer = payer/);
    assert.match(tx, /PAYER_REQUIRED/);
    assert.doesNotMatch(tx, /adminAccounts/);
  });

  it("Accept accounts are pending_authority signer readonly then config writable", () => {
    const accept = exportedFn(adminSrc, "buildAcceptAuthority");
    assert.match(accept, /acceptAccounts\(pendingAuthority, configAddress\)/);
    assert.match(
      adminSrc,
      /function acceptAccounts[\s\S]*isSigner: true, isWritable: false[\s\S]*isSigner: false, isWritable: true/,
    );
    const acceptFn = adminSrc.slice(
      adminSrc.indexOf("function acceptAccounts"),
      adminSrc.indexOf("async function readConfirmedUnixTs"),
    );
    const pendingPos = acceptFn.indexOf("pendingAuthority");
    const configPos = acceptFn.indexOf("config");
    assert.ok(pendingPos !== -1 && pendingPos < configPos);
  });
});

describe("live config precondition checks", () => {
  it("brands every admin-relevant Config field against mutation", () => {
    for (const field of [
      "authority",
      "pendingAuthority",
      "pendingEmissionNumerator",
      "pendingEmissionDenominator",
      "pendingRatioUnlockTs",
      "ratioTimelockSecs",
      "ratioUpdatesFrozen",
      "hasPendingRatio",
      "creatorBeneficiary",
      "realmsProgram",
      "realmsRealm",
      "realmsGovernance",
      "realmsNativeTreasury",
      "feeBeneficiariesBound",
      "transferFeeAuthorityRevoked",
      "withdrawWithheldBump",
      "totalFeesWithdrawn",
      "totalFeesToCreator",
      "totalFeesToRealms",
      "bump",
    ]) {
      assert.match(burnSrc, new RegExp(`this\\.config\\.${field}`), field);
    }
  });

  it("requires an issued VerifiedIchorConfig and the bound Connection", () => {
    assert.match(adminSrc, /assertVerifiedIchorConfig\(params\.verifiedConfig\)/);
    assert.match(adminSrc, /assertBoundConnection\(verifiedProgram\.verified, params\.connection\)/);
    assert.match(adminSrc, /configPda\(verifiedProgram\.programId\)/);
    assert.match(typesSrc, /interface BuildAdminParams/);
    assert.match(typesSrc, /interface BuildApplyEmissionRatioParams/);
    assert.match(typesSrc, /interface BuildAcceptAuthorityParams/);
    assert.match(typesSrc, /interface BuildSetPendingAuthorityToGovernanceParams/);
    assert.match(typesSrc, /interface BuildAcceptAuthorityAsGovernanceParams/);
    assert.match(indexSrc, /buildSetPaused/);
    assert.match(indexSrc, /buildApplyEmissionRatioTransaction/);
    assert.match(indexSrc, /encodeSetPendingAuthorityInstructionData/);
    assert.match(indexSrc, /buildSetPendingAuthorityToGovernance/);
    assert.match(indexSrc, /buildAcceptAuthorityAsGovernance/);
  });

  it("gates every admin builder before encode", () => {
    const authorityBuilders = [
      "buildSetPaused",
      "buildProposeEmissionRatio",
      "buildCancelPendingRatio",
      "buildFreezeRatioUpdates",
      "buildIncreaseRatioTimelock",
      "buildSetPendingAuthority",
      "buildSetPendingAuthorityToGovernance",
    ];
    assert.match(adminSrc, /function requireMatchingAuthority/);
    assert.match(adminSrc, /"UNAUTHORIZED"/);
    for (const name of authorityBuilders) {
      const fn = exportedFn(adminSrc, name);
      const authPos = fn.indexOf("requireMatchingAuthority");
      const encodePos = encodePosOf(fn);
      assert.notEqual(authPos, -1, `${name} must check authority`);
      assert.notEqual(encodePos, -1, `${name} must encode`);
      assert.ok(authPos < encodePos, `${name} authority check must run before encode`);
    }
    assertCodesBeforeEncode(exportedFn(adminSrc, "buildProposeEmissionRatio"), [
      "RATIO_UPDATES_FROZEN",
      "RATIO_LOCKED",
    ]);
    assert.match(exportedSyncFn(adminSrc, "encodeProposeEmissionRatioInstructionData"), /ZERO_RATIO/);
    assertCodesBeforeEncode(exportedFn(adminSrc, "buildApplyEmissionRatio"), [
      "RATIO_UPDATES_FROZEN",
      "NO_PENDING_RATIO",
      "ZERO_RATIO",
      "RATIO_TIMELOCK_NOT_ELAPSED",
    ]);
    assert.match(exportedFn(adminSrc, "buildApplyEmissionRatio"), /readConfirmedUnixTs/);
    assert.match(adminSrc, /CLOCK_UNAVAILABLE/);
    assert.match(adminSrc, /getSlot\("confirmed"\)/);
    assert.match(adminSrc, /getBlockTime\(slot\)/);
    assertCodesBeforeEncode(exportedFn(adminSrc, "buildCancelPendingRatio"), ["NO_PENDING_RATIO"]);
    assertCodesBeforeEncode(exportedFn(adminSrc, "buildIncreaseRatioTimelock"), ["TIMELOCK_CANNOT_DECREASE"]);
    assert.match(adminSrc, /function encodeOptionPubkey[\s\S]*INVALID_PENDING_AUTHORITY/);
    assert.match(exportedSyncFn(adminSrc, "encodeSetPendingAuthorityInstructionData"), /encodeOptionPubkey\(pending, "pending"\)/);
    assertCodesBeforeEncode(exportedFn(adminSrc, "buildAcceptAuthority"), [
      "NO_PENDING_AUTHORITY",
      "INVALID_PENDING_AUTHORITY",
      "PENDING_AUTHORITY_MISMATCH",
    ]);
    assertCodesBeforeEncode(exportedFn(adminSrc, "buildAcceptAuthorityAsGovernance"), [
      "NO_PENDING_AUTHORITY",
      "INVALID_PENDING_AUTHORITY",
      "PENDING_AUTHORITY_MISMATCH",
    ]);
  });

  it("derives Governance pending from issued identity, not a caller field", () => {
    const toGov = exportedFn(adminSrc, "buildSetPendingAuthorityToGovernance");
    const acceptGov = exportedFn(adminSrc, "buildAcceptAuthorityAsGovernance");
    const toGovParams = typesSrc.slice(
      typesSrc.indexOf("interface BuildSetPendingAuthorityToGovernanceParams"),
      typesSrc.indexOf("interface BuildAcceptAuthorityAsGovernanceParams"),
    );
    const acceptGovParams = typesSrc.slice(
      typesSrc.indexOf("interface BuildAcceptAuthorityAsGovernanceParams"),
      typesSrc.indexOf("interface BuildSetFeeDistributionParams"),
    );
    assert.match(toGov, /assertNoCallerPending/);
    assert.match(toGov, /assertVerifiedGovernanceIdentity/);
    assert.match(toGov, /assertSharedIssuedNetworkProof/);
    assert.match(toGov, /encodeSetPendingAuthorityInstructionData\(governance\)/);
    assert.match(toGov, /params\.verifiedGovernance\.governance/);
    assert.doesNotMatch(toGov, /params\.pending\b/);
    assert.doesNotMatch(toGovParams, /readonly pending:/);
    assert.match(toGovParams, /extends BuildAdminParams/);
    assert.match(toGovParams, /verifiedGovernance: VerifiedGovernanceIdentity/);
    assert.match(acceptGov, /assertNoCallerPending/);
    assert.match(acceptGov, /assertVerifiedGovernanceIdentity/);
    assert.match(acceptGov, /assertSharedIssuedNetworkProof/);
    assert.match(acceptGov, /pendingAuthority = params\.verifiedGovernance\.governance/);
    assert.doesNotMatch(acceptGov, /params\.pendingAuthority/);
    assert.doesNotMatch(acceptGovParams, /readonly pendingAuthority:/);
    assert.match(acceptGovParams, /verifiedGovernance: VerifiedGovernanceIdentity/);
    assert.match(adminSrc, /verifiedGovernance\.verifiedRealm\.verified !== verifiedProgram\.verified/);
    assert.match(adminSrc, /"NETWORK_PROOF"/);
    assert.match(adminSrc, /CALLER_PENDING_FIELDS/);
    assert.match(adminSrc, /"CALLER_PENDING"/);
    assert.doesNotMatch(adminSrc, /isOnCurve/);
    assert.match(acceptGov, /acceptAccounts\(pendingAuthority, configAddress\)/);
  });

  it("rejects caller program/config substitutions and secrets", () => {
    assert.match(adminSrc, /CALLER_PROGRAM_OR_CONFIG_FIELDS/);
    assert.match(adminSrc, /CALLER_PROGRAM_OR_CONFIG/);
    assert.match(adminSrc, /assertNoSecretMaterial/);
    assert.match(adminSrc, /SECRET_MATERIAL_REJECTED|assertNoSecretMaterial\(params/);
    assert.match(adminSrc, /"programId"/);
    assert.match(adminSrc, /"config"/);
    assert.match(adminSrc, /"accounts"/);
    assert.doesNotMatch(adminSrc, /Keypair\.fromSecretKey|Keypair\.fromSeed|sendAndConfirmTransaction|sendRawTransaction|sendTransaction/);
  });
});

describe("browser safety and no hand-entered program/config", () => {
  it("stays browser-safe: no node builtins and no Buffer identifier", () => {
    assert.doesNotMatch(adminSrc, /\bBuffer\b/);
    assert.doesNotMatch(adminSrc, /from ["']node:/);
    assert.doesNotMatch(adminSrc, /createHash|createHmac|node:crypto/);
    assert.doesNotMatch(adminSrc, /\.toBuffer\(/);
    assert.doesNotMatch(adminSrc, /fs\.|child_process|process\.env/);
  });

  it("does not hardcode a program id or config address", () => {
    assert.doesNotMatch(adminSrc, /declare_id!/);
    assert.doesNotMatch(adminSrc, /KEKBULL_ICHOR_PROGRAM_ID\s*=\s*["']/);
    assert.doesNotMatch(adminSrc, /new PublicKey\s*\(\s*["']/);
    assert.match(adminSrc, /verifiedProgram\.programId/);
    assert.match(adminSrc, /config\.config/);
    assert.match(adminSrc, /verifiedConfig/);
    assert.doesNotMatch(indexSrc, /IssuedVerifiedIchorConfig/);
  });

  it("brands every new Config fee field on IssuedVerifiedIchorConfig", () => {
    const branded = [
      "creatorBeneficiary",
      "realmsProgram",
      "realmsRealm",
      "realmsGovernance",
      "realmsNativeTreasury",
      "feeBeneficiariesBound",
      "transferFeeAuthorityRevoked",
      "withdrawWithheldBump",
      "totalFeesWithdrawn",
      "totalFeesToCreator",
      "totalFeesToRealms",
    ];
    for (const field of branded) {
      assert.match(burnSrc, new RegExp(`readonly #${field}`));
      assert.ok(
        burnSrc.includes(`this.#${field} = args.config.${field}`) ||
          burnSrc.includes(`this.#${field} = args.config.${field}.clone()`),
        `constructor must brand ${field}`,
      );
      assert.ok(
        burnSrc.includes(`this.config.${field}.eq(this.#${field})`) ||
          burnSrc.includes(`this.config.${field} === this.#${field}`) ||
          burnSrc.includes(`samePubkey(this.config.${field}, this.#${field})`),
        `matchesIssuedFields must brand ${field}`,
      );
    }
    assert.match(typesSrc, /readonly creatorBeneficiary: PublicKey \| null/);
    assert.match(typesSrc, /readonly realmsRealm: PublicKey \| null/);
    assert.match(typesSrc, /readonly realmsNativeTreasury: PublicKey \| null/);
    assert.match(typesSrc, /readonly feeBeneficiariesBound: boolean/);
    assert.match(typesSrc, /readonly transferFeeAuthorityRevoked: boolean/);
    assert.match(typesSrc, /readonly withdrawWithheldBump: number/);
    assert.match(typesSrc, /readonly totalFeesWithdrawn: BN/);
    assert.match(typesSrc, /readonly totalFeesToCreator: BN/);
    assert.match(typesSrc, /readonly totalFeesToRealms: BN/);
  });
});
