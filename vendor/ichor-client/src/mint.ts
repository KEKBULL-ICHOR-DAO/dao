import { unpackMint } from "@solana/spl-token";
import type { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { AccountReadCommitment, MintSnapshot, NetworkConfig, TokenProgramKind } from "./types.ts";
import { ClientValidationError } from "./types.ts";
import { assertMintSnapshot } from "./validation.ts";

const MINT_BASE_LEN = 82;

export const DEFAULT_ACCOUNT_READ_COMMITMENT: AccountReadCommitment = "confirmed";

export function resolveAccountReadCommitment(
  commitment: AccountReadCommitment | undefined,
): AccountReadCommitment {
  return commitment ?? DEFAULT_ACCOUNT_READ_COMMITMENT;
}

function tokenProgramKind(owner: PublicKey, network: NetworkConfig): TokenProgramKind {
  if (owner.equals(network.tokenProgramId)) {
    return "legacy-spl";
  }
  if (owner.equals(network.token2022ProgramId)) {
    return "token-2022";
  }
  throw new ClientValidationError("MINT_OWNER", [
    `mint owner ${owner.toBase58()} is not the named legacy SPL or Token-2022 program`,
  ]);
}

/**
 * Read mint owner, decimals, supply, and authorities from the live account.
 * Decimals are never assumed. Owner decides which token program to use.
 */
export async function fetchMintSnapshot(
  connection: Connection,
  network: NetworkConfig,
  mint: PublicKey,
  commitment?: AccountReadCommitment,
): Promise<MintSnapshot> {
  const info = await connection.getAccountInfo(mint, resolveAccountReadCommitment(commitment));
  if (info === null) {
    throw new ClientValidationError("MINT_MISSING", [`mint ${mint.toBase58()} has no account`]);
  }
  if (info.data.length < MINT_BASE_LEN) {
    throw new ClientValidationError("MINT_LAYOUT", [
      `mint ${mint.toBase58()} data length ${info.data.length} is shorter than the 82-byte base layout`,
    ]);
  }
  const kind = tokenProgramKind(info.owner, network);
  const parsed = unpackMint(mint, info, info.owner);
  const snapshot: MintSnapshot = {
    mint,
    ownerProgram: info.owner,
    tokenProgramKind: kind,
    decimals: parsed.decimals,
    supply: new BN(parsed.supply.toString()),
    mintAuthority: parsed.mintAuthority,
    freezeAuthority: parsed.freezeAuthority,
    isInitialized: parsed.isInitialized,
    dataLength: info.data.length,
  };
  assertMintSnapshot(snapshot, mint.toBase58());
  return snapshot;
}
