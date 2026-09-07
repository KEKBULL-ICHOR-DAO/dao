import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { composeSetPausedInstruction } from "../src/admin.ts";
import { composeConvertInstruction, encodeConvertInstructionData } from "../src/burn.ts";
import {
  ATA_CREATE_IDEMPOTENT_KEY_COUNT,
  COMPUTE_MARGIN_PERCENT,
  COMPUTE_MIN_UNITS,
  DEFENSIVE_STAKE_REALMS_PROGRAM,
  DEPOSIT_GOVERNING_TOKENS_AMOUNT_IS_GROSS,
  DEPOSIT_GOVERNING_TOKENS_DATA_LEN,
  cloneTransactionInstruction,
  encodeDepositGoverningTokensData,
  MAINNET_CREATOR_WALLET,
  OFFLINE_PACKET_BLOCKHASH,
  SOLANA_MAX_TX_COMPUTE_UNITS,
  SOLANA_PACKET_DATA_SIZE,
  assembleValidatedDefensiveStakeMessage,
  assertDefensiveStakeIdentities,
  assertNoExtraSignerMaterial,
  assertOfficialIchorCluster,
  deriveMeasuredComputePlan,
  enumerateRequiredSigners,
  limitFromMeasured,
  measureOfflineLegacyPacket,
  parseExplicitTokenAmount,
  validateDefensiveStakeGroups,
  type DefensiveStakeGroupIdentities,
} from "../src/defensive-stake.ts";
import { calculateToken2022TransferFee, getCurrentMintFee } from "../src/extensions.ts";
import { CLUSTER_GENESIS_HASH, REALMS_INSTANCES } from "../src/network.ts";
import {
  assertRealmConfigFieldsPreserved,
  composeDepositIchorVotesInstruction,
  composeSetRealmConfigVoteWeightOnly,
  emergencyBrakeVoteWeightSource,
} from "../src/realms.ts";
import { ClientValidationError } from "../src/types.ts";
import { U64_MAX } from "../src/validation.ts";
import { assertMainnetVoteWeightSource, mainnetSupplyFractionValue } from "../src/mainnet-governance.ts";
import { MintMaxVoteWeightSource } from "@realms-today/spl-governance";
import { GoverningTokenConfigAccountArgs, GoverningTokenType } from "@realms-today/spl-governance";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");
const repoRoot = join(srcDir, "../../..");

/** Deterministic non-default pubkeys so offline packetBytes are stable. */
function pk(n: number): PublicKey {
  if (!Number.isInteger(n) || n < 1 || n > 255) {
    throw new Error("fixture pubkey index must be 1..255");
  }
  const bytes = new Uint8Array(32);
  bytes[31] = n;
  return new PublicKey(bytes);
}

async function fixtureIdentities(): Promise<DefensiveStakeGroupIdentities> {
  const creator = new PublicKey(MAINNET_CREATOR_WALLET);
  const kekbullMint = pk(5);
  const ichorMint = pk(6);
  const realmsProgramId = new PublicKey(DEFENSIVE_STAKE_REALMS_PROGRAM);
  const realm = pk(10);
  const amount = "1000000";
  const composed = await composeDepositIchorVotesInstruction({
    realmsProgramId,
    programVersion: 3,
    realm,
    tokenSourceAccount: getAssociatedTokenAddressSync(ichorMint, creator, true, TOKEN_2022_PROGRAM_ID),
    communityMint: ichorMint,
    tokenOwner: creator,
    sourceAuthority: creator,
    payer: creator,
    amount: new BN(amount),
  });
  return {
    creator,
    ichorProgramId: pk(2),
    realmsProgramId,
    config: pk(4),
    kekbullMint,
    ichorMint,
    kekbullFrom: getAssociatedTokenAddressSync(kekbullMint, creator, false, TOKEN_2022_PROGRAM_ID),
    ichorTo: getAssociatedTokenAddressSync(ichorMint, creator, true, TOKEN_2022_PROGRAM_ID),
    bondingCurve: pk(9),
    kekbullTokenProgram: TOKEN_2022_PROGRAM_ID,
    ichorTokenProgram: TOKEN_2022_PROGRAM_ID,
    realm,
    governingTokenHolding: composed.instruction.keys[1]!.pubkey,
    tokenOwnerRecord: composed.tokenOwnerRecord,
    realmConfig: composed.realmConfig,
    kekbullAmount: amount,
    expectedIchorGross: amount,
  };
}

async function fixtureGroups(identities?: DefensiveStakeGroupIdentities) {
  const resolved = identities ?? (await fixtureIdentities());
  const kekbullAmount = new BN(resolved.kekbullAmount);
  const minIchorAmount = new BN(resolved.expectedIchorGross);
  const deposit = await composeDepositIchorVotesInstruction({
    realmsProgramId: resolved.realmsProgramId,
    programVersion: 3,
    realm: resolved.realm,
    tokenSourceAccount: resolved.ichorTo,
    communityMint: resolved.ichorMint,
    tokenOwner: resolved.creator,
    sourceAuthority: resolved.creator,
    payer: resolved.creator,
    amount: minIchorAmount,
  });
  return {
    identities: resolved,
    unpause: composeSetPausedInstruction({
      programId: resolved.ichorProgramId,
      authority: resolved.creator,
      config: resolved.config,
      paused: false,
    }),
    convert: [
      composeConvertInstruction({
        programId: resolved.ichorProgramId,
        burner: resolved.creator,
        config: resolved.config,
        kekbullMint: resolved.kekbullMint,
        ichorMint: resolved.ichorMint,
        kekbullFrom: resolved.kekbullFrom,
        ichorTo: resolved.ichorTo,
        bondingCurve: resolved.bondingCurve,
        kekbullTokenProgram: resolved.kekbullTokenProgram,
        ichorTokenProgram: resolved.ichorTokenProgram,
        kekbullAmount,
        minIchorAmount,
      }),
    ],
    deposit: [deposit.instruction],
    repause: composeSetPausedInstruction({
      programId: resolved.ichorProgramId,
      authority: resolved.creator,
      config: resolved.config,
      paused: true,
    }),
  };
}

function withKey(
  ix: TransactionInstruction,
  index: number,
  pubkey: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ix.programId,
    keys: ix.keys.map((key, i) => (i === index ? { ...key, pubkey } : key)),
    data: ix.data,
  });
}

function withData(ix: TransactionInstruction, data: Uint8Array): TransactionInstruction {
  return new TransactionInstruction({
    programId: ix.programId,
    keys: ix.keys,
    data: Buffer.from(data),
  });
}

/** Offline legacy packet of the Token-2022 / kekbull_governance fixture. MEASURED_OFFLINE. */
const EXPECTED_FIXTURE_PACKET_BYTES = 669;

describe("explicit amount has no default", () => {
  it("refuses missing, empty, both-kinds, and scientific notation", () => {
    assert.throws(
      () => parseExplicitTokenAmount(undefined, 6, "amount"),
      (err: unknown) => err instanceof ClientValidationError && err.code === "AMOUNT_REQUIRED",
    );
    assert.throws(
      () => parseExplicitTokenAmount({ kind: "human", value: "" }, 6, "amount"),
      (err: unknown) => err instanceof ClientValidationError && err.code === "AMOUNT_REQUIRED",
    );
    assert.throws(
      () => parseExplicitTokenAmount({ kind: "raw", value: new BN(1), human: "1" }, 6, "amount"),
      (err: unknown) => err instanceof ClientValidationError && err.code === "AMOUNT_EXCLUSIVE",
    );
    assert.throws(
      () => parseExplicitTokenAmount({ kind: "human", value: "1e6" }, 6, "amount"),
      (err: unknown) => err instanceof ClientValidationError && err.code === "AMOUNT_REQUIRED",
    );
  });

  it("scales human amounts from live decimals, never a hardcoded 6", () => {
    assert.equal(parseExplicitTokenAmount({ kind: "human", value: "1.5" }, 6, "amount").toString(), "1500000");
    assert.equal(parseExplicitTokenAmount({ kind: "human", value: "1.5" }, 9, "amount").toString(), "1500000000");
    assert.equal(parseExplicitTokenAmount({ kind: "raw", value: new BN(7) }, 99, "amount").toString(), "7");
    assert.throws(
      () => parseExplicitTokenAmount({ kind: "human", value: "1.25" }, 1, "amount"),
      (err: unknown) => err instanceof ClientValidationError && err.code === "AMOUNT_SCALE",
    );
  });
});

describe("identity refusals", () => {
  it("refuses wrong authority, realm, mint, program, unpaused state, and non-creator burner", () => {
    const creator = new PublicKey(MAINNET_CREATOR_WALLET);
    const other = PublicKey.unique();
    const realm = PublicKey.unique();
    const governance = PublicKey.unique();
    const mint = PublicKey.unique();
    const program = new PublicKey(DEFENSIVE_STAKE_REALMS_PROGRAM);
    const base = {
      creator,
      configAuthority: creator,
      configRealm: realm,
      configGovernance: governance,
      configRealmsProgram: program,
      configIchorMint: mint,
      configPaused: true,
      realm,
      governance,
      communityMint: mint,
      realmsProgramId: program,
      cluster: "mainnet-beta",
    };
    assert.doesNotThrow(() => assertDefensiveStakeIdentities(base));
    assert.throws(
      () => assertDefensiveStakeIdentities({ ...base, configAuthority: other }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "DEFENSIVE_STAKE_IDENTITY",
    );
    assert.throws(
      () => assertDefensiveStakeIdentities({ ...base, configRealm: other }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "DEFENSIVE_STAKE_IDENTITY",
    );
    assert.throws(
      () => assertDefensiveStakeIdentities({ ...base, communityMint: other }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "DEFENSIVE_STAKE_IDENTITY",
    );
    assert.throws(
      () => assertDefensiveStakeIdentities({ ...base, configRealmsProgram: other }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "DEFENSIVE_STAKE_IDENTITY",
    );
    assert.throws(
      () =>
        assertDefensiveStakeIdentities({
          ...base,
          realmsProgramId: new PublicKey(REALMS_INSTANCES["default-shared"].id),
          configRealmsProgram: new PublicKey(REALMS_INSTANCES["default-shared"].id),
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "DEFENSIVE_STAKE_IDENTITY" &&
        err.details.some((d) => d.includes("kekbull_governance")),
    );
    assert.throws(
      () => assertDefensiveStakeIdentities({ ...base, configPaused: false }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "DEFENSIVE_STAKE_IDENTITY" &&
        err.details.some((d) => d.includes("unpaused")),
    );
    assert.throws(
      () => assertDefensiveStakeIdentities({ ...base, creator: other, configAuthority: other }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "DEFENSIVE_STAKE_IDENTITY" &&
        err.details.some((d) => d.includes(MAINNET_CREATOR_WALLET)),
    );
  });

  it("accepts official genesis only", () => {
    assert.doesNotThrow(() =>
      assertOfficialIchorCluster({
        cluster: "mainnet-beta",
        genesisHash: CLUSTER_GENESIS_HASH["mainnet-beta"],
      }),
    );
    assert.doesNotThrow(() =>
      assertOfficialIchorCluster({
        cluster: "devnet",
        genesisHash: CLUSTER_GENESIS_HASH.devnet,
      }),
    );
    assert.throws(
      () => assertOfficialIchorCluster({ cluster: "localnet", genesisHash: "not-official" }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "CLUSTER_REFUSED",
    );
  });

  it("refuses extra signer/keypair fields", () => {
    assert.throws(
      () => assertNoExtraSignerMaterial({ keypairPath: "/tmp/x.json" }, "test"),
      (err: unknown) => err instanceof ClientValidationError && err.code === "EXTRA_SIGNER_REFUSED",
    );
  });
});

describe("compute.rs parity and refuse-don't-clamp", () => {
  it("mirrors MAX / MARGIN / MIN so source drift fails", () => {
    const rust = readFileSync(join(repoRoot, "src/launch/compute.rs"), "utf8");
    assert.match(rust, /pub const MAX_TX_COMPUTE_UNITS: u32 = 1_400_000;/);
    assert.match(rust, /pub const MARGIN_PERCENT: u32 = 25;/);
    assert.match(rust, /pub const MIN_COMPUTE_UNITS: u32 = 120_000;/);
    assert.equal(SOLANA_MAX_TX_COMPUTE_UNITS, 1_400_000);
    assert.equal(COMPUTE_MARGIN_PERCENT, 25);
    assert.equal(COMPUTE_MIN_UNITS, 120_000);
    const ts = readFileSync(join(srcDir, "defensive-stake.ts"), "utf8");
    assert.match(ts, /export const SOLANA_MAX_TX_COMPUTE_UNITS = 1_400_000;/);
    assert.match(ts, /export const COMPUTE_MARGIN_PERCENT = 25;/);
    assert.match(ts, /export const COMPUTE_MIN_UNITS = 120_000;/);
  });

  it("matches rust fixtures under the cap and floors at 120_000", () => {
    assert.equal(limitFromMeasured(200_000), 250_000);
    assert.equal(limitFromMeasured(217_040), 271_300);
    assert.equal(limitFromMeasured(1_000), COMPUTE_MIN_UNITS);
    assert.equal(limitFromMeasured(0), COMPUTE_MIN_UNITS);
    const plan = deriveMeasuredComputePlan(400_000);
    assert.equal(plan.kind, "measured");
    if (plan.kind !== "measured") {
      throw new Error("expected measured");
    }
    assert.equal(plan.unitsConsumed, 400_000);
    assert.equal(plan.computeUnitLimit, 500_000);
    assert.notEqual(plan.computeUnitLimit, plan.unitsConsumed);
  });

  it("refuses a 25% result above protocol max instead of clamping", () => {
    assert.throws(
      () => limitFromMeasured(1_300_000),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "COMPUTE_EXCEEDS_PROTOCOL_MAX",
    );
    assert.throws(
      () => deriveMeasuredComputePlan(1_300_000),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "COMPUTE_EXCEEDS_PROTOCOL_MAX",
    );
    assert.equal(limitFromMeasured(1_120_000), SOLANA_MAX_TX_COMPUTE_UNITS);
    assert.throws(
      () => deriveMeasuredComputePlan(SOLANA_MAX_TX_COMPUTE_UNITS + 1),
      (err: unknown) => err instanceof ClientValidationError && err.code === "COMPUTE_UNVERIFIED",
    );
  });
});

describe("validated groups, offline packet, and CU-prefix recheck", () => {
  it("assembles builder encodings with MEASURED_OFFLINE packet and creator sole signer", async () => {
    const g = await fixtureGroups();
    const groups = validateDefensiveStakeGroups(g);
    const assembled = assembleValidatedDefensiveStakeMessage({
      groups,
      computePlan: { kind: "none" },
    });
    assert.equal(assembled.instructions.length, 4);
    assert.equal(assembled.requiredSignerPubkeys.length, 1);
    assert.ok(assembled.requiredSignerPubkeys[0]!.equals(g.identities.creator));
    assert.equal(assembled.packet.status, "MEASURED_OFFLINE");
    assert.equal(assembled.packet.dummySignatureSlots, 1);
    assert.equal(assembled.packet.blockhash, OFFLINE_PACKET_BLOCKHASH);
    console.log(`MEASURED_OFFLINE fixture packetBytes=${String(assembled.packet.packetBytes)}`);
    assert.equal(
      assembled.packet.packetBytes,
      EXPECTED_FIXTURE_PACKET_BYTES,
      `fixture packetBytes must stay ${String(EXPECTED_FIXTURE_PACKET_BYTES)}; got ${String(assembled.packet.packetBytes)}`,
    );
    assert.ok(assembled.packet.packetBytes <= SOLANA_PACKET_DATA_SIZE);
    assert.equal(assembled.computeUnits.status, "UNVERIFIED");
    assert.match(assembled.computeUnits.status === "UNVERIFIED" ? assembled.computeUnits.reason : "", /CU is UNVERIFIED/);
    assert.match(
      assembled.computeUnits.status === "UNVERIFIED" ? assembled.computeUnits.reason : "",
      /MEASURED_OFFLINE/,
    );
    assert.deepEqual(
      Uint8Array.from(g.deposit[0]!.data),
      encodeDepositGoverningTokensData(new BN(g.identities.expectedIchorGross)),
    );
    assert.equal(g.deposit[0]!.data.length, DEPOSIT_GOVERNING_TOKENS_DATA_LEN);
    const ata = createAssociatedTokenAccountIdempotentInstruction(
      g.identities.creator,
      g.identities.ichorTo,
      g.identities.creator,
      g.identities.ichorMint,
      g.identities.ichorTokenProgram,
    );
    assert.equal(ata.keys.length, ATA_CREATE_IDEMPOTENT_KEY_COUNT);
    assert.deepEqual(Uint8Array.from(ata.data), new Uint8Array([1]));
    const withAta = validateDefensiveStakeGroups({
      ...g,
      convert: [ata, g.convert[0]!],
    });
    const ataAssembled = assembleValidatedDefensiveStakeMessage({
      groups: withAta,
      computePlan: { kind: "none" },
    });
    assert.equal(ataAssembled.packet.status, "MEASURED_OFFLINE");
    assert.ok(ataAssembled.packet.packetBytes > assembled.packet.packetBytes);
  });

  it("clones so builder-output and returned-copy mutation cannot touch branded source or another copy", async () => {
    const g = await fixtureGroups();
    const originalUnpauseData = Uint8Array.from(g.unpause.data);
    const groups = validateDefensiveStakeGroups(g);
    const first = assembleValidatedDefensiveStakeMessage({
      groups,
      computePlan: { kind: "none" },
    });
    const second = assembleValidatedDefensiveStakeMessage({
      groups,
      computePlan: { kind: "none" },
    });
    g.unpause.data[0] = (g.unpause.data[0] ?? 0) ^ 0xff;
    g.unpause.keys[0] = { pubkey: pk(20), isSigner: true, isWritable: false };
    g.convert[0]!.keys[2] = { pubkey: pk(21), isSigner: false, isWritable: true };
    first.instructions[0]!.keys[0] = { pubkey: pk(22), isSigner: true, isWritable: false };
    first.instructions[0]!.data[0] = (first.instructions[0]!.data[0] ?? 0) ^ 0xaa;
    assert.deepEqual(Uint8Array.from(groups.unpause.data), originalUnpauseData);
    assert.ok(groups.unpause.keys[0]!.pubkey.equals(g.identities.creator));
    assert.ok(groups.convert[0]!.keys[2]!.pubkey.equals(g.identities.kekbullMint));
    assert.ok(second.instructions[0]!.keys[0]!.pubkey.equals(g.identities.creator));
    assert.notEqual(second.instructions[0]!.data[0], first.instructions[0]!.data[0]);
    const remounted = assembleValidatedDefensiveStakeMessage({
      groups,
      computePlan: { kind: "none" },
    });
    assert.ok(remounted.instructions[0]!.keys[0]!.pubkey.equals(g.identities.creator));
    assert.deepEqual(Uint8Array.from(remounted.instructions[0]!.data), originalUnpauseData);
    const cloned = cloneTransactionInstruction(g.repause);
    assert.ok(Buffer.isBuffer(cloned.data));
    assert.deepEqual(Uint8Array.from(cloned.data), Uint8Array.from(g.repause.data));
    g.repause.data[0] = (g.repause.data[0] ?? 0) ^ 0xff;
    assert.notEqual(cloned.data[0], g.repause.data[0]);
    g.repause.keys[1] = { pubkey: pk(23), isSigner: false, isWritable: true };
    assert.ok(cloned.keys[1]!.pubkey.equals(g.identities.config));
  });

  it("refuses a fabricated lookalike and post-issue mutation", async () => {
    const g = await fixtureGroups();
    const lookalike = {
      unpause: g.unpause,
      convert: g.convert,
      deposit: g.deposit,
      repause: g.repause,
      identities: g.identities,
    };
    assert.throws(
      () =>
        assembleValidatedDefensiveStakeMessage({
          groups: lookalike as never,
          computePlan: { kind: "none" },
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
    );
    const issued = validateDefensiveStakeGroups(g);
    issued.unpause.keys[0] = {
      pubkey: pk(11),
      isSigner: true,
      isWritable: false,
    };
    assert.throws(
      () =>
        assembleValidatedDefensiveStakeMessage({
          groups: issued,
          computePlan: { kind: "none" },
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
    );
  });

  it("refuses a System transfer, extra ICHOR ix, and a second deposit", async () => {
    const g = await fixtureGroups();
    const transfer = SystemProgram.transfer({
      fromPubkey: g.identities.creator,
      toPubkey: pk(12),
      lamports: 1,
    });
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          convert: [transfer, g.convert[0]!],
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "STAKE_GROUP" &&
        err.details.some((d) => d.includes("createIdempotent") || d.includes("ATA")),
    );
    const extraIchor = composeSetPausedInstruction({
      programId: g.identities.ichorProgramId,
      authority: g.identities.creator,
      config: g.identities.config,
      paused: false,
    });
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          convert: [g.convert[0]!, extraIchor],
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
    );
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          deposit: [g.deposit[0]!, g.deposit[0]!],
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "STAKE_GROUP" &&
        err.details.some((d) => d.includes("exactly one")),
    );
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          deposit: [transfer],
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "STAKE_GROUP" &&
        err.details.some((d) => d.includes("System Program")),
    );
  });

  it("refuses a missing re-pause and swapped pause polarity", async () => {
    const g = await fixtureGroups();
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          repause: g.unpause,
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
    );
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          unpause: g.repause,
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
    );
  });

  it("refuses altered convert/deposit amounts, substituted deposit accounts, and trailing data", async () => {
    const g = await fixtureGroups();
    const other = pk(14);
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          convert: [
            withData(
              g.convert[0]!,
              encodeConvertInstructionData(new BN(2_000_000), new BN(g.identities.expectedIchorGross)),
            ),
          ],
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "STAKE_GROUP" &&
        err.details.some((d) => d.includes("kekbullAmount")),
    );
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          deposit: [withData(g.deposit[0]!, encodeDepositGoverningTokensData(new BN(2_000_000)))],
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "STAKE_GROUP" &&
        err.details.some((d) => d.includes("9-byte")),
    );
    const trailingDeposit = new Uint8Array(DEPOSIT_GOVERNING_TOKENS_DATA_LEN + 1);
    trailingDeposit.set(Uint8Array.from(g.deposit[0]!.data));
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          deposit: [withData(g.deposit[0]!, trailingDeposit)],
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
    );
    for (const index of [0, 1, 2, 5, 9, 10] as const) {
      assert.throws(
        () =>
          validateDefensiveStakeGroups({
            ...g,
            deposit: [withKey(g.deposit[0]!, index, other)],
          }),
        (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
        `deposit key ${String(index)} substitution must refuse`,
      );
    }
    const unpatched = new TransactionInstruction({
      programId: g.deposit[0]!.programId,
      keys: g.deposit[0]!.keys.slice(0, 10),
      data: g.deposit[0]!.data,
    });
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          deposit: [unpatched],
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "STAKE_GROUP" &&
        err.details.some((d) => d.includes("exactly 11")),
    );
    const ata = createAssociatedTokenAccountIdempotentInstruction(
      g.identities.creator,
      g.identities.ichorTo,
      g.identities.creator,
      g.identities.ichorMint,
      g.identities.ichorTokenProgram,
    );
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          convert: [withKey(ata, 1, other), g.convert[0]!],
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
    );
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          convert: [withKey(ata, 2, other), g.convert[0]!],
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
    );
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          convert: [withKey(ata, 3, other), g.convert[0]!],
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
    );
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          convert: [withKey(ata, 5, TOKEN_PROGRAM_ID), g.convert[0]!],
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
    );
    const trailingAta = new Uint8Array([1, 0]);
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          convert: [withData(ata, trailingAta), g.convert[0]!],
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
    );
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          identities: {
            ...g.identities,
            kekbullTokenProgram: TOKEN_PROGRAM_ID,
            kekbullFrom: getAssociatedTokenAddressSync(
              g.identities.kekbullMint,
              g.identities.creator,
              false,
              TOKEN_PROGRAM_ID,
            ),
          },
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "STAKE_GROUP" &&
        err.details.some((d) => d.includes("KEKBULL token program")),
    );
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          identities: { ...g.identities, governingTokenHolding: pk(24) },
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "STAKE_GROUP" &&
        err.details.some((d) => d.includes("governingTokenHolding")),
    );
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          identities: {
            ...g.identities,
            realmsProgramId: new PublicKey(REALMS_INSTANCES["default-shared"].id),
          },
        }),
      (err: unknown) =>
        err instanceof ClientValidationError && err.code === "KEKBULL_GOVERNANCE_REQUIRED",
    );
  });

  it("refuses extra signers at validation", async () => {
    const g = await fixtureGroups();
    const stranger = pk(13);
    const hijacked = new TransactionInstruction({
      programId: g.identities.realmsProgramId,
      keys: g.deposit[0]!.keys.map((key, i) =>
        i === 3 ? { ...key, pubkey: stranger } : key,
      ),
      data: g.deposit[0]!.data,
    });
    assert.throws(
      () =>
        validateDefensiveStakeGroups({
          ...g,
          deposit: [hijacked],
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "STAKE_GROUP",
    );
  });

  it("refuses >1232 offline and a default blockhash", () => {
    const creator = pk(1);
    const huge = new TransactionInstruction({
      programId: pk(3),
      keys: [{ pubkey: creator, isSigner: true, isWritable: false }],
      data: Buffer.alloc(1300, 7),
    });
    assert.throws(
      () =>
        measureOfflineLegacyPacket({
          feePayer: creator,
          instructions: [huge],
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "PACKET_TOO_LARGE",
    );
    assert.throws(
      () =>
        measureOfflineLegacyPacket({
          feePayer: creator,
          instructions: [
            composeSetPausedInstruction({
              programId: pk(2),
              authority: creator,
              config: pk(4),
              paused: false,
            }),
          ],
          blockhash: PublicKey.default.toBase58(),
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "PACKET_BLOCKHASH",
    );
    const stranger = pk(15);
    assert.throws(
      () =>
        measureOfflineLegacyPacket({
          feePayer: creator,
          instructions: [
            composeSetPausedInstruction({
              programId: pk(2),
              authority: creator,
              config: pk(4),
              paused: false,
            }),
            SystemProgram.transfer({ fromPubkey: stranger, toPubkey: creator, lamports: 1 }),
          ],
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "EXTRA_SIGNER_REFUSED",
    );
  });

  it("simulation plan stays CU UNVERIFIED; measured rebuild reapplies 25% and rechecks packet", async () => {
    const g = await fixtureGroups();
    const groups = validateDefensiveStakeGroups(g);
    const none = assembleValidatedDefensiveStakeMessage({
      groups,
      computePlan: { kind: "none" },
    });
    const sim = assembleValidatedDefensiveStakeMessage({
      groups,
      computePlan: { kind: "protocol-max-for-simulation" },
    });
    assert.equal(sim.computeUnits.status, "UNVERIFIED");
    assert.match(
      sim.computeUnits.status === "UNVERIFIED" ? sim.computeUnits.reason : "",
      /CU stays UNVERIFIED/,
    );
    assert.equal(sim.packet.status, "MEASURED_OFFLINE");
    assert.equal(sim.instructions[0]!.programId.toBase58(), "ComputeBudget111111111111111111111111111111");
    assert.ok(sim.packet.packetBytes > none.packet.packetBytes);
    const measured = deriveMeasuredComputePlan(400_000);
    const rebuilt = assembleValidatedDefensiveStakeMessage({
      groups,
      computePlan: measured,
    });
    assert.equal(rebuilt.computeUnits.status, "MEASURED");
    if (rebuilt.computeUnits.status !== "MEASURED") {
      throw new Error("expected MEASURED");
    }
    assert.equal(rebuilt.computeUnits.unitsConsumed, 400_000);
    assert.equal(rebuilt.computeUnits.computeUnitLimit, 500_000);
    assert.ok(rebuilt.packet.packetBytes > none.packet.packetBytes);
    assert.equal(rebuilt.packet.packetBytes, sim.packet.packetBytes);
  });

  it("enumerates signers from account metas", async () => {
    const g = await fixtureGroups();
    const signers = enumerateRequiredSigners([g.unpause, g.convert[0]!, g.deposit[0]!, g.repause]);
    assert.equal(signers.length, 1);
    assert.ok(signers[0]!.equals(g.identities.creator));
  });
});

describe("production-builder instruction shapes", () => {
  it("uses exported set_paused/convert/deposit helpers without live proofs", async () => {
    const g = await fixtureGroups();
    const paused = composeSetPausedInstruction({
      programId: g.identities.ichorProgramId,
      authority: g.identities.creator,
      config: g.identities.config,
      paused: false,
    });
    assert.equal(paused.keys.length, 2);
    assert.ok(paused.keys[0]!.pubkey.equals(g.identities.creator));
    assert.equal(paused.keys[0]!.isSigner, true);
    assert.equal(paused.keys[0]!.isWritable, false);
    assert.ok(paused.keys[1]!.pubkey.equals(g.identities.config));
    const convert = composeConvertInstruction({
      programId: g.identities.ichorProgramId,
      burner: g.identities.creator,
      config: g.identities.config,
      kekbullMint: g.identities.kekbullMint,
      ichorMint: g.identities.ichorMint,
      kekbullFrom: g.identities.kekbullFrom,
      ichorTo: g.identities.ichorTo,
      bondingCurve: g.identities.bondingCurve,
      kekbullTokenProgram: TOKEN_2022_PROGRAM_ID,
      ichorTokenProgram: TOKEN_2022_PROGRAM_ID,
      kekbullAmount: new BN(g.identities.kekbullAmount),
      minIchorAmount: new BN(g.identities.expectedIchorGross),
    });
    assert.equal(convert.keys.length, 9);
    assert.ok(convert.keys[7]!.pubkey.equals(TOKEN_2022_PROGRAM_ID));
    assert.ok(convert.keys[8]!.pubkey.equals(TOKEN_2022_PROGRAM_ID));
    const deposit = await composeDepositIchorVotesInstruction({
      realmsProgramId: g.identities.realmsProgramId,
      programVersion: 3,
      realm: g.identities.realm,
      tokenSourceAccount: g.identities.ichorTo,
      communityMint: g.identities.ichorMint,
      tokenOwner: g.identities.creator,
      sourceAuthority: g.identities.creator,
      payer: g.identities.creator,
      amount: new BN(g.identities.expectedIchorGross),
    });
    assert.equal(deposit.instruction.keys.length, 11);
    assert.ok(deposit.instruction.keys[8]!.pubkey.equals(TOKEN_2022_PROGRAM_ID));
    assert.ok(deposit.instruction.keys[10]!.pubkey.equals(g.identities.ichorMint));
    const admin = readFileSync(join(srcDir, "admin.ts"), "utf8");
    const burn = readFileSync(join(srcDir, "burn.ts"), "utf8");
    const realms = readFileSync(join(srcDir, "realms.ts"), "utf8");
    assert.match(admin, /export function composeSetPausedInstruction/);
    assert.match(exportedBuildSetPaused(admin), /composeSetPausedInstruction/);
    assert.match(burn, /export function composeConvertInstruction/);
    assert.match(exportedComposeConvert(burn), /composeConvertInstruction\(/);
    assert.match(realms, /export function applyIchorDepositToken2022Patch/);
    assert.match(realms, /export async function composeDepositIchorVotesInstruction/);
    assert.match(exportedBuildDeposit(realms), /composeDepositIchorVotesInstruction/);
    assert.doesNotMatch(readFileSync(fileURLToPath(import.meta.url), "utf8"), /ix\.keys\[8\] = \{ pubkey: TOKEN_2022_PROGRAM_ID/);
  });
});

function exportedBuildSetPaused(src: string): string {
  const start = src.indexOf("export async function buildSetPaused");
  return src.slice(start, src.indexOf("export async function buildProposeEmissionRatio", start));
}

function exportedComposeConvert(src: string): string {
  const start = src.indexOf("export async function composeConvertInstructionsFromIssuedConfig");
  return src.slice(start, src.indexOf("export async function buildConvertTransaction", start));
}

function exportedBuildDeposit(src: string): string {
  const start = src.indexOf("export async function buildDepositIchorVotes");
  return src.slice(start, src.indexOf("export async function buildDepositCouncilVotes", start));
}

describe("deposit amount is gross; TOR weight is net", () => {
  it("pins fork semantics and shared fee math", () => {
    assert.equal(DEPOSIT_GOVERNING_TOKENS_AMOUNT_IS_GROSS, true);
    const gross = new BN(1_000_000);
    const fee = calculateToken2022TransferFee({
      preFeeAmount: gross,
      transferFeeBasisPoints: 25,
      maximumFee: U64_MAX,
    });
    assert.equal(fee.toString(), "2500");
    const net = gross.sub(fee);
    assert.equal(net.toString(), "997500");
    const fromSchedule = getCurrentMintFee({
      config: {
        transferFeeConfigAuthority: null,
        withdrawWithheldAuthority: null,
        withheldAmount: new BN(0),
        olderTransferFee: {
          epoch: new BN(0),
          maximumFee: U64_MAX,
          transferFeeBasisPoints: 25,
        },
        newerTransferFee: {
          epoch: new BN(0),
          maximumFee: U64_MAX,
          transferFeeBasisPoints: 25,
        },
      },
      currentEpoch: new BN(0),
      preFeeAmount: gross,
    });
    assert.ok(fromSchedule.eq(fee));
  });
});

describe("SetRealmConfig emergency brake preserve/restore", () => {
  it("brake source is exact Absolute(u64::MAX)", () => {
    const brake = emergencyBrakeVoteWeightSource();
    assert.equal(brake.type, "absolute");
    assert.ok(brake.value.eq(U64_MAX));
  });

  it("preserve helper refuses any field other than the vote-weight source", () => {
    const realm = PublicKey.unique();
    const authority = PublicKey.unique();
    const community = PublicKey.unique();
    const council = PublicKey.unique();
    const before = {
      realm,
      realmAuthority: authority,
      communityMint: community,
      councilMint: council,
      minCommunityTokensToCreateGovernance: new BN(1),
      communityTokenConfig: {
        voterWeightAddin: undefined,
        maxVoterWeightAddin: undefined,
        tokenType: 0,
      },
      councilTokenConfig: {
        voterWeightAddin: undefined,
        maxVoterWeightAddin: undefined,
        tokenType: 0,
      },
    };
    assert.doesNotThrow(() => assertRealmConfigFieldsPreserved({ before, after: before }));
    assert.throws(
      () =>
        assertRealmConfigFieldsPreserved({
          before,
          after: { ...before, minCommunityTokensToCreateGovernance: new BN(2) },
        }),
      (err: unknown) => err instanceof ClientValidationError && err.code === "REALM_CONFIG_PRESERVE",
    );
  });

  it("compose uses Realm authority as the sole signer, not Governance", async () => {
    const program = PublicKey.unique();
    const realm = PublicKey.unique();
    const authority = PublicKey.unique();
    const council = PublicKey.unique();
    const built = await composeSetRealmConfigVoteWeightOnly({
      realmsProgramId: program,
      programVersion: 3,
      realm,
      realmAuthority: authority,
      councilMint: council,
      source: emergencyBrakeVoteWeightSource(),
      minCommunityTokensToCreateGovernance: new BN(1),
      communityTokenConfig: new GoverningTokenConfigAccountArgs({
        voterWeightAddin: undefined,
        maxVoterWeightAddin: undefined,
        tokenType: GoverningTokenType.Liquid,
      }),
      councilTokenConfig: new GoverningTokenConfigAccountArgs({
        voterWeightAddin: undefined,
        maxVoterWeightAddin: undefined,
        tokenType: GoverningTokenType.Liquid,
      }),
      payer: authority,
    });
    assert.equal(built.instructions.length, 1);
    const keys = built.instructions[0]!.keys;
    assert.ok(keys[1]!.pubkey.equals(authority));
    assert.equal(keys[1]!.isSigner, true);
    const signers = keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58());
    assert.deepEqual([...new Set(signers)], [authority.toBase58()]);
  });

  it("mainnet pin rejects the brake source", () => {
    assert.throws(
      () =>
        assertMainnetVoteWeightSource({
          cluster: "mainnet-beta",
          source: emergencyBrakeVoteWeightSource(),
          fullSupplyFractionValue: MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value,
        }),
      (err: unknown) =>
        err instanceof ClientValidationError &&
        err.code === "MAINNET_GOVERNANCE_PINS" &&
        err.details.some((d) => d.includes("absolute")),
    );
    assert.doesNotThrow(() =>
      assertMainnetVoteWeightSource({
        cluster: "mainnet-beta",
        source: {
          type: "supply-fraction",
          value: mainnetSupplyFractionValue(MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value),
        },
        fullSupplyFractionValue: MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION.value,
      }),
    );
  });
});

describe("source: convert pause gate stays closed", () => {
  it("buildConvertTransaction still refuses paused; composer is a separate function", () => {
    const burn = readFileSync(join(srcDir, "burn.ts"), "utf8");
    const publicFn = burn.slice(
      burn.indexOf("export async function buildConvertTransaction"),
      burn.indexOf("export async function buildConvertInstruction"),
    );
    assert.match(publicFn, /config\.paused/);
    assert.match(publicFn, /"PAUSED"/);
    assert.match(publicFn, /composeConvertInstructionsFromIssuedConfig/);
    const composer = readFileSync(join(srcDir, "defensive-stake.ts"), "utf8");
    assert.match(composer, /composeConvertInstructionsFromIssuedConfig/);
    assert.doesNotMatch(composer, /buildConvertTransaction\(/);
    assert.match(composer, /sendImplemented: false/);
    assert.doesNotMatch(composer, /getProgramAccounts/);
    assert.doesNotMatch(composer, /Keypair\.fromSecretKey/);
    assert.doesNotMatch(composer, /sendRawTransaction|sendAndConfirmTransaction/);
  });
});
