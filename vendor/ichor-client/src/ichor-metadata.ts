/**
 * Metaplex Token Metadata for the product ICHOR mint.
 *
 * The ICHOR program accepts **only** TransferFeeConfig on the mint TLV
 * (`extensions.rs`) - MetadataPointer / TokenMetadata extensions are rejected.
 * Wallet display (Phantom name/symbol) therefore uses a separate Metaplex
 * metadata PDA, same pattern as SolCreatorHub `t22_fee_mint.rs` CreateV1.
 *
 * CreateMetadataAccountV3 is refused on Token-2022 (0x99). CreateV1 Fungible
 * is required. Labels are pinned product strings - not throwaway.
 */
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { ClientValidationError } from "./types.ts";
import { requirePublicKey } from "./validation.ts";

/** Official Metaplex Token Metadata program (mainnet + official-devnet). */
export const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

/** Pinned wallet display name for product ICHOR. */
export const ICHOR_TOKEN_NAME = "ICHOR";
/** Pinned wallet display symbol for product ICHOR. */
export const ICHOR_TOKEN_SYMBOL = "ICHOR";

/** Metaplex `MetadataInstruction::Create` (`CreateV1` args follow). */
const IX_CREATE_V1 = 42;
const IX_CREATE_V1_ARGS = 0;
/** `TokenStandard::Fungible`. */
const TOKEN_STANDARD_FUNGIBLE = 2;
const METADATA_NAME_MAX = 32;
const METADATA_SYMBOL_MAX = 10;
/** Metaplex Metadata account `uri` field is 200 bytes. */
const METADATA_URI_MAX = 200;

export function ichorMetadataPda(mint: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [utf8("metadata"), MPL_TOKEN_METADATA_PROGRAM_ID.toBytes(), mint.toBytes()],
    MPL_TOKEN_METADATA_PROGRAM_ID,
  );
  return address;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function packBorshString(value: string, out: number[]): void {
  const bytes = utf8(value);
  out.push(bytes.length & 0xff, (bytes.length >> 8) & 0xff, (bytes.length >> 16) & 0xff, (bytes.length >> 24) & 0xff);
  for (const b of bytes) {
    out.push(b);
  }
}

/**
 * Require a fetchable HTTPS /ipfs/ URI. CreateV1 writes this into the mint
 * permanently (`is_mutable = false`); an empty URI is a nameless token.
 */
export function requireIchorMetadataUri(uri: string): string {
  if (typeof uri !== "string") {
    throw new ClientValidationError("ICHOR_METADATA_URI", ["metadata URI is not a string"]);
  }
  const trimmed = uri.trim();
  if (trimmed.length === 0) {
    throw new ClientValidationError("ICHOR_METADATA_URI", [
      "metadata URI is empty - CreateV1 is immutable; pin image+JSON first",
    ]);
  }
  if (trimmed !== uri) {
    throw new ClientValidationError("ICHOR_METADATA_URI", [
      "metadata URI has leading or trailing whitespace",
    ]);
  }
  if (trimmed.length > METADATA_URI_MAX) {
    throw new ClientValidationError("ICHOR_METADATA_URI", [
      `metadata URI is ${String(trimmed.length)} chars; Metaplex uri field allows ${String(METADATA_URI_MAX)}`,
    ]);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ClientValidationError("ICHOR_METADATA_URI", ["metadata URI is not a valid URL"]);
  }
  if (parsed.protocol !== "https:") {
    throw new ClientValidationError("ICHOR_METADATA_URI", ["metadata URI must be https"]);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ClientValidationError("ICHOR_METADATA_URI", [
      "metadata URI must not carry userinfo (authority-spoof form)",
    ]);
  }
  if (!parsed.pathname.includes("/ipfs/")) {
    throw new ClientValidationError("ICHOR_METADATA_URI", [
      "metadata URI must be an /ipfs/ CID path",
    ]);
  }
  return trimmed;
}

/**
 * Immutable Metaplex CreateV1 for an already-initialized Token-2022 ICHOR mint.
 * Mint account stays 278 bytes (TransferFeeConfig only). URI is the pinned
 * HTTPS metadata JSON (image + description + socials). The mint-authority
 * account is the payer - it must match the live mint authority and sign.
 * Update authority is the payer; `is_mutable = false`.
 */
export function createIchorMetaplexCreateV1Instruction(params: {
  mint: PublicKey;
  payer: PublicKey;
  decimals: number;
  metadataUri: string;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const mint = requirePublicKey(params.mint, "mint");
  const payer = requirePublicKey(params.payer, "payer");
  const metadataUri = requireIchorMetadataUri(params.metadataUri);
  if (!Number.isInteger(params.decimals) || params.decimals < 0 || params.decimals > 255) {
    throw new ClientValidationError("MINT_DECIMALS", [
      `decimals ${String(params.decimals)} is not a u8`,
    ]);
  }
  if (ICHOR_TOKEN_NAME.length === 0 || ICHOR_TOKEN_NAME.length > METADATA_NAME_MAX) {
    throw new ClientValidationError("ICHOR_METADATA_LABEL", ["pinned ICHOR name length invalid"]);
  }
  if (ICHOR_TOKEN_SYMBOL.length === 0 || ICHOR_TOKEN_SYMBOL.length > METADATA_SYMBOL_MAX) {
    throw new ClientValidationError("ICHOR_METADATA_LABEL", ["pinned ICHOR symbol length invalid"]);
  }
  const metadata = ichorMetadataPda(mint);
  const tokenProgram = params.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const data: number[] = [IX_CREATE_V1, IX_CREATE_V1_ARGS];
  packBorshString(ICHOR_TOKEN_NAME, data);
  packBorshString(ICHOR_TOKEN_SYMBOL, data);
  packBorshString(metadataUri, data);
  data.push(0, 0); // seller_fee_basis_points u16 = 0
  data.push(0); // creators None
  data.push(0); // primary_sale_happened
  data.push(0); // is_mutable = false
  data.push(TOKEN_STANDARD_FUNGIBLE);
  data.push(0); // collection None
  data.push(0); // uses None
  data.push(0); // collection_details None
  data.push(0); // rule_set None
  data.push(1); // decimals Some
  data.push(params.decimals & 0xff);
  data.push(0); // print_supply None

  return {
    programId: MPL_TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: MPL_TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.from(data),
  };
}

function readBorshString(data: Uint8Array, offset: number): { value: string; next: number } {
  if (data.length < offset + 4) {
    throw new ClientValidationError("ICHOR_METADATA_LAYOUT", ["metadata string length truncated"]);
  }
  const len = data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24);
  const start = offset + 4;
  const end = start + len;
  if (len < 0 || end > data.length) {
    throw new ClientValidationError("ICHOR_METADATA_LAYOUT", [
      `metadata string length ${String(len)} overruns account`,
    ]);
  }
  return {
    value: new TextDecoder().decode(data.subarray(start, end)).replace(/\0+$/g, "").trim(),
    next: end,
  };
}

/**
 * Live proof: Metaplex metadata PDA exists for this mint with pinned ICHOR
 * name/symbol and the operator-supplied HTTPS URI. Required after mint create
 * on every cluster - an empty URI is a permanent blank token.
 */
export async function verifyIchorMintMetaplexMetadata(params: {
  connection: Connection;
  mint: PublicKey;
  expectedUri: string;
}): Promise<{ metadata: PublicKey; name: string; symbol: string; uri: string }> {
  const mint = requirePublicKey(params.mint, "mint");
  const metadata = ichorMetadataPda(mint);
  const info = await params.connection.getAccountInfo(metadata, "confirmed");
  if (info === null) {
    throw new ClientValidationError("ICHOR_METADATA_MISSING", [
      `Metaplex metadata PDA ${metadata.toBase58()} missing for ICHOR mint ${mint.toBase58()}`,
      "buildCreateIchorMintAccount must include CreateV1; wallets otherwise show Unknown Asset",
    ]);
  }
  if (!info.owner.equals(MPL_TOKEN_METADATA_PROGRAM_ID)) {
    throw new ClientValidationError("ICHOR_METADATA_OWNER", [
      `metadata owner ${info.owner.toBase58()} is not Metaplex Token Metadata`,
    ]);
  }
  const data = info.data instanceof Uint8Array ? info.data : new Uint8Array(info.data);
  if (data.length < 65) {
    throw new ClientValidationError("ICHOR_METADATA_LAYOUT", ["metadata account shorter than mint field"]);
  }
  const mintInAccount = new PublicKey(data.subarray(33, 65));
  if (!mintInAccount.equals(mint)) {
    throw new ClientValidationError("ICHOR_METADATA_MINT", [
      `metadata mint field ${mintInAccount.toBase58()} !== ${mint.toBase58()}`,
    ]);
  }
  const expectedUri = requireIchorMetadataUri(params.expectedUri);
  const name = readBorshString(data, 65);
  const symbol = readBorshString(data, name.next);
  const uri = readBorshString(data, symbol.next);
  if (name.value !== ICHOR_TOKEN_NAME) {
    throw new ClientValidationError("ICHOR_METADATA_NAME", [
      `metadata name ${JSON.stringify(name.value)} !== pinned ${JSON.stringify(ICHOR_TOKEN_NAME)}`,
    ]);
  }
  if (symbol.value !== ICHOR_TOKEN_SYMBOL) {
    throw new ClientValidationError("ICHOR_METADATA_SYMBOL", [
      `metadata symbol ${JSON.stringify(symbol.value)} !== pinned ${JSON.stringify(ICHOR_TOKEN_SYMBOL)}`,
    ]);
  }
  if (uri.value !== expectedUri) {
    throw new ClientValidationError("ICHOR_METADATA_URI", [
      `metadata URI ${JSON.stringify(uri.value)} !== expected ${JSON.stringify(expectedUri)}`,
    ]);
  }
  return { metadata, name: name.value, symbol: symbol.value, uri: uri.value };
}
