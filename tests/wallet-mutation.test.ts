/**
 * AUDIT_20260824_ICHOR_DAO.md B1 - behavioural coverage.
 *
 * The old code detected a wallet-mutated message, appended a line to a log
 * array nothing rendered, and broadcast the wallet's bytes anyway with
 * skipPreflight. These exercise the replacement decision directly.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

import { assertWalletOnlyAdjustedFees } from "../src/send.ts";

const PAYER = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ALICE = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATTACKER = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const BLOCKHASH_A = "11111111111111111111111111111111";
const BLOCKHASH_B = "So11111111111111111111111111111111111111112";

function tx(opts: {
  to?: PublicKey;
  lamports?: number;
  blockhash?: string;
  feePayer?: PublicKey;
  computeBudgetFirst?: boolean;
  extraTransfer?: boolean;
}): Transaction {
  const t = new Transaction();
  t.feePayer = opts.feePayer ?? PAYER;
  t.recentBlockhash = opts.blockhash ?? BLOCKHASH_A;
  if (opts.computeBudgetFirst === true) {
    t.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }));
  }
  t.add(
    SystemProgram.transfer({
      fromPubkey: PAYER,
      toPubkey: opts.to ?? ALICE,
      lamports: opts.lamports ?? 1_000_000,
    }),
  );
  if (opts.extraTransfer === true) {
    t.add(
      SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: ATTACKER, lamports: 999_000_000 }),
    );
  }
  return t;
}

describe("assertWalletOnlyAdjustedFees - AUDIT B1", () => {
  it("accepts an unchanged transaction", () => {
    assert.doesNotThrow(() => assertWalletOnlyAdjustedFees(tx({}), tx({})));
  });

  it("accepts a refreshed blockhash", () => {
    // Only the message bytes change; instructions are identical.
    assert.doesNotThrow(() =>
      assertWalletOnlyAdjustedFees(tx({}), tx({ blockhash: BLOCKHASH_B })),
    );
  });

  it("accepts a prepended ComputeBudget instruction", () => {
    assert.doesNotThrow(() =>
      assertWalletOnlyAdjustedFees(tx({}), tx({ computeBudgetFirst: true })),
    );
  });

  it("accepts a ComputeBudget instruction the wallet rewrote", () => {
    assert.doesNotThrow(() =>
      assertWalletOnlyAdjustedFees(tx({ computeBudgetFirst: true }), tx({})),
    );
  });

  it("accepts a Message round-trip that only normalizes account metas", () => {
    // Wallets serialize → sign → deserialize. Transaction.populate rebuilds
    // instruction metas from the account-keys header; isSigner/isWritable on
    // the TransactionInstruction objects can drift without changing the Message.
    const built = tx({});
    const roundTripped = Transaction.populate(built.compileMessage());
    assert.doesNotThrow(() => assertWalletOnlyAdjustedFees(built, roundTripped));
  });

  it("REFUSES a swapped recipient", () => {
    // The finding: a compromised wallet rewrites where the money goes.
    assert.throws(
      () => assertWalletOnlyAdjustedFees(tx({}), tx({ to: ATTACKER })),
      /SIGNED_MESSAGE_CHANGED/,
    );
  });

  it("REFUSES a changed amount", () => {
    assert.throws(
      () => assertWalletOnlyAdjustedFees(tx({}), tx({ lamports: 999_000_000 })),
      /SIGNED_MESSAGE_CHANGED/,
    );
  });

  it("REFUSES an appended transfer", () => {
    assert.throws(
      () => assertWalletOnlyAdjustedFees(tx({}), tx({ extraTransfer: true })),
      /SIGNED_MESSAGE_CHANGED/,
    );
  });

  it("REFUSES an appended transfer hidden behind a ComputeBudget prepend", () => {
    assert.throws(
      () =>
        assertWalletOnlyAdjustedFees(
          tx({}),
          tx({ computeBudgetFirst: true, extraTransfer: true }),
        ),
      /SIGNED_MESSAGE_CHANGED/,
    );
  });

  it("REFUSES a removed instruction", () => {
    const stripped = new Transaction();
    stripped.feePayer = PAYER;
    stripped.recentBlockhash = BLOCKHASH_A;
    assert.throws(
      () => assertWalletOnlyAdjustedFees(tx({}), stripped),
      /SIGNED_MESSAGE_CHANGED/,
    );
  });

  it("REFUSES a changed fee payer", () => {
    assert.throws(
      () => assertWalletOnlyAdjustedFees(tx({}), tx({ feePayer: ATTACKER })),
      /SIGNED_MESSAGE_CHANGED/,
    );
  });
});

describe("send.ts no longer broadcasts a mutated message", () => {
  it("does not carry the old log-and-continue copy", () => {
    // Regex guards are weak, but this one is cheap and pins the exact shape
    // the audit found: detect the mutation, then send it anyway.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/send.ts"),
      "utf8",
    );
    assert.doesNotMatch(src, /sending those signed bytes/);
    assert.match(src, /assertWalletOnlyAdjustedFees\(expectedBeforeSign, signed\)/);
    assert.match(src, /cloneTransaction\(transaction\)/);
    assert.match(src, /messageCoreWithoutComputeBudget/);
  });
});
