import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { ClientValidationError } from "../src/types.ts";
import {
  ICHOR_TOKEN_NAME,
  ICHOR_TOKEN_SYMBOL,
  MPL_TOKEN_METADATA_PROGRAM_ID,
  createIchorMetaplexCreateV1Instruction,
  ichorMetadataPda,
  requireIchorMetadataUri,
} from "../src/ichor-metadata.ts";

const PINNED_URI =
  "https://gold-hilarious-monkey-129.mypinata.cloud/ipfs/bafkreigujhjgxusi2d4d5cknh33yjkhqj5lgpnr4kqsxtthmtxvh632pya";

describe("ICHOR Metaplex metadata (wallet display)", () => {
  it("pins product labels and Metaplex program id", () => {
    assert.equal(ICHOR_TOKEN_NAME, "ICHOR");
    assert.equal(ICHOR_TOKEN_SYMBOL, "ICHOR");
    assert.equal(
      MPL_TOKEN_METADATA_PROGRAM_ID.toBase58(),
      "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
    );
  });

  it("derives the standard metadata PDA and packs CreateV1 Fungible", () => {
    const mint = PublicKey.unique();
    const payer = PublicKey.unique();
    const pda = ichorMetadataPda(mint);
    const [expected] = PublicKey.findProgramAddressSync(
      [
        new TextEncoder().encode("metadata"),
        MPL_TOKEN_METADATA_PROGRAM_ID.toBytes(),
        mint.toBytes(),
      ],
      MPL_TOKEN_METADATA_PROGRAM_ID,
    );
    assert.equal(pda.toBase58(), expected.toBase58());

    const ix = createIchorMetaplexCreateV1Instruction({
      mint,
      payer,
      decimals: 6,
      metadataUri: PINNED_URI,
    });
    assert.equal(ix.programId.toBase58(), MPL_TOKEN_METADATA_PROGRAM_ID.toBase58());
    assert.equal(ix.keys[0]?.pubkey.toBase58(), pda.toBase58());
    assert.equal(ix.keys[0]?.isWritable, true);
    assert.equal(ix.data[0], 42);
    assert.equal(ix.data[1], 0);
    const nameBytes = new TextEncoder().encode("ICHOR");
    assert.equal(ix.data[2], nameBytes.length);
    assert.deepEqual(
      Array.from(ix.data.slice(6, 6 + nameBytes.length)),
      Array.from(nameBytes),
    );
    const uriBytes = Buffer.from(PINNED_URI, "utf8");
    const packed = Buffer.from(ix.data);
    const uriStart = packed.indexOf(uriBytes);
    assert.ok(uriStart > 0, "CreateV1 must pack the HTTPS metadata URI");
    assert.deepEqual(packed.subarray(uriStart, uriStart + uriBytes.length), uriBytes);
  });

  it("refuses an empty or non-https metadata URI", () => {
    assert.throws(() => requireIchorMetadataUri(""), ClientValidationError);
    assert.throws(() => requireIchorMetadataUri("   "), ClientValidationError);
    assert.throws(
      () => requireIchorMetadataUri("http://gold-hilarious-monkey-129.mypinata.cloud/ipfs/bafkreiabc"),
      ClientValidationError,
    );
    assert.throws(
      () => requireIchorMetadataUri("https://gold-hilarious-monkey-129.mypinata.cloud/no-cid"),
      ClientValidationError,
    );
    assert.throws(
      () =>
        requireIchorMetadataUri(
          "https://gold-hilarious-monkey-129.mypinata.cloud@evil.tld/ipfs/bafkreiabc",
        ),
      ClientValidationError,
    );
    assert.equal(requireIchorMetadataUri(PINNED_URI), PINNED_URI);
    const mint = PublicKey.unique();
    const payer = PublicKey.unique();
    assert.throws(
      () => createIchorMetaplexCreateV1Instruction({ mint, payer, decimals: 6, metadataUri: "" }),
      ClientValidationError,
    );
  });
});
