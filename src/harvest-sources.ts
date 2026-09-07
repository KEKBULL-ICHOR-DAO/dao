/**
 * Operator-pasted harvest source lines. No React, no RPC, no account discovery.
 * Bind is a one-way door; the UI must refuse an empty list before
 * `buildSetFeeDistribution`, same as harvest.
 */

const HARVEST_SOURCES_EMPTY_MESSAGE =
  "paste at least one known Token-2022 ICHOR account to harvest";

function splitHarvestSourceLines(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function parseHarvestSourceLines(text: string): string[] {
  const values = splitHarvestSourceLines(text);
  if (values.length === 0) {
    throw new Error(HARVEST_SOURCES_EMPTY_MESSAGE);
  }
  return values;
}

export function harvestSourceLinesPresent(text: string): boolean {
  return splitHarvestSourceLines(text).length > 0;
}
