/**
 * Holder proposal action templates and English summaries of recovered inners.
 *
 * proposal-action classifier: every inner is classified; token "pay" requires
 * TransferChecked; amounts are decoded; any unknown or multi-index set fails
 * closed for Execute.
 */
import {
  BPF_LOADER_UPGRADEABLE,
  ProposalState,
  UPGRADE_PROGRAM_DATA,
  assertBufferFrozenToGovernance,
  deriveVerifiedNativeTreasury,
  buildInsertProposalTransaction,
  buildTreasuryIchorTransfer,
  buildTreasurySolTransfer,
  buildUpgradeIchorProgram,
  requirePublicKey,
  type CommunityProposalSnapshot,
  type StagedProposalActions,
  type UnsignedInstructionBuild,
  type VerifiedGovernanceIdentity,
  type VerifiedIchorProgram,
} from "@kekbull/ichor-client";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { formatBaseUnits, groupUiAmount, parseUiToBaseUnits } from "./format.ts";

export type HolderActionKind = "none" | "pay-ichor" | "pay-sol" | "upgrade";

export type ActionSummaryKind = "pay-ichor" | "pay-sol" | "upgrade" | "unknown" | "none";

export interface ActionEnglishSummary {
  readonly kind: ActionSummaryKind;
  readonly headline: string;
  readonly details: readonly string[];
  /** False until every Approve ProposalTransaction index is recovered. */
  readonly recoveryComplete: boolean;
}

/** Per-instruction classification before roll-up (C2 / C3). */
export type ClassifiedInstructionKind =
  | "pay-ichor"
  | "pay-sol"
  | "pay-token"
  | "upgrade"
  | "ata-create"
  | "unknown";

export interface ClassifiedMove {
  readonly asset: "sol" | "ichor" | "token";
  readonly amount: BN;
  readonly decimals: number;
  readonly mint?: string;
  readonly destination?: string;
}

export interface ClassifiedInstruction {
  readonly kind: ClassifiedInstructionKind;
  readonly headline: string;
  readonly details: readonly string[];
  readonly moved?: ClassifiedMove;
}

export interface UpgradeReviewIdentity {
  readonly program: PublicKey;
  readonly programData: PublicKey;
  readonly governance: PublicKey;
  readonly nativeTreasury: PublicKey;
  /**
   * Buffer pubkeys that passed assertBufferFrozenToGovernance.
   * Per-instruction - classify looks up keys[2], never a proposal-level boolean.
   */
  readonly frozenBuffers: readonly string[];
  /** A legitimate ICHOR upgrade is one Upgrade. Two or more refuse the label. */
  readonly multipleUpgrades: boolean;
}

export interface SummarizeProposalOptions {
  /**
   * Live mint transfer-fee basis points when measured. Never invent 0.25%.
   * When omitted, the summary says the fee follows the mint schedule.
   */
  readonly transferFeeBasisPoints?: number | null;
  /**
   * Required to label an Upgrade as this ICHOR program. Missing or mismatched
   * accounts, or a buffer not already frozen to Governance, stay unknown.
   */
  readonly upgradeIdentity?: UpgradeReviewIdentity;
}

/** SPL Token / Token-2022 TransferChecked. */
const TOKEN_TRANSFER_CHECKED = 12;
/** Associated Token Account: Create. */
const ATA_CREATE = 0;
/** Associated Token Account: CreateIdempotent. */
const ATA_CREATE_IDEMPOTENT = 1;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function u8At(data: Uint8Array, offset: number): number | null {
  if (offset >= data.length) {
    return null;
  }
  return data[offset] ?? null;
}

function readU32LE(data: Uint8Array, offset: number): number | null {
  if (offset + 4 > data.length) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getUint32(offset, true);
}

function readU64LE(data: Uint8Array, offset: number): BN | null {
  if (offset + 8 > data.length) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return new BN(view.getBigUint64(offset, true).toString(10));
}

function feeDetailLine(basisPoints: number | null | undefined): string {
  if (basisPoints === null || basisPoints === undefined) {
    return "Transfer fee withheld on arrival per the mint's live schedule (not assumed here).";
  }
  const whole = Math.floor(basisPoints / 100);
  const frac = String(basisPoints % 100).padStart(2, "0");
  return `Transfer fee ${String(whole)}.${frac}% (live mint basis points ${String(basisPoints)}) withheld on arrival.`;
}

/**
 * Classify one recovered inner. Token "pay" requires TransferChecked (12);
 * ApproveChecked / Burn / Transfer(3) land as unknown (C2).
 */
export function classifyProposalInstruction(
  instruction: TransactionInstruction,
  ichorMint: PublicKey | null,
  opts?: SummarizeProposalOptions,
): ClassifiedInstruction {
  const data = Uint8Array.from(instruction.data);

  if (
    instruction.programId.equals(new PublicKey(BPF_LOADER_UPGRADEABLE.id)) &&
    bytesEqual(data, UPGRADE_PROGRAM_DATA)
  ) {
    const programData = instruction.keys[0]?.pubkey;
    const program = instruction.keys[1]?.pubkey;
    const buffer = instruction.keys[2]?.pubkey;
    const spill = instruction.keys[3]?.pubkey;
    const authority = instruction.keys[6]?.pubkey;
    const identity = opts?.upgradeIdentity;
    const accounts = [
      programData ? `ProgramData ${programData.toBase58()}` : "ProgramData unread",
      program ? `Program ${program.toBase58()}` : "Program unread",
      buffer ? `Loader buffer ${buffer.toBase58()}` : "Buffer unread",
      spill ? `Spill ${spill.toBase58()}` : "Spill unread",
      authority ? `Authority ${authority.toBase58()}` : "Authority unread",
    ];
    if (identity === undefined) {
      return {
        kind: "unknown",
        headline: "Loader Upgrade with unread ICHOR identity. Execute stays closed",
        details: [
          "This page will not label an Upgrade as the ICHOR program until Program, ProgramData, spill, and Governance are bound and the buffer is frozen to Governance.",
          ...accounts,
        ],
      };
    }
    if (identity.multipleUpgrades) {
      return {
        kind: "unknown",
        headline: "More than one loader Upgrade. Execute stays closed",
        details: [
          "A legitimate ICHOR upgrade is one Upgrade instruction. This proposal has more than one; each buffer was read and none of them inherit another's freeze.",
          ...accounts,
        ],
      };
    }
    const bound =
      programData !== undefined &&
      program !== undefined &&
      spill !== undefined &&
      authority !== undefined &&
      programData.equals(identity.programData) &&
      program.equals(identity.program) &&
      spill.equals(identity.nativeTreasury) &&
      authority.equals(identity.governance);
    const thisBufferFrozen =
      buffer !== undefined && identity.frozenBuffers.includes(buffer.toBase58());
    if (!bound || !thisBufferFrozen) {
      return {
        kind: "unknown",
        headline: "Loader Upgrade is not a verified ICHOR upgrade. Execute stays closed",
        details: [
          bound
            ? "Buffer authority is not frozen to the Governance PDA. The bytes can still change after a yes vote."
            : "Program, ProgramData, spill, or authority does not match the issued ICHOR / Governance proofs.",
          ...accounts,
        ],
      };
    }
    return {
      kind: "upgrade",
      headline: "Upgrade the ICHOR program",
      details: [
        ...accounts,
        "Buffer authority is already the Governance PDA. Spill SOL goes to the native treasury.",
      ],
    };
  }

  if (instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
    const disc = u8At(data, 0);
    if (disc === ATA_CREATE || disc === ATA_CREATE_IDEMPOTENT) {
      const ata = instruction.keys[1]?.pubkey;
      const wallet = instruction.keys[2]?.pubkey;
      const mint = instruction.keys[3]?.pubkey;
      return {
        kind: "ata-create",
        headline:
          disc === ATA_CREATE_IDEMPOTENT
            ? "Create recipient token account (idempotent)"
            : "Create recipient token account",
        details: [
          mint ? `Mint ${mint.toBase58()}` : "Mint unread",
          wallet ? `Owner ${wallet.toBase58()}` : "Owner unread",
          ata ? `ATA ${ata.toBase58()}` : "ATA unread",
        ],
      };
    }
    return {
      kind: "unknown",
      headline: "Unrecognized associated-token instruction",
      details: [
        `Program ${instruction.programId.toBase58()}`,
        `Data discriminator ${disc === null ? "missing" : String(disc)}`,
      ],
    };
  }

  if (instruction.programId.equals(SystemProgram.programId)) {
    const index = readU32LE(data, 0);
    if (index === 2) {
      const lamports = readU64LE(data, 4);
      const to = instruction.keys[1]?.pubkey;
      if (lamports === null) {
        return {
          kind: "unknown",
          headline: "System transfer with unreadable lamports",
          details: [to ? `Recipient ${to.toBase58()}` : "Recipient unread"],
        };
      }
      return {
        kind: "pay-sol",
        headline: "Pay SOL from the treasury",
        details: [
          to ? `Recipient ${to.toBase58()}` : "Recipient unread",
          `${groupUiAmount(formatBaseUnits(lamports, 9))} SOL (${lamports.toString(10)} lamports)`,
        ],
        moved: {
          asset: "sol",
          amount: lamports,
          decimals: 9,
          ...(to ? { destination: to.toBase58() } : {}),
        },
      };
    }
    return {
      kind: "unknown",
      headline: "Unrecognized System Program instruction",
      details: [
        `Discriminator ${index === null ? "unreadable" : String(index)}`,
        "Only SystemProgram Transfer (2) is labeled as a treasury SOL payment.",
      ],
    };
  }

  if (
    instruction.programId.equals(TOKEN_2022_PROGRAM_ID) ||
    instruction.programId.equals(TOKEN_PROGRAM_ID)
  ) {
    const disc = u8At(data, 0);
    // C2: only TransferChecked is a "pay" label. Transfer(3), ApproveChecked(13),
    // BurnChecked(15), etc. must not render as payments.
    if (disc === TOKEN_TRANSFER_CHECKED) {
      const amount = readU64LE(data, 1);
      const decimals = u8At(data, 9);
      const mint = instruction.keys[1]?.pubkey;
      const dest = instruction.keys[2]?.pubkey;
      const isIchor = ichorMint !== null && mint !== undefined && mint.equals(ichorMint);
      if (isIchor && !instruction.programId.equals(TOKEN_2022_PROGRAM_ID)) {
        return {
          kind: "unknown",
          headline: "Token program does not own this ICHOR mint. Execute stays closed",
          details: [
            `Instruction program ${instruction.programId.toBase58()}`,
            `Mint ${mint!.toBase58()}`,
            dest ? `Destination ATA ${dest.toBase58()}` : "Destination unread",
            "ICHOR is Token-2022. A legacy Tokenkeg TransferChecked naming this mint cannot execute and is not a treasury payment.",
          ],
        };
      }
      if (amount === null || decimals === null) {
        return {
          kind: "unknown",
          headline: isIchor
            ? "ICHOR TransferChecked with unreadable amount"
            : "Token TransferChecked with unreadable amount",
          details: [
            mint ? `Mint ${mint.toBase58()}` : "Mint unread",
            dest ? `Destination ATA ${dest.toBase58()}` : "Destination unread",
          ],
        };
      }
      const qty = groupUiAmount(formatBaseUnits(amount, decimals));
      if (!isIchor) {
        const mint58 = mint?.toBase58();
        const dest58 = dest?.toBase58();
        return {
          kind: "pay-token",
          headline: `Transfer ${qty} of mint ${mint58 ?? "unread"} to ${dest58 ?? "unread"}`,
          details: [
            mint58 ? `Mint ${mint58}` : "Mint unread",
            dest58 ? `Destination ${dest58}` : "Destination unread",
            `Amount ${qty} (${amount.toString(10)} base units, decimals ${String(decimals)})`,
            ...(ichorMint ? [`Not the ICHOR mint ${ichorMint.toBase58()}.`] : []),
            "Refusing a Pay ICHOR label. Execute stays closed.",
          ],
          moved: {
            asset: "token",
            amount,
            decimals,
            ...(mint58 ? { mint: mint58 } : {}),
            ...(dest58 ? { destination: dest58 } : {}),
          },
        };
      }
      return {
        kind: "pay-ichor",
        headline: "Pay ICHOR from the treasury",
        details: [
          `Mint ${mint!.toBase58()}`,
          dest ? `Destination ATA ${dest.toBase58()}` : "Destination ATA unread",
          `Gross ${qty} ICHOR (${amount.toString(10)} base units, decimals ${String(decimals)})`,
          feeDetailLine(opts?.transferFeeBasisPoints),
        ],
        moved: {
          asset: "ichor",
          amount,
          decimals,
          mint: mint!.toBase58(),
          ...(dest ? { destination: dest.toBase58() } : {}),
        },
      };
    }
    return {
      kind: "unknown",
      headline: "Unrecognized token instruction",
      details: [
        `Program ${instruction.programId.toBase58()}`,
        `Discriminator ${disc === null ? "missing" : String(disc)}`,
        "Only TransferChecked (12) is labeled as a treasury ICHOR payment. Approve, burn, and plain Transfer are refused.",
      ],
    };
  }

  return {
    kind: "unknown",
    headline: "Custom instruction",
    details: [
      `Program ${instruction.programId.toBase58()}`,
      `Data ${data.length} byte(s)`,
      "This page does not invent a friendlier label.",
    ],
  };
}

function numberedDetails(classified: readonly ClassifiedInstruction[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < classified.length; i += 1) {
    const row = classified[i]!;
    lines.push(`${String(i + 1)}. ${row.headline}`);
    for (const detail of row.details) {
      lines.push(`   ${detail}`);
    }
  }
  return lines;
}

function movedValueLines(classified: readonly ClassifiedInstruction[]): string[] {
  const moves = classified.flatMap((row) => (row.moved ? [row.moved] : []));
  if (moves.length === 0) {
    return [];
  }
  const parts = moves.map((move) => {
    const qty = groupUiAmount(formatBaseUnits(move.amount, move.decimals));
    if (move.asset === "sol") {
      return `${qty} SOL`;
    }
    if (move.asset === "ichor") {
      return `${qty} ICHOR`;
    }
    return `${qty} of mint ${move.mint ?? "unread"}`;
  });
  return [`Moves ${parts.join(" · ")}`];
}

function englishSummary(
  kind: ActionSummaryKind,
  headline: string,
  details: readonly string[],
  recoveryComplete: boolean,
): ActionEnglishSummary {
  return { kind, headline, details, recoveryComplete };
}

/**
 * True only after every Approve index is recovered. Unknown inners may still
 * be voted - holders must be able to vote No on a drain - but unread inners
 * must not.
 */
export function proposalInstructionsReviewedForVote(
  summary: ActionEnglishSummary | null,
): boolean {
  return summary !== null && summary.recoveryComplete;
}

/**
 * Roll up every inner instruction (C3). Overall kind is unknown if any inner
 * is unknown, or if recognized payment/upgrade kinds are mixed.
 */
export function summarizeProposalInstructions(
  instructions: readonly TransactionInstruction[],
  ichorMint: PublicKey | null,
  opts?: SummarizeProposalOptions,
): ActionEnglishSummary {
  if (instructions.length === 0) {
    return englishSummary(
      "none",
      "No on-chain action",
      ["This proposal has no inserted instruction. Passing it records a decision only."],
      true,
    );
  }

  const classified = instructions.map((instruction) =>
    classifyProposalInstruction(instruction, ichorMint, opts),
  );
  const lines = numberedDetails(classified);
  const moved = movedValueLines(classified);

  if (classified.some((row) => row.kind === "pay-token")) {
    return englishSummary(
      "unknown",
      "Moves a non-ICHOR token. Execute stays closed on this page",
      [
        "A TransferChecked of any mint other than ICHOR is not a labeled Pay ICHOR action, including when it shares a proposal with an ICHOR transfer.",
        ...moved,
        ...lines,
      ],
      true,
    );
  }
  if (classified.some((row) => row.kind === "unknown")) {
    return englishSummary(
      "unknown",
      "Unrecognized on-chain action. Do not treat this as a labeled payment or upgrade",
      [
        "At least one inner instruction could not be classified. Execute stays closed on this page.",
        ...moved,
        ...lines,
      ],
      true,
    );
  }

  const actionKinds = new Set(
    classified
      .map((row) => row.kind)
      .filter((kind) => kind === "pay-ichor" || kind === "pay-sol" || kind === "upgrade"),
  );
  if (actionKinds.size > 1) {
    return englishSummary(
      "unknown",
      "Mixed on-chain actions. Refusing a single friendly label",
      [
        "This proposal combines more than one recognized action type. Execute stays closed on this page.",
        ...moved,
        ...lines,
      ],
      true,
    );
  }
  if (actionKinds.size === 0) {
    const tokenMoves = classified.filter((row) => row.kind === "pay-token");
    if (tokenMoves.length > 0) {
      return englishSummary(
        "unknown",
        tokenMoves.length === 1
          ? tokenMoves[0]!.headline
          : "Moves non-ICHOR tokens",
        [
          "This is not a labeled ICHOR, SOL, or upgrade action. Execute stays closed on this page.",
          ...moved,
          ...lines,
        ],
        true,
      );
    }
    return englishSummary(
      "unknown",
      "No recognized treasury action",
      [
        "Inners classified only as account setup, or nothing actionable. Execute stays closed.",
        ...moved,
        ...lines,
      ],
      true,
    );
  }

  const primary = [...actionKinds][0]!;
  const primaryRow = classified.find((row) => row.kind === primary)!;
  let headline = primaryRow.headline;
  if (primary === "pay-ichor") {
    const payCount = classified.filter((row) => row.kind === "pay-ichor").length;
    if (payCount > 1) {
      headline = `Pay ICHOR from the treasury (${String(payCount)} transfers)`;
    }
  }
  return englishSummary(primary, headline, [...moved, ...lines], true);
}

function isLoaderUpgrade(instruction: TransactionInstruction): boolean {
  return (
    instruction.programId.equals(new PublicKey(BPF_LOADER_UPGRADEABLE.id)) &&
    bytesEqual(Uint8Array.from(instruction.data), UPGRADE_PROGRAM_DATA)
  );
}

/**
 * Per-instruction buffer freeze for loader Upgrades. Reads every keys[2].
 * getAccountInfo rejections propagate. assertBufferFrozenToGovernance
 * failures leave that buffer out of frozenBuffers.
 */
export async function reviewLoaderUpgrades(params: {
  readonly connection: Connection;
  readonly instructions: readonly TransactionInstruction[];
  readonly program: PublicKey;
  readonly programData: PublicKey;
  readonly governance: PublicKey;
  readonly nativeTreasury: PublicKey;
}): Promise<UpgradeReviewIdentity> {
  const upgrades = params.instructions.filter(isLoaderUpgrade);
  const frozenBuffers: string[] = [];
  for (const upgrade of upgrades) {
    const buffer = upgrade.keys[2]?.pubkey;
    if (buffer === undefined) {
      continue;
    }
    const info = await params.connection.getAccountInfo(buffer, "confirmed");
    try {
      assertBufferFrozenToGovernance(buffer, info, params.governance);
      frozenBuffers.push(buffer.toBase58());
    } catch {
      // Not frozen. Keep reading the rest - do not attest from a neighbour.
    }
  }
  return {
    program: params.program,
    programData: params.programData,
    governance: params.governance,
    nativeTreasury: params.nativeTreasury,
    frozenBuffers,
    multipleUpgrades: upgrades.length > 1,
  };
}

export async function proposalReviewOptions(params: {
  readonly connection: Connection;
  readonly instructions: readonly TransactionInstruction[];
  readonly verifiedProgram: VerifiedIchorProgram | null;
  readonly verifiedGovernance: VerifiedGovernanceIdentity | null;
  readonly transferFeeBasisPoints?: number | null;
}): Promise<SummarizeProposalOptions> {
  const base: SummarizeProposalOptions = {
    transferFeeBasisPoints: params.transferFeeBasisPoints ?? null,
  };
  const upgrades = params.instructions.filter(isLoaderUpgrade);
  if (
    upgrades.length === 0 ||
    params.verifiedProgram === null ||
    params.verifiedGovernance === null
  ) {
    return base;
  }
  const nativeTreasury = await deriveVerifiedNativeTreasury(params.verifiedGovernance);
  return {
    ...base,
    upgradeIdentity: await reviewLoaderUpgrades({
      connection: params.connection,
      instructions: params.instructions,
      program: params.verifiedProgram.programId,
      programData: params.verifiedProgram.programData,
      governance: params.verifiedGovernance.governance,
      nativeTreasury,
    }),
  };
}

/**
 * Review path for recovered inners. Binds Upgrade to the issued ICHOR program
 * and refuses a buffer that is not already frozen to Governance (H-5 / H-6).
 */
export async function summarizeProposalInstructionsForReview(params: {
  readonly connection: Connection;
  readonly instructions: readonly TransactionInstruction[];
  readonly ichorMint: PublicKey | null;
  readonly verifiedProgram: VerifiedIchorProgram | null;
  readonly verifiedGovernance: VerifiedGovernanceIdentity | null;
  readonly transferFeeBasisPoints?: number | null;
}): Promise<ActionEnglishSummary> {
  const opts = await proposalReviewOptions(params);
  return summarizeProposalInstructions(params.instructions, params.ichorMint, opts);
}

/**
 * C4 - when Approve has more than one ProposalTransaction index, this page
 * must not pretend index 0 is the whole action (execute is permissionless per
 * index). Call after recovering every index 0..count-1.
 */
export function summarizeRecoveredProposalTransactions(params: {
  readonly instructionsCount: number;
  readonly recoveredIndexes: number;
  readonly instructions: readonly TransactionInstruction[];
  readonly ichorMint: PublicKey | null;
  readonly opts?: SummarizeProposalOptions;
}): ActionEnglishSummary {
  if (params.instructionsCount <= 0) {
    return englishSummary(
      "none",
      "No inserted action (or not yet inserted)",
      ["Approve option has instructionsCount 0. A signal-only proposal is valid."],
      true,
    );
  }
  if (params.recoveredIndexes < params.instructionsCount) {
    return englishSummary(
      "unknown",
      "Incomplete recovery. Refusing a partial summary",
      [
        `Approve option reports ${String(params.instructionsCount)} ProposalTransaction index(es); only ${String(params.recoveredIndexes)} were recovered.`,
        "Execute stays closed. Do not vote from a partial view.",
      ],
      false,
    );
  }
  if (params.instructionsCount > 1) {
    const innerSummary = summarizeProposalInstructions(
      params.instructions,
      params.ichorMint,
      params.opts,
    );
    return englishSummary(
      "unknown",
      "Multiple ProposalTransaction indexes. Execute stays closed here",
      [
        `This proposal has ${String(params.instructionsCount)} transaction indexes. Execution is permissionless per index; this page will not execute only index 0 while others remain.`,
        ...innerSummary.details,
      ],
      true,
    );
  }
  return summarizeProposalInstructions(params.instructions, params.ichorMint, params.opts);
}

export async function buildHolderPayIchorAction(params: {
  connection: Connection;
  verifiedGovernance: VerifiedGovernanceIdentity;
  recipient: string;
  amountUi: string;
  decimals: number;
  createDestinationAta: boolean;
}): Promise<UnsignedInstructionBuild & { transfer: { amount: BN; expectedMintFee: BN; expectedNet: BN } }> {
  const amount = parseUiToBaseUnits(params.amountUi, params.decimals);
  if (amount.lte(new BN(0))) {
    throw new Error("ICHOR amount must be positive");
  }
  return buildTreasuryIchorTransfer({
    connection: params.connection,
    verifiedGovernance: params.verifiedGovernance,
    recipient: requirePublicKey(params.recipient, "recipient"),
    amount,
    createDestinationAta: params.createDestinationAta,
  });
}

export async function buildHolderPaySolAction(params: {
  connection: Connection;
  verifiedGovernance: VerifiedGovernanceIdentity;
  recipient: string;
  amountUi: string;
}): Promise<UnsignedInstructionBuild & { lamports: BN }> {
  const lamports = parseUiToBaseUnits(params.amountUi, 9);
  if (lamports.lte(new BN(0))) {
    throw new Error("SOL amount must be positive");
  }
  return buildTreasurySolTransfer({
    connection: params.connection,
    verifiedGovernance: params.verifiedGovernance,
    recipient: requirePublicKey(params.recipient, "recipient"),
    lamports,
  });
}

export async function buildHolderUpgradeAction(params: {
  /** Required: the builder reads the buffer account. */
  connection: Connection;
  verifiedProgram: VerifiedIchorProgram;
  verifiedGovernance: VerifiedGovernanceIdentity;
  buffer: string;
}): Promise<UnsignedInstructionBuild> {
  const authority = params.verifiedProgram.upgradeAuthority;
  if (authority === null) {
    throw new Error("ProgramData has no upgrade authority; the program is immutable");
  }
  if (!authority.equals(params.verifiedGovernance.governance)) {
    throw new Error(
      `Upgrade authority is ${authority.toBase58()}, not Governance ${params.verifiedGovernance.governance.toBase58()}. Stage this only after the handoff.`,
    );
  }
  return buildUpgradeIchorProgram({
    connection: params.connection,
    verifiedProgram: params.verifiedProgram,
    verifiedGovernance: params.verifiedGovernance,
    buffer: requirePublicKey(params.buffer, "buffer"),
  });
}

export async function insertApproveAction(params: {
  verifiedGovernance: VerifiedGovernanceIdentity;
  proposal: PublicKey;
  tokenOwnerRecord: PublicKey;
  governanceAuthority: PublicKey;
  payer: PublicKey;
  holdUpTime: number;
  instructions: TransactionInstruction[];
}): Promise<{
  insert: Awaited<ReturnType<typeof buildInsertProposalTransaction>>;
  staged: StagedProposalActions;
}> {
  const insert = await buildInsertProposalTransaction({
    verifiedGovernance: params.verifiedGovernance,
    proposal: params.proposal,
    tokenOwnerRecord: params.tokenOwnerRecord,
    governanceAuthority: params.governanceAuthority,
    payer: params.payer,
    index: 0,
    optionIndex: 0,
    holdUpTime: params.holdUpTime,
    transactionInstructions: params.instructions,
  });
  return { insert, staged: insert.staged };
}

/**
 * Effective vote-window length in seconds: proposal override when set, else
 * governance `baseVotingTime`. Realms keeps state=`Voting` after this elapses
 * until FinalizeVote - CastVote then fails with ProposalVotingTimeExpired (536).
 */
export function proposalVotingWindowSecs(
  snapshot: Pick<CommunityProposalSnapshot, "maxVotingTime">,
  baseVotingTime: number,
): number {
  const max = snapshot.maxVotingTime;
  if (max != null && max > 0) {
    return max;
  }
  return baseVotingTime;
}

/** Unix seconds when CastVote stops being accepted, or null if voting never opened. */
export function proposalVotingEndsAtSecs(
  snapshot: Pick<CommunityProposalSnapshot, "votingAt" | "maxVotingTime">,
  baseVotingTime: number,
): number | null {
  // spl-governance uses Option → undefined for None; we also normalize to null.
  const votingAt = snapshot.votingAt;
  if (votingAt == null) {
    return null;
  }
  return votingAt.toNumber() + proposalVotingWindowSecs(snapshot, baseVotingTime);
}

export function proposalVoteEnded(
  snapshot: Pick<CommunityProposalSnapshot, "votingAt" | "maxVotingTime">,
  baseVotingTime: number,
  nowSecs: number,
): boolean {
  const end = proposalVotingEndsAtSecs(snapshot, baseVotingTime);
  if (end === null) {
    return false;
  }
  return nowSecs >= end;
}

/**
 * True only while Realms will accept CastVote: account state is Voting and the
 * measured voting window has not elapsed.
 */
export function proposalVotingAcceptsCast(
  snapshot: Pick<CommunityProposalSnapshot, "state" | "votingAt" | "maxVotingTime">,
  baseVotingTime: number,
  nowSecs: number,
): boolean {
  if (snapshot.state !== ProposalState.Voting) {
    return false;
  }
  return !proposalVoteEnded(snapshot, baseVotingTime, nowSecs);
}
