/**
 * Production `deployment.json` shape for `vite build` and the publish script.
 *
 * Pre-D: realm / governance / nativeTreasury stay null.
 * After D: those three must equal the derived mainnet pins — not any pubkey.
 * The guard changes shape; it is never deleted.
 */

export const MAINNET_C_ICHOR_PROGRAM = "DmnfCzQNbx4ZAWEwBoAKqTALgwuUXwYxZL1dRqXoZ1Md";
export const MAINNET_C_ICHOR_MINT = "61fHeSXmBuJMbqsYKVqgXifJDV8v9zzF7rFpysNT3Mq2";
export const MAINNET_C_KEKBULL_MINT = "CKFvy16Gd8kadtCmNyu9r91TYgyvrbJnsJey8McFpump";

/** Derived from realm name `KEKBULL DAO` + kekbull_governance. Not on chain until D. */
export const MAINNET_D_REALM = "EJQ83ay57EH84wmqBk8r1dsqN7PSVmP83mY1DArq7ft9";
export const MAINNET_D_GOVERNANCE = "H9hwaXvV5bXGrVRtrbd9n8PUmheAGeA7dDmvmwC45WnC";
export const MAINNET_D_NATIVE_TREASURY = "Dn2cjgXaHLju8Gc5fRpvHX3AzeKAi3JwSjusPCoAYWGJ";
export const MAINNET_D_VOTE_PROGRAM = "2uNHeSLiNn6dLLtiGrpCd8UZKBfV36kap57eg9kV39Fj";
export const MAINNET_D_REALM_NAME = "KEKBULL DAO";

export type ShippedDeploymentJson = {
  cluster?: unknown;
  realmsInstance?: unknown;
  rpcUrl?: unknown;
  ichorProgram?: unknown;
  ichorMint?: unknown;
  kekbullMint?: unknown;
  realm?: unknown;
  governance?: unknown;
  nativeTreasury?: unknown;
  voteProgram?: unknown;
};

export type ShippedDeploymentMode = "pre-d" | "published";

function isNullish(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * Fail-closed production JSON. Nulls remain legal before D. Any populated
 * realm/governance/treasury triple must be the exact derived mainnet pins.
 */
export function assertShippedDeploymentJson(shipped: ShippedDeploymentJson): ShippedDeploymentMode {
  if (shipped.cluster !== "mainnet-beta") {
    throw new Error(
      `REFUSING: dist/deployment.json cluster is ${String(shipped.cluster)}; vite build ships the mainnet origin only`,
    );
  }
  if (shipped.rpcUrl !== "") {
    throw new Error(
      "REFUSING: dist/deployment.json rpcUrl must be empty (same-origin /rpc; official cluster HTTP is the browser fallback)",
    );
  }
  if (
    shipped.ichorProgram !== MAINNET_C_ICHOR_PROGRAM ||
    shipped.ichorMint !== MAINNET_C_ICHOR_MINT ||
    shipped.kekbullMint !== MAINNET_C_KEKBULL_MINT
  ) {
    throw new Error(
      "REFUSING: dist/deployment.json must ship the measured mainnet C ICHOR program, mint, and KEKBULL source",
    );
  }

  const realm = shipped.realm;
  const governance = shipped.governance;
  const nativeTreasury = shipped.nativeTreasury;
  const allNull = isNullish(realm) && isNullish(governance) && isNullish(nativeTreasury);
  const allPopulated = !isNullish(realm) && !isNullish(governance) && !isNullish(nativeTreasury);

  if (allNull) {
    return "pre-d";
  }

  if (!allPopulated) {
    throw new Error(
      "REFUSING: dist/deployment.json realm/governance/treasury must stay null until PLAN §15.3 D, or all three equal the measured mainnet D pins",
    );
  }

  if (
    realm !== MAINNET_D_REALM ||
    governance !== MAINNET_D_GOVERNANCE ||
    nativeTreasury !== MAINNET_D_NATIVE_TREASURY
  ) {
    throw new Error(
      "REFUSING: dist/deployment.json realm/governance/treasury must stay null until PLAN §15.3 D, or equal the measured mainnet D pins (arbitrary non-null values are refused)",
    );
  }

  if (shipped.voteProgram !== undefined && shipped.voteProgram !== null && shipped.voteProgram !== "") {
    if (shipped.voteProgram !== MAINNET_D_VOTE_PROGRAM) {
      throw new Error(
        "REFUSING: dist/deployment.json voteProgram must be kekbull_governance or omitted",
      );
    }
  }
  if (shipped.realmsInstance !== undefined && shipped.realmsInstance !== "kekbull") {
    throw new Error("REFUSING: dist/deployment.json realmsInstance must be kekbull");
  }

  return "published";
}
