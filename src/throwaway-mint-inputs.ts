/**
 * Operator-entered throwaway Q3b mint inputs. No React, no RPC, no keys.
 * Empty and zero amount throw; nonempty valid decimals+amount return.
 * Decimals are a u8 (0-255 inclusive). Amount is a positive raw integer
 * string (no floats). This is not ICHOR.
 */

export const THROWAWAY_Q3B_TRANSFER_FEE_BASIS_POINTS = 25;
export const THROWAWAY_Q3B_TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** u64::MAX as a decimal string. No per-transfer cap. */
export const THROWAWAY_Q3B_MAXIMUM_FEE = (2n ** 64n - 1n).toString();

const DECIMALS_MESSAGE = "decimals must be a u8 integer 0-255 (empty is refused)";
const AMOUNT_MESSAGE =
  "amount must be a positive decimal integer string (empty, zero, floats, sign, whitespace, and leading zeros are refused)";

const U64_MAX = 2n ** 64n - 1n;

function parseU8Decimals(text: string): number {
  if (text.length === 0) {
    throw new Error(DECIMALS_MESSAGE);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(DECIMALS_MESSAGE);
  }
  const decimals = Number(text);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(DECIMALS_MESSAGE);
  }
  return decimals;
}

function parsePositiveRawAmount(text: string): string {
  if (text.length === 0 || text === "0") {
    throw new Error(AMOUNT_MESSAGE);
  }
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(AMOUNT_MESSAGE);
  }
  const value = BigInt(text);
  if (value <= 0n || value > U64_MAX) {
    throw new Error(AMOUNT_MESSAGE);
  }
  return text;
}

export function parseThrowawayMintInputs(
  decimalsText: string,
  amountText: string,
): { decimals: number; amountRaw: string } {
  return {
    decimals: parseU8Decimals(decimalsText),
    amountRaw: parsePositiveRawAmount(amountText),
  };
}

export function throwawayMintInputsPresent(decimalsText: string, amountText: string): boolean {
  try {
    parseThrowawayMintInputs(decimalsText, amountText);
    return true;
  } catch {
    return false;
  }
}
