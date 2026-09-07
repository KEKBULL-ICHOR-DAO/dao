import { requirePublicKey } from "@kekbull/ichor-client";
import { PublicKey } from "@solana/web3.js";

/**
 * Operator 25% ICHOR harvested-fee wallet. Official-devnet and mainnet use
 * this same on-curve address as `set_fee_distribution` creatorBeneficiary.
 * Not the Realms treasury PDA. Not a convert mint destination.
 */
export const OPERATOR_CREATOR_FEE_BENEFICIARY =
  "5E6eeUqF2UunqwGDavfCgh28smQe88JSN7MXGvCdh4Zd";

export function requireOperatorCreatorBeneficiary(value: string): PublicKey {
  const key = requirePublicKey(value, "creatorBeneficiary");
  if (key.toBase58() !== OPERATOR_CREATOR_FEE_BENEFICIARY) {
    throw new Error(
      `creatorBeneficiary must be the pinned operator wallet ${OPERATOR_CREATOR_FEE_BENEFICIARY}`,
    );
  }
  return key;
}
