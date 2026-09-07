import { ClientValidationError } from "@kekbull/ichor-client";
import BN from "bn.js";

export function parseUiToBaseUnits(ui: string, decimals: number): BN {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ClientValidationError("DECIMALS", [
      "decimals must be the u8 read from the mint account",
    ]);
  }
  const trimmed = ui.trim().replace(/,/g, "");
  if (trimmed.length === 0) {
    throw new ClientValidationError("AMOUNT", [
      "type how much ICHOR, or use the wallet-balance button. Grouped figures like 497,814.06 are accepted.",
    ]);
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new ClientValidationError("AMOUNT", [
      "amount must be a non-negative decimal string with no exponent",
    ]);
  }
  const parts = trimmed.split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  if (frac.length > decimals) {
    throw new ClientValidationError("AMOUNT", [
      `amount has more than ${String(decimals)} fractional digits (mint decimals from chain)`,
    ]);
  }
  const combined = `${whole}${frac.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return new BN(combined, 10);
}

export function formatBaseUnits(amount: BN, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ClientValidationError("DECIMALS", [
      "decimals must be the u8 read from the mint account",
    ]);
  }
  const raw = amount.toString(10);
  if (decimals === 0) {
    return raw;
  }
  const padded = raw.padStart(decimals + 1, "0");
  const split = padded.length - decimals;
  const whole = padded.slice(0, split);
  const frac = padded.slice(split).replace(/0+$/, "");
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

/** Comma-group the integer side only. `9950.0625` is `9,950.0625`, not `9,950.0,625`. */
export function groupUiAmount(value: string): string {
  const [whole, fraction] = value.split(".");
  const withCommas = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction && fraction.length > 0 ? `${withCommas}.${fraction}` : withCommas;
}

/**
 * Strict positive decimal integer string. No sign, no whitespace (including
 * leading/trailing), no decimal point, no leading zero, no exponent.
 */
export function parsePositiveDecimalIntegerString(value: string, label: string): BN {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ClientValidationError("AMOUNT_MUST_BE_BN", [
      `${label} must be a strict positive decimal integer string (no sign, whitespace, decimal point, leading zero, or exponent)`,
    ]);
  }
  return new BN(value, 10);
}

export function formatError(error: unknown): string {
  const client = readClientValidation(error);
  if (client !== null) {
    return formatClientValidation(client.code, client.details);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readClientValidation(
  error: unknown,
): { readonly code: string; readonly details: readonly string[] } | null {
  if (error instanceof ClientValidationError) {
    return { code: error.code, details: error.details };
  }
  // Vite HMR can load two copies of the client; instanceof then fails while
  // the thrown object still carries code + details.
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ClientValidationError" &&
    typeof (error as { code?: unknown }).code === "string" &&
    Array.isArray((error as { details?: unknown }).details)
  ) {
    return {
      code: (error as { code: string }).code,
      details: (error as { details: readonly string[] }).details.map(String),
    };
  }
  return null;
}

function formatClientValidation(code: string, details: readonly string[]): string {
  const joined = details.join("; ");
  switch (code) {
    case "ACTIVE_VOTES_BLOCK_WITHDRAW":
      return `Can't withdraw while you have an active vote.\n${joined}`;
    case "FINALIZE_BEFORE_RELINQUISH":
      return `Can't withdraw yet. A proposal you voted on still needs Finalize.\n${joined}`;
    case "UNRELINQUISHED_VOTES":
      return `Can't withdraw while standing votes are still locked.\n${joined}`;
    case "OUTSTANDING_PROPOSALS":
      return `Can't withdraw while you still own an open proposal.\n${joined}`;
    case "NO_STANDING_VOTES":
      return joined;
    default:
      return `${code}: ${joined}`;
  }
}

/**
 * True when an issued-proof WeakSet rejected an object React still holds.
 * Typical after Vite HMR remounts the client module (new WeakSet) while
 * preflight state still points at proofs from the previous module instance.
 * Callers should clear preflight to idle so verification re-runs.
 */
export function isStaleIssuedProofError(error: unknown): boolean {
  const client = readClientValidation(error);
  if (client === null) {
    return false;
  }
  if (
    client.code !== "GOVERNANCE_PROOF" &&
    client.code !== "GOVERNANCE_IDENTITY_PROOF" &&
    client.code !== "REALM_PROOF" &&
    client.code !== "NETWORK_PROOF" &&
    client.code !== "ICHOR_PROGRAM_PROOF" &&
    client.code !== "ICHOR_CONFIG_PROOF"
  ) {
    return false;
  }
  return client.details.some(
    (detail) => detail.includes("fabricated") || detail.includes("lookalike"),
  );
}

export const STALE_PROOF_REVERIFY_MESSAGE =
  "Chain verification expired (dev hot-reload). Re-checking addresses against chain…";

/**
 * Humanise a Realms Governance time field. Those fields are seconds on chain.
 * `259200` → `3 days`. Does not invent a value; rejects non-integers and negatives.
 */
export function formatGovernanceSeconds(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new ClientValidationError("GOVERNANCE_TIME", [
      "governance time fields are non-negative integer seconds from the account",
    ]);
  }
  if (seconds === 0) {
    return "0 seconds";
  }
  const parts: string[] = [];
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = seconds % 60;
  if (days > 0) {
    parts.push(days === 1 ? "1 day" : `${String(days)} days`);
  }
  if (hours > 0) {
    parts.push(hours === 1 ? "1 hour" : `${String(hours)} hours`);
  }
  if (minutes > 0) {
    parts.push(minutes === 1 ? "1 minute" : `${String(minutes)} minutes`);
  }
  if (secs > 0) {
    parts.push(secs === 1 ? "1 second" : `${String(secs)} seconds`);
  }
  return parts.join(" ");
}

