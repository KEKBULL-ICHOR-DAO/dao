/**
 * proposal-action classifier - behavioural coverage for the classifier.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createApproveCheckedInstruction,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { BPF_LOADER_UPGRADEABLE, UPGRADE_PROGRAM_DATA } from "@kekbull/ichor-client";

import {
  classifyProposalInstruction,
  proposalInstructionsReviewedForVote,
  proposalReviewOptions,
  reviewLoaderUpgrades,
  summarizeProposalInstructions,
  summarizeRecoveredProposalTransactions,
} from "../src/proposal-actions.ts";

const ICHOR = new PublicKey("wejFhZN2wvq3XmzH96KdVu3apJCtGDpFHhMqxnTobYV");
const OTHER_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const TREASURY = new PublicKey("92SQkZtxixKaFQfJuAmuek1mzi68tKxrHTJ6j6ZVLmUy");
const RECIPIENT = new PublicKey("CPv7vQ74BVeYJ3N3pBhACxGvLzRC6QFfKEPoMiK31G1L");
const SOURCE = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const DEST = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const PROGRAMDATA = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const BUFFER = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const ATTACKER = new PublicKey("11111111111111111111111111111112");

describe("classifyProposalInstruction - C2 / H5", () => {
  it("labels TransferChecked of ICHOR as pay-ichor and decodes the amount", () => {
    const ix = createTransferCheckedInstruction(
      SOURCE,
      ICHOR,
      DEST,
      TREASURY,
      1_000_000n,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const row = classifyProposalInstruction(ix, ICHOR, { transferFeeBasisPoints: 25 });
    assert.equal(row.kind, "pay-ichor");
    assert.match(row.details.join("\n"), /Gross 1 ICHOR/);
    assert.match(row.details.join("\n"), /0\.25%/);
    assert.doesNotMatch(row.details.join("\n"), /encoded in the instruction/);
  });

  it("REFUSES ApproveChecked as a payment (C2)", () => {
    const ix = createApproveCheckedInstruction(
      SOURCE,
      ICHOR,
      ATTACKER,
      TREASURY,
      BigInt("18446744073709551615"),
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const row = classifyProposalInstruction(ix, ICHOR);
    assert.equal(row.kind, "unknown");
    assert.match(row.headline, /Unrecognized token/);
  });

  it("decodes TransferChecked for a non-ICHOR mint and refuses a Pay ICHOR label", () => {
    const ix = createTransferCheckedInstruction(
      SOURCE,
      OTHER_MINT,
      DEST,
      TREASURY,
      20_000_000_000_000n,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const row = classifyProposalInstruction(ix, ICHOR);
    assert.equal(row.kind, "pay-token");
    assert.match(row.headline, /Transfer 20,000,000 of mint/);
    assert.match(row.headline, new RegExp(DEST.toBase58()));
    const summary = summarizeProposalInstructions([ix], ICHOR);
    assert.equal(summary.kind, "unknown");
    assert.equal(summary.recoveryComplete, true);
    assert.match(summary.headline, /non-ICHOR token/);
    assert.match(summary.details.join("\n"), /Moves 20,000,000 of mint/);
    assert.match(summary.details.join("\n"), /Execute stays closed/);
  });

  it("REFUSES mixed ICHOR + foreign TransferChecked as Pay ICHOR", () => {
    const ichor = createTransferCheckedInstruction(
      SOURCE,
      ICHOR,
      DEST,
      TREASURY,
      1_000_000n,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const foreign = createTransferCheckedInstruction(
      SOURCE,
      OTHER_MINT,
      DEST,
      TREASURY,
      1n,
      0,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const summary = summarizeProposalInstructions([ichor, foreign], ICHOR);
    assert.equal(summary.kind, "unknown");
    assert.match(summary.headline, /non-ICHOR token/);
    assert.match(summary.details.join("\n"), /Pay ICHOR|Gross/);
    assert.match(summary.details.join("\n"), /Execute stays closed/);
  });
});

describe("summarizeProposalInstructions - C3 / C5", () => {
  it("does not hide a second instruction behind the first (C3)", () => {
    const sol = SystemProgram.transfer({
      fromPubkey: TREASURY,
      toPubkey: RECIPIENT,
      lamports: 1_000_000,
    });
    const drain = createTransferCheckedInstruction(
      SOURCE,
      ICHOR,
      DEST,
      TREASURY,
      9_999_999_000_000n,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const summary = summarizeProposalInstructions([sol, drain], ICHOR);
    assert.equal(summary.kind, "unknown");
    assert.match(summary.details.join("\n"), /Pay SOL/);
    assert.match(summary.details.join("\n"), /Pay ICHOR|Gross/);
    assert.match(summary.headline, /Mixed|Unrecognized|Refusing/i);
  });

  it("accepts ATA create + TransferChecked as pay-ichor", () => {
    const ata = createAssociatedTokenAccountIdempotentInstruction(
      TREASURY,
      DEST,
      RECIPIENT,
      ICHOR,
      TOKEN_2022_PROGRAM_ID,
    );
    const pay = createTransferCheckedInstruction(
      SOURCE,
      ICHOR,
      DEST,
      TREASURY,
      500_000n,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const summary = summarizeProposalInstructions([ata, pay], ICHOR, {
      transferFeeBasisPoints: 25,
    });
    assert.equal(summary.kind, "pay-ichor");
    assert.match(summary.details.join("\n"), /Create recipient/);
    assert.match(summary.details.join("\n"), /Gross 0\.5 ICHOR/);
    assert.equal(summary.headline, "Pay ICHOR from the treasury");
  });

  it("rolls N ICHOR payments into a counted headline without closing Execute", () => {
    const payA = createTransferCheckedInstruction(
      SOURCE,
      ICHOR,
      DEST,
      TREASURY,
      500_000n,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const payB = createTransferCheckedInstruction(
      SOURCE,
      ICHOR,
      DEST,
      TREASURY,
      250_000n,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const summary = summarizeProposalInstructions([payA, payB], ICHOR, {
      transferFeeBasisPoints: 25,
    });
    assert.equal(summary.kind, "pay-ichor");
    assert.equal(summary.headline, "Pay ICHOR from the treasury (2 transfers)");
  });

  it("refuses a loader Upgrade without issued ICHOR identity", () => {
    const upgrade = new TransactionInstruction({
      programId: new PublicKey(BPF_LOADER_UPGRADEABLE.id),
      keys: [
        { pubkey: PROGRAMDATA, isSigner: false, isWritable: true },
        { pubkey: ATTACKER, isSigner: false, isWritable: true },
        { pubkey: BUFFER, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: PROGRAMDATA, isSigner: false, isWritable: false },
        { pubkey: PROGRAMDATA, isSigner: false, isWritable: false },
        { pubkey: TREASURY, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(UPGRADE_PROGRAM_DATA),
    });
    const row = classifyProposalInstruction(upgrade, ICHOR);
    assert.equal(row.kind, "unknown");
    assert.match(row.headline, /unread ICHOR identity|Execute stays closed/);
    const summary = summarizeProposalInstructions([upgrade], ICHOR);
    assert.equal(summary.kind, "unknown");
  });

  it("refuses a bound Upgrade whose buffer is not frozen to Governance", () => {
    const program = new PublicKey("DmnfCzQNbx4ZAWEwBoAKqTALgwuUXwYxZL1dRqXoZ1Md");
    const programData = new PublicKey("CkZAQsgJMe9TsMcyVQabts9D3mL8cyaeeLCZgwpCW1UC");
    const upgrade = new TransactionInstruction({
      programId: new PublicKey(BPF_LOADER_UPGRADEABLE.id),
      keys: [
        { pubkey: programData, isSigner: false, isWritable: true },
        { pubkey: program, isSigner: false, isWritable: true },
        { pubkey: BUFFER, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: PROGRAMDATA, isSigner: false, isWritable: false },
        { pubkey: PROGRAMDATA, isSigner: false, isWritable: false },
        { pubkey: RECIPIENT, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(UPGRADE_PROGRAM_DATA),
    });
    const summary = summarizeProposalInstructions([upgrade], ICHOR, {
      upgradeIdentity: {
        program,
        programData,
        governance: RECIPIENT,
        nativeTreasury: TREASURY,
        frozenBuffers: [],
        multipleUpgrades: false,
      },
    });
    assert.equal(summary.kind, "unknown");
    assert.match(summary.details.join("\n"), /not frozen|Buffer authority/);
  });

  it("marks SetAuthority-shaped loader data as unknown (C5)", () => {
    const setAuthority = new TransactionInstruction({
      programId: new PublicKey(BPF_LOADER_UPGRADEABLE.id),
      keys: [
        { pubkey: PROGRAMDATA, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: true, isWritable: false },
        { pubkey: ATTACKER, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([4, 0, 0, 0]),
    });
    const summary = summarizeProposalInstructions([setAuthority], ICHOR);
    assert.equal(summary.kind, "unknown");
    assert.notDeepEqual(Uint8Array.from(UPGRADE_PROGRAM_DATA), Uint8Array.from([4, 0, 0, 0]));
  });
});

describe("summarizeRecoveredProposalTransactions - C4", () => {
  it("refuses a partial recovery", () => {
    const summary = summarizeRecoveredProposalTransactions({
      instructionsCount: 2,
      recoveredIndexes: 1,
      instructions: [],
      ichorMint: ICHOR,
    });
    assert.equal(summary.kind, "unknown");
    assert.equal(summary.recoveryComplete, false);
    assert.equal(proposalInstructionsReviewedForVote(summary), false);
    assert.match(summary.headline, /Incomplete recovery/);
  });

  it("refuses multi-index proposals for this page's Execute", () => {
    const pay = createTransferCheckedInstruction(
      SOURCE,
      ICHOR,
      DEST,
      TREASURY,
      1n,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const summary = summarizeRecoveredProposalTransactions({
      instructionsCount: 2,
      recoveredIndexes: 2,
      instructions: [pay],
      ichorMint: ICHOR,
    });
    assert.equal(summary.kind, "unknown");
    assert.match(summary.headline, /Multiple ProposalTransaction/);
  });

  it("passes through a single classified index", () => {
    const pay = createTransferCheckedInstruction(
      SOURCE,
      ICHOR,
      DEST,
      TREASURY,
      2_000_000n,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const summary = summarizeRecoveredProposalTransactions({
      instructionsCount: 1,
      recoveredIndexes: 1,
      instructions: [pay],
      ichorMint: ICHOR,
    });
    assert.equal(summary.kind, "pay-ichor");
  });
});

const HEADER = 37;
const LOADER = new PublicKey(BPF_LOADER_UPGRADEABLE.id);
const GOVERNANCE = RECIPIENT;
const PROGRAM = new PublicKey("DmnfCzQNbx4ZAWEwBoAKqTALgwuUXwYxZL1dRqXoZ1Md");
const ISSUED_PROGRAMDATA = new PublicKey("CkZAQsgJMe9TsMcyVQabts9D3mL8cyaeeLCZgwpCW1UC");
const BUF_A = BUFFER;
const BUF_B = new PublicKey("SysvarC1ock11111111111111111111111111111111");

function bufferData(authority: PublicKey): Uint8Array {
  const data = new Uint8Array(HEADER + 64);
  new DataView(data.buffer).setUint32(0, 1, true);
  data[4] = 1;
  data.set(authority.toBytes(), 5);
  return data;
}

function loaderUpgrade(buffer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(BPF_LOADER_UPGRADEABLE.id),
    keys: [
      { pubkey: ISSUED_PROGRAMDATA, isSigner: false, isWritable: true },
      { pubkey: PROGRAM, isSigner: false, isWritable: true },
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: PROGRAMDATA, isSigner: false, isWritable: false },
      { pubkey: PROGRAMDATA, isSigner: false, isWritable: false },
      { pubkey: GOVERNANCE, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(UPGRADE_PROGRAM_DATA),
  });
}

function stubConnection(
  accounts: Map<string, { owner: PublicKey; data: Uint8Array } | Error>,
): { reads: string[]; connection: { getAccountInfo: (pk: PublicKey) => Promise<unknown> } } {
  const reads: string[] = [];
  return {
    reads,
    connection: {
      getAccountInfo: async (pk: PublicKey) => {
        reads.push(pk.toBase58());
        const hit = accounts.get(pk.toBase58());
        if (hit instanceof Error) {
          throw hit;
        }
        return hit ?? null;
      },
    },
  };
}

describe("reviewLoaderUpgrades / proposalReviewOptions - V-1", () => {
  it("reads every Upgrade buffer and refuses when one is not frozen (V-1)", async () => {
    const stub = stubConnection(
      new Map([
        [BUF_A.toBase58(), { owner: LOADER, data: bufferData(GOVERNANCE) }],
        [BUF_B.toBase58(), { owner: LOADER, data: bufferData(ATTACKER) }],
      ]),
    );
    const instructions = [loaderUpgrade(BUF_A), loaderUpgrade(BUF_B)];
    const identity = await reviewLoaderUpgrades({
      connection: stub.connection as never,
      instructions,
      program: PROGRAM,
      programData: ISSUED_PROGRAMDATA,
      governance: GOVERNANCE,
      nativeTreasury: TREASURY,
    });
    assert.deepEqual(stub.reads, [BUF_A.toBase58(), BUF_B.toBase58()]);
    assert.equal(identity.multipleUpgrades, true);
    assert.deepEqual(identity.frozenBuffers, [BUF_A.toBase58()]);
    const rows = instructions.map((ix) =>
      classifyProposalInstruction(ix, ICHOR, { upgradeIdentity: identity }),
    );
    assert.equal(rows[0]?.kind, "unknown");
    assert.equal(rows[1]?.kind, "unknown");
    assert.match(rows[0]?.headline ?? "", /More than one loader Upgrade/);
    assert.match(rows[1]?.headline ?? "", /More than one loader Upgrade/);
    const summary = summarizeProposalInstructions(instructions, ICHOR, { upgradeIdentity: identity });
    assert.equal(summary.kind, "unknown");
    assert.match(summary.details.join("\n"), /More than one loader Upgrade/);
    assert.doesNotMatch(summary.details.join("\n"), /Buffer authority is already the Governance PDA/);
  });

  it("returns no upgradeIdentity and zero reads when proofs are missing", async () => {
    const stub = stubConnection(new Map());
    const noneProgram = await proposalReviewOptions({
      connection: stub.connection as never,
      instructions: [loaderUpgrade(BUF_A)],
      verifiedProgram: null,
      verifiedGovernance: GOVERNANCE as never,
    });
    assert.equal(noneProgram.upgradeIdentity, undefined);
    assert.deepEqual(stub.reads, []);
    const noneGov = await proposalReviewOptions({
      connection: stub.connection as never,
      instructions: [loaderUpgrade(BUF_A)],
      verifiedProgram: { programId: PROGRAM } as never,
      verifiedGovernance: null,
    });
    assert.equal(noneGov.upgradeIdentity, undefined);
    assert.deepEqual(stub.reads, []);
  });

  it("a single unfrozen buffer stays unknown", async () => {
    const stub = stubConnection(
      new Map([[BUF_A.toBase58(), { owner: LOADER, data: bufferData(ATTACKER) }]]),
    );
    const identity = await reviewLoaderUpgrades({
      connection: stub.connection as never,
      instructions: [loaderUpgrade(BUF_A)],
      program: PROGRAM,
      programData: ISSUED_PROGRAMDATA,
      governance: GOVERNANCE,
      nativeTreasury: TREASURY,
    });
    assert.deepEqual(stub.reads, [BUF_A.toBase58()]);
    assert.equal(identity.multipleUpgrades, false);
    assert.deepEqual(identity.frozenBuffers, []);
    const summary = summarizeProposalInstructions([loaderUpgrade(BUF_A)], ICHOR, {
      upgradeIdentity: identity,
    });
    assert.equal(summary.kind, "unknown");
    assert.match(summary.details.join("\n"), /not frozen|Buffer authority/);
  });

  it("propagates getAccountInfo rejection", async () => {
    const stub = stubConnection(new Map([[BUF_A.toBase58(), new Error("rpc down")]]));
    await assert.rejects(
      () =>
        reviewLoaderUpgrades({
          connection: stub.connection as never,
          instructions: [loaderUpgrade(BUF_A)],
          program: PROGRAM,
          programData: ISSUED_PROGRAMDATA,
          governance: GOVERNANCE,
          nativeTreasury: TREASURY,
        }),
      /rpc down/,
    );
    assert.deepEqual(stub.reads, [BUF_A.toBase58()]);
  });
});

describe("classifyProposalInstruction - V-2 / H-4 shapes", () => {
  it("REFUSES a Tokenkeg TransferChecked that names the Token-2022 ICHOR mint (V-2)", () => {
    const ix = createTransferCheckedInstruction(
      SOURCE,
      ICHOR,
      DEST,
      TREASURY,
      9_000_000n,
      6,
      [],
      TOKEN_PROGRAM_ID,
    );
    const row = classifyProposalInstruction(ix, ICHOR);
    assert.equal(row.kind, "unknown");
    assert.match(row.headline, /does not own this ICHOR mint/);
    const summary = summarizeProposalInstructions([ix], ICHOR);
    assert.equal(summary.kind, "unknown");
    assert.doesNotMatch(summary.headline, /Pay ICHOR/);
  });

  it("REFUSES foreign-first mixed TransferChecked as Pay ICHOR (H-4)", () => {
    const ichor = createTransferCheckedInstruction(
      SOURCE,
      ICHOR,
      DEST,
      TREASURY,
      1_000_000n,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const foreign = createTransferCheckedInstruction(
      SOURCE,
      OTHER_MINT,
      DEST,
      TREASURY,
      1n,
      0,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const summary = summarizeProposalInstructions([foreign, ichor], ICHOR);
    assert.equal(summary.kind, "unknown");
    assert.match(summary.headline, /non-ICHOR token/);
  });

  it("REFUSES ata-create + foreign + ICHOR as Pay ICHOR (H-4)", () => {
    const ata = createAssociatedTokenAccountIdempotentInstruction(
      TREASURY,
      DEST,
      RECIPIENT,
      ICHOR,
      TOKEN_2022_PROGRAM_ID,
    );
    const foreign = createTransferCheckedInstruction(
      SOURCE,
      OTHER_MINT,
      DEST,
      TREASURY,
      1n,
      0,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const ichor = createTransferCheckedInstruction(
      SOURCE,
      ICHOR,
      DEST,
      TREASURY,
      1_000_000n,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const summary = summarizeProposalInstructions([ata, foreign, ichor], ICHOR);
    assert.equal(summary.kind, "unknown");
    assert.match(summary.headline, /non-ICHOR token/);
  });
});
