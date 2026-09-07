import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/upgrade.ts"), "utf8");
const types = readFileSync(join(root, "src/types.ts"), "utf8");
const index = readFileSync(join(root, "src/index.ts"), "utf8");

describe("loader-v3 upgrade authority", () => {
  it("uses SetAuthority variant 4 and exact loader account order", () => {
    assert.match(source, /SET_UPGRADE_AUTHORITY_DATA = new Uint8Array\(\[4,\s*0,\s*0,\s*0\]\)/);
    const start = source.indexOf("function setAuthorityInstruction");
    const end = source.indexOf("export async function", start);
    const fn = source.slice(start, end);
    assert.match(fn, /verifiedProgram\.programData[\s\S]*isSigner:\s*false[\s\S]*isWritable:\s*true/);
    assert.match(fn, /currentAuthority[\s\S]*isSigner:\s*true[\s\S]*isWritable:\s*false/);
    assert.match(fn, /newAuthority[\s\S]*isSigner:\s*false[\s\S]*isWritable:\s*false/);
    assert.match(fn, /BPF_LOADER_UPGRADEABLE\.id/);
  });

  it("derives Realms authority from issued proofs and never caller input", () => {
    assert.match(source, /assertVerifiedIchorProgram/);
    assert.match(source, /assertVerifiedGovernanceIdentity/);
    assert.match(source, /getNativeTreasuryAddress/);
    assert.match(source, /exact issued network proof/);
    assert.match(source, /UPGRADE_AUTHORITY_ALREADY_GOVERNANCE/);
    assert.doesNotMatch(source, /UPGRADE_AUTHORITY_ALREADY_TRANSFERRED/);
    assert.match(source, /PROGRAM_IMMUTABLE/);
    assert.doesNotMatch(
      types.match(/interface BuildTransferProgramUpgradeAuthorityParams \{[^}]*\}/s)?.[0] ?? "",
      /newAuthority|currentAuthority/,
    );
  });

  it("freezes with no new-authority account and exports no secrets or sends", () => {
    assert.match(source, /buildFreezeProgramUpgrades/);
    assert.match(source, /currentAuthority,\s*null/);
    assert.doesNotMatch(
      source,
      /\bBuffer\b|from ["']node:|Keypair|sendTransaction|sendRawTransaction|sendAndConfirmTransaction/,
    );
  });

  it("exports only public proof-bound params and builders", () => {
    assert.match(types, /interface BuildTransferProgramUpgradeAuthorityParams/);
    assert.match(types, /interface BuildFreezeProgramUpgradesParams/);
    assert.match(types, /interface BuildUpgradeIchorProgramParams/);
    assert.doesNotMatch(index, /buildTransferProgramUpgradeAuthorityToRealms/);
    assert.match(index, /buildTransferProgramUpgradeAuthorityToGovernance/);
    assert.match(index, /buildUpgradeIchorProgram/);
    assert.match(index, /buildFreezeProgramUpgrades/);
    assert.match(index, /SET_UPGRADE_AUTHORITY_DATA/);
    assert.match(index, /UPGRADE_PROGRAM_DATA/);
    assert.doesNotMatch(index, /IssuedVerifiedIchorProgram/);
  });

  it("uses Upgrade variant 3 and the seven-account loader order", () => {
    assert.match(source, /UPGRADE_PROGRAM_DATA = new Uint8Array\(\[3,\s*0,\s*0,\s*0\]\)/);
    const start = source.indexOf("export async function buildUpgradeIchorProgram");
    const end = source.indexOf("export async function", start + 1);
    const fn = source.slice(start, end === -1 ? undefined : end);
    assert.match(fn, /pubkey:\s*programData[\s\S]*isSigner:\s*false[\s\S]*isWritable:\s*true/);
    assert.match(fn, /pubkey:\s*program,[\s\S]*isSigner:\s*false[\s\S]*isWritable:\s*true/);
    assert.match(fn, /pubkey:\s*buffer[\s\S]*isSigner:\s*false[\s\S]*isWritable:\s*true/);
    assert.match(fn, /pubkey:\s*spill[\s\S]*isSigner:\s*false[\s\S]*isWritable:\s*true/);
    assert.match(fn, /SYSVAR_RENT_PUBKEY[\s\S]*isSigner:\s*false[\s\S]*isWritable:\s*false/);
    assert.match(fn, /SYSVAR_CLOCK_PUBKEY[\s\S]*isSigner:\s*false[\s\S]*isWritable:\s*false/);
    assert.match(fn, /pubkey:\s*authority[\s\S]*isSigner:\s*true[\s\S]*isWritable:\s*false/);
    assert.match(fn, /BPF_LOADER_UPGRADEABLE\.id/);
    assert.match(fn, /Uint8Array\.from\(UPGRADE_PROGRAM_DATA\)/);
    assert.equal((fn.match(/isWritable:\s*true/g) ?? []).length, 4);
    assert.equal((fn.match(/isSigner:\s*true/g) ?? []).length, 1);
  });

  it("derives spill from getNativeTreasuryAddress and refuses a colliding buffer", () => {
    const start = source.indexOf("export async function buildUpgradeIchorProgram");
    const end = source.indexOf("export async function", start + 1);
    const fn = source.slice(start, end === -1 ? undefined : end);
    assert.match(fn, /getNativeTreasuryAddress/);
    assert.match(fn, /const spill = await getNativeTreasuryAddress/);
    assert.match(fn, /requirePublicKey\(params\.buffer,\s*"buffer"\)/);
    assert.match(fn, /BUFFER_ACCOUNT_COLLISION/);
    assert.match(fn, /exact issued network proof|assertSharedIssuedNetworkProof/);
    assert.match(fn, /observedAuthority\(params\.verifiedProgram\)/);
    assert.match(fn, /params\.verifiedProgram\.programId/);
    assert.match(fn, /params\.verifiedProgram\.programData/);
    assert.doesNotMatch(fn, /params\.spill|params\.authority|params\.programData|params\.programId/);
    assert.doesNotMatch(
      types.match(/interface BuildUpgradeIchorProgramParams \{[^}]*\}/s)?.[0] ?? "",
      /spill|currentAuthority|newAuthority|elf|bytes/,
    );
  });

  it("transfers upgrade authority to the issued Governance PDA and forbids the native-treasury builder", () => {
    const start = source.indexOf(
      "export async function buildTransferProgramUpgradeAuthorityToGovernance",
    );
    const fn = source.slice(start);
    assert.match(fn, /params\.verifiedGovernance\.governance/);
    assert.match(fn, /UPGRADE_AUTHORITY_ALREADY_GOVERNANCE/);
    assert.match(fn, /assertSharedIssuedNetworkProof/);
    assert.match(fn, /setAuthorityInstruction\([\s\S]*currentAuthority,\s*governance/);
    assert.doesNotMatch(fn, /getNativeTreasuryAddress/);
    assert.doesNotMatch(source, /export async function buildTransferProgramUpgradeAuthorityToRealms/);
    assert.doesNotMatch(source, /function buildTransferProgramUpgradeAuthorityToRealms/);
    assert.doesNotMatch(source, /newUpgradeAuthority:\s*treasury/);
    assert.doesNotMatch(source, /UPGRADE_AUTHORITY_ALREADY_TRANSFERRED/);
    assert.doesNotMatch(index, /buildTransferProgramUpgradeAuthorityToRealms/);
  });
});
