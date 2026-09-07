import { requirePublicKey } from "@kekbull/ichor-client";
import { PublicKey } from "@solana/web3.js";
import { OPERATOR_CREATOR_FEE_BENEFICIARY } from "./creator-beneficiary.ts";
import type { PreflightState } from "./panels/Preflight.tsx";

export type OperatorAuthorityRole =
  | "upgrade-authority"
  | "config-authority"
  | "pending-authority"
  | "creator-beneficiary"
  | "bootstrap-operator";

export interface OperatorAuthority {
  readonly key: PublicKey;
  readonly role: OperatorAuthorityRole;
}

/**
 * Wallets that may open the loopback operator console.
 *
 * Live authorities are read from issued preflight proofs (ProgramData upgrade
 * authority, Config authority / pending / creator beneficiary). Nothing is
 * typed in. The pinned operator wallet is bootstrap only: it unlocks the
 * console when no ICHOR program is configured yet, so the first deploy is
 * possible. After Config exists, that pin is not enough unless it is also
 * one of the live fields.
 */
export function operatorAuthoritiesFromProofs(params: {
  readonly programConfigured: boolean;
  readonly upgradeAuthority: PublicKey | null;
  readonly configAuthority: PublicKey | null;
  readonly pendingAuthority: PublicKey | null;
  readonly creatorBeneficiary: PublicKey | null;
}): OperatorAuthority[] {
  if (!params.programConfigured) {
    return [
      {
        key: requirePublicKey(OPERATOR_CREATOR_FEE_BENEFICIARY, "bootstrap-operator"),
        role: "bootstrap-operator",
      },
    ];
  }
  const rows: OperatorAuthority[] = [];
  const seen = new Set<string>();
  const add = (key: PublicKey | null, role: OperatorAuthorityRole): void => {
    if (key === null) {
      return;
    }
    const id = key.toBase58();
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    rows.push({ key, role });
  };
  add(params.upgradeAuthority, "upgrade-authority");
  add(params.configAuthority, "config-authority");
  add(params.pendingAuthority, "pending-authority");
  add(params.creatorBeneficiary, "creator-beneficiary");
  return rows;
}

export function operatorAuthoritiesFromPreflight(
  preflight: PreflightState,
  programConfigured: boolean,
): OperatorAuthority[] {
  if (!programConfigured) {
    return operatorAuthoritiesFromProofs({
      programConfigured: false,
      upgradeAuthority: null,
      configAuthority: null,
      pendingAuthority: null,
      creatorBeneficiary: null,
    });
  }
  if (preflight.status !== "passed") {
    return [];
  }
  return operatorAuthoritiesFromProofs({
    programConfigured: true,
    upgradeAuthority: preflight.verifiedIchorProgram?.upgradeAuthority ?? null,
    configAuthority: preflight.verifiedIchorConfig?.config.authority ?? null,
    pendingAuthority: preflight.verifiedIchorConfig?.config.pendingAuthority ?? null,
    creatorBeneficiary: preflight.verifiedIchorConfig?.config.creatorBeneficiary ?? null,
  });
}

export function isOperatorConsoleUnlocked(params: {
  readonly connected: PublicKey | null;
  readonly authorities: readonly OperatorAuthority[];
}): boolean {
  if (params.connected === null || params.authorities.length === 0) {
    return false;
  }
  return params.authorities.some((row) => row.key.equals(params.connected));
}
