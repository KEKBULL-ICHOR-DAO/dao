import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentSrc = readFileSync(join(clientRoot, "src/deployment.ts"), "utf8");
const typesSrc = readFileSync(join(clientRoot, "src/types.ts"), "utf8");
const indexSrc = readFileSync(join(clientRoot, "src/index.ts"), "utf8");

function exportedFn(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const nextExport = src.indexOf("\nexport async function ", start + 1);
  return src.slice(start, nextExport === -1 ? undefined : nextExport);
}

const ichorMintFn = exportedFn(deploymentSrc, "buildCreateIchorMintAccount");
const councilMintFn = exportedFn(deploymentSrc, "buildCreateBootstrapCouncilMint");
const zeroSupplyFn = exportedFn(deploymentSrc, "buildCreateZeroSupplyCouncilMint");

describe("unsigned ICHOR mint-account builder", () => {
  it("is a browser-safe Token-2022 TransferFeeConfig mint path", () => {
    assert.match(deploymentSrc, /export async function buildCreateIchorMintAccount/);
    assert.match(deploymentSrc, /export async function verifyCreatedIchorMintAccount/);
    assert.match(deploymentSrc, /from ["']@solana\/spl-token["']/);
    assert.match(deploymentSrc, /createInitializeTransferFeeConfigInstruction/);
    assert.match(deploymentSrc, /createInitializeMint2Instruction/);
    assert.match(deploymentSrc, /getMintLen\(\[ExtensionType\.TransferFeeConfig\]\)/);
    assert.match(deploymentSrc, /ICHOR_TRANSFER_FEE_MINT_LEN/);
    assert.match(deploymentSrc, /TOKEN_2022_PROGRAM_ID/);
    assert.match(deploymentSrc, /withdrawWithheldPda/);
    assert.match(deploymentSrc, /SystemProgram\.createAccount/);
    assert.match(deploymentSrc, /getMinimumBalanceForRentExemption/);
    assert.match(deploymentSrc, /assertVerifiedIchorProgram/);
    assert.match(deploymentSrc, /assertBoundConnection/);
    assert.match(deploymentSrc, /configPda/);
    assert.match(
      ichorMintFn,
      /createInitializeMint2Instruction\(\s*mint,\s*decimals,\s*payer,\s*null/,
    );
    assert.match(ichorMintFn, /programId:\s*tokenProgram/);
    assert.match(ichorMintFn, /space:\s*mintSpace/);
    assert.match(ichorMintFn, /lamports:\s*rentLamports/);
    assert.match(ichorMintFn, /requiredSignerPubkeys = \[payer,\s*mint\]/);
    assert.match(ichorMintFn, /mintAuthority:\s*configAddress/);
    assert.match(ichorMintFn, /withdrawWithheldAuthority:\s*withdrawAddress/);
    assert.match(ichorMintFn, /freezeAuthority:\s*null/);
    assert.match(ichorMintFn, /TRANSFER_FEE_BASIS_POINTS/);
    assert.match(ichorMintFn, /TRANSFER_FEE_MAXIMUM_FEE/);
    assert.match(deploymentSrc, /CONFIG_ALREADY_INITIALIZED/);
    assert.match(deploymentSrc, /MINT_ALREADY_EXISTS/);
    assert.match(deploymentSrc, /DEFAULT_PUBKEY/);
    assert.match(deploymentSrc, /pass exactly one of verified or verifiedProgram/);
    assert.match(deploymentSrc, /CALLER_MINT_OVERRIDE/);
    assert.match(deploymentSrc, /ICHOR_SUPPLY_MUST_BE_ZERO/);
    assert.match(deploymentSrc, /MINT_AUTHORITY_MISMATCH/);
    assert.match(deploymentSrc, /MINT_LEN_SDK_DRIFT/);
    assert.doesNotMatch(deploymentSrc, /createInitializeMintInstruction\b/);
    assert.doesNotMatch(deploymentSrc, /\bcreateMint\b/);
    assert.doesNotMatch(ichorMintFn, /createMintTo|mintToChecked|MintTo\b/);
    assert.doesNotMatch(ichorMintFn, /createInitializeAccount/);
    assert.match(ichorMintFn, /createSetAuthorityInstruction/);
    assert.match(
      ichorMintFn,
      /createSetAuthorityInstruction\(\s*mint,\s*payer,\s*AuthorityType\.MintTokens,\s*configAddress/,
    );
    assert.doesNotMatch(ichorMintFn, /\bMINT_SIZE\b/);
    assert.doesNotMatch(ichorMintFn, /TOKEN_PROGRAM_ID/);
    assert.match(ichorMintFn, /createInitializeMint2Instruction/);
    assert.match(ichorMintFn, /createIchorMetaplexCreateV1Instruction/);
    assert.match(ichorMintFn, /metadata:\s*metadataAddress/);
    assert.match(ichorMintFn, /metadataName:\s*ICHOR_TOKEN_NAME/);
    assert.match(ichorMintFn, /ICHOR_METADATA_ALREADY_EXISTS/);
    const feePos = ichorMintFn.indexOf("createInitializeTransferFeeConfigInstruction");
    const mintPos = ichorMintFn.indexOf("createInitializeMint2Instruction");
    const metaPos = ichorMintFn.indexOf("createIchorMetaplexCreateV1Instruction");
    const handoffPos = ichorMintFn.indexOf("createSetAuthorityInstruction");
    assert.ok(feePos !== -1 && feePos < mintPos, "TransferFeeConfig must initialize before the mint");
    assert.ok(mintPos !== -1 && mintPos < metaPos, "Metaplex CreateV1 must follow initializeMint2");
    assert.ok(
      metaPos !== -1 && metaPos < handoffPos,
      "SetAuthority to config PDA must follow CreateV1 so the payer can sign metadata",
    );
    assert.match(deploymentSrc, /verifyIchorMintMetaplexMetadata/);
    assert.match(typesSrc, /metadataName:\s*"ICHOR"/);
    assert.match(typesSrc, /metadataSymbol:\s*"ICHOR"/);
    assert.match(typesSrc, /metadataUri:\s*string/);
    assert.match(ichorMintFn, /requireIchorMetadataUri\(params\.metadataUri\)/);
    assert.match(deploymentSrc, /expectedMetadataUri/);
  });

  it("does not hardcode decimals, supply, or rent", () => {
    assert.doesNotMatch(deploymentSrc, /decimals:\s*6|decimals:\s*9/);
    assert.doesNotMatch(deploymentSrc, /DEFAULT_DECIMALS|DEFAULT_SUPPLY|DEFAULT_RENT/);
    assert.doesNotMatch(deploymentSrc, /1_000_000_000_000_000/);
    assert.doesNotMatch(deploymentSrc, /1461600|2039280|890880/);
    assert.doesNotMatch(deploymentSrc, /supply:\s*new BN|mintTo\(/);
    assert.doesNotMatch(deploymentSrc, /space:\s*82|MINT_BASE_LEN\s*=\s*82/);
    assert.match(deploymentSrc, /requireU8Decimals\(params\.decimals/);
    assert.match(ichorMintFn, /getMinimumBalanceForRentExemption\(\s*mintSpace/);
    assert.match(councilMintFn, /getMinimumBalanceForRentExemption\(\s*MINT_SIZE/);
    assert.match(deploymentSrc, /rentExemptionLamports:\s*new BN\(rentLamports\)/);
    assert.match(deploymentSrc, /ICHOR_TRANSFER_FEE_MINT_LEN = 278|ICHOR_TRANSFER_FEE_MINT_LEN/);
  });

  it("stays browser-safe: no secrets, sends, or node-only APIs", () => {
    assert.doesNotMatch(deploymentSrc, /\bBuffer\b/);
    assert.doesNotMatch(deploymentSrc, /from ["']node:/);
    assert.doesNotMatch(deploymentSrc, /createHash|createHmac|node:crypto/);
    assert.doesNotMatch(deploymentSrc, /\.toBuffer\(/);
    assert.doesNotMatch(deploymentSrc, /fs\.|child_process|process\.env/);
    assert.doesNotMatch(
      deploymentSrc,
      /Keypair\.fromSecretKey|Keypair\.fromSeed|sendAndConfirmTransaction|sendRawTransaction|sendTransaction/,
    );
    assert.doesNotMatch(deploymentSrc, /generateKeypair|Keypair\.generate/);
  });

  it("rejects caller authority, supply, rent, space, and token-program substitution", () => {
    assert.match(
      deploymentSrc,
      /CALLER_MINT_OVERRIDE_FIELDS = \[\s*"mintAuthority",\s*"freezeAuthority",\s*"supply",\s*"initialSupply",\s*"lamports",\s*"space",\s*"tokenProgram",\s*"tokenProgramId",\s*\]/,
    );
    assert.match(deploymentSrc, /field in params/);
    assert.match(deploymentSrc, /TOKEN_PROGRAM\.id/);
    assert.match(deploymentSrc, /TOKEN_2022_PROGRAM\.id/);
    assert.match(deploymentSrc, /INVALID_TOKEN_PROGRAM/);
  });

  it("exports the builder and param types without issued-brand leakage", () => {
    assert.match(typesSrc, /interface BuildIchorMintAccountParams/);
    assert.match(typesSrc, /interface IchorMintAccountBuild/);
    assert.match(
      typesSrc,
      /interface BuildIchorMintAccountParams \{[^}]*verifiedProgram[^}]*payer[^}]*mint[^}]*decimals[^}]*metadataUri[^}]*\}/s,
    );
    assert.doesNotMatch(
      typesSrc.match(/interface BuildIchorMintAccountParams \{[^}]*\}/s)?.[0] ?? "",
      /mintAuthority|freezeAuthority|supply|lamports|space|tokenProgram/,
    );
    assert.match(indexSrc, /buildCreateIchorMintAccount/);
    assert.match(indexSrc, /verifyCreatedIchorMintAccount/);
    assert.match(indexSrc, /BuildIchorMintAccountParams/);
    assert.match(indexSrc, /IchorMintAccountBuild/);
    assert.doesNotMatch(indexSrc, /IssuedVerifiedIchorProgram/);
    assert.doesNotMatch(deploymentSrc, /export class Issued/);
    assert.doesNotMatch(deploymentSrc, /IssuedVerifiedIchorProgram/);
    assert.doesNotMatch(deploymentSrc, /from ["']node:/);
  });
});

describe("unsigned fixed-supply bootstrap council mint", () => {
  it("orders create mint, initialize, ATAs, then mint-to, with no SetAuthority", () => {
    assert.match(deploymentSrc, /export async function buildCreateBootstrapCouncilMint/);
    assert.match(councilMintFn, /SystemProgram\.createAccount/);
    assert.match(
      councilMintFn,
      /createInitializeMint2Instruction\(\s*mint,\s*decimals,\s*mintAuthority,\s*null/,
    );
    assert.match(councilMintFn, /createAssociatedTokenAccountIdempotentInstruction/);
    assert.match(councilMintFn, /createMintToCheckedInstruction/);
    assert.doesNotMatch(councilMintFn, /createSetAuthorityInstruction/);
    assert.doesNotMatch(councilMintFn, /AuthorityType/);
    const createPos = councilMintFn.indexOf("SystemProgram.createAccount");
    const initPos = councilMintFn.indexOf("createInitializeMint2Instruction");
    const ataPos = councilMintFn.indexOf("createAssociatedTokenAccountIdempotentInstruction");
    const mintToPos = councilMintFn.indexOf("createMintToCheckedInstruction");
    assert.ok(createPos !== -1 && createPos < initPos, "createAccount must precede initializeMint2");
    assert.ok(initPos !== -1 && initPos < ataPos, "initializeMint2 must precede ATAs");
    assert.ok(ataPos !== -1 && ataPos < mintToPos, "ATAs must precede MintToChecked");
    assert.doesNotMatch(councilMintFn, /configPda/);
    assert.doesNotMatch(councilMintFn, /createInitializeMintInstruction\b/);
    assert.doesNotMatch(councilMintFn, /\bcreateMint\b/);
    assert.doesNotMatch(councilMintFn, /createMintToInstruction\b/);
  });

  it("verifies fixed live supply, retained mint authority, null freeze, and exact recipient ATAs", () => {
    assert.match(deploymentSrc, /export async function verifyCreatedBootstrapCouncilMint/);
    assert.match(deploymentSrc, /expectedMintAuthority/);
    assert.match(deploymentSrc, /COUNCIL_FREEZE_AUTHORITY_SET/);
    assert.match(deploymentSrc, /COUNCIL_MINT_AUTHORITY_NOT_RETAINED/);
    assert.match(deploymentSrc, /COUNCIL_SUPPLY_MISMATCH/);
    assert.match(deploymentSrc, /COUNCIL_ATA_MISSING/);
    assert.match(deploymentSrc, /COUNCIL_DISTRIBUTION_MISMATCH/);
    assert.match(deploymentSrc, /unpackAccount/);
  });

  it("does not hardcode decimals, supply, or rent and does not pick council seats", () => {
    assert.doesNotMatch(councilMintFn, /decimals:\s*6|decimals:\s*9/);
    assert.doesNotMatch(councilMintFn, /DEFAULT_DECIMALS|DEFAULT_SUPPLY|DEFAULT_RENT/);
    assert.doesNotMatch(councilMintFn, /DEFAULT_COUNCIL|COUNCIL_MEMBERS|BOOTSTRAP_RECIPIENTS/);
    assert.doesNotMatch(councilMintFn, /1_000_000_000_000_000/);
    assert.doesNotMatch(councilMintFn, /1461600|2039280|890880/);
    assert.doesNotMatch(councilMintFn, /space:\s*82|MINT_BASE_LEN\s*=\s*82/);
    assert.doesNotMatch(councilMintFn, /recipients\s*=\s*\[/);
    assert.match(councilMintFn, /requireU8Decimals\(params\.decimals/);
    assert.match(councilMintFn, /params\.recipients/);
    assert.match(councilMintFn, /getMinimumBalanceForRentExemption\(\s*MINT_SIZE/);
    assert.match(councilMintFn, /rentExemptionLamports:\s*new BN\(rentLamports\)/);
    assert.match(councilMintFn, /getAssociatedTokenAddressSync\(\s*mint,\s*owner/);
    assert.match(councilMintFn, /BigInt\(recipient\.amount\.toString\(\)\)/);
  });

  it("retains mint authority and leaves freeze null in the unsigned create transaction", () => {
    assert.doesNotMatch(councilMintFn, /AuthorityType\.MintTokens,\s*null/);
    assert.doesNotMatch(councilMintFn, /createSetAuthorityInstruction/);
    assert.match(councilMintFn, /freezeAuthority:\s*null/);
    assert.match(councilMintFn, /mintAuthority,/);
    assert.doesNotMatch(councilMintFn, /mintAuthority:\s*null/);
    assert.match(councilMintFn, /requiredSignerPubkeys = \[payer,\s*mint\]/);
    assert.match(councilMintFn, /requiredSignerPubkeys\.push\(mintAuthority\)/);
  });

  it("rejects duplicate/default recipients, bad amounts, overrides, caller ATAs, and Token-2022", () => {
    assert.match(councilMintFn, /RECIPIENTS_EMPTY/);
    assert.match(councilMintFn, /DUPLICATE_RECIPIENT/);
    assert.match(councilMintFn, /DEFAULT_PUBKEY/);
    assert.match(councilMintFn, /ARITHMETIC_OVERFLOW/);
    assert.match(councilMintFn, /requirePositiveBn/);
    assert.match(councilMintFn, /requireU64Bn/);
    assert.match(councilMintFn, /CALLER_ATA/);
    assert.match(councilMintFn, /assertNoCallerCouncilMintOverride/);
    assert.match(deploymentSrc, /CALLER_COUNCIL_MINT_OVERRIDE_FIELDS/);
    assert.match(deploymentSrc, /ClientValidationError\("CALLER_MINT_OVERRIDE"/);
    assert.match(councilMintFn, /MINT_ALREADY_EXISTS/);
    assert.match(councilMintFn, /requireLegacySplTokenProgram\(verified\.network\.tokenProgramId/);
    assert.match(deploymentSrc, /INVALID_TOKEN_PROGRAM/);
    assert.match(councilMintFn, /TOKEN_2022_PROGRAM\.id/);
    assert.match(councilMintFn, /assertBoundConnection\(verified,\s*params\.connection\)/);
    assert.match(councilMintFn, /assertNoSecretMaterial\(params,\s*"buildCreateBootstrapCouncilMint"\)/);
    assert.match(deploymentSrc, /VerifiedNetwork or VerifiedIchorProgram/);
    assert.doesNotMatch(councilMintFn, /sendAndConfirmTransaction|sendRawTransaction|sendTransaction/);
    assert.doesNotMatch(councilMintFn, /Keypair\.fromSecretKey|Keypair\.generate/);
  });

  it("exports the builder and param types without issued-brand leakage", () => {
    assert.match(typesSrc, /type BuildBootstrapCouncilMintParams/);
    assert.match(typesSrc, /interface BootstrapCouncilMintBuild/);
    assert.match(typesSrc, /interface BootstrapCouncilMintRecipient/);
    assert.match(
      typesSrc,
      /type BuildBootstrapCouncilMintParams = BootstrapCouncilMintBaseParams[\s\S]*verified: VerifiedNetwork[\s\S]*verifiedProgram: VerifiedIchorProgram/,
    );
    assert.doesNotMatch(
      typesSrc.match(/interface BootstrapCouncilMintBaseParams \{[^}]*\}/s)?.[0] ?? "",
      /freezeAuthority|totalRawSupply|lamports|space|tokenProgram|ata\b/,
    );
    assert.match(
      typesSrc.match(/interface BootstrapCouncilMintBuild \{[\s\S]*?^\}/m)?.[0] ?? "",
      /mintAuthority: PublicKey/,
    );
    assert.doesNotMatch(
      typesSrc.match(/interface BootstrapCouncilMintBuild \{[\s\S]*?^\}/m)?.[0] ?? "",
      /mintAuthority: null/,
    );
    assert.match(indexSrc, /buildCreateBootstrapCouncilMint/);
    assert.match(indexSrc, /verifyCreatedBootstrapCouncilMint/);
    assert.match(indexSrc, /buildAssignCouncilMintAuthorityToGovernance/);
    assert.match(indexSrc, /verifyCouncilMintAuthorityAssignedToGovernance/);
    assert.match(indexSrc, /BuildBootstrapCouncilMintParams/);
    assert.match(indexSrc, /BootstrapCouncilMintBuild/);
    assert.match(indexSrc, /BuildAssignCouncilMintAuthorityToGovernanceParams/);
    assert.match(indexSrc, /AssignCouncilMintAuthorityToGovernanceBuild/);
    assert.doesNotMatch(indexSrc, /IssuedVerifiedIchorProgram/);
    assert.doesNotMatch(councilMintFn, /from ["']node:/);
    assert.doesNotMatch(councilMintFn, /\bBuffer\b/);
  });
});

describe("unsigned zero-supply council mint", () => {
  it("builds a dedicated zero-supply council mint with no MintTo, ATA, or SetAuthority", () => {
    assert.match(deploymentSrc, /export async function buildCreateZeroSupplyCouncilMint/);
    assert.match(deploymentSrc, /export async function verifyCreatedZeroSupplyCouncilMint/);
    assert.match(zeroSupplyFn, /SystemProgram\.createAccount/);
    assert.match(
      zeroSupplyFn,
      /createInitializeMint2Instruction\(\s*mint,\s*decimals,\s*mintAuthority,\s*null/,
    );
    assert.doesNotMatch(zeroSupplyFn, /createMintToCheckedInstruction/);
    assert.doesNotMatch(zeroSupplyFn, /createMintToInstruction/);
    assert.doesNotMatch(zeroSupplyFn, /createAssociatedTokenAccountIdempotentInstruction/);
    assert.doesNotMatch(zeroSupplyFn, /createSetAuthorityInstruction/);
    assert.doesNotMatch(zeroSupplyFn, /AuthorityType/);
    assert.doesNotMatch(zeroSupplyFn, /params\.recipients/);
    assert.match(zeroSupplyFn, /ZERO_SUPPLY_RECIPIENTS_FORBIDDEN/);
    assert.match(zeroSupplyFn, /totalRawSupply:\s*new BN\(0\)/);
    assert.match(zeroSupplyFn, /freezeAuthority:\s*null/);
    assert.match(zeroSupplyFn, /assertNoSecretMaterial\(params,\s*"buildCreateZeroSupplyCouncilMint"\)/);
    assert.match(indexSrc, /buildCreateZeroSupplyCouncilMint/);
    assert.match(indexSrc, /verifyCreatedZeroSupplyCouncilMint/);
    assert.match(typesSrc, /type BuildZeroSupplyCouncilMintParams/);
    assert.match(typesSrc, /interface ZeroSupplyCouncilMintBuild/);
    assert.match(deploymentSrc, /COUNCIL_SUPPLY_NOT_ZERO/);
  });
});

describe("unsigned minimal-supply council mint", () => {
  const minimalFn = exportedFn(deploymentSrc, "buildCreateMinimalSupplyCouncilMint");

  it("parks one base unit at a derived non-voting sink and keeps mint authority", () => {
    assert.match(deploymentSrc, /export async function buildCreateMinimalSupplyCouncilMint/);
    assert.match(deploymentSrc, /export async function verifyCreatedMinimalSupplyCouncilMint/);
    assert.match(deploymentSrc, /export function deriveCouncilNonvotingSink/);
    assert.match(deploymentSrc, /new TextEncoder\(\)\.encode\(COUNCIL_NONVOTING_SINK_SEED\)/);
    assert.match(deploymentSrc, /findProgramAddressSync/);
    assert.match(deploymentSrc, /council-nonvoting-sink/);
    assert.match(minimalFn, /SystemProgram\.createAccount/);
    assert.match(
      minimalFn,
      /createInitializeMint2Instruction\(\s*mint,\s*decimals,\s*mintAuthority,\s*null/,
    );
    assert.match(minimalFn, /createAssociatedTokenAccountIdempotentInstruction/);
    assert.match(minimalFn, /createMintToCheckedInstruction/);
    assert.match(minimalFn, /getAssociatedTokenAddressSync\(mint,\s*nonvotingSink,\s*true/);
    assert.doesNotMatch(minimalFn, /createSetAuthorityInstruction/);
    assert.doesNotMatch(minimalFn, /params\.recipients/);
    assert.match(minimalFn, /MINIMAL_SUPPLY_RECIPIENTS_FORBIDDEN/);
    assert.match(minimalFn, /SINK_COLLIDES/);
    assert.match(minimalFn, /assertNoSecretMaterial\(params,\s*"buildCreateMinimalSupplyCouncilMint"\)/);
    assert.match(indexSrc, /buildCreateMinimalSupplyCouncilMint/);
    assert.match(indexSrc, /verifyCreatedMinimalSupplyCouncilMint/);
    assert.match(indexSrc, /deriveCouncilNonvotingSink/);
    assert.match(typesSrc, /type BuildMinimalSupplyCouncilMintParams/);
    assert.match(typesSrc, /interface MinimalSupplyCouncilMintBuild/);
    assert.match(deploymentSrc, /COUNCIL_SUPPLY_NOT_MINIMAL/);
    assert.match(deploymentSrc, /COUNCIL_SINK_NOT_PARKED/);
    assert.doesNotMatch(minimalFn, /\bBuffer\b/);
  });
});

describe("unsigned assign council mint authority to Governance", () => {
  const assignFn = exportedFn(deploymentSrc, "buildAssignCouncilMintAuthorityToGovernance");

  it("emits exactly one SetAuthority(MintTokens) to the issued Governance pubkey", () => {
    assert.match(deploymentSrc, /export async function buildAssignCouncilMintAuthorityToGovernance/);
    assert.match(
      assignFn,
      /createSetAuthorityInstruction\(\s*mint,\s*currentMintAuthority,\s*AuthorityType\.MintTokens,\s*governance/,
    );
    assert.equal(assignFn.split("createSetAuthorityInstruction").length - 1, 1);
    assert.doesNotMatch(assignFn, /AuthorityType\.MintTokens,\s*null/);
    assert.doesNotMatch(assignFn, /AuthorityType\.FreezeAccount/);
    assert.match(assignFn, /freezeAuthority:\s*null/);
    assert.match(assignFn, /assertBoundConnection\(verified,\s*params\.connection\)/);
    assert.match(assignFn, /assertVerifiedGovernanceIdentity\(params\.verifiedGovernance\)/);
    assert.match(assignFn, /requiredSignerPubkeys/);
    assert.match(assignFn, /requiredSignerPubkeys\.push\(currentMintAuthority\)/);
    assert.match(assignFn, /PublicKey\.default/);
    assert.doesNotMatch(assignFn, /\bnewAuthority\b/);
    assert.match(deploymentSrc, /export async function verifyCouncilMintAuthorityAssignedToGovernance/);
    assert.match(deploymentSrc, /COUNCIL_MINT_AUTHORITY_NOT_GOVERNANCE/);
    assert.match(assignFn, /resolveAccountReadCommitment\(params\.commitment\)/);
    const assignedFn = exportedFn(deploymentSrc, "verifyCouncilMintAuthorityAssignedToGovernance");
    assert.match(assignedFn, /resolveAccountReadCommitment\(params\.commitment\)/);
    const createdFn = exportedFn(deploymentSrc, "verifyCreatedZeroSupplyCouncilMint");
    assert.match(createdFn, /resolveAccountReadCommitment\(params\.commitment\)/);
  });

  it("takes Governance from the issued identity and refuses a caller newAuthority", () => {
    assert.match(typesSrc, /interface BuildAssignCouncilMintAuthorityToGovernanceParams/);
    assert.match(typesSrc, /interface AssignCouncilMintAuthorityToGovernanceBuild/);
    const params = typesSrc.match(/interface BuildAssignCouncilMintAuthorityToGovernanceParams \{[^}]*\}/s)?.[0] ?? "";
    assert.match(params, /verifiedGovernance: VerifiedGovernanceIdentity/);
    assert.match(params, /currentMintAuthority: PublicKey/);
    assert.doesNotMatch(params, /newAuthority/);
    assert.match(
      typesSrc.match(/interface AssignCouncilMintAuthorityToGovernanceBuild \{[^}]*\}/s)?.[0] ?? "",
      /freezeAuthority: null/,
    );
  });
});
