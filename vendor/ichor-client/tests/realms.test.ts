import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  getRealmConfigAddress,
  GoverningTokenConfigAccountArgs,
  GoverningTokenType,
  MintMaxVoteWeightSource,
  withCreateRealm,
  withDepositGoverningTokens,
  withWithdrawGoverningTokens,
} from "@realms-today/spl-governance";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { REALMS_INSTANCES, REALMS_PROGRAM_VERSION } from "../src/network.ts";
import {
  applyIchorDepositToken2022Patch,
  composeDepositIchorVotesInstruction,
} from "../src/realms.ts";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(clientRoot, "src");

function readSrc(name: string): string {
  return readFileSync(join(srcDir, name), "utf8");
}

function interfaceBody(src: string, name: string): string {
  const match = src.match(new RegExp(`(?:export )?interface ${name} \\{[^}]*\\}`, "s"));
  return match?.[0] ?? "";
}

function withCreateRealmCall(fnSrc: string): string {
  const start = fnSrc.indexOf("withCreateRealm(");
  if (start === -1) {
    return "";
  }
  let depth = 0;
  for (let i = start; i < fnSrc.length; i++) {
    const ch = fnSrc[i];
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return fnSrc.slice(start, i + 1);
      }
    }
  }
  return "";
}

function exportedFn(src: string, name: string): string {
  const asyncStart = src.indexOf(`export async function ${name}`);
  const syncStart = src.indexOf(`export function ${name}`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) {
    return "";
  }
  const nextAsync = src.indexOf("\nexport async function ", start + 1);
  const nextSync = src.indexOf("\nexport function ", start + 1);
  const next =
    nextAsync === -1
      ? nextSync
      : nextSync === -1
        ? nextAsync
        : Math.min(nextAsync, nextSync);
  return src.slice(start, next === -1 ? undefined : next);
}

type FingerprintIx = {
  programId: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: number[];
};

function bytesToHex(data: readonly number[]): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Mirrors realms.ts fingerprintInnerInstructions on a plain instruction shape. */
function fingerprintInnerInstructions(instructions: readonly FingerprintIx[]): string {
  return instructions
    .map((ix) => {
      const keys = ix.keys
        .map((key) => `${key.pubkey}:${key.isSigner ? "1" : "0"}:${key.isWritable ? "1" : "0"}`)
        .join(",");
      return `${ix.programId};${keys};${bytesToHex(ix.data)}`;
    })
    .join("|");
}

function sampleIx(overrides: Partial<FingerprintIx> = {}): FingerprintIx {
  return {
    programId: "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw",
    keys: [
      {
        pubkey: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: "11111111111111111111111111111111",
        isSigner: true,
        isWritable: false,
      },
    ],
    data: [4, 0, 0, 0],
    ...overrides,
  };
}

describe("proposal lifecycle caller-field absence", () => {
  const types = readSrc("types.ts");
  const realms = readSrc("realms.ts");
  const meteora = readSrc("meteora.ts");

  it("binds insert/execute/sign-off and council create to identity, not raw verified/governance/realm", () => {
    for (const name of [
      "InsertProposalTransactionParams",
      "ExecuteProposalTransactionParams",
      "BuildSignOffProposalParams",
      "BuildProposalParams",
    ]) {
      const body = interfaceBody(types, name);
      assert.match(body, /verifiedGovernance/);
      assert.doesNotMatch(body, /readonly verified:/);
      assert.doesNotMatch(body, /readonly governance:/);
      assert.doesNotMatch(body, /readonly realm:/);
      assert.doesNotMatch(body, /readonly verifiedRealm:/);
    }

    const execute = interfaceBody(types, "ExecuteProposalTransactionParams");
    assert.match(execute, /readonly staged:/);
    assert.match(execute, /readonly transactionInstructions:/);
    assert.doesNotMatch(execute, /readonly transactionAddress:/);

    const insert = interfaceBody(types, "InsertProposalTransactionParams");
    assert.doesNotMatch(insert, /readonly transactionAddress:/);

    const create = interfaceBody(types, "BuildProposalParams");
    assert.match(create, /readonly governingTokenMint:/);
    assert.match(create, /readonly tokenOwnerRecord:/);

    const claim = interfaceBody(types, "ClaimFeesToTreasuryParams");
    assert.match(claim, /readonly positionNftMint:/);
    assert.doesNotMatch(claim, /positionNftAccount/);
    assert.doesNotMatch(exportedFn(meteora, "buildClaimPositionFeeToTreasury"), /params\.positionNftAccount/);
    const claimBuild = interfaceBody(types, "ClaimFeesToTreasuryBuild");
    assert.match(claimBuild, /readonly insert0:\s*Transaction/);
    assert.match(claimBuild, /readonly insert1:\s*Transaction/);
    assert.match(claimBuild, /readonly transaction:\s*Transaction/);
  });

  it("rejects caller identity substitution on identity-bound lifecycle builders", () => {
    for (const name of [
      "buildInsertProposalTransaction",
      "buildExecuteProposalTransaction",
      "buildSignOffProposal",
      "buildCreateProposal",
      "buildCommunityActivationInstruction",
    ]) {
      const fn = exportedFn(realms, name);
      assert.match(fn, /assertIdentityBoundLifecycle/);
      assert.match(fn, /params\.verifiedGovernance/);
      assert.doesNotMatch(fn, /params\.verified\b/);
      assert.doesNotMatch(fn, /params\.governance\b/);
      assert.doesNotMatch(fn, /params\.realm\b/);
    }
    assert.match(realms, /CALLER_IDENTITY_SUBSTITUTION_FIELDS/);
    assert.match(realms, /"verified",\s*"governance",\s*"realm",\s*"verifiedRealm"/);
  });
});

describe("proposal lifecycle identity branding", () => {
  const realms = readSrc("realms.ts");
  const types = readSrc("types.ts");
  const index = readSrc("index.ts");

  it("issues an unexported staged-actions receipt bound to the insert identity", () => {
    assert.match(realms, /class IssuedStagedProposalActions/);
    assert.doesNotMatch(realms, /export class IssuedStagedProposalActions/);
    assert.match(realms, /issuedStagedProposalActions\.add\(/);
    assert.match(realms, /issuedStagedProposalActions\.has\(/);
    assert.match(realms, /instanceof IssuedStagedProposalActions/);
    assert.match(realms, /boundTo\(identity:\s*VerifiedGovernanceIdentity\)/);
    assert.match(realms, /STAGED_PROPOSAL_ACTIONS/);
    assert.match(realms, /STAGED_GOVERNANCE_MISMATCH/);
    assert.match(realms, /fabricated staged proposal actions/);
    assert.match(types, /interface StagedProposalActions/);
    assert.match(types, /interface InsertProposalTransactionBuild/);
    assert.match(index, /assertStagedProposalActions/);
    assert.match(index, /fingerprintInnerInstructions/);
    assert.match(index, /recoverProposalTransaction/);
    assert.doesNotMatch(index, /IssuedStagedProposalActions/);
    assert.doesNotMatch(index, /issuedStagedProposalActions/);

    const insert = exportedFn(realms, "buildInsertProposalTransaction");
    assert.match(insert, /new IssuedStagedProposalActions/);
    assert.match(insert, /cloneInnerInstructions\(params\.transactionInstructions\)/);
    assert.match(insert, /derivedAddresses:\s*\{\s*transaction:\s*transactionAddress/);

    const execute = exportedFn(realms, "buildExecuteProposalTransaction");
    assert.match(execute, /assertStagedProposalActions\(params\.staged\)/);
    assert.match(execute, /params\.staged\.boundTo\(params\.verifiedGovernance\)/);
    assert.match(execute, /params\.staged\.cloneInnerInstructions\(\)/);
    assert.match(execute, /assertIdentityBoundLifecycle/);
    assert.match(realms, /function assertIdentityBoundLifecycle[\s\S]*assertVerifiedGovernanceIdentity/);
  });

  it("recovers a restart-safe staged receipt from the live ProposalTransaction", () => {
    const recover = exportedFn(realms, "recoverProposalTransaction");
    assert.match(recover, /getProposalTransactionAddress/);
    assert.match(recover, /getAccountInfo\(transactionAddress,\s*"confirmed"\)/);
    assert.match(recover, /ProposalTransaction/);
    assert.match(recover, /getAllInstructions\(\)/);
    assert.match(recover, /fromInstructionData/);
    assert.match(recover, /new IssuedStagedProposalActions/);
    assert.match(recover, /PROPOSAL_TX_OWNER/);
    assert.match(recover, /PROPOSAL_TX_IDENTITY/);
    assert.match(types, /interface RecoveredProposalTransaction/);
    assert.match(index, /RecoverProposalTransactionParams/);
  });

  it("keeps community propose/cast on the active governance proof", () => {
    const communityCreate = interfaceBody(types, "BuildCommunityProposalParams");
    const communityVote = interfaceBody(types, "CastCommunityVoteParams");
    assert.match(communityCreate, /readonly verifiedGovernance:/);
    assert.match(communityVote, /readonly verifiedGovernance:/);
    assert.doesNotMatch(communityCreate, /readonly governingTokenMint:/);
    assert.match(realms, /assertCommunityGovernanceBuilder\(params,\s*params\.verifiedGovernance/);
    assert.match(
      exportedFn(realms, "buildCreateCommunityProposal"),
      /assertVerifiedGovernance|assertCommunityGovernanceBuilder/,
    );
    assert.match(
      exportedFn(realms, "buildCastCouncilVote"),
      /assertIdentityBoundLifecycle/,
    );
    assert.match(
      exportedFn(realms, "buildWithdrawCouncilVotes"),
      /getAssociatedTokenAddressSync/,
    );
    assert.match(
      exportedFn(realms, "buildCreateCommunityProposal"),
      /communityMint,/,
    );
    assert.match(
      exportedFn(realms, "buildCreateProposal"),
      /params\.governingTokenMint,/,
    );
    assert.match(
      exportedFn(realms, "buildCommunityActivationInstruction"),
      /assertIdentityBoundLifecycle|assertVerifiedGovernanceIdentity/,
    );
    assert.match(
      exportedFn(realms, "buildCommunityActivationInstruction"),
      /assertMainnetCommunityActivation/,
    );
  });

  it("creates Governance with communityActivationGovernanceConfig, not council-only bootstrap", () => {
    const createGov = exportedFn(realms, "buildCreateGovernance");
    const activation = exportedFn(realms, "communityActivationGovernanceConfig");
    assert.match(createGov, /communityActivationGovernanceConfig\(params\.config\)/);
    assert.match(createGov, /assertMainnetCommunityActivation/);
    assert.doesNotMatch(createGov, /bootstrapGovernanceConfig/);
    assert.match(activation, /councilVoteThreshold:\s*disabledThreshold\(\)/);
    assert.match(activation, /councilVetoVoteThreshold:\s*disabledThreshold\(\)/);
    assert.match(activation, /communityVoteThreshold:\s*yesPercent/);
    assert.match(index, /communityActivationGovernanceConfig/);
    assert.match(index, /buildTransferRealmAuthorityToGovernance/);
  });

  it("binds bootstrap Realm-authority handoff to SetChecked Governance only", () => {
    const transfer = exportedFn(realms, "buildTransferRealmAuthorityToGovernance");
    assert.match(transfer, /withSetRealmAuthority/);
    assert.match(transfer, /SetRealmAuthorityAction\.SetChecked/);
    assert.match(transfer, /assertIdentityBoundLifecycle/);
    assert.match(transfer, /CONNECTION_MISMATCH/);
    assert.match(transfer, /AUTHORITY_DEFAULT/);
    assert.match(transfer, /AUTHORITY_ALREADY_GOVERNANCE/);
    assert.match(transfer, /REALM_AUTHORITY/);
    assert.match(transfer, /REALMS_SDK_LAYOUT_DRIFT/);
    assert.match(transfer, /ix\.keys\.length !== 3/);
    assert.match(transfer, /newRealmAuthority:\s*governance/);
    assert.doesNotMatch(transfer, /SetUnchecked|SetRealmAuthorityAction\.Remove/);
    assert.doesNotMatch(transfer, /params\.newRealmAuthority|params\.destination|params\.action/);
    assert.match(types, /interface BuildTransferRealmAuthorityParams/);
    assert.match(index, /buildTransferRealmAuthorityToGovernance/);
    assert.match(index, /BuildTransferRealmAuthorityParams/);

    const remove = exportedFn(realms, "buildRemoveCouncilInstruction");
    assert.match(remove, /Proposal-only payload|assertIdentityBoundLifecycle/);
    assert.match(remove, /Governance must be the live Realm authority/);
    assert.match(remove, /COUNCIL_DEPOSITS_REMAIN/);
    assert.match(remove, /ix\.keys\.length !== 4/);
    assert.match(remove, /SystemProgram\.programId/);
    assert.match(remove, /isWritable !== true \|\| ix\.keys\[0\]!\.isSigner !== false/);
    assert.match(remove, /isWritable !== false \|\| ix\.keys\[1\]!\.isSigner !== true/);
    assert.match(remove, /isWritable !== false \|\| ix\.keys\[2\]!\.isSigner !== false/);
    assert.match(remove, /isWritable !== true \|\| ix\.keys\[3\]!\.isSigner !== false/);
    assert.match(remove, /writable non-signer/);
    assert.match(remove, /readonly signer/);
    assert.match(remove, /readonly non-signer/);
  });
});

describe("inserted/executed inner-instruction byte equality", () => {
  const realms = readSrc("realms.ts");

  it("fingerprints program id, key order/flags, and data the same way insert stores and execute checks", () => {
    const helper = exportedFn(realms, "fingerprintInnerInstructions");
    assert.match(helper, /key\.pubkey\.toBase58\(\)/);
    assert.match(helper, /key\.isSigner \? "1" : "0"/);
    assert.match(helper, /key\.isWritable \? "1" : "0"/);
    assert.match(helper, /ix\.programId\.toBase58\(\)/);
    assert.match(helper, /bytesToHex\(Uint8Array\.from\(ix\.data\)\)/);
    assert.match(helper, /\.join\("\|"\)/);
    assert.match(realms, /INNER_INSTRUCTION_MISMATCH/);

    const execute = exportedFn(realms, "buildExecuteProposalTransaction");
    assert.match(execute, /assertInnerInstructionsMatch\(inner,\s*params\.transactionInstructions\)/);
    assert.match(execute, /const encoded = inner\.map\(toInstructionData\)/);
    assert.doesNotMatch(execute, /params\.transactionInstructions\.map\(toInstructionData\)/);
  });

  it("validates u16 index, u8 option index, and u32 hold-up before SDK calls", () => {
    const insert = exportedFn(realms, "buildInsertProposalTransaction");
    assert.match(insert, /requireUnsignedIntegerInRange\(params\.index,\s*"index",\s*0xffff\)/);
    assert.match(
      insert,
      /requireUnsignedIntegerInRange\(\s*params\.optionIndex,\s*"optionIndex",\s*0xff/,
    );
    assert.match(
      insert,
      /requireUnsignedIntegerInRange\(\s*params\.holdUpTime,\s*"holdUpTime",\s*0xffff_ffff/,
    );
    assert.match(realms, /Number\.isSafeInteger/);
    assert.match(realms, /INTEGER_RANGE/);
  });

  it("treats program id, key order, signer/writable flags, and data as identity", () => {
    const inserted = [sampleIx()];
    const sameClaim = [sampleIx()];
    assert.equal(fingerprintInnerInstructions(inserted), fingerprintInnerInstructions(sameClaim));

    assert.notEqual(
      fingerprintInnerInstructions(inserted),
      fingerprintInnerInstructions([
        sampleIx({ programId: "GTesTBiEWE32WHXXE2S4XbZvA5CrEc4xs6ZgRe895dP" }),
      ]),
    );

    const swappedKeys = sampleIx({
      keys: [
        {
          pubkey: "11111111111111111111111111111111",
          isSigner: true,
          isWritable: false,
        },
        {
          pubkey: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          isSigner: false,
          isWritable: true,
        },
      ],
    });
    assert.notEqual(fingerprintInnerInstructions(inserted), fingerprintInnerInstructions([swappedKeys]));

    const flippedSigner = sampleIx({
      keys: [
        {
          pubkey: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          isSigner: true,
          isWritable: true,
        },
        {
          pubkey: "11111111111111111111111111111111",
          isSigner: true,
          isWritable: false,
        },
      ],
    });
    assert.notEqual(fingerprintInnerInstructions(inserted), fingerprintInnerInstructions([flippedSigner]));

    const flippedWritable = sampleIx({
      keys: [
        {
          pubkey: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: "11111111111111111111111111111111",
          isSigner: true,
          isWritable: false,
        },
      ],
    });
    assert.notEqual(fingerprintInnerInstructions(inserted), fingerprintInnerInstructions([flippedWritable]));

    assert.notEqual(
      fingerprintInnerInstructions(inserted),
      fingerprintInnerInstructions([sampleIx({ data: [4, 0, 0, 1] })]),
    );
    assert.notEqual(
      fingerprintInnerInstructions(inserted),
      fingerprintInnerInstructions([sampleIx(), sampleIx()]),
    );
  });
});

describe("Realms v3.1.2 Token-2022 key patches", () => {
  const realms = readSrc("realms.ts");
  const types = readSrc("types.ts");
  const index = readSrc("index.ts");

  it("patches installed 0.3.33 deposit/withdraw/createRealm onto the fork Token-2022 layout", async () => {
    const programId = new PublicKey(REALMS_INSTANCES.kekbull.id);
    const realm = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 10 : 0)));
    const communityMint = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 6 : 0)));
    const councilMint = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 7 : 0)));
    const owner = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 3 : 0)));
    const source = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 11 : 0)));
    const destination = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 12 : 0)));
    const realmAuthority = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 13 : 0)));
    const liquid = new GoverningTokenConfigAccountArgs({
      voterWeightAddin: undefined,
      maxVoterWeightAddin: undefined,
      tokenType: GoverningTokenType.Liquid,
    });

    const depositIxs: TransactionInstruction[] = [];
    await withDepositGoverningTokens(
      depositIxs,
      programId,
      REALMS_PROGRAM_VERSION,
      realm,
      source,
      communityMint,
      owner,
      owner,
      owner,
      new BN(1_000_000),
    );
    assert.equal(depositIxs.length, 1);
    const unpatchedDeposit = depositIxs[0]!;
    const depositRealmConfig = await getRealmConfigAddress(programId, realm);
    assert.equal(unpatchedDeposit.keys.length, 10, "0.3.33 deposit is 0-8 + RealmConfig");
    assert.ok(unpatchedDeposit.keys[8]!.pubkey.equals(TOKEN_PROGRAM_ID), "SDK hardcodes legacy token at 8");
    assert.equal(unpatchedDeposit.keys[8]!.isSigner, false);
    assert.equal(unpatchedDeposit.keys[8]!.isWritable, false);
    assert.ok(unpatchedDeposit.keys[9]!.pubkey.equals(depositRealmConfig));
    const depositClone = new TransactionInstruction({
      programId: unpatchedDeposit.programId,
      keys: unpatchedDeposit.keys.map((key) => ({ ...key })),
      data: Buffer.from(unpatchedDeposit.data),
    });
    applyIchorDepositToken2022Patch(depositClone, communityMint, depositRealmConfig);
    assert.equal(depositClone.keys.length, 11);
    assert.ok(depositClone.keys[8]!.pubkey.equals(TOKEN_2022_PROGRAM_ID));
    assert.equal(depositClone.keys[8]!.isSigner, false);
    assert.equal(depositClone.keys[8]!.isWritable, false);
    assert.ok(depositClone.keys[9]!.pubkey.equals(depositRealmConfig));
    assert.ok(depositClone.keys[10]!.pubkey.equals(communityMint));
    assert.equal(depositClone.keys[10]!.isSigner, false);
    assert.equal(depositClone.keys[10]!.isWritable, false);
    const composed = await composeDepositIchorVotesInstruction({
      realmsProgramId: programId,
      programVersion: REALMS_PROGRAM_VERSION,
      realm,
      tokenSourceAccount: source,
      communityMint,
      tokenOwner: owner,
      sourceAuthority: owner,
      payer: owner,
      amount: new BN(1_000_000),
    });
    assert.equal(composed.instruction.keys.length, 11);
    assert.ok(composed.instruction.keys[8]!.pubkey.equals(TOKEN_2022_PROGRAM_ID));
    assert.ok(composed.instruction.keys[10]!.pubkey.equals(communityMint));
    assert.ok(composed.realmConfig.equals(depositRealmConfig));

    const withdrawIxs: TransactionInstruction[] = [];
    await withWithdrawGoverningTokens(
      withdrawIxs,
      programId,
      REALMS_PROGRAM_VERSION,
      realm,
      destination,
      communityMint,
      owner,
    );
    assert.equal(withdrawIxs.length, 1);
    const unpatchedWithdraw = withdrawIxs[0]!;
    const withdrawRealmConfig = await getRealmConfigAddress(programId, realm);
    assert.equal(unpatchedWithdraw.keys.length, 7, "0.3.33 withdraw is 0-5 + RealmConfig");
    assert.ok(unpatchedWithdraw.keys[5]!.pubkey.equals(TOKEN_PROGRAM_ID), "SDK hardcodes legacy token at 5");
    assert.equal(unpatchedWithdraw.keys[5]!.isSigner, false);
    assert.equal(unpatchedWithdraw.keys[5]!.isWritable, false);
    assert.ok(unpatchedWithdraw.keys[6]!.pubkey.equals(withdrawRealmConfig));

    const createIxs: TransactionInstruction[] = [];
    const realmAddress = await withCreateRealm(
      createIxs,
      programId,
      REALMS_PROGRAM_VERSION,
      "KEKBULL DAO",
      realmAuthority,
      communityMint,
      owner,
      councilMint,
      MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION,
      new BN(1),
      liquid,
      liquid,
    );
    assert.equal(createIxs.length, 1);
    const unpatchedCreate = createIxs[0]!;
    const createRealmConfig = await getRealmConfigAddress(programId, realmAddress);
    assert.equal(unpatchedCreate.keys.length, 11, "0.3.33 createRealm with council is 11 keys");
    assert.ok(unpatchedCreate.keys[6]!.pubkey.equals(TOKEN_PROGRAM_ID), "SDK hardcodes legacy community token at 6");
    assert.equal(unpatchedCreate.keys[6]!.isSigner, false);
    assert.equal(unpatchedCreate.keys[6]!.isWritable, false);
    assert.ok(unpatchedCreate.keys[8]!.pubkey.equals(councilMint));
    assert.ok(unpatchedCreate.keys[10]!.pubkey.equals(createRealmConfig));
  });

  it("verifies 0.3.33 helper layout then patches deposit/withdraw/createRealm", () => {
    assert.match(realms, /function patchDepositGoverningTokenKeys/);
    assert.match(realms, /function patchWithdrawGoverningTokenKeys/);
    assert.match(realms, /function patchCreateRealmKeys/);
    assert.match(realms, /REALMS_SDK_LAYOUT_DRIFT/);
    assert.match(realms, /instruction\.keys\.length !== 10/);
    assert.match(realms, /instruction\.keys\.length !== 7/);
    assert.match(realms, /instruction\.keys\.length !== 11/);
    assert.match(realms, /requireInstructionKey\(instruction\.keys, 8, legacyTokenProgram\(\), "deposit"\)/);
    assert.match(realms, /requireInstructionKey\(instruction\.keys, 5, legacyTokenProgram\(\), "withdraw"\)/);
    assert.match(realms, /requireInstructionKey\(instruction\.keys, 6, legacyTokenProgram\(\), "createRealm"\)/);
    assert.match(realms, /instruction\.keys\[8\] = \{ pubkey: token2022Program\(\)/);
    assert.match(realms, /instruction\.keys\[5\] = \{ pubkey: token2022Program\(\)/);
    assert.match(realms, /instruction\.keys\[6\] = \{ pubkey: token2022Program\(\)/);
    assert.match(realms, /instruction\.keys\.push\(\{ pubkey: communityMint/);
    assert.match(realms, /instruction\.keys\.splice\(10, 0,/);
    assert.match(realms, /legacyTokenProgram\(\)/);
    assert.match(exportedFn(realms, "buildDepositIchorVotes"), /composeDepositIchorVotesInstruction/);
    assert.match(exportedFn(realms, "composeDepositIchorVotesInstruction"), /applyIchorDepositToken2022Patch/);
    assert.match(exportedFn(realms, "buildWithdrawIchorVotes"), /patchWithdrawGoverningTokenKeys/);
    assert.match(exportedFn(realms, "buildCreateRealm"), /patchCreateRealmKeys/);
    const createRealmFn = exportedFn(realms, "buildCreateRealm");
    const createRealmCall = withCreateRealmCall(createRealmFn);
    assert.match(createRealmCall, /withCreateRealm\(/);
    assert.doesNotMatch(createRealmCall, /FULL_SUPPLY/);
    assert.doesNotMatch(createRealmCall, /MintMaxVoteWeightSource\.FULL_SUPPLY_FRACTION/);
    assert.match(createRealmCall, /communityMintMaxVoteWeightSource/);
    assert.match(createRealmFn, /requireReachableMintMaxVoteWeightSource/);
    assert.match(createRealmFn, /assertMainnetVoteWeightSource/);
    assert.match(createRealmFn, /assertMainnetKekbullGovernance/);
    assert.match(createRealmFn, /MintMaxVoteWeightSource\.FULL_SUPPLY_FRACTION\.value/);
    assert.match(createRealmFn, /UNREACHABLE_QUORUM_DENOMINATOR/);
    assert.match(createRealmFn, /linearDepositedTokenConfig\(\)/);
    assert.match(createRealmFn, /isFullSupply\(\)/);
    assert.match(interfaceBody(types, "BuildRealmParams"), /communityMintMaxVoteWeightSource/);
    assert.match(interfaceBody(types, "BuildRealmParams"), /readonly councilMint:/);
    assert.match(interfaceBody(types, "BuildCreateGovernanceParams"), /config: CommunityActivationConfig/);
    assert.match(
      interfaceBody(types, "CommunityMintMaxVoteWeightSource"),
      /"absolute" \| "supply-fraction"|MintMaxVoteWeightSourceKind/,
    );
    assert.match(exportedFn(realms, "buildDepositIchorVotes"), /liveIchorMintFee/);
    assert.match(exportedFn(realms, "communityGoverningTokenHoldingAddress"), /assertVerifiedRealm/);
    assert.match(exportedFn(realms, "communityGoverningTokenHoldingAddress"), /getTokenHoldingAddress/);
    assert.match(exportedFn(realms, "readCommunityGoverningTokenDeposit"), /assertBoundConnection/);
    assert.match(exportedFn(realms, "readCommunityGoverningTokenDeposit"), /getTokenOwnerRecordAddress/);
    assert.match(exportedFn(realms, "readCommunityGoverningTokenDeposit"), /getAccountInfo/);
    assert.match(exportedFn(realms, "readCommunityGoverningTokenDeposit"), /info === null/);
    assert.match(exportedFn(realms, "readCommunityGoverningTokenDeposit"), /getTokenOwnerRecord/);
    assert.match(exportedFn(realms, "readCommunityGoverningTokenDeposit"), /governingTokenDepositAmount/);
    assert.match(exportedFn(realms, "readCommunityGoverningTokenDeposit"), /unrelinquishedVotesCount/);
    assert.match(exportedFn(realms, "readCommunityGoverningTokenDeposit"), /TOKEN_OWNER_RECORD_MINT/);
    assert.match(exportedFn(realms, "listCommunityProposals"), /getProposalsByGovernance/);
    assert.match(exportedFn(realms, "listCommunityProposals"), /assertVerifiedGovernance/);
    assert.match(exportedFn(realms, "listCommunityProposals"), /governingTokenMint\.equals\(communityMint\)/);
    assert.match(exportedFn(realms, "listCommunityProposals"), /approveInstructionsCount/);
    assert.match(index, /listCommunityProposals/);
    assert.match(types, /interface CommunityProposalListItem/);
    assert.match(exportedFn(realms, "readCommunityProposal"), /assertBoundConnection/);
    assert.match(exportedFn(realms, "readCommunityProposal"), /getProposal/);
    assert.match(exportedFn(realms, "readCommunityProposal"), /getAccountInfo/);
    assert.match(exportedFn(realms, "readCommunityProposal"), /PROPOSAL_GOVERNANCE/);
    assert.match(exportedFn(realms, "readCommunityProposal"), /PROPOSAL_MINT/);
    assert.doesNotMatch(exportedFn(realms, "readCommunityProposal"), /getProgramAccounts/);
    assert.match(exportedFn(realms, "buildTreasuryIchorTransfer"), /createTransferCheckedInstruction/);
    assert.match(exportedFn(realms, "buildTreasuryIchorTransfer"), /TREASURY_ICHOR_SHORTFALL/);
    assert.match(exportedFn(realms, "buildTreasuryIchorTransfer"), /liveIchorMintFee/);
    assert.match(exportedFn(realms, "buildTreasuryIchorTransfer"), /createDestinationAta/);
    assert.doesNotMatch(exportedFn(realms, "buildTreasuryIchorTransfer"), /getProgramAccounts/);
    assert.match(exportedFn(realms, "buildTreasurySolTransfer"), /SystemProgram\.transfer/);
    assert.match(exportedFn(realms, "buildTreasurySolTransfer"), /TREASURY_SOL_SHORTFALL/);
    assert.match(exportedFn(realms, "buildTreasurySolTransfer"), /TREASURY_SOL_RENT/);
    assert.match(exportedFn(realms, "buildTreasurySolTransfer"), /getMinimumBalanceForRentExemption/);
    assert.match(exportedFn(realms, "buildTreasurySolTransfer"), /getBalance/);
    assert.match(interfaceBody(types, "CommunityProposalSnapshot"), /descriptionLink/);
    assert.match(interfaceBody(types, "CommunityProposalSnapshot"), /tokenOwnerRecord/);
    assert.match(types, /interface TreasuryIchorTransferBuild extends UnsignedInstructionBuild/);
    assert.match(types, /interface TreasurySolTransferBuild extends UnsignedInstructionBuild/);
    assert.match(types, /TreasuryIchorTransferBuild[\s\S]*?readonly transfer:/);
    assert.match(types, /interface GovernanceTokenTransferPreview/);
    assert.match(index, /readCommunityProposal/);
    assert.match(index, /buildTreasuryIchorTransfer/);
    assert.match(index, /buildTreasurySolTransfer/);
    assert.match(index, /ProposalState/);
    assert.match(exportedFn(realms, "buildWithdrawIchorVotes"), /getTokenOwnerRecord/);
    assert.match(exportedFn(realms, "buildWithdrawIchorVotes"), /governingTokenDepositAmount/);
    assert.match(
      exportedFn(realms, "buildWithdrawIchorVotes"),
      /getAssociatedTokenAddressSync\(\s*communityMint,\s*params\.governingTokenOwner,\s*false,\s*verified\.network\.token2022ProgramId,/,
    );
    assert.match(exportedFn(realms, "buildWithdrawIchorVotes"), /DESTINATION_MISMATCH/);
    assert.doesNotMatch(exportedFn(realms, "buildWithdrawIchorVotes"), /params\.amount/);
    assert.match(
      interfaceBody(types, "WithdrawIchorVotesParams"),
      /readonly governingTokenDestination\?:/,
    );
    assert.match(types, /interface DepositIchorVotesBuild/);
    assert.match(types, /interface WithdrawIchorVotesBuild/);
    assert.match(types, /interface GovernanceTokenTransferPreview/);
    assert.match(types, /expectedMintFee/);
    assert.match(types, /expectedNet/);
    assert.match(interfaceBody(types, "DepositIchorVoteParams"), /readonly connection:/);
    assert.match(interfaceBody(types, "WithdrawIchorVotesParams"), /readonly connection:/);
    assert.match(index, /DepositIchorVotesBuild/);
    assert.match(index, /WithdrawIchorVotesBuild/);
  });
});

describe("claim treasury position NFT ATA derivation", () => {
  const meteora = readSrc("meteora.ts");
  const types = readSrc("types.ts");
  const index = readSrc("index.ts");

  it("derives the canonical treasury ATA and rejects a caller positionNftAccount", () => {
    assert.match(
      meteora,
      /function canonicalAta\(\s*mint:\s*PublicKey,\s*owner:\s*PublicKey,\s*tokenProgram:\s*PublicKey,/,
    );
    assert.match(
      meteora,
      /getAssociatedTokenAddressSync\(\s*mint,\s*owner,\s*true,\s*tokenProgram\s*\)/,
    );
    assert.match(
      exportedFn(meteora, "expectedTreasuryPositionNftAta"),
      /return canonicalAta\(positionNftMint,\s*treasury,\s*tokenProgram\)/,
    );
    assert.match(
      exportedFn(meteora, "buildClaimPositionFeeToTreasury"),
      /expectedTreasuryPositionNftAta\(nft\.mint,\s*treasury,\s*nft\.ownerProgram\)/,
    );
    assert.match(meteora, /"positionNftAccount"/);
    assert.match(index, /expectedTreasuryPositionNftAta/);
    assert.match(index, /ClaimFeesToTreasuryBuild/);
    assert.doesNotMatch(interfaceBody(types, "ClaimFeesToTreasuryParams"), /positionNftAccount/);
    assert.doesNotMatch(exportedFn(meteora, "buildClaimPositionFeeToTreasury"), /params\.positionNftAccount/);
  });
});
