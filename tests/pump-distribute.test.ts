import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import {
  ACCOUNT_BONDING_CURVE,
  ACCOUNT_SHARING_CONFIG,
  BONDING_CURVE_COMPLETE_OFFSET,
  BONDING_CURVE_CREATOR_OFFSET,
  IX_DISTRIBUTE_CREATOR_FEES,
  IX_DISTRIBUTE_CREATOR_FEES_V2,
  IX_GET_MINIMUM_DISTRIBUTABLE_FEE,
  IX_TRANSFER_CREATOR_FEES_TO_PUMP,
  KEKBULL_OPERATOR_BPS,
  KEKBULL_TREASURY_BPS,
  PUMP_AMM_PROGRAM,
  PUMP_FEE_PROGRAM,
  PUMP_PROGRAM,
  WSOL_MINT,
  ammCreatorVaultAta,
  ammCreatorVaultAuthority,
  ammTransferCanUnlock,
  bondingCurveAddress,
  buildDistributeCreatorFees,
  buildDistributeCreatorFeesV2,
  buildGetMinimumDistributableFee,
  buildPumpDistribute,
  buildTransferCreatorFeesToPump,
  creatorVaultAddress,
  decodeShareholders,
  distributeVariant,
  extractSimulateReturnData,
  parseBondingCurveHead,
  parseMinimumDistributableFee,
  parseSharingConfig,
  parseSplTokenAmount,
  pumpEventAuthority,
  pumpVaultCanPay,
  remainingAccountsForCurrentShareholders,
  sharesMatchKekbullPolicy,
  sharingConfigAddress,
} from "../src/pump-distribute.ts";

function pk(byte: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => byte));
}

function encodeShareholders(
  rows: ReadonlyArray<{ address: PublicKey; shareBps: number }>,
): Uint8Array {
  const out = Buffer.alloc(4 + rows.length * 34);
  out.writeUInt32LE(rows.length, 0);
  let off = 4;
  for (const row of rows) {
    out.set(row.address.toBytes(), off);
    out.writeUInt16LE(row.shareBps, off + 32);
    off += 34;
  }
  return out;
}

describe("pump distribute builders", () => {
  it("derives sharing-config on the fee program and the vault on pump", () => {
    const mint = pk(10);
    const sharing = sharingConfigAddress(mint);
    assert.equal(
      sharing.toBase58(),
      PublicKey.findProgramAddressSync(
        [Buffer.from("sharing-config"), mint.toBuffer()],
        PUMP_FEE_PROGRAM,
      )[0].toBase58(),
    );
    const creator = pk(9);
    assert.notEqual(creatorVaultAddress(creator).toBase58(), sharing.toBase58());
    assert.equal(
      creatorVaultAddress(creator).toBase58(),
      PublicKey.findProgramAddressSync(
        [Buffer.from("creator-vault"), creator.toBuffer()],
        PUMP_PROGRAM,
      )[0].toBase58(),
    );
  });

  it("parses SharingConfig at the measured offsets including admin_revoked", () => {
    const shares = [
      { address: pk(1), shareBps: KEKBULL_TREASURY_BPS },
      { address: pk(2), shareBps: KEKBULL_OPERATOR_BPS },
    ];
    const data = Buffer.concat([
      Buffer.from(ACCOUNT_SHARING_CONFIG),
      Buffer.from([255, 2, 1]),
      Buffer.from(pk(10).toBytes()),
      Buffer.from(pk(9).toBytes()),
      Buffer.from([1]),
      Buffer.from(encodeShareholders(shares)),
    ]);
    const cfg = parseSharingConfig(PUMP_FEE_PROGRAM, data);
    assert.equal(cfg.bump, 255);
    assert.equal(cfg.version, 2);
    assert.equal(cfg.status, "Active");
    assert.equal(cfg.mint.toBase58(), pk(10).toBase58());
    assert.equal(cfg.admin.toBase58(), pk(9).toBase58());
    assert.equal(cfg.adminRevoked, true);
    assert.equal(cfg.shareholders.length, 2);
    assert.equal(cfg.shareholders[0]?.shareBps, KEKBULL_TREASURY_BPS);
    assert.throws(() => parseSharingConfig(PUMP_PROGRAM, data));
    const bad = Buffer.from(data);
    bad[0] ^= 0xff;
    assert.throws(() => parseSharingConfig(PUMP_FEE_PROGRAM, bad));
  });

  it("reads the bonding-curve quote mint from the measured offset and keeps native SOL distinct", () => {
    const data = Buffer.alloc(151);
    data.set(ACCOUNT_BONDING_CURVE, 0);
    data[BONDING_CURVE_COMPLETE_OFFSET] = 1;
    data.set(pk(9).toBytes(), BONDING_CURVE_CREATOR_OFFSET);
    data.set(pk(55).toBytes(), 83);
    const usdc = parseBondingCurveHead(data);
    assert.equal(usdc.complete, true);
    assert.equal(usdc.creator.toBase58(), pk(9).toBase58());
    assert.equal(usdc.quoteMintRaw.toBase58(), pk(55).toBase58());
    assert.equal(usdc.quoteMint.toBase58(), pk(55).toBase58());
    assert.equal(distributeVariant(usdc.quoteMintRaw), "v2");

    data.set(Buffer.alloc(32), 83);
    const sol = parseBondingCurveHead(data);
    assert.equal(sol.quoteMintRaw.equals(PublicKey.default), true);
    assert.equal(sol.quoteMint.equals(WSOL_MINT), true);
    assert.equal(distributeVariant(sol.quoteMintRaw), "v1");
  });

  it("builds v1 with the IDL named accounts, no payer, and current shareholders as remaining", () => {
    const mint = pk(10);
    const creator = pk(9);
    const ix = buildDistributeCreatorFees({
      mint,
      curveCreator: creator,
      currentShareholders: [pk(1), pk(2)],
    });
    assert.equal(ix.programId.toBase58(), PUMP_PROGRAM.toBase58());
    assert.deepEqual(Uint8Array.from(ix.data), IX_DISTRIBUTE_CREATOR_FEES);
    assert.equal(ix.keys.length, 9);
    assert.equal(ix.keys[0]?.pubkey.toBase58(), mint.toBase58());
    assert.equal(ix.keys[1]?.pubkey.toBase58(), bondingCurveAddress(mint).toBase58());
    assert.equal(ix.keys[2]?.pubkey.toBase58(), sharingConfigAddress(mint).toBase58());
    assert.equal(ix.keys[3]?.pubkey.toBase58(), creatorVaultAddress(creator).toBase58());
    assert.equal(ix.keys[3]?.isWritable, true);
    assert.equal(ix.keys[4]?.pubkey.toBase58(), SystemProgram.programId.toBase58());
    assert.equal(ix.keys[5]?.pubkey.toBase58(), pumpEventAuthority().toBase58());
    assert.equal(ix.keys[6]?.pubkey.toBase58(), PUMP_PROGRAM.toBase58());
    assert.equal(ix.keys[7]?.pubkey.toBase58(), pk(1).toBase58());
    assert.equal(ix.keys[8]?.pubkey.toBase58(), pk(2).toBase58());
    assert.equal(ix.keys.some((key) => key.isSigner), false);
  });

  it("builds v2 with a rent payer and initialize_ata after the discriminator", () => {
    const mint = pk(10);
    const creator = pk(9);
    const payer = pk(3);
    const quote = pk(55);
    const ix = buildDistributeCreatorFeesV2({
      payer,
      mint,
      curveCreator: creator,
      quoteMint: quote,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
      currentShareholders: [pk(1), pk(2)],
      initializeAta: true,
    });
    assert.equal(ix.data.length, 9);
    assert.deepEqual(Uint8Array.from(ix.data.subarray(0, 8)), IX_DISTRIBUTE_CREATOR_FEES_V2);
    assert.equal(ix.data[8], 1);
    assert.equal(ix.keys[0]?.pubkey.toBase58(), payer.toBase58());
    assert.equal(ix.keys[0]?.isSigner, true);
    assert.equal(ix.keys[0]?.isWritable, true);
    const vaultAta = getAssociatedTokenAddressSync(
      quote,
      creatorVaultAddress(creator),
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    assert.equal(ix.keys[8]?.pubkey.toBase58(), vaultAta.toBase58());
    assert.equal(ix.keys[10]?.pubkey.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
    assert.equal(ix.keys[11]?.pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID), true);
    const remaining = remainingAccountsForCurrentShareholders(
      [pk(1), pk(2)],
      quote,
      TOKEN_2022_PROGRAM_ID,
    );
    assert.equal(remaining.length, 4);
    assert.equal(ix.keys[ix.keys.length - 1]?.pubkey.toBase58(), remaining[3]?.pubkey.toBase58());
  });

  it("omits shareholder ATAs from remaining accounts when the quote is wrapped SOL", () => {
    const remaining = remainingAccountsForCurrentShareholders([pk(1), pk(2)], WSOL_MINT, TOKEN_PROGRAM_ID);
    assert.equal(remaining.length, 2);
    assert.equal(remaining[0]?.pubkey.toBase58(), pk(1).toBase58());
  });

  it("parses get_minimum_distributable_fee return data with and without the event disc", () => {
    const body = Buffer.alloc(17);
    body.writeBigUInt64LE(1_000_000n, 0);
    body.writeBigUInt64LE(2_500_000n, 8);
    body[16] = 1;
    const parsed = parseMinimumDistributableFee(body);
    assert.equal(parsed.minimumRequired.toString(10), "1000000");
    assert.equal(parsed.distributableFees.toString(10), "2500000");
    assert.equal(parsed.canDistribute, true);

    const withDisc = Buffer.concat([Buffer.alloc(8, 9), body]);
    assert.equal(parseMinimumDistributableFee(withDisc).canDistribute, true);
    assert.throws(() => parseMinimumDistributableFee(Buffer.alloc(8)));
  });

  it("reads program return data from simulate logs when returnData is missing", () => {
    const body = Buffer.alloc(17);
    body.writeBigUInt64LE(4n, 0);
    body.writeBigUInt64LE(4n, 8);
    body[16] = 0;
    const extracted = extractSimulateReturnData(null, [
      "Program log: ignore",
      `Program return: ${PUMP_PROGRAM.toBase58()} ${body.toString("base64")}`,
    ]);
    assert.equal(parseMinimumDistributableFee(extracted).canDistribute, false);
  });

  it("get_minimum_distributable_fee is the four named accounts plus current shareholders", () => {
    const mint = pk(10);
    const holders = [pk(3), pk(4)];
    const ix = buildGetMinimumDistributableFee({
      mint,
      curveCreator: pk(9),
      currentShareholders: holders,
    });
    assert.deepEqual(Uint8Array.from(ix.data), IX_GET_MINIMUM_DISTRIBUTABLE_FEE);
    assert.equal(ix.keys.length, 6);
    assert.equal(ix.keys[4]?.pubkey.toBase58(), holders[0]?.toBase58());
    assert.equal(ix.keys[5]?.pubkey.toBase58(), holders[1]?.toBase58());
    assert.equal(ix.keys[4]?.isWritable, true);
    assert.equal(ix.keys.every((key) => !key.isSigner), true);
  });

  it("treats 75/25 as policy only when pinned addresses hold the matching bps", () => {
    const treasury = pk(1);
    const operator = pk(2);
    assert.equal(
      sharesMatchKekbullPolicy(
        [
          { address: treasury, shareBps: KEKBULL_TREASURY_BPS },
          { address: operator, shareBps: KEKBULL_OPERATOR_BPS },
        ],
        treasury,
        operator,
      ),
      true,
    );
    assert.equal(
      sharesMatchKekbullPolicy(
        [
          { address: operator, shareBps: KEKBULL_TREASURY_BPS },
          { address: treasury, shareBps: KEKBULL_OPERATOR_BPS },
        ],
        treasury,
        operator,
      ),
      false,
    );
    assert.equal(
      sharesMatchKekbullPolicy(
        [
          { address: treasury, shareBps: KEKBULL_OPERATOR_BPS },
          { address: operator, shareBps: KEKBULL_TREASURY_BPS },
        ],
        treasury,
        operator,
      ),
      false,
    );
    assert.equal(
      sharesMatchKekbullPolicy([{ address: pk(1), shareBps: 10_000 }], treasury, operator),
      false,
    );
    const decoded = decodeShareholders(encodeShareholders([{ address: pk(1), shareBps: 10_000 }]));
    assert.equal(decoded.shareholders[0]?.shareBps, 10_000);
  });

  it("builds transfer_creator_fees_to_pump with the measured AMM account list", () => {
    const creator = pk(9);
    const ix = buildTransferCreatorFeesToPump(creator);
    assert.deepEqual(Uint8Array.from(ix.data), IX_TRANSFER_CREATOR_FEES_TO_PUMP);
    assert.equal(ix.programId.toBase58(), PUMP_AMM_PROGRAM.toBase58());
    assert.equal(ix.keys.length, 10);
    assert.equal(ix.keys[4]?.pubkey.toBase58(), creator.toBase58());
    assert.equal(ix.keys[5]?.pubkey.toBase58(), ammCreatorVaultAuthority(creator).toBase58());
    assert.equal(ix.keys[6]?.pubkey.toBase58(), ammCreatorVaultAta(creator).toBase58());
    assert.equal(ix.keys[7]?.pubkey.toBase58(), creatorVaultAddress(creator).toBase58());
    assert.equal(ix.keys.every((key) => !key.isSigner), true);
  });

  it("reads SPL token amount at offset 64 and refuses ZBT-style 1-lamport can_distribute dust", () => {
    const data = Buffer.alloc(72);
    data.writeBigUInt64LE(3_004_661n, 64);
    assert.equal(parseSplTokenAmount(data).toString(10), "3004661");
    assert.equal(
      pumpVaultCanPay(
        {
          minimumRequired: new BN("2672640"),
          distributableFees: new BN("1"),
          canDistribute: true,
        },
        2,
      ),
      false,
    );
    assert.equal(
      pumpVaultCanPay(
        {
          minimumRequired: new BN("890880"),
          distributableFees: new BN("3"),
          canDistribute: true,
        },
        4,
      ),
      false,
    );
    assert.equal(
      pumpVaultCanPay(
        {
          minimumRequired: new BN("2672640"),
          distributableFees: new BN("2113781"),
          canDistribute: true,
        },
        2,
      ),
      true,
    );
    assert.equal(
      ammTransferCanUnlock({
        variant: "v1",
        transferEligible: true,
        vaultLamports: new BN(0),
        ammTokenAmount: new BN("3004661"),
        tokenAccountRent: new BN("2039280"),
        minimum: {
          minimumRequired: new BN("2672640"),
          distributableFees: new BN(0),
          canDistribute: false,
        },
      }),
      true,
    );
    assert.equal(
      ammTransferCanUnlock({
        variant: "v2",
        transferEligible: true,
        vaultLamports: new BN(0),
        ammTokenAmount: new BN("3004661"),
        tokenAccountRent: new BN("2039280"),
        minimum: {
          minimumRequired: new BN("2672640"),
          distributableFees: new BN(0),
          canDistribute: false,
        },
      }),
      false,
    );
    assert.equal(
      ammTransferCanUnlock({
        variant: "v1",
        transferEligible: false,
        vaultLamports: new BN(0),
        ammTokenAmount: new BN("1003219"),
        tokenAccountRent: new BN("2039280"),
        minimum: {
          minimumRequired: new BN("2672640"),
          distributableFees: new BN(0),
          canDistribute: false,
        },
      }),
      false,
    );
  });

  it("prefixes transfer_creator_fees_to_pump on v1 when AMM wSOL unlocks distribute", async () => {
    const mint = pk(10);
    const creator = pk(9);
    const built = await buildPumpDistribute({
      connection: {} as Connection,
      mint,
      payer: pk(3),
      live: {
        mint,
        sharingConfigAddress: pk(11),
        bondingCurve: pk(12),
        creatorVault: creatorVaultAddress(creator),
        sharing: {
          bump: 255,
          version: 2,
          status: "Active",
          mint,
          admin: pk(8),
          adminRevoked: true,
          shareholders: [
            { address: pk(1), shareBps: 5_000 },
            { address: pk(2), shareBps: 5_000 },
          ],
        },
        curve: {
          complete: true,
          creator,
          quoteMintRaw: PublicKey.default,
          quoteMint: WSOL_MINT,
        },
        vaultLamports: new BN(0),
        quoteTokenProgram: null,
        minimum: {
          minimumRequired: new BN("2672640"),
          distributableFees: new BN(0),
          canDistribute: false,
        },
        variant: "v1",
        ammVaultAta: ammCreatorVaultAta(creator),
        ammTokenAmount: new BN("3004661"),
        tokenAccountRent: new BN("2039280"),
        transferEligible: true,
      },
    });
    assert.equal(built.includesTransfer, true);
    assert.equal(built.instructions.length, 2);
    assert.deepEqual(Uint8Array.from(built.instructions[0]!.data), IX_TRANSFER_CREATOR_FEES_TO_PUMP);
    assert.deepEqual(Uint8Array.from(built.instructions[1]!.data), IX_DISTRIBUTE_CREATOR_FEES);
    assert.equal(built.instructions[0]!.programId.toBase58(), PUMP_AMM_PROGRAM.toBase58());
  });
});
