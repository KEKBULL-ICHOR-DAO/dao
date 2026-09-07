/**
 * Unsigned throwaway Token-2022 mint for Realms Q3b. Not ICHOR: no
 * program proof, no Config PDA. Payer is mint + withdraw-withheld
 * authority. Freeze is null. TransferFeeConfig is 25 bps / u64::MAX.
 *
 * Also creates the payer's Token-2022 ATA and mintToChecked the operator
 * amount. The mint Keypair is generated in memory, attached as an extra
 * signer, and never logged.
 */

import {
  CLUSTER_GENESIS_HASH,
  ClientValidationError,
  ICHOR_TRANSFER_FEE_MINT_LEN,
  TOKEN_2022_PROGRAM,
  TRANSFER_FEE_BASIS_POINTS,
  TRANSFER_FEE_MAXIMUM_FEE,
  requirePublicKey,
  type ClusterName,
} from "@kekbull/ichor-client";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  createMintToCheckedInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import type { Connection, TransactionInstruction } from "@solana/web3.js";
import { isLocalGovernanceDevHost } from "./config.ts";
import { proveOfficialDevnetConnection, type UnsignedPayload } from "./send.ts";
import {
  THROWAWAY_Q3B_MAXIMUM_FEE,
  THROWAWAY_Q3B_TOKEN_2022_PROGRAM_ID,
  THROWAWAY_Q3B_TRANSFER_FEE_BASIS_POINTS,
  parseThrowawayMintInputs,
} from "./throwaway-mint-inputs.ts";

export interface PrepareThrowawayQ3bMintParams {
  readonly connection: Connection;
  readonly rpcUrl: string;
  readonly cluster: ClusterName;
  readonly hostname: string;
  readonly payer: PublicKey;
  readonly decimalsText: string;
  readonly amountText: string;
}

function requireMintSpace(): number {
  const space = getMintLen([ExtensionType.TransferFeeConfig]);
  if (space !== ICHOR_TRANSFER_FEE_MINT_LEN) {
    throw new ClientValidationError("MINT_LEN_SDK_DRIFT", [
      `getMintLen([TransferFeeConfig]) is ${String(space)}, not pinned ${String(ICHOR_TRANSFER_FEE_MINT_LEN)}`,
    ]);
  }
  return space;
}

function assertThrowawayPolicyPins(): void {
  if (THROWAWAY_Q3B_TRANSFER_FEE_BASIS_POINTS !== TRANSFER_FEE_BASIS_POINTS) {
    throw new ClientValidationError("FEE_BPS_DRIFT", [
      `throwaway mint bps ${String(THROWAWAY_Q3B_TRANSFER_FEE_BASIS_POINTS)} drifted from client ${String(TRANSFER_FEE_BASIS_POINTS)}`,
    ]);
  }
  if (THROWAWAY_Q3B_MAXIMUM_FEE !== TRANSFER_FEE_MAXIMUM_FEE.toString(10)) {
    throw new ClientValidationError("FEE_MAX_DRIFT", [
      "throwaway maximumFee drifted from client TRANSFER_FEE_MAXIMUM_FEE",
    ]);
  }
  if (TOKEN_2022_PROGRAM.id !== THROWAWAY_Q3B_TOKEN_2022_PROGRAM_ID) {
    throw new ClientValidationError("TOKEN_2022_ID_DRIFT", [
      `named Token-2022 ${TOKEN_2022_PROGRAM.id} is not ${THROWAWAY_Q3B_TOKEN_2022_PROGRAM_ID}`,
    ]);
  }
  if (!TOKEN_2022_PROGRAM_ID.equals(new PublicKey(THROWAWAY_Q3B_TOKEN_2022_PROGRAM_ID))) {
    throw new ClientValidationError("TOKEN_2022_SDK_DRIFT", [
      `@solana/spl-token TOKEN_2022_PROGRAM_ID drifted from ${THROWAWAY_Q3B_TOKEN_2022_PROGRAM_ID}`,
    ]);
  }
}

export async function prepareThrowawayQ3bMint(
  params: PrepareThrowawayQ3bMintParams,
): Promise<UnsignedPayload> {
  if (!isLocalGovernanceDevHost(params.hostname)) {
    throw new ClientValidationError("FORBIDDEN_HOST", [
      "throwaway Q3b mint is loopback-only; dao.kekbull.com must never mint throwaways",
    ]);
  }
  if (params.cluster !== "devnet") {
    throw new ClientValidationError("CLUSTER_REFUSED", [
      "throwaway Q3b mint is official-devnet only; mainnet-beta is refused even on loopback",
    ]);
  }
  if (params.rpcUrl.length === 0 || params.connection.rpcEndpoint !== params.rpcUrl) {
    throw new ClientValidationError("CONNECTION_MISMATCH", [
      "throwaway mint must use the exact deployment RPC Connection",
    ]);
  }
  assertThrowawayPolicyPins();
  const { decimals, amountRaw } = parseThrowawayMintInputs(
    params.decimalsText,
    params.amountText,
  );
  const payer = requirePublicKey(params.payer, "payer");
  if (payer.equals(PublicKey.default)) {
    throw new ClientValidationError("DEFAULT_PUBKEY", [
      "payer must not be the default/System Program address",
    ]);
  }
  const measuredGenesisHash = await proveOfficialDevnetConnection(params.connection);
  if (measuredGenesisHash !== CLUSTER_GENESIS_HASH.devnet) {
    throw new ClientValidationError("GENESIS_MISMATCH", [
      `live genesis ${measuredGenesisHash} is not official devnet ${CLUSTER_GENESIS_HASH.devnet}`,
    ]);
  }
  const mint = Keypair.generate();
  try {
    if (payer.equals(mint.publicKey)) {
      throw new ClientValidationError("PAYER_IS_MINT", ["payer and new mint pubkey must differ"]);
    }
    const mintInfo = await params.connection.getAccountInfo(mint.publicKey, "confirmed");
    if (mintInfo !== null) {
      throw new ClientValidationError("MINT_ALREADY_EXISTS", [
        `mint ${mint.publicKey.toBase58()} already has an account`,
      ]);
    }
    const mintSpace = requireMintSpace();
    const rentLamports = await params.connection.getMinimumBalanceForRentExemption(
      mintSpace,
      "confirmed",
    );
    if (!Number.isSafeInteger(rentLamports) || rentLamports <= 0) {
      throw new ClientValidationError("RENT_EXEMPTION", [
        `rent exemption for mint space ${String(mintSpace)} is not a positive measured lamport value`,
      ]);
    }
    const tokenProgram = TOKEN_2022_PROGRAM_ID;
    const ata = getAssociatedTokenAddressSync(mint.publicKey, payer, false, tokenProgram);
    const instructions: TransactionInstruction[] = [
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mint.publicKey,
        lamports: rentLamports,
        space: mintSpace,
        programId: tokenProgram,
      }),
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        payer,
        payer,
        THROWAWAY_Q3B_TRANSFER_FEE_BASIS_POINTS,
        BigInt(THROWAWAY_Q3B_MAXIMUM_FEE),
        tokenProgram,
      ),
      createInitializeMint2Instruction(mint.publicKey, decimals, payer, null, tokenProgram),
      createAssociatedTokenAccountInstruction(
        payer,
        ata,
        payer,
        mint.publicKey,
        tokenProgram,
      ),
      createMintToCheckedInstruction(
        mint.publicKey,
        ata,
        payer,
        BigInt(amountRaw),
        decimals,
        [],
        tokenProgram,
      ),
    ];
    return {
      label: "throwaway Q3b Token-2022 mint (not ICHOR): TransferFeeConfig 25 bps / u64::MAX, freeze null",
      instructions,
      derivedAddresses: {
        mint: mint.publicKey,
        ata,
        tokenProgram,
        payer,
      },
      extraSigners: [mint],
      genesisMode: "official-devnet",
      measuredGenesisHash,
    };
  } catch (error) {
    mint.secretKey.fill(0);
    throw error;
  }
}
