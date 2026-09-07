import { getNativeTreasuryAddress } from "@realms-today/spl-governance";
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { assertVerifiedIchorProgram, parseUpgradeableBuffer } from "./burn.ts";
import { BPF_LOADER_UPGRADEABLE } from "./network.ts";
import { assertBoundConnection } from "./preflight.ts";
import { assertVerifiedGovernanceIdentity } from "./realms.ts";
import type {
  BuildFreezeProgramUpgradesParams,
  BuildTransferProgramUpgradeAuthorityParams,
  BuildUpgradeIchorProgramParams,
  UnsignedInstructionBuild,
  VerifiedGovernanceIdentity,
  VerifiedIchorProgram,
} from "./types.ts";
import { ClientValidationError } from "./types.ts";
import { assertNoSecretMaterial, requirePublicKey } from "./validation.ts";

/**
 * Loader-v3 `UpgradeableLoaderInstruction::SetAuthority`.
 * Bincode serializes this fieldless enum variant as its u32 variant index.
 * Verified against local `solana-loader-v3-interface` 3.0.0 source.
 */
export const SET_UPGRADE_AUTHORITY_DATA = new Uint8Array([4, 0, 0, 0]);

/**
 * Loader-v3 `UpgradeableLoaderInstruction::Upgrade`.
 * Bincode serializes this fieldless enum variant as its u32 variant index.
 * Verified against local `solana-loader-v3-interface` 3.0.0 source.
 */
export const UPGRADE_PROGRAM_DATA = new Uint8Array([3, 0, 0, 0]);

/**
 * Loader v3 `size_of_buffer_metadata()`: u32 disc + Option tag + pubkey.
 * A buffer of exactly this length carries no program bytes.
 */
const BUFFER_HEADER_LEN = 37;

/**
 * Minimal account shape the buffer gate needs. Structurally matches a live
 * `getAccountInfo` result, so one passes unchanged, while a test can hand in
 * crafted bytes.
 */
export interface LoaderAccountView {
  readonly owner: PublicKey;
  readonly data: Uint8Array;
}

/**
 * refuse to stage an Upgrade whose buffer is not already frozen
 * to Governance.
 *
 * Address checks say nothing about bytes. The loader lets a buffer's authority
 * `Write` fresh contents and `SetAuthority` to anyone, so unless the authority
 * is ALREADY the Governance PDA the proposer can swap the ELF after the vote
 * passes and before the permissionless execute: the DAO approves one program
 * and installs another. Once the authority is Governance, `Write`,
 * `SetAuthority` and `Close` each need a Governance signature, which only
 * another passed proposal produces - so the bytes are frozen on chain rather
 * than by convention.
 *
 * Exported for direct testing: the builder is reachable only behind issued
 * proofs, and this check has to be exercised with crafted account data.
 */
export function assertBufferFrozenToGovernance(
  buffer: PublicKey,
  info: LoaderAccountView | null,
  governance: PublicKey,
): void {
  if (info === null) {
    throw new ClientValidationError("BUFFER_MISSING", [
      `buffer ${buffer.toBase58()} does not exist on this cluster`,
    ]);
  }
  if (!info.owner.equals(new PublicKey(BPF_LOADER_UPGRADEABLE.id))) {
    throw new ClientValidationError("BUFFER_LOADER_OWNER", [
      `buffer owner ${info.owner.toBase58()} is not the BPF upgradeable loader`,
    ]);
  }
  const state = parseUpgradeableBuffer(new Uint8Array(info.data));
  if (state.authority === null) {
    throw new ClientValidationError("BUFFER_AUTHORITY_NOT_GOVERNANCE", [
      `buffer ${buffer.toBase58()} has no authority, so its bytes cannot be frozen to Governance`,
    ]);
  }
  if (!state.authority.equals(governance)) {
    throw new ClientValidationError("BUFFER_AUTHORITY_NOT_GOVERNANCE", [
      `buffer authority ${state.authority.toBase58()} is not the Governance PDA ` +
        `${governance.toBase58()}`,
      "whoever holds the buffer authority can rewrite these bytes after the vote passes",
      "hand the buffer to Governance with the loader's SetAuthority before proposing",
    ]);
  }
  if (info.data.length <= BUFFER_HEADER_LEN) {
    throw new ClientValidationError("BUFFER_EMPTY", [
      `buffer ${buffer.toBase58()} is ${info.data.length} bytes; it carries no program`,
    ]);
  }
}

function observedAuthority(verifiedProgram: VerifiedIchorProgram): PublicKey {
  assertVerifiedIchorProgram(verifiedProgram);
  const authority = verifiedProgram.upgradeAuthority;
  if (authority === null) {
    throw new ClientValidationError("PROGRAM_IMMUTABLE", [
      `ProgramData ${verifiedProgram.programData.toBase58()} has no upgrade authority`,
    ]);
  }
  if (authority.equals(PublicKey.default)) {
    throw new ClientValidationError("INVALID_UPGRADE_AUTHORITY", [
      "observed upgrade authority is the default pubkey",
    ]);
  }
  return authority;
}

function assertSharedIssuedNetworkProof(
  verifiedProgram: VerifiedIchorProgram,
  verifiedGovernance: VerifiedGovernanceIdentity,
): void {
  if (verifiedGovernance.verifiedRealm.verified !== verifiedProgram.verified) {
    throw new ClientValidationError("NETWORK_PROOF", [
      "ICHOR program and Governance identity must share the exact issued network proof",
    ]);
  }
}

function setAuthorityInstruction(
  verifiedProgram: VerifiedIchorProgram,
  currentAuthority: PublicKey,
  newAuthority: PublicKey | null,
): TransactionInstruction {
  const keys = [
    {
      pubkey: verifiedProgram.programData,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: currentAuthority,
      isSigner: true,
      isWritable: false,
    },
  ];
  if (newAuthority !== null) {
    keys.push({
      pubkey: newAuthority,
      isSigner: false,
      isWritable: false,
    });
  }
  return new TransactionInstruction({
    programId: new PublicKey(BPF_LOADER_UPGRADEABLE.id),
    keys,
    data: Uint8Array.from(SET_UPGRADE_AUTHORITY_DATA) as TransactionInstruction["data"],
  });
}

/**
 * Permanently freeze program upgrades by setting ProgramData authority to
 * `None`. When current authority is the Governance PDA, insert this
 * instruction into a proposal so Realms signs for that PDA.
 */
export function buildFreezeProgramUpgrades(
  params: BuildFreezeProgramUpgradesParams,
): UnsignedInstructionBuild {
  assertNoSecretMaterial(params, "buildFreezeProgramUpgrades");
  const currentAuthority = observedAuthority(params.verifiedProgram);
  const instruction = setAuthorityInstruction(
    params.verifiedProgram,
    currentAuthority,
    null,
  );
  return {
    instructions: [instruction],
    derivedAddresses: {
      program: params.verifiedProgram.programId,
      programData: params.verifiedProgram.programData,
      currentUpgradeAuthority: currentAuthority,
    },
  };
}

/**
 * Loader-v3 Upgrade. Program and ProgramData come from the issued proof.
 * Spill is the derived Realms native treasury - not a caller field. The
 * `buffer` pubkey is an already-written loader account supplied by the caller.
 */
export async function buildUpgradeIchorProgram(
  params: BuildUpgradeIchorProgramParams,
): Promise<UnsignedInstructionBuild> {
  assertNoSecretMaterial(params, "buildUpgradeIchorProgram");
  assertVerifiedIchorProgram(params.verifiedProgram);
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertSharedIssuedNetworkProof(params.verifiedProgram, params.verifiedGovernance);
  const authority = observedAuthority(params.verifiedProgram);
  const program = params.verifiedProgram.programId;
  const programData = params.verifiedProgram.programData;
  const buffer = requirePublicKey(params.buffer, "buffer");
  const spill = await getNativeTreasuryAddress(
    params.verifiedProgram.verified.network.realmsProgramId,
    params.verifiedGovernance.governance,
  );
  if (
    buffer.equals(program) ||
    buffer.equals(programData) ||
    buffer.equals(spill) ||
    buffer.equals(authority)
  ) {
    throw new ClientValidationError("BUFFER_ACCOUNT_COLLISION", [
      `buffer ${buffer.toBase58()} collides with program, programData, treasury, or authority`,
    ]);
  }

  // Address checks alone say nothing about the bytes. The loader
  // lets a buffer's authority `Write` new contents and `SetAuthority` to
  // anyone, so unless the authority is ALREADY the Governance PDA the proposer
  // can swap the ELF after the vote passes and before the permissionless
  // execute - the DAO approves one program and installs another. Once the
  // authority is Governance, only another passed proposal can touch it.
  assertBoundConnection(params.verifiedProgram.verified, params.connection);
  const bufferInfo = await params.connection.getAccountInfo(buffer, "confirmed");
  assertBufferFrozenToGovernance(buffer, bufferInfo, params.verifiedGovernance.governance);
  const instruction = new TransactionInstruction({
    programId: new PublicKey(BPF_LOADER_UPGRADEABLE.id),
    keys: [
      {
        pubkey: programData,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: program,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: buffer,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: spill,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SYSVAR_RENT_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: SYSVAR_CLOCK_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: authority,
        isSigner: true,
        isWritable: false,
      },
    ],
    data: Uint8Array.from(UPGRADE_PROGRAM_DATA) as TransactionInstruction["data"],
  });
  return {
    instructions: [instruction],
    derivedAddresses: {
      program,
      programData,
      buffer,
      spill,
      authority,
      governance: params.verifiedGovernance.governance,
    },
  };
}

/**
 * Transfer program upgrade authority to the issued Governance PDA
 * (PLAN §0.4). Native treasury is not an upgrade-authority destination.
 */
export async function buildTransferProgramUpgradeAuthorityToGovernance(
  params: BuildTransferProgramUpgradeAuthorityParams,
): Promise<UnsignedInstructionBuild> {
  assertNoSecretMaterial(params, "buildTransferProgramUpgradeAuthorityToGovernance");
  assertVerifiedIchorProgram(params.verifiedProgram);
  assertVerifiedGovernanceIdentity(params.verifiedGovernance);
  assertSharedIssuedNetworkProof(params.verifiedProgram, params.verifiedGovernance);
  const currentAuthority = observedAuthority(params.verifiedProgram);
  const governance = params.verifiedGovernance.governance;
  if (governance.equals(currentAuthority)) {
    throw new ClientValidationError("UPGRADE_AUTHORITY_ALREADY_GOVERNANCE", [
      `upgrade authority is already the Governance PDA ${governance.toBase58()}`,
    ]);
  }
  const instruction = setAuthorityInstruction(
    params.verifiedProgram,
    currentAuthority,
    governance,
  );
  return {
    instructions: [instruction],
    derivedAddresses: {
      program: params.verifiedProgram.programId,
      programData: params.verifiedProgram.programData,
      currentUpgradeAuthority: currentAuthority,
      newUpgradeAuthority: governance,
      governance,
    },
  };
}
