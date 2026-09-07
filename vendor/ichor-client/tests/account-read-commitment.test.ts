/**
 * Optional AccountReadCommitment on shared verifiers. Default stays confirmed
 * so non-D callers are unchanged. Explicit finalized is recorded.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  DEFAULT_ACCOUNT_READ_COMMITMENT,
  fetchMintSnapshot,
  resolveAccountReadCommitment,
} from "../src/mint.ts";
import { resolveNetwork } from "../src/network.ts";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readSrc(name: string): string {
  return readFileSync(join(clientRoot, "src", name), "utf8");
}

function exportedFn(src: string, name: string): string {
  const asyncStart = src.indexOf(`export async function ${name}`);
  const syncStart = src.indexOf(`export function ${name}`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  assert.notEqual(start, -1, `missing ${name}`);
  const nextAsync = src.indexOf("\nexport async function ", start + 1);
  const nextSync = src.indexOf("\nexport function ", start + 1);
  const next =
    nextAsync === -1 ? nextSync : nextSync === -1 ? nextAsync : Math.min(nextAsync, nextSync);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("account read commitment helper", () => {
  it("defaults omitted commitment to confirmed", () => {
    assert.equal(DEFAULT_ACCOUNT_READ_COMMITMENT, "confirmed");
    assert.equal(resolveAccountReadCommitment(undefined), "confirmed");
    assert.equal(resolveAccountReadCommitment("finalized"), "finalized");
    assert.equal(resolveAccountReadCommitment("confirmed"), "confirmed");
  });

  it("fetchMintSnapshot records confirmed by default and honors finalized", async () => {
    const seen: string[] = [];
    const connection = {
      async getAccountInfo(_pk: PublicKey, commitment?: string) {
        seen.push(String(commitment));
        return null;
      },
    } as unknown as Connection;
    const network = resolveNetwork({ cluster: "mainnet-beta", realmsInstance: "kekbull" });
    const mint = PublicKey.unique();
    await assert.rejects(() => fetchMintSnapshot(connection, network, mint), /MINT_MISSING/);
    await assert.rejects(
      () => fetchMintSnapshot(connection, network, mint, "finalized"),
      /MINT_MISSING/,
    );
    assert.deepEqual(seen, ["confirmed", "finalized"]);
  });
});

describe("implicated verifiers thread the optional commitment", () => {
  it("uses resolveAccountReadCommitment on every explicit account read", () => {
    const mint = readSrc("mint.ts");
    assert.match(exportedFn(mint, "fetchMintSnapshot"), /resolveAccountReadCommitment\(commitment\)/);
    assert.doesNotMatch(exportedFn(mint, "fetchMintSnapshot"), /getAccountInfo\([^,]+,\s*"confirmed"\)/);

    const burn = readSrc("burn.ts");
    const programFn = exportedFn(burn, "verifyIchorProgramDeployment");
    assert.match(programFn, /resolveAccountReadCommitment\(commitment\)/);
    assert.match(programFn, /getAccountInfo\(configured, readCommitment\)/);
    assert.match(programFn, /getAccountInfo\(parsed\.programData, readCommitment\)/);
    assert.doesNotMatch(programFn, /getAccountInfo\([^,]+,\s*"confirmed"\)/);

    const configFn = exportedFn(burn, "verifyIchorConfigDeployment");
    assert.match(configFn, /resolveAccountReadCommitment\(commitment\)/);
    assert.doesNotMatch(configFn, /getAccountInfo\([^,]+,\s*"confirmed"\)/);

    const preflight = readSrc("preflight.ts");
    const executableStart = preflight.indexOf("async function readExecutableProgram");
    assert.notEqual(executableStart, -1);
    const executable = preflight.slice(
      executableStart,
      preflight.indexOf("\nasync function readMeteoraProgram"),
    );
    assert.match(executable, /resolveAccountReadCommitment\(commitment\)/);
    assert.doesNotMatch(executable, /getAccountInfo\([^,]+,\s*"confirmed"\)/);
  });
});
