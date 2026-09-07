import {
  AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  createMintToCheckedInstruction,
  createSetAuthorityInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { assertVerifiedIchorProgram, configPda, withdrawWithheldPda } from "./burn.ts";
import {
  ICHOR_TRANSFER_FEE_MINT_LEN,
  parseIchorTransferFeeConfig,
  requireIchorTransferFeeConfig,
  TRANSFER_FEE_BASIS_POINTS,
  TRANSFER_FEE_MAXIMUM_FEE,
} from "./extensions.ts";
import { fetchMintSnapshot, resolveAccountReadCommitment } from "./mint.ts";
import {
  createIchorMetaplexCreateV1Instruction,
  ichorMetadataPda,
  ICHOR_TOKEN_NAME,
  ICHOR_TOKEN_SYMBOL,
  requireIchorMetadataUri,
  verifyIchorMintMetaplexMetadata,
} from "./ichor-metadata.ts";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./network.ts";
import { assertBoundConnection } from "./preflight.ts";
import type {
  AccountReadCommitment,
  AssignCouncilMintAuthorityToGovernanceBuild,
  BootstrapCouncilMintBuild,
  BootstrapCouncilMintRecipient,
  BuildAssignCouncilMintAuthorityToGovernanceParams,
  BuildBootstrapCouncilMintParams,
  BuildIchorMintAccountParams,
  BuildMinimalSupplyCouncilMintParams,
  BuildZeroSupplyCouncilMintParams,
  IchorMintAccountBuild,
  MinimalSupplyCouncilMintBuild,
  UnsignedTransactionBuild,
  VerifiedIchorProgram,
  VerifiedNetwork,
  ZeroSupplyCouncilMintBuild,
} from "./types.ts";
import { ClientValidationError } from "./types.ts";
import {
  assertIchorIsToken2022,
  assertLegacySplMint,
  assertNoSecretMaterial,
  requireNonNegativeInt,
  requirePositiveBn,
  requirePublicKey,
  requireU64Bn,
  U64_MAX,
} from "./validation.ts";

const CALLER_MINT_OVERRIDE_FIELDS = [
  "mintAuthority",
  "freezeAuthority",
  "supply",
  "initialSupply",
  "lamports",
  "space",
  "tokenProgram",
  "tokenProgramId",
] as const;

/** PLAN §13.1 ship-default sink. PDA seeds on the council Tokenkeg program. */
export const COUNCIL_NONVOTING_SINK_SEED = "council-nonvoting-sink";
export const COUNCIL_MINIMAL_SUPPLY_RAW = new BN(1);

/**
 * Deterministic non-voting owner for the parked council base unit.
 * No private key exists. DepositGoverningTokens cannot be signed for it.
 */
export function deriveCouncilNonvotingSink(
  mint: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  const mintKey = requirePublicKey(mint, "mint");
  const program = requireLegacySplTokenProgram(tokenProgram, "council mint owner");
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(COUNCIL_NONVOTING_SINK_SEED), mintKey.toBytes()],
    program,
  )[0];
}

const CALLER_COUNCIL_MINT_OVERRIDE_FIELDS = [
  "freezeAuthority",
  "newAuthority",
  "nextMintAuthority",
  "remainingMintAuthority",
  "supply",
  "initialSupply",
  "totalSupply",
  "totalRawSupply",
  "amount",
  "amounts",
  "lamports",
  "rent",
  "rentExemptionLamports",
  "space",
  "mintSpace",
  "tokenProgram",
  "tokenProgramId",
  "associatedToken",
  "ata",
  "atas",
  "tokenAccount",
  "destination",
  "sink",
  "nonvotingSink",
  "nonvotingSinkAta",
] as const;

const CALLER_RECIPIENT_ATA_FIELDS = ["ata", "associatedToken", "tokenAccount", "destination"] as const;

const U8_MAX = 255;

function assertNoCallerMintOverride(params: object, label: string): void {
  const hits = CALLER_MINT_OVERRIDE_FIELDS.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError("CALLER_MINT_OVERRIDE", [
      `${label} derives mint authority, freeze authority, rent, space, and token program; ${hits.join(", ")} cannot substitute`,
    ]);
  }
}

function assertNoCallerCouncilMintOverride(params: object, label: string): void {
  const hits = CALLER_COUNCIL_MINT_OVERRIDE_FIELDS.filter((field) => field in params);
  if (hits.length > 0) {
    throw new ClientValidationError("CALLER_MINT_OVERRIDE", [
      `${label} derives freeze authority, rent, space, token program, ATAs, and total supply; ${hits.join(", ")} cannot substitute`,
    ]);
  }
}

function requireU8Decimals(value: unknown, label: string): number {
  const decimals = requireNonNegativeInt(value, label);
  if (decimals > U8_MAX) {
    throw new ClientValidationError("MINT_DECIMALS", [
      `${label} ${String(decimals)} are not a valid u8`,
    ]);
  }
  return decimals;
}

function requireToken2022Program(tokenProgramId: PublicKey, label: string): PublicKey {
  const named2022 = new PublicKey(TOKEN_2022_PROGRAM.id);
  if (!tokenProgramId.equals(named2022) || !TOKEN_2022_PROGRAM_ID.equals(named2022)) {
    throw new ClientValidationError("INVALID_TOKEN_PROGRAM", [
      `${label} must be Token-2022 ${TOKEN_2022_PROGRAM.id}`,
    ]);
  }
  if (tokenProgramId.equals(new PublicKey(TOKEN_PROGRAM.id))) {
    throw new ClientValidationError("ICHOR_TOKEN_PROGRAM", [
      `${label} cannot be legacy SPL`,
    ]);
  }
  return tokenProgramId;
}

function requireLegacySplTokenProgram(tokenProgramId: PublicKey, label: string): PublicKey {
  const namedLegacy = new PublicKey(TOKEN_PROGRAM.id);
  if (!tokenProgramId.equals(namedLegacy) || !TOKEN_PROGRAM_ID.equals(namedLegacy)) {
    throw new ClientValidationError("INVALID_TOKEN_PROGRAM", [
      `${label} must be legacy SPL ${TOKEN_PROGRAM.id}`,
    ]);
  }
  if (tokenProgramId.equals(new PublicKey(TOKEN_2022_PROGRAM.id))) {
    throw new ClientValidationError("ICHOR_TOKEN_PROGRAM", [
      `${label} cannot be Token-2022`,
    ]);
  }
  return tokenProgramId;
}

function resolveCouncilVerifiedNetwork(
  params: {
    readonly verified?: VerifiedNetwork;
    readonly verifiedProgram?: VerifiedIchorProgram;
  },
  label: string,
): VerifiedNetwork {
  if (params.verifiedProgram !== undefined && params.verified !== undefined) {
    throw new ClientValidationError("NETWORK_PROOF", [
      "pass exactly one of verified or verifiedProgram, not both",
    ]);
  }
  if (params.verifiedProgram !== undefined) {
    assertVerifiedIchorProgram(params.verifiedProgram);
    return params.verifiedProgram.verified;
  }
  if (params.verified !== undefined) {
    return params.verified;
  }
  throw new ClientValidationError("NETWORK_PROOF", [
    `${label} requires VerifiedNetwork or VerifiedIchorProgram`,
  ]);
}

function unsignedTx(
  feePayer: PublicKey,
  instructions: TransactionInstruction[],
  requiredSignerPubkeys: PublicKey[],
): UnsignedTransactionBuild {
  const transaction = new Transaction();
  transaction.feePayer = feePayer;
  transaction.add(...instructions);
  return { transaction, instructions, requiredSignerPubkeys };
}

function requireIchorMintSpace(): number {
  const space = getMintLen([ExtensionType.TransferFeeConfig]);
  if (space !== ICHOR_TRANSFER_FEE_MINT_LEN) {
    throw new ClientValidationError("MINT_LEN_SDK_DRIFT", [
      `getMintLen([TransferFeeConfig]) is ${String(space)}, not the pinned ${String(ICHOR_TRANSFER_FEE_MINT_LEN)}-byte Token-2022 layout`,
    ]);
  }
  return space;
}

/**
 * Unsigned SystemProgram.createAccount + initializeTransferFeeConfig +
 * initializeMint2 + immutable Metaplex CreateV1 (name/symbol ICHOR + HTTPS
 * URI) + SetAuthority(MintTokens → config PDA) for a new Token-2022 ICHOR
 * mint sized for exactly TransferFeeConfig. Fee config is initialized before
 * the mint. Transfer-fee and withdraw-withheld authorities are the config /
 * withdraw PDAs. Freeze is null. Does not mint supply.
 *
 * CreateV1 requires the live mint authority to sign. The config PDA cannot
 * sign from this client, so initializeMint2 uses the payer as a same-tx
 * temporary mint authority, CreateV1 runs, then SetAuthority hands mint
 * authority to `configPda(programId)`. The transaction is atomic; verify
 * requires the config PDA.
 *
 * Metaplex metadata is mandatory: the ICHOR program rejects MetadataPointer on
 * the mint TLV, so wallet display requires the external metadata PDA. The URI
 * is required and immutable. Signs later, outside this client.
 */
export async function buildCreateIchorMintAccount(
  params: BuildIchorMintAccountParams,
): Promise<IchorMintAccountBuild> {
  assertNoSecretMaterial(params, "buildCreateIchorMintAccount");
  assertNoCallerMintOverride(params, "buildCreateIchorMintAccount");
  assertVerifiedIchorProgram(params.verifiedProgram);
  assertBoundConnection(params.verifiedProgram.verified, params.connection);

  const payer = requirePublicKey(params.payer, "payer");
  const mint = requirePublicKey(params.mint, "mint");
  const decimals = requireU8Decimals(params.decimals, "decimals");
  const metadataUri = requireIchorMetadataUri(params.metadataUri);
  const tokenProgram = requireToken2022Program(
    params.verifiedProgram.verified.network.token2022ProgramId,
    "ICHOR mint owner",
  );
  const { address: configAddress } = configPda(params.verifiedProgram.programId);
  const { address: withdrawAddress } = withdrawWithheldPda(params.verifiedProgram.programId);
  const metadataAddress = ichorMetadataPda(mint);

  if (payer.equals(PublicKey.default) || mint.equals(PublicKey.default)) {
    throw new ClientValidationError("DEFAULT_PUBKEY", [
      "payer and new mint must not be the default/System Program address",
    ]);
  }
  if (payer.equals(mint)) {
    throw new ClientValidationError("PAYER_IS_MINT", ["payer and new mint pubkey must differ"]);
  }
  if (mint.equals(configAddress)) {
    throw new ClientValidationError("MINT_IS_CONFIG", [
      "new mint pubkey cannot be the config PDA; the mint keypair must sign",
    ]);
  }
  if (mint.equals(params.verifiedProgram.programId) || mint.equals(tokenProgram)) {
    throw new ClientValidationError("MINT_IS_PROGRAM", [
      "new mint pubkey cannot be the ICHOR or token program",
    ]);
  }
  if (mint.equals(withdrawAddress) || configAddress.equals(withdrawAddress)) {
    throw new ClientValidationError("MINT_IS_CONFIG", [
      "new mint pubkey cannot be the withdraw-withheld PDA",
    ]);
  }

  const [configInfo, mintInfo, metadataInfo] = await Promise.all([
    params.connection.getAccountInfo(configAddress, "confirmed"),
    params.connection.getAccountInfo(mint, "confirmed"),
    params.connection.getAccountInfo(metadataAddress, "confirmed"),
  ]);
  if (configInfo !== null) {
    throw new ClientValidationError("CONFIG_ALREADY_INITIALIZED", [
      `config PDA ${configAddress.toBase58()} already exists; mint creation is closed after initialize`,
    ]);
  }
  if (mintInfo !== null) {
    throw new ClientValidationError("MINT_ALREADY_EXISTS", [
      `mint ${mint.toBase58()} already has an account`,
    ]);
  }
  if (metadataInfo !== null) {
    throw new ClientValidationError("ICHOR_METADATA_ALREADY_EXISTS", [
      `Metaplex metadata ${metadataAddress.toBase58()} already exists for mint ${mint.toBase58()}`,
    ]);
  }

  const mintSpace = requireIchorMintSpace();
  const rentLamports = await params.connection.getMinimumBalanceForRentExemption(
    mintSpace,
    "confirmed",
  );
  if (!Number.isSafeInteger(rentLamports) || rentLamports <= 0) {
    throw new ClientValidationError("RENT_EXEMPTION", [
      `rent exemption for mint space ${String(mintSpace)} is not a positive measured lamport value`,
    ]);
  }

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer,
    newAccountPubkey: mint,
    lamports: rentLamports,
    space: mintSpace,
    programId: tokenProgram,
  });
  const initializeFeeIx = createInitializeTransferFeeConfigInstruction(
    mint,
    configAddress,
    withdrawAddress,
    TRANSFER_FEE_BASIS_POINTS,
    BigInt(TRANSFER_FEE_MAXIMUM_FEE.toString()),
    tokenProgram,
  );
  const initializeMintIx = createInitializeMint2Instruction(
    mint,
    decimals,
    payer,
    null,
    tokenProgram,
  );
  const createMetadataIx = createIchorMetaplexCreateV1Instruction({
    mint,
    payer,
    decimals,
    metadataUri,
    tokenProgram,
  });
  const handoffMintAuthorityIx = createSetAuthorityInstruction(
    mint,
    payer,
    AuthorityType.MintTokens,
    configAddress,
    [],
    tokenProgram,
  );

  const requiredSignerPubkeys = [payer, mint];
  return {
    unsigned: unsignedTx(
      payer,
      [createAccountIx, initializeFeeIx, initializeMintIx, createMetadataIx, handoffMintAuthorityIx],
      requiredSignerPubkeys,
    ),
    programId: params.verifiedProgram.programId,
    derivedAddresses: {
      mint,
      config: configAddress,
      mintAuthority: configAddress,
      withdrawWithheldAuthority: withdrawAddress,
      tokenProgram,
      metadata: metadataAddress,
    },
    rentExemptionLamports: new BN(rentLamports),
    mintSpace,
    decimals,
    freezeAuthority: null,
    transferFeeBasisPoints: TRANSFER_FEE_BASIS_POINTS,
    maximumFee: TRANSFER_FEE_MAXIMUM_FEE,
    metadataName: ICHOR_TOKEN_NAME,
    metadataSymbol: ICHOR_TOKEN_SYMBOL,
    metadataUri,
  };
}

/** Live post-create proof for the zero-supply Token-2022 ICHOR mint + Metaplex metadata. */
export async function verifyCreatedIchorMintAccount(params: {
  connection: BuildIchorMintAccountParams["connection"];
  verifiedProgram: BuildIchorMintAccountParams["verifiedProgram"];
  mint: PublicKey;
  expectedDecimals: number;
  expectedMetadataUri: string;
}): Promise<{
  mint: PublicKey;
  mintAuthority: PublicKey;
  withdrawWithheldAuthority: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  supply: BN;
  freezeAuthority: null;
  transferFeeBasisPoints: 25;
  maximumFee: BN;
  verified: true;
}> {
  assertNoSecretMaterial(params, "verifyCreatedIchorMintAccount");
  assertVerifiedIchorProgram(params.verifiedProgram);
  assertBoundConnection(params.verifiedProgram.verified, params.connection);
  const mint = requirePublicKey(params.mint, "mint");
  const expectedDecimals = requireU8Decimals(params.expectedDecimals, "expectedDecimals");
  const expectedAuthority = configPda(params.verifiedProgram.programId).address;
  const expectedWithdraw = withdrawWithheldPda(params.verifiedProgram.programId).address;
  const expectedSpace = requireIchorMintSpace();
  const snapshot = await fetchMintSnapshot(
    params.connection,
    params.verifiedProgram.verified.network,
    mint,
  );
  assertIchorIsToken2022(snapshot);
  if (snapshot.dataLength !== expectedSpace) {
    throw new ClientValidationError("ICHOR_MINT_LAYOUT", [
      `ICHOR mint data length ${String(snapshot.dataLength)} is not exact TransferFeeConfig mint len ${String(expectedSpace)}`,
    ]);
  }
  if (snapshot.decimals !== expectedDecimals) {
    throw new ClientValidationError("MINT_DECIMALS", [
      `live ICHOR decimals ${String(snapshot.decimals)} are not expected ${String(expectedDecimals)}`,
    ]);
  }
  if (!snapshot.supply.isZero()) {
    throw new ClientValidationError("ICHOR_SUPPLY_MUST_BE_ZERO", [
      `live ICHOR supply is ${snapshot.supply.toString()}, not zero`,
    ]);
  }
  if (snapshot.mintAuthority === null || !snapshot.mintAuthority.equals(expectedAuthority)) {
    throw new ClientValidationError("MINT_AUTHORITY_MISMATCH", [
      `live ICHOR mint authority is not config PDA ${expectedAuthority.toBase58()}`,
    ]);
  }
  if (snapshot.freezeAuthority !== null) {
    throw new ClientValidationError("FREEZE_AUTHORITY_SET", [
      "live ICHOR freeze authority is not null",
    ]);
  }
  const info = await params.connection.getAccountInfo(mint, "confirmed");
  if (info === null) {
    throw new ClientValidationError("MINT_MISSING", [`mint ${mint.toBase58()} has no account`]);
  }
  requireIchorTransferFeeConfig(
    parseIchorTransferFeeConfig(info.data instanceof Uint8Array ? info.data : new Uint8Array(info.data)),
    expectedAuthority,
    expectedWithdraw,
  );
  const metadata = await verifyIchorMintMetaplexMetadata({
    connection: params.connection,
    mint,
    expectedUri: params.expectedMetadataUri,
  });
  return {
    mint,
    mintAuthority: expectedAuthority,
    withdrawWithheldAuthority: expectedWithdraw,
    tokenProgram: snapshot.ownerProgram,
    decimals: snapshot.decimals,
    supply: snapshot.supply,
    freezeAuthority: null,
    transferFeeBasisPoints: TRANSFER_FEE_BASIS_POINTS,
    maximumFee: TRANSFER_FEE_MAXIMUM_FEE,
    metadata: metadata.metadata,
    metadataName: metadata.name,
    metadataSymbol: metadata.symbol,
    verified: true,
  };
}

/**
 * Unsigned SystemProgram.createAccount + initializeMint2 + recipient ATAs +
 * MintToChecked for a fixed-supply bootstrap council mint. Freeze authority is
 * null. Mint authority remains the current mint authority so it can be assigned
 * to the verified Governance PDA after that account exists. Does not select
 * council members or amounts. Signs later, outside this client.
 */
export async function buildCreateBootstrapCouncilMint(
  params: BuildBootstrapCouncilMintParams,
): Promise<BootstrapCouncilMintBuild> {
  assertNoSecretMaterial(params, "buildCreateBootstrapCouncilMint");
  assertNoCallerCouncilMintOverride(params, "buildCreateBootstrapCouncilMint");
  const verified = resolveCouncilVerifiedNetwork(params, "buildCreateBootstrapCouncilMint");
  assertBoundConnection(verified, params.connection);

  const payer = requirePublicKey(params.payer, "payer");
  const mint = requirePublicKey(params.mint, "mint");
  const mintAuthority = requirePublicKey(params.mintAuthority, "mintAuthority");
  const decimals = requireU8Decimals(params.decimals, "decimals");
  const tokenProgram = requireLegacySplTokenProgram(verified.network.tokenProgramId, "council mint owner");

  if (
    payer.equals(PublicKey.default) ||
    mint.equals(PublicKey.default) ||
    mintAuthority.equals(PublicKey.default)
  ) {
    throw new ClientValidationError("DEFAULT_PUBKEY", [
      "payer, new mint, and mint authority must not be the default/System Program address",
    ]);
  }
  if (payer.equals(mint)) {
    throw new ClientValidationError("PAYER_IS_MINT", ["payer and new mint pubkey must differ"]);
  }
  if (mint.equals(tokenProgram) || mint.equals(new PublicKey(TOKEN_2022_PROGRAM.id))) {
    throw new ClientValidationError("MINT_IS_PROGRAM", [
      "new mint pubkey cannot be the token program",
    ]);
  }

  if (!Array.isArray(params.recipients) || params.recipients.length === 0) {
    throw new ClientValidationError("RECIPIENTS_EMPTY", [
      "bootstrap council mint requires a nonempty operator-selected recipient list",
    ]);
  }

  const recipients: { owner: PublicKey; amount: BN; ata: PublicKey }[] = [];
  const seenOwners = new Set<string>();
  let totalRawSupply = new BN(0);
  for (let i = 0; i < params.recipients.length; i += 1) {
    const row = params.recipients[i];
    if (row === null || typeof row !== "object") {
      throw new ClientValidationError("INVALID_RECIPIENT", [
        `recipients[${String(i)}] must be { owner, amount }`,
      ]);
    }
    const record = row as Record<string, unknown>;
    const ataHits = CALLER_RECIPIENT_ATA_FIELDS.filter((field) => field in record);
    if (ataHits.length > 0) {
      throw new ClientValidationError("CALLER_ATA", [
        `recipients[${String(i)}] ATA is derived; ${ataHits.join(", ")} cannot substitute`,
      ]);
    }
    const owner = requirePublicKey(record.owner, `recipients[${String(i)}].owner`);
    if (owner.equals(PublicKey.default)) {
      throw new ClientValidationError("DEFAULT_PUBKEY", [
        `recipients[${String(i)}].owner must not be the default/System Program address`,
      ]);
    }
    const amount = requireU64Bn(
      requirePositiveBn(record.amount, `recipients[${String(i)}].amount`),
      `recipients[${String(i)}].amount`,
    );
    const recipient = {
      owner,
      amount,
      ata: getAssociatedTokenAddressSync(mint, owner, true, tokenProgram),
    };
    const ownerKey = recipient.owner.toBase58();
    if (seenOwners.has(ownerKey)) {
      throw new ClientValidationError("DUPLICATE_RECIPIENT", [
        `recipient ${ownerKey} appears more than once`,
      ]);
    }
    seenOwners.add(ownerKey);
    const nextTotal = totalRawSupply.add(recipient.amount);
    if (nextTotal.gt(U64_MAX)) {
      throw new ClientValidationError("ARITHMETIC_OVERFLOW", [
        "recipient raw amounts overflow u64 total supply",
      ]);
    }
    totalRawSupply = nextTotal;
    recipients.push(recipient);
  }

  const mintInfo = await params.connection.getAccountInfo(mint, "confirmed");
  if (mintInfo !== null) {
    throw new ClientValidationError("MINT_ALREADY_EXISTS", [
      `mint ${mint.toBase58()} already has an account`,
    ]);
  }

  const rentLamports = await params.connection.getMinimumBalanceForRentExemption(
    MINT_SIZE,
    "confirmed",
  );
  if (!Number.isSafeInteger(rentLamports) || rentLamports <= 0) {
    throw new ClientValidationError("RENT_EXEMPTION", [
      `rent exemption for mint space ${String(MINT_SIZE)} is not a positive measured lamport value`,
    ]);
  }

  const instructions: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      lamports: rentLamports,
      space: MINT_SIZE,
      programId: tokenProgram,
    }),
    createInitializeMint2Instruction(mint, decimals, mintAuthority, null, tokenProgram),
  ];
  for (const recipient of recipients) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        recipient.ata,
        recipient.owner,
        mint,
        tokenProgram,
      ),
    );
  }
  for (const recipient of recipients) {
    instructions.push(
      createMintToCheckedInstruction(
        mint,
        recipient.ata,
        mintAuthority,
        BigInt(recipient.amount.toString()),
        decimals,
        [],
        tokenProgram,
      ),
    );
  }

  const requiredSignerPubkeys = [payer, mint];
  if (!requiredSignerPubkeys.some((key) => key.equals(mintAuthority))) {
    requiredSignerPubkeys.push(mintAuthority);
  }
  return {
    unsigned: unsignedTx(payer, instructions, requiredSignerPubkeys),
    derivedAddresses: {
      mint,
      tokenProgram,
      recipientAtas: recipients.map((recipient) => recipient.ata),
    },
    rentExemptionLamports: new BN(rentLamports),
    mintSpace: MINT_SIZE,
    decimals,
    totalRawSupply,
    freezeAuthority: null,
    mintAuthority,
    recipients,
  };
}

/** Live post-create proof that council supply is fixed and distributed exactly. */
export async function verifyCreatedBootstrapCouncilMint(params: {
  connection: BuildBootstrapCouncilMintParams["connection"];
  verified: VerifiedNetwork;
  mint: PublicKey;
  expectedDecimals: number;
  expectedMintAuthority: PublicKey;
  expectedRecipients: readonly BootstrapCouncilMintRecipient[];
}): Promise<{
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  totalRawSupply: BN;
  mintAuthority: PublicKey;
  freezeAuthority: null;
  recipients: readonly { owner: PublicKey; ata: PublicKey; amount: BN }[];
  verified: true;
}> {
  assertNoSecretMaterial(params, "verifyCreatedBootstrapCouncilMint");
  assertBoundConnection(params.verified, params.connection);
  const mint = requirePublicKey(params.mint, "mint");
  const expectedDecimals = requireU8Decimals(params.expectedDecimals, "expectedDecimals");
  const expectedMintAuthority = requirePublicKey(
    params.expectedMintAuthority,
    "expectedMintAuthority",
  );
  if (expectedMintAuthority.equals(PublicKey.default)) {
    throw new ClientValidationError("DEFAULT_PUBKEY", [
      "expected mint authority must not be the default/System Program address",
    ]);
  }
  if (!Array.isArray(params.expectedRecipients) || params.expectedRecipients.length === 0) {
    throw new ClientValidationError("RECIPIENTS_EMPTY", [
      "expected council recipients are required for post-create verification",
    ]);
  }
  const tokenProgram = requireLegacySplTokenProgram(
    params.verified.network.tokenProgramId,
    "council mint owner",
  );
  const snapshot = await fetchMintSnapshot(
    params.connection,
    params.verified.network,
    mint,
  );
  assertLegacySplMint(snapshot, "council mint");
  if (!snapshot.ownerProgram.equals(tokenProgram) || snapshot.dataLength !== MINT_SIZE) {
    throw new ClientValidationError("INVALID_TOKEN_PROGRAM", [
      "live council mint is not the exact legacy SPL mint layout",
    ]);
  }
  if (snapshot.decimals !== expectedDecimals) {
    throw new ClientValidationError("MINT_DECIMALS", [
      `live council decimals ${String(snapshot.decimals)} are not expected ${String(expectedDecimals)}`,
    ]);
  }
  if (snapshot.freezeAuthority !== null) {
    throw new ClientValidationError("COUNCIL_FREEZE_AUTHORITY_SET", [
      "live council mint freeze authority must be null",
    ]);
  }
  if (
    snapshot.mintAuthority === null ||
    !snapshot.mintAuthority.equals(expectedMintAuthority)
  ) {
    throw new ClientValidationError("COUNCIL_MINT_AUTHORITY_NOT_RETAINED", [
      "live council mint authority must remain the current mint authority until assigned to Governance",
    ]);
  }

  const seen = new Set<string>();
  let expectedTotal = new BN(0);
  const expected = params.expectedRecipients.map((row, index) => {
    const owner = requirePublicKey(row.owner, `expectedRecipients[${String(index)}].owner`);
    if (owner.equals(PublicKey.default) || seen.has(owner.toBase58())) {
      throw new ClientValidationError("INVALID_RECIPIENT", [
        `expectedRecipients[${String(index)}] is default or duplicated`,
      ]);
    }
    seen.add(owner.toBase58());
    const amount = requireU64Bn(
      requirePositiveBn(row.amount, `expectedRecipients[${String(index)}].amount`),
      `expectedRecipients[${String(index)}].amount`,
    );
    expectedTotal = expectedTotal.add(amount);
    if (expectedTotal.gt(U64_MAX)) {
      throw new ClientValidationError("ARITHMETIC_OVERFLOW", [
        "expected council distribution exceeds u64 supply",
      ]);
    }
    return {
      owner,
      amount,
      ata: getAssociatedTokenAddressSync(mint, owner, true, tokenProgram),
    };
  });
  if (!snapshot.supply.eq(expectedTotal)) {
    throw new ClientValidationError("COUNCIL_SUPPLY_MISMATCH", [
      `live supply ${snapshot.supply.toString()} is not expected ${expectedTotal.toString()}`,
    ]);
  }

  const accounts = await Promise.all(
    expected.map(async (row) => {
      const info = await params.connection.getAccountInfo(row.ata, "confirmed");
      if (info === null) {
        throw new ClientValidationError("COUNCIL_ATA_MISSING", [
          `council ATA ${row.ata.toBase58()} is missing`,
        ]);
      }
      const account = unpackAccount(row.ata, info, tokenProgram);
      if (
        !account.mint.equals(mint) ||
        !account.owner.equals(row.owner) ||
        account.isFrozen ||
        account.amount.toString() !== row.amount.toString()
      ) {
        throw new ClientValidationError("COUNCIL_DISTRIBUTION_MISMATCH", [
          `council ATA ${row.ata.toBase58()} does not hold the exact expected amount`,
        ]);
      }
      return row;
    }),
  );

  return {
    mint,
    tokenProgram,
    decimals: snapshot.decimals,
    totalRawSupply: snapshot.supply,
    mintAuthority: snapshot.mintAuthority,
    freezeAuthority: null,
    recipients: accounts,
    verified: true,
  };
}

/**
 * Unsigned SystemProgram.createAccount + initializeMint2 for a zero-supply
 * council mint. No recipients, ATA, or MintTo. Freeze is null. Mint authority
 * remains currentMintAuthority so it can be assigned to the Governance PDA
 * after that account exists. Signs later, outside this client.
 */
export async function buildCreateZeroSupplyCouncilMint(
  params: BuildZeroSupplyCouncilMintParams,
): Promise<ZeroSupplyCouncilMintBuild> {
  assertNoSecretMaterial(params, "buildCreateZeroSupplyCouncilMint");
  assertNoCallerCouncilMintOverride(params, "buildCreateZeroSupplyCouncilMint");
  if ("recipients" in params) {
    throw new ClientValidationError("ZERO_SUPPLY_RECIPIENTS_FORBIDDEN", [
      "zero-supply council mint refuses recipients; use buildCreateBootstrapCouncilMint for a fixed-supply mint",
    ]);
  }
  const verified = resolveCouncilVerifiedNetwork(params, "buildCreateZeroSupplyCouncilMint");
  assertBoundConnection(verified, params.connection);

  const payer = requirePublicKey(params.payer, "payer");
  const mint = requirePublicKey(params.mint, "mint");
  const mintAuthority = requirePublicKey(params.mintAuthority, "mintAuthority");
  const decimals = requireU8Decimals(params.decimals, "decimals");
  const tokenProgram = requireLegacySplTokenProgram(verified.network.tokenProgramId, "council mint owner");

  if (
    payer.equals(PublicKey.default) ||
    mint.equals(PublicKey.default) ||
    mintAuthority.equals(PublicKey.default)
  ) {
    throw new ClientValidationError("DEFAULT_PUBKEY", [
      "payer, new mint, and mint authority must not be the default/System Program address",
    ]);
  }
  if (payer.equals(mint)) {
    throw new ClientValidationError("PAYER_IS_MINT", ["payer and new mint pubkey must differ"]);
  }
  if (mint.equals(tokenProgram) || mint.equals(new PublicKey(TOKEN_2022_PROGRAM.id))) {
    throw new ClientValidationError("MINT_IS_PROGRAM", [
      "new mint pubkey cannot be the token program",
    ]);
  }

  const mintInfo = await params.connection.getAccountInfo(mint, "confirmed");
  if (mintInfo !== null) {
    throw new ClientValidationError("MINT_ALREADY_EXISTS", [
      `mint ${mint.toBase58()} already has an account`,
    ]);
  }

  const rentLamports = await params.connection.getMinimumBalanceForRentExemption(
    MINT_SIZE,
    "confirmed",
  );
  if (!Number.isSafeInteger(rentLamports) || rentLamports <= 0) {
    throw new ClientValidationError("RENT_EXEMPTION", [
      `rent exemption for mint space ${String(MINT_SIZE)} is not a positive measured lamport value`,
    ]);
  }

  const instructions: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      lamports: rentLamports,
      space: MINT_SIZE,
      programId: tokenProgram,
    }),
    createInitializeMint2Instruction(mint, decimals, mintAuthority, null, tokenProgram),
  ];

  const requiredSignerPubkeys = [payer, mint];
  if (!requiredSignerPubkeys.some((key) => key.equals(mintAuthority))) {
    requiredSignerPubkeys.push(mintAuthority);
  }
  return {
    unsigned: unsignedTx(payer, instructions, requiredSignerPubkeys),
    derivedAddresses: {
      mint,
      tokenProgram,
    },
    rentExemptionLamports: new BN(rentLamports),
    mintSpace: MINT_SIZE,
    decimals,
    totalRawSupply: new BN(0),
    freezeAuthority: null,
    mintAuthority,
  };
}

/** Live post-create proof that council supply is zero, freeze is null, mint authority retained. */
export async function verifyCreatedZeroSupplyCouncilMint(params: {
  connection: BuildZeroSupplyCouncilMintParams["connection"];
  verified: VerifiedNetwork;
  mint: PublicKey;
  expectedDecimals: number;
  expectedMintAuthority: PublicKey;
  commitment?: AccountReadCommitment;
}): Promise<{
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  totalRawSupply: BN;
  mintAuthority: PublicKey;
  freezeAuthority: null;
  verified: true;
}> {
  assertNoSecretMaterial(params, "verifyCreatedZeroSupplyCouncilMint");
  assertBoundConnection(params.verified, params.connection);
  const mint = requirePublicKey(params.mint, "mint");
  const expectedDecimals = requireU8Decimals(params.expectedDecimals, "expectedDecimals");
  const expectedMintAuthority = requirePublicKey(
    params.expectedMintAuthority,
    "expectedMintAuthority",
  );
  if (expectedMintAuthority.equals(PublicKey.default)) {
    throw new ClientValidationError("DEFAULT_PUBKEY", [
      "expected mint authority must not be the default/System Program address",
    ]);
  }
  const tokenProgram = requireLegacySplTokenProgram(
    params.verified.network.tokenProgramId,
    "council mint owner",
  );
  const snapshot = await fetchMintSnapshot(
    params.connection,
    params.verified.network,
    mint,
    resolveAccountReadCommitment(params.commitment),
  );
  assertLegacySplMint(snapshot, "council mint");
  if (!snapshot.ownerProgram.equals(tokenProgram) || snapshot.dataLength !== MINT_SIZE) {
    throw new ClientValidationError("INVALID_TOKEN_PROGRAM", [
      "live council mint is not the exact legacy SPL mint layout",
    ]);
  }
  if (snapshot.decimals !== expectedDecimals) {
    throw new ClientValidationError("MINT_DECIMALS", [
      `live council decimals ${String(snapshot.decimals)} are not expected ${String(expectedDecimals)}`,
    ]);
  }
  if (snapshot.freezeAuthority !== null) {
    throw new ClientValidationError("COUNCIL_FREEZE_AUTHORITY_SET", [
      "live council mint freeze authority must be null",
    ]);
  }
  if (
    snapshot.mintAuthority === null ||
    !snapshot.mintAuthority.equals(expectedMintAuthority)
  ) {
    throw new ClientValidationError("COUNCIL_MINT_AUTHORITY_NOT_RETAINED", [
      "live council mint authority must remain the current mint authority until assigned to Governance",
    ]);
  }
  if (!snapshot.supply.isZero()) {
    throw new ClientValidationError("COUNCIL_SUPPLY_NOT_ZERO", [
      `live council supply ${snapshot.supply.toString()} is not zero`,
    ]);
  }

  return {
    mint,
    tokenProgram,
    decimals: snapshot.decimals,
    totalRawSupply: snapshot.supply,
    mintAuthority: snapshot.mintAuthority,
    freezeAuthority: null,
    verified: true,
  };
}

/**
 * Unsigned SystemProgram.createAccount + initializeMint2 + sink ATA +
 * MintToChecked(1) for the PLAN §13.1 ship-default council mint. The one
 * base unit is parked at a derived non-voting sink (no private key). Freeze
 * is null. Mint authority remains currentMintAuthority so it can be assigned
 * to the Governance PDA after that account exists. Signs later, outside this
 * client. Zero-supply remains the 0.11 measurement builder.
 */
export async function buildCreateMinimalSupplyCouncilMint(
  params: BuildMinimalSupplyCouncilMintParams,
): Promise<MinimalSupplyCouncilMintBuild> {
  assertNoSecretMaterial(params, "buildCreateMinimalSupplyCouncilMint");
  assertNoCallerCouncilMintOverride(params, "buildCreateMinimalSupplyCouncilMint");
  if ("recipients" in params) {
    throw new ClientValidationError("MINIMAL_SUPPLY_RECIPIENTS_FORBIDDEN", [
      "minimal-supply council mint parks one unit at the derived non-voting sink; recipients are refused",
    ]);
  }
  const verified = resolveCouncilVerifiedNetwork(params, "buildCreateMinimalSupplyCouncilMint");
  assertBoundConnection(verified, params.connection);

  const payer = requirePublicKey(params.payer, "payer");
  const mint = requirePublicKey(params.mint, "mint");
  const mintAuthority = requirePublicKey(params.mintAuthority, "mintAuthority");
  const decimals = requireU8Decimals(params.decimals, "decimals");
  const tokenProgram = requireLegacySplTokenProgram(verified.network.tokenProgramId, "council mint owner");
  const nonvotingSink = deriveCouncilNonvotingSink(mint, tokenProgram);
  const nonvotingSinkAta = getAssociatedTokenAddressSync(mint, nonvotingSink, true, tokenProgram);

  if (
    payer.equals(PublicKey.default) ||
    mint.equals(PublicKey.default) ||
    mintAuthority.equals(PublicKey.default) ||
    nonvotingSink.equals(PublicKey.default)
  ) {
    throw new ClientValidationError("DEFAULT_PUBKEY", [
      "payer, new mint, mint authority, and derived sink must not be the default/System Program address",
    ]);
  }
  if (payer.equals(mint)) {
    throw new ClientValidationError("PAYER_IS_MINT", ["payer and new mint pubkey must differ"]);
  }
  if (mint.equals(tokenProgram) || mint.equals(new PublicKey(TOKEN_2022_PROGRAM.id))) {
    throw new ClientValidationError("MINT_IS_PROGRAM", [
      "new mint pubkey cannot be the token program",
    ]);
  }
  if (payer.equals(nonvotingSink) || mintAuthority.equals(nonvotingSink) || mint.equals(nonvotingSink)) {
    throw new ClientValidationError("SINK_COLLIDES", [
      "derived council non-voting sink must not equal payer, mint authority, or mint",
    ]);
  }

  const mintInfo = await params.connection.getAccountInfo(mint, "confirmed");
  if (mintInfo !== null) {
    throw new ClientValidationError("MINT_ALREADY_EXISTS", [
      `mint ${mint.toBase58()} already has an account`,
    ]);
  }

  const rentLamports = await params.connection.getMinimumBalanceForRentExemption(
    MINT_SIZE,
    "confirmed",
  );
  if (!Number.isSafeInteger(rentLamports) || rentLamports <= 0) {
    throw new ClientValidationError("RENT_EXEMPTION", [
      `rent exemption for mint space ${String(MINT_SIZE)} is not a positive measured lamport value`,
    ]);
  }

  const instructions: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      lamports: rentLamports,
      space: MINT_SIZE,
      programId: tokenProgram,
    }),
    createInitializeMint2Instruction(mint, decimals, mintAuthority, null, tokenProgram),
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      nonvotingSinkAta,
      nonvotingSink,
      mint,
      tokenProgram,
    ),
    createMintToCheckedInstruction(
      mint,
      nonvotingSinkAta,
      mintAuthority,
      BigInt(COUNCIL_MINIMAL_SUPPLY_RAW.toString()),
      decimals,
      [],
      tokenProgram,
    ),
  ];

  const requiredSignerPubkeys = [payer, mint];
  if (!requiredSignerPubkeys.some((key) => key.equals(mintAuthority))) {
    requiredSignerPubkeys.push(mintAuthority);
  }
  return {
    unsigned: unsignedTx(payer, instructions, requiredSignerPubkeys),
    derivedAddresses: {
      mint,
      tokenProgram,
      nonvotingSink,
      nonvotingSinkAta,
    },
    rentExemptionLamports: new BN(rentLamports),
    mintSpace: MINT_SIZE,
    decimals,
    totalRawSupply: COUNCIL_MINIMAL_SUPPLY_RAW.clone(),
    freezeAuthority: null,
    mintAuthority,
  };
}

/**
 * Live post-create (or post-assign) proof that council supply is exactly one
 * parked base unit, freeze is null, and mint authority matches expected.
 */
export async function verifyCreatedMinimalSupplyCouncilMint(params: {
  connection: BuildMinimalSupplyCouncilMintParams["connection"];
  verified: VerifiedNetwork;
  mint: PublicKey;
  expectedDecimals: number;
  expectedMintAuthority: PublicKey;
}): Promise<{
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  totalRawSupply: BN;
  mintAuthority: PublicKey;
  freezeAuthority: null;
  nonvotingSink: PublicKey;
  nonvotingSinkAta: PublicKey;
  verified: true;
}> {
  assertNoSecretMaterial(params, "verifyCreatedMinimalSupplyCouncilMint");
  assertBoundConnection(params.verified, params.connection);
  const mint = requirePublicKey(params.mint, "mint");
  const expectedDecimals = requireU8Decimals(params.expectedDecimals, "expectedDecimals");
  const expectedMintAuthority = requirePublicKey(
    params.expectedMintAuthority,
    "expectedMintAuthority",
  );
  if (expectedMintAuthority.equals(PublicKey.default)) {
    throw new ClientValidationError("DEFAULT_PUBKEY", [
      "expected mint authority must not be the default/System Program address",
    ]);
  }
  const tokenProgram = requireLegacySplTokenProgram(
    params.verified.network.tokenProgramId,
    "council mint owner",
  );
  const nonvotingSink = deriveCouncilNonvotingSink(mint, tokenProgram);
  const nonvotingSinkAta = getAssociatedTokenAddressSync(mint, nonvotingSink, true, tokenProgram);
  const snapshot = await fetchMintSnapshot(
    params.connection,
    params.verified.network,
    mint,
  );
  assertLegacySplMint(snapshot, "council mint");
  if (!snapshot.ownerProgram.equals(tokenProgram) || snapshot.dataLength !== MINT_SIZE) {
    throw new ClientValidationError("INVALID_TOKEN_PROGRAM", [
      "live council mint is not the exact legacy SPL mint layout",
    ]);
  }
  if (snapshot.decimals !== expectedDecimals) {
    throw new ClientValidationError("MINT_DECIMALS", [
      `live council decimals ${String(snapshot.decimals)} are not expected ${String(expectedDecimals)}`,
    ]);
  }
  if (snapshot.freezeAuthority !== null) {
    throw new ClientValidationError("COUNCIL_FREEZE_AUTHORITY_SET", [
      "live council mint freeze authority must be null",
    ]);
  }
  if (
    snapshot.mintAuthority === null ||
    !snapshot.mintAuthority.equals(expectedMintAuthority)
  ) {
    throw new ClientValidationError("COUNCIL_MINT_AUTHORITY_NOT_RETAINED", [
      "live council mint authority must match the expected authority",
    ]);
  }
  if (!snapshot.supply.eq(COUNCIL_MINIMAL_SUPPLY_RAW)) {
    throw new ClientValidationError("COUNCIL_SUPPLY_NOT_MINIMAL", [
      `live council supply ${snapshot.supply.toString()} is not the parked one base unit`,
    ]);
  }

  const ataInfo = await params.connection.getAccountInfo(nonvotingSinkAta, "confirmed");
  if (ataInfo === null) {
    throw new ClientValidationError("COUNCIL_SINK_ATA_MISSING", [
      `council non-voting sink ATA ${nonvotingSinkAta.toBase58()} is missing`,
    ]);
  }
  const account = unpackAccount(nonvotingSinkAta, ataInfo, tokenProgram);
  if (
    !account.mint.equals(mint) ||
    !account.owner.equals(nonvotingSink) ||
    account.isFrozen ||
    account.amount.toString() !== COUNCIL_MINIMAL_SUPPLY_RAW.toString()
  ) {
    throw new ClientValidationError("COUNCIL_SINK_NOT_PARKED", [
      `council sink ATA ${nonvotingSinkAta.toBase58()} does not hold the parked one base unit`,
    ]);
  }

  return {
    mint,
    tokenProgram,
    decimals: snapshot.decimals,
    totalRawSupply: snapshot.supply,
    mintAuthority: snapshot.mintAuthority,
    freezeAuthority: null,
    nonvotingSink,
    nonvotingSinkAta,
    verified: true,
  };
}

/**
 * Unsigned SetAuthority(MintTokens, governance) for a live bootstrap council
 * mint. Governance pubkey is taken only from the issued identity. Freeze stays
 * null. Current mint authority must sign. Does not invent Governance addresses.
 */
export async function buildAssignCouncilMintAuthorityToGovernance(
  params: BuildAssignCouncilMintAuthorityToGovernanceParams,
): Promise<AssignCouncilMintAuthorityToGovernanceBuild> {
  assertNoSecretMaterial(params, "buildAssignCouncilMintAuthorityToGovernance");
  // Lazy: realms.ts named-imports CJS @realms-today/spl-governance. Loading
  // that graph at module init breaks bn.js on the Node 22 mint+init send path.
  const { assertVerifiedGovernanceIdentity } = await import("./realms.ts");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  const verified = params.verifiedGovernance.verifiedRealm.verified;
  assertBoundConnection(verified, params.connection);

  const payer = requirePublicKey(params.payer, "payer");
  const mint = requirePublicKey(params.mint, "mint");
  const currentMintAuthority = requirePublicKey(
    params.currentMintAuthority,
    "currentMintAuthority",
  );
  const governance = requirePublicKey(
    params.verifiedGovernance.governance,
    "verifiedGovernance.governance",
  );
  const tokenProgram = requireLegacySplTokenProgram(
    verified.network.tokenProgramId,
    "council mint owner",
  );

  if (
    payer.equals(PublicKey.default) ||
    mint.equals(PublicKey.default) ||
    currentMintAuthority.equals(PublicKey.default) ||
    governance.equals(PublicKey.default)
  ) {
    throw new ClientValidationError("DEFAULT_PUBKEY", [
      "payer, council mint, current mint authority, and Governance PDA must not be the default/System Program address",
    ]);
  }

  const councilMint = params.verifiedGovernance.verifiedRealm.councilMint;
  if (councilMint === null) {
    throw new ClientValidationError("COUNCIL_MINT_MISSING", [
      "verified Realm has no council mint; cannot assign mint authority",
    ]);
  }
  if (!councilMint.equals(mint)) {
    throw new ClientValidationError("COUNCIL_MINT_MISMATCH", [
      `mint ${mint.toBase58()} is not the verified Realm council mint ${councilMint.toBase58()}`,
    ]);
  }

  const snapshot = await fetchMintSnapshot(
    params.connection,
    verified.network,
    mint,
    resolveAccountReadCommitment(params.commitment),
  );
  assertLegacySplMint(snapshot, "council mint");
  if (!snapshot.ownerProgram.equals(tokenProgram) || snapshot.dataLength !== MINT_SIZE) {
    throw new ClientValidationError("INVALID_TOKEN_PROGRAM", [
      "live council mint is not the exact legacy SPL mint layout",
    ]);
  }
  if (snapshot.freezeAuthority !== null) {
    throw new ClientValidationError("COUNCIL_FREEZE_AUTHORITY_SET", [
      "live council mint freeze authority must be null",
    ]);
  }
  if (snapshot.mintAuthority === null) {
    throw new ClientValidationError("COUNCIL_MINT_AUTHORITY_REVOKED", [
      "live council mint authority is null; it cannot be assigned to Governance",
    ]);
  }
  if (!snapshot.mintAuthority.equals(currentMintAuthority)) {
    throw new ClientValidationError("COUNCIL_MINT_AUTHORITY_MISMATCH", [
      `live mint authority ${snapshot.mintAuthority.toBase58()} !== currentMintAuthority ${currentMintAuthority.toBase58()}`,
    ]);
  }
  if (currentMintAuthority.equals(governance)) {
    throw new ClientValidationError("COUNCIL_MINT_AUTHORITY_ALREADY_GOVERNANCE", [
      "current mint authority is already the Governance PDA",
    ]);
  }

  const instructions = [
    createSetAuthorityInstruction(
      mint,
      currentMintAuthority,
      AuthorityType.MintTokens,
      governance,
      [],
      tokenProgram,
    ),
  ];
  const requiredSignerPubkeys = [payer];
  if (!requiredSignerPubkeys.some((key) => key.equals(currentMintAuthority))) {
    requiredSignerPubkeys.push(currentMintAuthority);
  }
  return {
    unsigned: unsignedTx(payer, instructions, requiredSignerPubkeys),
    mint,
    currentMintAuthority,
    newMintAuthority: governance,
    freezeAuthority: null,
    tokenProgram,
  };
}

/** Live proof that council mint authority is the issued Governance PDA and freeze is null. */
export async function verifyCouncilMintAuthorityAssignedToGovernance(params: {
  connection: BuildAssignCouncilMintAuthorityToGovernanceParams["connection"];
  verifiedGovernance: BuildAssignCouncilMintAuthorityToGovernanceParams["verifiedGovernance"];
  mint: PublicKey;
  commitment?: AccountReadCommitment;
}): Promise<{
  mint: PublicKey;
  mintAuthority: PublicKey;
  freezeAuthority: null;
  tokenProgram: PublicKey;
  verified: true;
}> {
  assertNoSecretMaterial(params, "verifyCouncilMintAuthorityAssignedToGovernance");
  const { assertVerifiedGovernanceIdentity } = await import("./realms.ts");
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  const verified = params.verifiedGovernance.verifiedRealm.verified;
  assertBoundConnection(verified, params.connection);
  const mint = requirePublicKey(params.mint, "mint");
  const governance = requirePublicKey(
    params.verifiedGovernance.governance,
    "verifiedGovernance.governance",
  );
  if (mint.equals(PublicKey.default) || governance.equals(PublicKey.default)) {
    throw new ClientValidationError("DEFAULT_PUBKEY", [
      "council mint and Governance PDA must not be the default/System Program address",
    ]);
  }
  const councilMint = params.verifiedGovernance.verifiedRealm.councilMint;
  if (councilMint === null || !councilMint.equals(mint)) {
    throw new ClientValidationError("COUNCIL_MINT_MISMATCH", [
      "mint is not the verified Realm council mint",
    ]);
  }
  const tokenProgram = requireLegacySplTokenProgram(
    verified.network.tokenProgramId,
    "council mint owner",
  );
  const snapshot = await fetchMintSnapshot(
    params.connection,
    verified.network,
    mint,
    resolveAccountReadCommitment(params.commitment),
  );
  assertLegacySplMint(snapshot, "council mint");
  if (!snapshot.ownerProgram.equals(tokenProgram) || snapshot.dataLength !== MINT_SIZE) {
    throw new ClientValidationError("INVALID_TOKEN_PROGRAM", [
      "live council mint is not the exact legacy SPL mint layout",
    ]);
  }
  if (snapshot.freezeAuthority !== null) {
    throw new ClientValidationError("COUNCIL_FREEZE_AUTHORITY_SET", [
      "live council mint freeze authority must be null",
    ]);
  }
  if (snapshot.mintAuthority === null || !snapshot.mintAuthority.equals(governance)) {
    throw new ClientValidationError("COUNCIL_MINT_AUTHORITY_NOT_GOVERNANCE", [
      "live council mint authority must be the Governance PDA",
    ]);
  }
  return {
    mint,
    mintAuthority: snapshot.mintAuthority,
    freezeAuthority: null,
    tokenProgram,
    verified: true,
  };
}
