import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(clientRoot, "src");

function sourceFiles(): string[] {
  return readdirSync(srcDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(srcDir, name));
}

function readSrc(name: string): string {
  return readFileSync(join(srcDir, name), "utf8");
}

function exportedFn(src: string, name: string): string {
  const asyncStart = src.indexOf(`export async function ${name}`);
  const syncStart = src.indexOf(`export function ${name}`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) {
    return "";
  }
  const nextAsync = src.indexOf("\nexport async function ", start + 1);
  const nextSync = src.indexOf("\nexport function ", start + 1);
  const next =
    nextAsync === -1
      ? nextSync
      : nextSync === -1
        ? nextAsync
        : Math.min(nextAsync, nextSync);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("unsigned-only source hygiene", () => {
  it("does not construct Keypairs from secrets or send transactions", () => {
    const forbidden = [
      "Keypair.fromSecretKey",
      "Keypair.fromSeed",
      "sendTransaction",
      "sendAndConfirmTransaction",
      "sendRawTransaction",
    ];
    const hits: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const needle of forbidden) {
        if (text.includes(needle)) {
          hits.push(`${file}: ${needle}`);
        }
      }
    }
    assert.deepEqual(hits, []);
  });

  it("locks the initial pool with isLockLiquidity true", () => {
    const meteora = readSrc("meteora.ts");
    const types = readSrc("types.ts");
    const validation = readSrc("validation.ts");
    assert.match(meteora, /isLockLiquidity:\s*true/);
    assert.match(meteora, /assertIchorSolSeedPlan\(params\.seedPlan,\s*params\.connection\)/);
    const poolParams = types.match(/interface BuildIchorSolPoolParams \{[^}]*\}/s)?.[0] ?? "";
    assert.match(poolParams, /readonly seedPlan:/);
    assert.doesNotMatch(poolParams, /readonly amounts:|readonly ichorMint:|readonly verified:/);
    assert.doesNotMatch(meteora, /initialPrice:\s*1(\.0)?/);
    assert.doesNotMatch(meteora, /900000/);
    assert.match(exportedFn(validation, "assertExpectedLock"), /LOCK_MISMATCH/);
    assert.match(exportedFn(validation, "assertExpectedLock"), /\):\s*true \{/);
    assert.doesNotMatch(
      exportedFn(validation, "assertExpectedLock"),
      /return \(\s*params\.permanentLockedLiquidity/,
    );
    assert.match(exportedFn(meteora, "verifyPermanentLock"), /isFullyPermanentlyLocked:\s*true/);
    assert.match(exportedFn(meteora, "readLockedDammPoolTokens"), /verifyPermanentLock/);
    assert.match(exportedFn(meteora, "readLockedDammPoolTokens"), /tokenAVault/);
    assert.match(exportedFn(meteora, "readLockedDammPoolTokens"), /tokenBVault/);
    assert.match(exportedFn(meteora, "readLockedDammPoolTokens"), /verifiedGovernance/);
    assert.match(exportedFn(meteora, "readLockedDammPoolTokens"), /derivePositionAddress/);
    assert.match(exportedFn(meteora, "readLockedDammPoolTokens"), /protocolFeePercent/);
    assert.match(exportedFn(meteora, "readLockedDammPoolTokens"), /POSITION_NFT_SUPPLY|exactly 1/);
    assert.match(types, /readonly isFullyPermanentlyLocked:\s*true/);
    assert.doesNotMatch(types, /readonly isFullyPermanentlyLocked:\s*boolean/);
    assert.match(types, /readonly protocolFeePercent:\s*number/);
    assert.match(types, /readonly treasuryHoldsPositionNft:\s*true/);
  });
});

describe("red-team invariants", () => {
  it("plans ICHOR/SOL seed amounts from a bound proof and measured PumpSwap reserves", () => {
    const pricing = readSrc("pricing.ts");
    const types = readSrc("types.ts");
    const index = readSrc("index.ts");
    const network = readSrc("network.ts");
    assert.match(pricing, /export async function planIchorSolSeed/);
    assert.match(pricing, /export async function readCanonicalPumpSwapPoolSnapshot/);
    assert.match(index, /readCanonicalPumpSwapPoolSnapshot/);
    assert.match(index, /readLockedDammPoolTokens/);
    assert.match(pricing, /assertBoundConnection\(verifiedConfig\.verifiedProgram\.verified, connection\)/);
    assert.match(pricing, /assertVerifiedIchorConfig/);
    assert.match(pricing, /OFF_VIRTUAL_QUOTE = 245/);
    assert.match(pricing, /POOL_AUTHORITY_SEED = utf8\.encode\("pool-authority"\)/);
    assert.match(pricing, /POOL_SEED = utf8\.encode\("pool"\)/);
    assert.match(pricing, /ADJUSTMENT_BPS_REQUIRED/);
    assert.match(network, /pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA/);
    assert.match(types, /interface PlanIchorSolSeedParams/);
    assert.match(types, /interface IchorSolSeedPlan/);
    assert.match(index, /planIchorSolSeed/);
    assert.match(index, /PUMP_SWAP/);
    assert.doesNotMatch(pricing, /decimals:\s*6|decimals:\s*9/);
    assert.doesNotMatch(pricing, /900000/);
    assert.doesNotMatch(pricing, /initialPrice:\s*1(\.0)?/);
    assert.doesNotMatch(pricing, /\bBuffer\b|from ["']node:/);
    assert.doesNotMatch(pricing, /Keypair\.fromSecretKey|sendAndConfirmTransaction|sendRawTransaction/);
    assert.doesNotMatch(index, /IssuedVerifiedIchorConfig/);
  });

  it("builds an unsigned ICHOR mint account from chain rent and config PDA", () => {
    const deployment = readSrc("deployment.ts");
    const types = readSrc("types.ts");
    const index = readSrc("index.ts");
    assert.match(deployment, /export async function buildCreateIchorMintAccount/);
    assert.match(deployment, /assertBoundConnection\(params\.verifiedProgram\.verified,\s*params\.connection\)/);
    assert.match(deployment, /assertVerifiedIchorProgram\(params\.verifiedProgram\)/);
    assert.match(deployment, /configPda\(params\.verifiedProgram\.programId\)/);
    assert.match(deployment, /getMintLen\(\[ExtensionType\.TransferFeeConfig\]\)/);
    assert.match(deployment, /ICHOR_TRANSFER_FEE_MINT_LEN/);
    assert.match(deployment, /createInitializeTransferFeeConfigInstruction/);
    assert.match(
      exportedFn(deployment, "buildCreateIchorMintAccount"),
      /getMinimumBalanceForRentExemption\(\s*mintSpace/,
    );
    assert.match(deployment, /createInitializeMint2Instruction\(\s*mint,\s*decimals,\s*payer,\s*null/);
    assert.match(
      exportedFn(deployment, "buildCreateIchorMintAccount"),
      /createSetAuthorityInstruction\(\s*mint,\s*payer,\s*AuthorityType\.MintTokens,\s*configAddress/,
    );
    assert.match(deployment, /SystemProgram\.createAccount/);
    assert.match(deployment, /requiredSignerPubkeys = \[payer,\s*mint\]/);
    assert.match(deployment, /CALLER_MINT_OVERRIDE/);
    assert.match(deployment, /CONFIG_ALREADY_INITIALIZED/);
    assert.match(deployment, /MINT_ALREADY_EXISTS/);
    assert.match(types, /interface BuildIchorMintAccountParams/);
    assert.match(types, /interface IchorMintAccountBuild/);
    assert.match(index, /buildCreateIchorMintAccount/);
    assert.doesNotMatch(deployment, /decimals:\s*6|decimals:\s*9/);
    assert.doesNotMatch(deployment, /1_000_000_000_000_000|1461600|2039280/);
    assert.doesNotMatch(deployment, /\bBuffer\b|from ["']node:/);
    assert.doesNotMatch(deployment, /Keypair\.fromSecretKey|sendAndConfirmTransaction|sendRawTransaction/);
    assert.doesNotMatch(deployment, /\bcreateMint\b|createInitializeMintInstruction\b/);
    assert.doesNotMatch(
      exportedFn(deployment, "buildCreateIchorMintAccount"),
      /createMintTo|mintToChecked/,
    );
    assert.doesNotMatch(index, /IssuedVerifiedIchorProgram/);
  });

  it("builds an unsigned zero-supply council mint with no MintTo or SetAuthority", () => {
    const deployment = readSrc("deployment.ts");
    const types = readSrc("types.ts");
    const index = readSrc("index.ts");
    const zero = exportedFn(deployment, "buildCreateZeroSupplyCouncilMint");
    assert.match(deployment, /export async function buildCreateZeroSupplyCouncilMint/);
    assert.match(zero, /SystemProgram\.createAccount/);
    assert.match(
      zero,
      /createInitializeMint2Instruction\(\s*mint,\s*decimals,\s*mintAuthority,\s*null/,
    );
    assert.doesNotMatch(zero, /createMintToCheckedInstruction|createMintToInstruction/);
    assert.doesNotMatch(zero, /createAssociatedTokenAccountIdempotentInstruction/);
    assert.doesNotMatch(zero, /createSetAuthorityInstruction|AuthorityType/);
    assert.match(zero, /ZERO_SUPPLY_RECIPIENTS_FORBIDDEN/);
    assert.match(zero, /totalRawSupply:\s*new BN\(0\)/);
    assert.match(types, /type BuildZeroSupplyCouncilMintParams/);
    assert.match(index, /buildCreateZeroSupplyCouncilMint/);
    assert.match(index, /verifyCreatedZeroSupplyCouncilMint/);
  });

  it("builds an unsigned minimal-supply council mint parked at a derived non-voting sink", () => {
    const deployment = readSrc("deployment.ts");
    const types = readSrc("types.ts");
    const index = readSrc("index.ts");
    const minimal = exportedFn(deployment, "buildCreateMinimalSupplyCouncilMint");
    const derive = exportedFn(deployment, "deriveCouncilNonvotingSink");
    assert.match(deployment, /export async function buildCreateMinimalSupplyCouncilMint/);
    assert.match(deployment, /export function deriveCouncilNonvotingSink/);
    assert.match(deployment, /COUNCIL_NONVOTING_SINK_SEED = "council-nonvoting-sink"/);
    assert.match(derive, /TextEncoder/);
    assert.match(derive, /findProgramAddressSync/);
    assert.match(derive, /COUNCIL_NONVOTING_SINK_SEED/);
    assert.doesNotMatch(derive, /\bBuffer\b/);
    assert.match(minimal, /SystemProgram\.createAccount/);
    assert.match(
      minimal,
      /createInitializeMint2Instruction\(\s*mint,\s*decimals,\s*mintAuthority,\s*null/,
    );
    assert.match(minimal, /createAssociatedTokenAccountIdempotentInstruction/);
    assert.match(minimal, /createMintToCheckedInstruction/);
    assert.match(minimal, /getAssociatedTokenAddressSync\(mint,\s*nonvotingSink,\s*true/);
    assert.doesNotMatch(minimal, /createSetAuthorityInstruction|AuthorityType/);
    assert.match(minimal, /MINIMAL_SUPPLY_RECIPIENTS_FORBIDDEN/);
    assert.match(types, /type BuildMinimalSupplyCouncilMintParams/);
    assert.match(types, /interface MinimalSupplyCouncilMintBuild/);
    assert.match(index, /buildCreateMinimalSupplyCouncilMint/);
    assert.match(index, /verifyCreatedMinimalSupplyCouncilMint/);
    assert.match(index, /deriveCouncilNonvotingSink/);
  });

  it("builds an unsigned fixed-supply bootstrap council mint and keeps mint authority for Governance assignment", () => {
    const deployment = readSrc("deployment.ts");
    const types = readSrc("types.ts");
    const index = readSrc("index.ts");
    const council = exportedFn(deployment, "buildCreateBootstrapCouncilMint");
    const assign = exportedFn(deployment, "buildAssignCouncilMintAuthorityToGovernance");
    assert.match(deployment, /export async function buildCreateBootstrapCouncilMint/);
    assert.match(council, /assertBoundConnection\(verified,\s*params\.connection\)/);
    assert.match(council, /getMinimumBalanceForRentExemption\(\s*MINT_SIZE/);
    assert.match(
      council,
      /createInitializeMint2Instruction\(\s*mint,\s*decimals,\s*mintAuthority,\s*null/,
    );
    assert.match(council, /createAssociatedTokenAccountIdempotentInstruction/);
    assert.match(council, /createMintToCheckedInstruction/);
    assert.doesNotMatch(council, /createSetAuthorityInstruction/);
    const createPos = council.indexOf("SystemProgram.createAccount");
    const initPos = council.indexOf("createInitializeMint2Instruction");
    const ataPos = council.indexOf("createAssociatedTokenAccountIdempotentInstruction");
    const mintToPos = council.indexOf("createMintToCheckedInstruction");
    assert.ok(createPos !== -1 && createPos < initPos);
    assert.ok(initPos !== -1 && initPos < ataPos);
    assert.ok(ataPos !== -1 && ataPos < mintToPos);
    assert.doesNotMatch(council, /mintAuthority:\s*null/);
    assert.match(council, /RECIPIENTS_EMPTY|DUPLICATE_RECIPIENT|CALLER_ATA/);
    assert.match(types, /type BuildBootstrapCouncilMintParams/);
    assert.match(types, /interface BootstrapCouncilMintBuild/);
    assert.match(index, /buildCreateBootstrapCouncilMint/);
    assert.match(index, /buildAssignCouncilMintAuthorityToGovernance/);
    assert.match(
      assign,
      /createSetAuthorityInstruction\(\s*mint,\s*currentMintAuthority,\s*AuthorityType\.MintTokens,\s*governance/,
    );
    assert.equal(assign.split("createSetAuthorityInstruction").length - 1, 1);
    assert.doesNotMatch(assign, /AuthorityType\.MintTokens,\s*null/);
    assert.match(assign, /assertVerifiedGovernanceIdentity/);
    assert.doesNotMatch(council, /decimals:\s*6|decimals:\s*9/);
    assert.doesNotMatch(council, /1_000_000_000_000_000|1461600|2039280/);
    assert.doesNotMatch(council, /configPda|DEFAULT_COUNCIL|COUNCIL_MEMBERS/);
    assert.doesNotMatch(council, /Keypair\.fromSecretKey|sendAndConfirmTransaction|sendRawTransaction/);
  });

  it("does not cap mint decimals at 18", () => {
    const validation = readSrc("validation.ts");
    assert.doesNotMatch(validation, /MAX_DECIMALS\s*=\s*18/);
    assert.match(validation, /U8_MAX\s*=\s*255/);
  });

  it("builds unsigned admin instructions from an issued VerifiedIchorConfig", () => {
    const admin = readSrc("admin.ts");
    const types = readSrc("types.ts");
    const index = readSrc("index.ts");
    assert.match(admin, /export async function buildSetPaused/);
    assert.match(admin, /export async function buildProposeEmissionRatio/);
    assert.match(admin, /export async function buildApplyEmissionRatio/);
    assert.match(admin, /export async function buildApplyEmissionRatioTransaction/);
    assert.match(admin, /export async function buildCancelPendingRatio/);
    assert.match(admin, /export async function buildFreezeRatioUpdates/);
    assert.match(admin, /export async function buildIncreaseRatioTimelock/);
    assert.match(admin, /export async function buildSetPendingAuthority/);
    assert.match(admin, /export async function buildAcceptAuthority/);
    assert.match(admin, /export async function buildSetPendingAuthorityToGovernance/);
    assert.match(admin, /export async function buildAcceptAuthorityAsGovernance/);
    assert.match(admin, /assertVerifiedIchorConfig\(params\.verifiedConfig\)/);
    assert.match(admin, /assertBoundConnection\(verifiedProgram\.verified, params\.connection\)/);
    assert.match(admin, /isSigner: true, isWritable: false/);
    assert.match(admin, /OPTION_NONE = 0/);
    assert.match(admin, /OPTION_SOME = 1/);
    assert.match(admin, /PAYER_REQUIRED/);
    assert.match(admin, /CALLER_PROGRAM_OR_CONFIG/);
    assert.match(admin, /CALLER_SIGNER/);
    assert.match(types, /interface BuildSetPausedParams/);
    assert.match(types, /interface BuildApplyEmissionRatioTransactionParams/);
    assert.match(index, /buildSetPaused/);
    assert.match(index, /buildAcceptAuthority/);
    assert.match(index, /buildSetPendingAuthorityToGovernance/);
    assert.match(index, /buildAcceptAuthorityAsGovernance/);
    assert.match(types, /interface BuildSetPendingAuthorityToGovernanceParams extends BuildAdminParams/);
    assert.match(types, /interface BuildAcceptAuthorityAsGovernanceParams/);
    assert.doesNotMatch(
      types.slice(
        types.indexOf("interface BuildSetPendingAuthorityToGovernanceParams"),
        types.indexOf("interface BuildAcceptAuthorityAsGovernanceParams"),
      ),
      /readonly pending:/,
    );
    assert.doesNotMatch(
      types.slice(
        types.indexOf("interface BuildAcceptAuthorityAsGovernanceParams"),
        types.indexOf("interface BuildSetFeeDistributionParams"),
      ),
      /readonly pendingAuthority:/,
    );
    assert.match(index, /SET_PAUSED_DISCRIMINATOR/);
    assert.doesNotMatch(admin, /\bBuffer\b|from ["']node:/);
    assert.doesNotMatch(admin, /createHash|Keypair\.fromSecretKey|sendAndConfirmTransaction/);
    assert.doesNotMatch(admin, /new PublicKey\s*\(\s*["']/);
    assert.doesNotMatch(admin, /KEKBULL_ICHOR_PROGRAM_ID\s*=\s*["']/);
    assert.doesNotMatch(index, /IssuedVerifiedIchorConfig/);
  });

  it("encodes convert from live program accounts, not a blocked placeholder", () => {
    const burn = readSrc("burn.ts");
    const types = readSrc("types.ts");
    const index = readSrc("index.ts");
    assert.doesNotMatch(burn, /BURN_BUILDER_BLOCKED/);
    assert.doesNotMatch(burn, /\bBuffer\b/);
    assert.doesNotMatch(burn, /from ["']node:/);
    assert.doesNotMatch(burn, /createHash/);
    assert.match(burn, /CONVERT_DISCRIMINATOR/);
    assert.match(burn, /INITIALIZE_DISCRIMINATOR/);
    assert.match(burn, /CONFIG_ACCOUNT_DISCRIMINATOR/);
    assert.match(burn, /as TransactionInstruction\["data"\]/);
    assert.match(burn, /min_ichor_amount/);
    assert.match(burn, /parseUpgradeableProgramData/);
    assert.match(burn, /upgradeAuthority/);
    assert.match(burn, /deploymentSlot/);
    assert.match(burn, /UPGRADE_AUTHORITY_REVOKED/);
    assert.match(burn, /NOT_UPGRADE_AUTHORITY/);
    assert.match(burn, /new\s+TransactionInstruction\s*\(/);
    assert.match(burn, /BurnChecked/);
    assert.match(burn, /MintToChecked/);
    assert.match(burn, /seeds=\["config"\]|CONFIG_SEED/);
    assert.match(burn, /BONDING_CURVE_SEED/);
    assert.match(burn, /assertBoundConnection/);
    assert.match(burn, /assertVerifiedIchorConfig/);
    assert.match(burn, /verifyIchorProgramDeployment/);
    assert.match(burn, /verifyIchorConfigDeployment/);
    assert.match(burn, /PROGRAM_ID_UNCONFIGURED|requireConfiguredDeploymentAddress/);
    assert.match(burn, /PROGRAM_NOT_DEPLOYED/);
    assert.match(burn, /CONFIG_NOT_INITIALIZED/);
    assert.match(burn, /fetchMintSnapshot/);
    assert.match(burn, /getAssociatedTokenAddressSync/);
    assert.match(burn, /requireGraduatedCurve/);
    assert.match(burn, /ichorFromKekbull/);
    assert.match(burn, /class IssuedVerifiedIchorProgram/);
    assert.match(burn, /class IssuedVerifiedIchorConfig/);
    assert.doesNotMatch(burn, /export class IssuedVerifiedIchorProgram/);
    assert.doesNotMatch(burn, /export class IssuedVerifiedIchorConfig/);
    assert.doesNotMatch(index, /IssuedVerifiedIchorProgram/);
    assert.doesNotMatch(index, /issuedIchorProgramProofs/);
    assert.match(index, /verifyIchorProgramDeployment/);
    assert.match(index, /verifyIchorConfigDeployment/);
    assert.match(types, /interface VerifiedIchorConfig/);
    assert.match(types, /interface BuildConvertParams/);
    assert.doesNotMatch(burn, /decimals:\s*6/);
    assert.doesNotMatch(burn, /1_000_000_000_000_000/);
    assert.doesNotMatch(burn, /Keypair\.fromSecretKey|sendAndConfirmTransaction|sendRawTransaction/);
  });

  it("requires creator==payer for atomic permanent-lock bootstrap", () => {
    const meteora = readSrc("meteora.ts");
    assert.match(meteora, /creator\.equals\(params\.payer\)/);
    assert.match(meteora, /CREATOR_PAYER_MISMATCH/);
  });

  it("requires an issued VerifiedNetwork on builders", () => {
    const meteora = readSrc("meteora.ts");
    const realms = readSrc("realms.ts");
    assert.match(meteora, /assertMeteoraProgramId\(params\.verified,\s*params\.connection\)/);
    assert.match(realms, /assertVerifiedNetwork\(params\.verified\)/);
    assert.match(
      realms,
      /assertBoundConnection\((?:params\.verified|verified),\s*params\.connection\)/,
    );
    assert.match(readSrc("burn.ts"), /assertBoundConnection\(verifiedProgram\.verified,\s*params\.connection\)/);
    assert.match(readSrc("burn.ts"), /assertVerifiedIchorConfig\(params\.verifiedConfig\)/);
    assert.match(readSrc("pricing.ts"), /assertBoundConnection\(verifiedConfig\.verifiedProgram\.verified,\s*connection\)/);
    assert.match(readSrc("pricing.ts"), /assertVerifiedIchorConfig/);
    assert.match(readSrc("preflight.ts"), /PROGRAM_NOT_DEPLOYED/);
    assert.match(readSrc("preflight.ts"), /executable=false/);
    assert.match(readSrc("preflight.ts"), /PROGRAM_LOADER_UNKNOWN/);
  });

  it("creates Governance with community live and council vote thresholds Disabled", () => {
    const realms = readSrc("realms.ts");
    const types = readSrc("types.ts");
    assert.match(realms, /communityVoteThreshold:\s*disabledThreshold\(\)/);
    assert.match(
      types,
      /interface BuildRealmParams \{[^}]*verifiedConfig[^}]*\}/s,
    );
    assert.doesNotMatch(
      types.match(/interface BuildRealmParams \{[^}]*\}/s)?.[0] ?? "",
      /readonly ichorMint:|readonly verified:/,
    );
    assert.match(
      types,
      /interface BuildRealmParams \{[^}]*communityMintMaxVoteWeightSource[^}]*\}/s,
    );
    assert.match(realms, /const ichorMint = params\.verifiedConfig\.config\.ichorMint/);
    const createRealmFn = exportedFn(realms, "buildCreateRealm");
    const createStart = createRealmFn.indexOf("withCreateRealm(");
    let createCall = "";
    if (createStart !== -1) {
      let depth = 0;
      for (let i = createStart; i < createRealmFn.length; i++) {
        if (createRealmFn[i] === "(") depth += 1;
        if (createRealmFn[i] === ")") {
          depth -= 1;
          if (depth === 0) {
            createCall = createRealmFn.slice(createStart, i + 1);
            break;
          }
        }
      }
    }
    assert.match(createCall, /communityMintMaxVoteWeightSource/);
    assert.doesNotMatch(createCall, /FULL_SUPPLY/);
    assert.doesNotMatch(createCall, /MintMaxVoteWeightSource\.FULL_SUPPLY_FRACTION/);
    assert.match(createRealmFn, /requireReachableMintMaxVoteWeightSource/);
    assert.match(createRealmFn, /assertMainnetVoteWeightSource/);
    assert.match(createRealmFn, /linearDepositedTokenConfig\(\)/);
    assert.match(createRealmFn, /UNREACHABLE_QUORUM_DENOMINATOR/);
    assert.match(realms, /export async function buildDepositCouncilVotes/);
    assert.match(realms, /export async function buildTransferRealmAuthorityToGovernance/);
    assert.match(realms, /withSetRealmAuthority/);
    assert.match(realms, /SetRealmAuthorityAction\.SetChecked/);
    assert.match(realms, /AUTHORITY_ALREADY_GOVERNANCE/);
    assert.match(realms, /AUTHORITY_DEFAULT/);
    assert.match(realms, /newRealmAuthority/);
    assert.match(realms, /export async function buildRemoveCouncilInstruction/);
    assert.match(realms, /export async function buildCastCouncilVote/);
    assert.match(realms, /export async function buildWithdrawCouncilVotes/);
    assert.match(realms, /COUNCIL_DEPOSITS_REMAIN/);
    assert.match(realms, /withSetRealmConfig/);
    assert.match(realms, /Governance must be the live Realm authority/);
    assert.match(realms, /COUNCIL_MINT_MISSING/);
    assert.match(realms, /Proposal-only payload/);
    assert.match(realms, /expected 4 for v3 council removal/);
    assert.match(realms, /SystemProgram\.programId/);
    assert.match(realms, /setRealmConfig key\[0\] realm must be writable non-signer/);
    assert.match(realms, /setRealmConfig key\[1\] Governance must be a readonly signer/);
    assert.match(realms, /setRealmConfig key\[2\] SystemProgram must be readonly non-signer/);
    assert.match(realms, /setRealmConfig key\[3\] RealmConfig must be writable non-signer/);
    assert.match(
      realms,
      /assertIdentityBoundLifecycle\(\s*params,\s*params\.verifiedGovernance,\s*"buildRemoveCouncilInstruction"/,
    );
    assert.match(
      realms,
      /assertIdentityBoundLifecycle\(\s*params,\s*params\.verifiedGovernance,\s*"buildTransferRealmAuthorityToGovernance"/,
    );
    assert.match(realms, /buildCreateGovernance\(\s*params: BuildCreateGovernanceParams/);
    assert.match(
      types,
      /interface BuildCreateGovernanceParams \{[^}]*config: CommunityActivationConfig/,
    );
    assert.match(
      types,
      /interface BuildRealmParams \{[^}]*councilMint: PublicKey[^}]*minCommunityWeightToCreateGovernance/,
    );
    assert.match(realms, /COUNCIL_MINT_MISMATCH/);
    const createGov = exportedFn(realms, "buildCreateGovernance");
    assert.match(createGov, /assertMainnetCommunityActivation/);
    assert.match(createGov, /communityActivationGovernanceConfig\(params\.config\)/);
    assert.doesNotMatch(createGov, /bootstrapGovernanceConfig/);
    assert.doesNotMatch(createGov, /COMMUNITY_PROPOSAL_DISABLED/);
    const activationCfg = exportedFn(realms, "communityActivationGovernanceConfig");
    assert.match(activationCfg, /communityVoteThreshold:\s*yesPercent\(config\.communityVoteThresholdPercent\)/);
    assert.match(activationCfg, /councilVoteThreshold:\s*disabledThreshold\(\)/);
    assert.match(activationCfg, /councilVetoVoteThreshold:\s*disabledThreshold\(\)/);
    assert.match(activationCfg, /communityVoteTipping:\s*VoteTipping\.Disabled/);
    assert.doesNotMatch(activationCfg, /communityVoteTipping:\s*VoteTipping\.Strict/);
    assert.match(realms, /minCommunityTokensToCreateProposal:\s*COMMUNITY_PROPOSAL_DISABLED/);
    assert.match(realms, /communityVoteTipping:\s*VoteTipping\.Disabled/);
    assert.match(
      types,
      /interface BootstrapCouncilConfig \{[^}]*councilMint[^}]*\}/s,
    );
    assert.match(
      types.match(/interface BootstrapCouncilConfig \{[^}]*\}/s)?.[0] ?? "",
      /1-100|1-100/,
    );
    assert.doesNotMatch(
      types.match(/interface BootstrapCouncilConfig \{[^}]*\}/s)?.[0] ?? "",
      /communityVoteThresholdPercent/,
    );
    const validation = readSrc("validation.ts");
    assert.match(validation, /export function requireReachableMintMaxVoteWeightSource/);
    assert.match(validation, /UNREACHABLE_QUORUM_DENOMINATOR/);
    assert.match(validation, /fullSupplyFractionValue/);
    assert.match(validation, /export function requireYesVotePercent/);
    assert.match(validation, /requireYesVotePercent\(council\.councilVoteThresholdPercent/);
    assert.match(validation, /requireYesVotePercent\(\s*council\.councilVetoVoteThresholdPercent/);
    assert.match(validation, /INVALID_YES_VOTE_PERCENT/);
    assert.match(
      validation,
      /requireYesVotePercent\(\s*config\.communityVoteThresholdPercent/,
    );
    assert.match(
      types,
      /interface BuildTransferRealmAuthorityParams \{[^}]*verifiedGovernance[^}]*currentAuthority[^}]*\}/s,
    );
    assert.doesNotMatch(
      types.match(/interface BuildTransferRealmAuthorityParams \{[^}]*\}/s)?.[0] ?? "",
      /readonly newRealmAuthority:|readonly destination:|readonly action:/,
    );
    assert.match(realms, /createSetGovernanceConfig/);
    assert.match(realms, /PLAN §13 recovery window|bootstrap signer/);
    assert.match(
      types,
      /interface BuildNativeTreasuryParams \{[^}]*verifiedGovernance[^}]*\}/s,
    );
    assert.doesNotMatch(
      types.match(/interface BuildNativeTreasuryParams \{[^}]*\}/s)?.[0] ?? "",
      /readonly governance:/,
    );
  });

  it("keeps Realms 0.3.33 insert/execute argument order", () => {
    const realms = readSrc("realms.ts");
    assert.match(
      realms,
      /withInsertTransaction\(\s*instructions,\s*verified\.network\.realmsProgramId,\s*verified\.network\.programVersion,\s*governance,\s*params\.proposal,\s*params\.tokenOwnerRecord,\s*params\.governanceAuthority,\s*index,\s*optionIndex,\s*holdUpTime,\s*encoded,\s*params\.payer,/,
    );
    assert.match(
      realms,
      /withExecuteTransaction\(\s*instructions,\s*verified\.network\.realmsProgramId,\s*verified\.network\.programVersion,\s*governance,\s*params\.proposal,\s*params\.staged\.transactionAddress,\s*encoded,/,
    );
    assert.match(realms, /assertInnerInstructionsMatch\(inner,\s*params\.transactionInstructions\)/);
    assert.match(realms, /const encoded = inner\.map\(toInstructionData\)/);
    assert.doesNotMatch(
      exportedFn(realms, "buildExecuteProposalTransaction"),
      /params\.transactionInstructions\.map\(toInstructionData\)/,
    );
  });

  it("keeps Realms 0.3.33 cast/relinquish/withdraw argument order", () => {
    const realms = readSrc("realms.ts");
    assert.match(realms, /Vote\.fromYesNoVote\(/);
    assert.match(realms, /YesNoVote\.Yes/);
    assert.match(realms, /YesNoVote\.No/);
    assert.doesNotMatch(realms, /new\s+Vote\s*\(/);
    assert.doesNotMatch(realms, /VoteKind/);
    assert.doesNotMatch(realms, /quadratic/i);
    assert.doesNotMatch(realms, /VoterStakeRegistry|\bVSR\b/);
    const voteLifecycle = [
      exportedFn(realms, "buildCastCommunityVote"),
      exportedFn(realms, "buildCastCouncilVote"),
      exportedFn(realms, "buildRelinquishCommunityVote"),
      exportedFn(realms, "buildRelinquishCouncilVote"),
      exportedFn(realms, "buildFinalizeVote"),
      exportedFn(realms, "buildSetRealmConfigCouncilMint"),
      exportedFn(realms, "buildWithdrawIchorVotes"),
      exportedFn(realms, "buildWithdrawCouncilVotes"),
    ].join("\n");
    assert.match(realms, /export async function listStandingCommunityVotes/);
    assert.match(realms, /export async function buildRelinquishStandingCommunityVotes/);
    assert.match(realms, /export async function listUnrelinquishedVotesOnProposal/);
    assert.match(realms, /export async function buildReleaseVotesOnClosedProposal/);
    assert.match(realms, /export async function buildReleaseStandingAndWithdrawIchorVotes/);
    assert.match(realms, /getVoteRecordsByVoter/);
    assert.match(realms, /getGovernanceAccounts/);
    assert.match(exportedFn(realms, "buildFinalizeVote"), /releaseVoterDeposits/);
    assert.match(exportedFn(realms, "buildFinalizeVote"), /listUnrelinquishedVotesOnProposal/);
    assert.match(exportedFn(realms, "buildWithdrawIchorVotes"), /UNRELINQUISHED_VOTES/);
    assert.match(exportedFn(realms, "buildWithdrawIchorVotes"), /expectRelinquishInSameTransaction/);
    assert.match(exportedFn(realms, "buildWithdrawIchorVotes"), /OUTSTANDING_PROPOSALS/);
    assert.doesNotMatch(voteLifecycle, /new\s+TransactionInstruction\s*\(/);
    assert.doesNotMatch(realms, /discriminator\s*[:=]/);
    assert.match(
      realms,
      /withCastVote\(\s*instructions,\s*verified\.network\.realmsProgramId,\s*verified\.network\.programVersion,\s*realm,\s*governance,\s*params\.proposal,\s*params\.proposalOwnerRecord,\s*params\.tokenOwnerRecord,\s*params\.governanceAuthority,\s*communityMint,\s*vote,\s*params\.payer,\s*undefined,\s*undefined,/,
    );
    assert.match(
      realms,
      /withCastVote\(\s*instructions,\s*verified\.network\.realmsProgramId,\s*verified\.network\.programVersion,\s*realm,\s*governance,\s*params\.proposal,\s*params\.proposalOwnerRecord,\s*params\.tokenOwnerRecord,\s*params\.governanceAuthority,\s*councilMint,\s*vote,\s*params\.payer,\s*undefined,\s*undefined,/,
    );
    assert.match(
      exportedFn(realms, "buildCastCouncilVote"),
      /assertIdentityBoundLifecycle/,
    );
    assert.match(
      exportedFn(realms, "buildWithdrawCouncilVotes"),
      /getAssociatedTokenAddressSync/,
    );
    assert.doesNotMatch(
      exportedFn(realms, "buildWithdrawCouncilVotes"),
      /patchWithdrawGoverningTokenKeys/,
    );
    assert.match(
      realms,
      /withRelinquishVote\(\s*instructions,\s*verified\.network\.realmsProgramId,\s*verified\.network\.programVersion,\s*realm,\s*governance,\s*params\.proposal,\s*params\.tokenOwnerRecord,\s*communityMint,\s*params\.voteRecord,\s*governanceAuthority,\s*beneficiary,/,
    );
    assert.match(
      realms,
      /withRelinquishVote\(\s*instructions,\s*verified\.network\.realmsProgramId,\s*verified\.network\.programVersion,\s*realm,\s*governance,\s*params\.proposal,\s*params\.tokenOwnerRecord,\s*councilMint,\s*params\.voteRecord,\s*governanceAuthority,\s*beneficiary,/,
    );
    assert.match(
      realms,
      /withFinalizeVote\(\s*instructions,\s*verified\.network\.realmsProgramId,\s*verified\.network\.programVersion,\s*realm,\s*governance,\s*params\.proposal,\s*params\.proposalOwnerRecord,\s*governingTokenMint,\s*undefined,/,
    );
    assert.match(
      realms,
      /withSetRealmConfig\(\s*instructions,\s*verified\.network\.realmsProgramId,\s*verified\.network\.programVersion,\s*realm,\s*governance,\s*newCouncilMint,/,
    );
    assert.match(exportedFn(realms, "buildSetRealmConfigCouncilMint"), /COUNCIL_MINT_UNCHANGED/);
    assert.doesNotMatch(
      exportedFn(realms, "buildSetRealmConfigCouncilMint"),
      /buildRemoveCouncilInstruction/,
    );
    assert.match(
      realms,
      /withWithdrawGoverningTokens\(\s*instructions,\s*verified\.network\.realmsProgramId,\s*verified\.network\.programVersion,\s*realm,\s*destination,\s*communityMint,\s*params\.governingTokenOwner,/,
    );
    assert.match(
      exportedFn(realms, "buildWithdrawIchorVotes"),
      /getAssociatedTokenAddressSync\(\s*communityMint,\s*params\.governingTokenOwner,\s*false,\s*verified\.network\.token2022ProgramId,/,
    );
    assert.match(exportedFn(realms, "buildWithdrawIchorVotes"), /DESTINATION_MISMATCH/);
    assert.doesNotMatch(
      exportedFn(realms, "buildWithdrawIchorVotes"),
      /withWithdrawGoverningTokens\([\s\S]*params\.governingTokenDestination/,
    );
    assert.match(realms, /assertVerifiedNetwork\(params\.verified\)/);
    assert.match(realms, /PLUGIN_WEIGHT_REJECTED/);
    assert.match(realms, /derivedAddresses:\s*\{\s*voteRecord,\s*governance\s*\}/);
  });

  it("issues an unexported VerifiedRealm; fabricated realm/mint/plugin proofs are rejected", () => {
    const realms = readSrc("realms.ts");
    const types = readSrc("types.ts");
    const index = readSrc("index.ts");
    assert.match(realms, /export async function verifyRealmDeployment/);
    assert.match(realms, /assertBoundConnection\(verified,\s*connection\)/);
    assert.match(realms, /getAccountInfo\(realm/);
    assert.match(realms, /REALM_OWNER/);
    assert.match(realms, /getRealm\(connection,\s*realm\)/);
    assert.match(realms, /tryGetRealmConfig\(connection,\s*verified\.network\.realmsProgramId,\s*realm\)/);
    assert.match(realms, /GoverningTokenType\.Liquid/);
    assert.match(realms, /REALM_CONFIG_MISSING/);
    assert.match(realms, /COMMUNITY_MINT_MISMATCH/);
    assert.match(realms, /COMMUNITY_MINT_IS_COUNCIL/);
    assert.match(realms, /issuedRealmProofs\.add\(/);
    assert.match(realms, /issuedRealmProofs\.has\(/);
    assert.match(realms, /instanceof IssuedVerifiedRealm/);
    assert.match(realms, /readonly councilMint: PublicKey \| null/);
    assert.match(realms, /this\.councilMint\.equals\(this\.#councilMint\)/);
    assert.match(realms, /class IssuedVerifiedRealm/);
    assert.doesNotMatch(realms, /export class IssuedVerifiedRealm/);
    assert.doesNotMatch(index, /IssuedVerifiedRealm/);
    assert.doesNotMatch(index, /issuedRealmProofs/);
    assert.match(index, /verifyRealmDeployment/);
    assert.match(index, /assertVerifiedRealm/);

    const verifyStart = realms.indexOf("export async function verifyRealmDeployment");
    assert.notEqual(verifyStart, -1);
    const nextExport = realms.indexOf("\nexport function assertVerifiedRealm", verifyStart);
    const verifyFn = realms.slice(verifyStart, nextExport === -1 ? undefined : nextExport);
    assert.match(verifyFn, /fetchMintSnapshot/);
    assert.match(verifyFn, /assertIchorIsToken2022/);
    const ownerPos = verifyFn.indexOf("getAccountInfo");
    const getRealmPos = verifyFn.indexOf("getRealm(");
    const configPos = verifyFn.indexOf("tryGetRealmConfig");
    const mintPos = verifyFn.indexOf("fetchMintSnapshot");
    assert.ok(ownerPos !== -1 && ownerPos < getRealmPos, "raw owner read must precede getRealm");
    assert.ok(getRealmPos !== -1 && getRealmPos < configPos, "getRealm must precede tryGetRealmConfig");
    assert.ok(getRealmPos !== -1 && mintPos !== -1 && getRealmPos < mintPos, "community mint Token-2022 proof must follow getRealm");
    assert.match(verifyFn, /resolveAccountReadCommitment\(commitment\)/);
    assert.match(verifyFn, /getAccountInfo\(realm, readCommitment\)/);
    assert.match(verifyFn, /getAccountInfo\(realmConfig\.pubkey, readCommitment\)/);
    assert.match(verifyFn, /fetchMintSnapshot\(\s*connection,\s*verified\.network,\s*parsed\.account\.communityMint,\s*readCommitment/);
    assert.doesNotMatch(verifyFn, /getAccountInfo\([^,]+,\s*"confirmed"\)/);

    assert.match(types, /interface DepositIchorVoteParams \{[^}]*verifiedRealm[^}]*\}/s);
    assert.doesNotMatch(
      types.match(/interface DepositIchorVoteParams \{[^}]*\}/s)?.[0] ?? "",
      /\bichorMint\b/,
    );
    assert.doesNotMatch(
      types.match(/interface CastCommunityVoteParams \{[^}]*\}/s)?.[0] ?? "",
      /\bichorMint\b/,
    );
    assert.doesNotMatch(
      types.match(/interface BuildCommunityProposalParams \{[^}]*\}/s)?.[0] ?? "",
      /\bgoverningTokenMint\b/,
    );
    assert.match(realms, /CALLER_REALM_OR_MINT/);
    assert.match(realms, /verifiedRealm\.communityMint/);
    assert.match(realms, /const \{ verified, realm, communityMint \} = params\.verifiedRealm/);
    assert.match(realms, /assertCommunityBuilder\(params,\s*params\.verifiedRealm/);
    assert.match(
      realms,
      /composeDepositIchorVotesInstruction\(\s*\{\s*realmsProgramId:\s*verified\.network\.realmsProgramId,\s*programVersion:\s*verified\.network\.programVersion,\s*realm,\s*tokenSourceAccount:\s*params\.tokenSourceAccount,\s*communityMint,/,
    );
    assert.match(
      realms,
      /withDepositGoverningTokens\(\s*instructions,\s*params\.realmsProgramId,\s*params\.programVersion,\s*params\.realm,\s*params\.tokenSourceAccount,\s*params\.communityMint,/,
    );
    assert.match(
      realms,
      /withCreateProposal\(\s*instructions,\s*verified\.network\.realmsProgramId,\s*verified\.network\.programVersion,\s*realm,\s*governance,\s*params\.tokenOwnerRecord,\s*params\.name,\s*params\.descriptionLink,\s*communityMint,/,
    );
    assert.doesNotMatch(
      realms.match(/export async function buildCastCommunityVote[\s\S]*?^export async function/m)?.[0] ??
        realms.slice(realms.indexOf("export async function buildCastCommunityVote")),
      /params\.ichorMint/,
    );
  });

  it("issues an unexported VerifiedGovernance; disabled community config cannot propose/cast", () => {
    const realms = readSrc("realms.ts");
    const types = readSrc("types.ts");
    const index = readSrc("index.ts");
    assert.match(realms, /export async function verifyGovernanceDeployment/);
    assert.match(realms, /getGovernanceAccount\(connection,\s*governance,\s*Governance\)/);
    assert.match(realms, /GOVERNANCE_OWNER/);
    assert.match(realms, /VoteThresholdType\.Disabled/);
    assert.match(realms, /GOVERNANCE_COMMUNITY_DISABLED/);
    assert.match(realms, /verifyGovernanceIdentity/);
    assert.match(realms, /assertVerifiedGovernanceIdentity/);
    assert.match(realms, /IssuedVerifiedGovernanceIdentity/);
    assert.match(realms, /COMMUNITY_PROPOSAL_DISABLED/);
    assert.match(realms, /GOVERNANCE_COMMUNITY_PROPOSAL_DISABLED/);
    assert.doesNotMatch(realms, /GOVERNANCE_COMMUNITY_TIPPING/);
    assert.match(realms, /VoteTipping\.Disabled means "never tip early"/);
    assert.match(realms, /issuedGovernanceProofs\.add\(/);
    assert.match(realms, /issuedGovernanceProofs\.has\(/);
    assert.match(realms, /instanceof IssuedVerifiedGovernance/);
    assert.match(realms, /class IssuedVerifiedGovernance/);
    assert.doesNotMatch(realms, /export class IssuedVerifiedGovernance/);
    assert.doesNotMatch(index, /IssuedVerifiedGovernance/);
    assert.doesNotMatch(index, /issuedGovernanceProofs/);
    assert.match(index, /verifyGovernanceDeployment/);
    assert.match(index, /assertVerifiedGovernance/);
    assert.doesNotMatch(realms, /borsh|serialize\(|deserialize\(/);

    const verifyStart = realms.indexOf("export async function verifyGovernanceIdentity");
    assert.notEqual(verifyStart, -1);
    const nextExport = realms.indexOf(
      "\nexport function assertVerifiedGovernanceIdentity",
      verifyStart,
    );
    const verifyFn = realms.slice(verifyStart, nextExport === -1 ? undefined : nextExport);
    const ownerPos = verifyFn.indexOf("getAccountInfo");
    const parsePos = verifyFn.indexOf("getGovernanceAccount");
    assert.ok(ownerPos !== -1 && ownerPos < parsePos, "raw owner read must precede getGovernanceAccount");
    assert.match(verifyFn, /resolveAccountReadCommitment\(commitment\)/);
    assert.match(verifyFn, /getAccountInfo\(governance, readCommitment\)/);
    assert.doesNotMatch(verifyFn, /getAccountInfo\([^,]+,\s*"confirmed"\)/);
    assert.match(verifyFn, /verifiedRealm\.boundTo\(connection,\s*verifiedRealm\.verified\)/);
    assert.match(verifyFn, /assertBoundConnection\(verified,\s*connection\)/);
    assert.match(verifyFn, /parsed\.account\.realm\.equals\(verifiedRealm\.realm\)/);

    assert.match(types, /interface CastCommunityVoteParams \{[^}]*verifiedGovernance[^}]*\}/s);
    assert.match(types, /interface BuildCommunityProposalParams \{[^}]*verifiedGovernance[^}]*\}/s);
    assert.doesNotMatch(
      types.match(/interface CastCommunityVoteParams \{[^}]*\}/s)?.[0] ?? "",
      /readonly governance:/,
    );
    assert.doesNotMatch(
      types.match(/interface BuildCommunityProposalParams \{[^}]*\}/s)?.[0] ?? "",
      /readonly governance:|readonly verifiedRealm:/,
    );
    assert.match(
      types,
      /interface RelinquishCommunityVoteParams \{[^}]*verifiedGovernance[^}]*\}/s,
    );
    assert.doesNotMatch(
      types.match(/interface RelinquishCommunityVoteParams \{[^}]*\}/s)?.[0] ?? "",
      /readonly governance:|readonly verifiedRealm:/,
    );
    assert.match(realms, /assertCommunityGovernanceBuilder\(params,\s*params\.verifiedGovernance/);
    assert.match(realms, /const \{ verifiedRealm, governance \} = params\.verifiedGovernance/);
    assert.match(realms, /CALLER_GOVERNANCE_OR_MINT/);
  });

  it("uses verified 1.4.6 fee and prepare shapes", () => {
    const meteora = readSrc("meteora.ts");
    assert.match(meteora, /preparePoolCreationParams\(\{[\s\S]*tokenAInfo:[\s\S]*collectFeeMode/);
    assert.match(meteora, /calculateTransferFeeExcludedAmount/);
    assert.match(meteora, /validateNoTransferHook/);
    assert.match(meteora, /hasTransferHookExtension/);
    assert.match(meteora, /assertIchorIsToken2022/);
    assert.match(meteora, /parseIchorTransferFeeConfig/);
    assert.match(meteora, /TRANSFER_HOOK_ACTIVE/);
    assert.doesNotMatch(exportedFn(meteora, "buildIchorSolPool"), /assertIchorIsLegacySpl/);
    assert.match(meteora, /getBaseFeeParams\(\{\s*baseFeeMode/);
    assert.match(meteora, /compoundingFeeBps:\s*0/);
    assert.match(meteora, /padding:\s*0/);
  });

  it("does not import axios or @coral-xyz/anchor from source", () => {
    const hits: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      if (text.includes("from \"axios\"") || text.includes("from 'axios'")) {
        hits.push(`${file}: axios`);
      }
      if (text.includes("@coral-xyz/anchor")) {
        hits.push(`${file}: @coral-xyz/anchor`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it("pins official genesis hashes and checks them before program reads", () => {
    const network = readSrc("network.ts");
    const preflight = readSrc("preflight.ts");
    assert.match(network, /github\.com\/solana-labs\/solana\/blob\/master\/sdk\/src\/genesis_config\.rs/);
    assert.match(network, /devnet:\s*"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"/);
    assert.match(network, /"mainnet-beta":\s*"5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"/);
    assert.match(preflight, /connection\.getGenesisHash\(\)/);
    assert.match(preflight, /GENESIS_MISMATCH/);

    const verifyStart = preflight.indexOf("export async function verifyNetworkDeployment");
    assert.notEqual(verifyStart, -1);
    const nextExport = preflight.indexOf("\nexport function assertVerifiedNetwork", verifyStart);
    const verifyFn = preflight.slice(verifyStart, nextExport === -1 ? undefined : nextExport);
    const genesisPos = verifyFn.indexOf("getGenesisHash");
    const meteoraReadPos = verifyFn.indexOf("readMeteoraProgram");
    const realmsReadPos = verifyFn.indexOf("readRealmsProgram");
    const accountPos = verifyFn.indexOf("getAccountInfo");
    assert.notEqual(genesisPos, -1);
    assert.notEqual(meteoraReadPos, -1);
    assert.notEqual(realmsReadPos, -1);
    assert.ok(genesisPos < meteoraReadPos, "getGenesisHash must run before readMeteoraProgram");
    assert.ok(genesisPos < realmsReadPos, "getGenesisHash must run before readRealmsProgram");
    assert.equal(accountPos, -1, "verifyNetworkDeployment must not read accounts before genesis check");
    assert.match(verifyFn, /resolveAccountReadCommitment\(commitment\)/);
    assert.match(verifyFn, /readMeteoraProgram\(connection, network, readCommitment\)/);
    assert.match(verifyFn, /readRealmsProgram\(connection, network, readCommitment\)/);
  });

  it("issues an unexported brand; fabricated lookalikes cannot pass assert", () => {
    const preflight = readSrc("preflight.ts");
    const index = readSrc("index.ts");
    assert.match(preflight, /new WeakSet<object>\(\)/);
    assert.match(preflight, /issuedNetworkProofs\.add\(/);
    assert.match(preflight, /issuedNetworkProofs\.has\(/);
    assert.match(preflight, /instanceof IssuedVerifiedNetwork/);
    assert.match(preflight, /class IssuedVerifiedNetwork/);
    assert.doesNotMatch(preflight, /export class IssuedVerifiedNetwork/);
    assert.doesNotMatch(preflight, /source:\s*["']preflight["']/);
    assert.doesNotMatch(preflight, /verified\.source/);
    assert.doesNotMatch(index, /IssuedVerifiedNetwork/);
    assert.doesNotMatch(index, /issuedNetworkProofs/);
    assert.doesNotMatch(index, /preflightMeteoraProgram/);
    assert.doesNotMatch(index, /preflightRealmsProgram/);
    assert.match(index, /verifyNetworkDeployment/);
    assert.match(index, /assertVerifiedNetwork/);
    assert.match(index, /assertBoundConnection/);
  });

  it("binds Connection-taking builders to the issued proof", () => {
    const preflight = readSrc("preflight.ts");
    const meteora = readSrc("meteora.ts");
    const realms = readSrc("realms.ts");
    assert.match(preflight, /export function assertBoundConnection/);
    assert.match(preflight, /CONNECTION_MISMATCH/);
    assert.match(preflight, /boundTo\(connection\)/);
    assert.match(meteora, /assertBoundConnection\(verified,\s*connection\)/);
    assert.match(meteora, /assertMeteoraProgramId\(params\.verified,\s*params\.connection\)/);
    assert.match(
      realms,
      /assertBoundConnection\((?:params\.verified|verified),\s*params\.connection\)/,
    );
    assert.match(preflight, /#connection/);
    assert.match(preflight, /connection === this\.#connection/);
    assert.doesNotMatch(preflight, /connection\.rpcEndpoint ===/);
    assert.doesNotMatch(preflight, /rpcEndpoint plus official genesis/);
    assert.match(readSrc("types.ts"), /exact Connection\s+\*\s*instance/);
    assert.match(readSrc("types.ts"), /same rpcEndpoint is not accepted/);
    const readme = readFileSync(join(clientRoot, "README.md"), "utf8");
    assert.match(readme, /exact same Connection instance/);
    assert.doesNotMatch(readme, /unless that connection shares/);
    assert.doesNotMatch(readme, /rpcEndpoint plus official genesis/);
  });

  it("hands off DAMM v2 position rights via TransferChecked to the derived Realms treasury", () => {
    const meteora = readSrc("meteora.ts");
    const realms = readSrc("realms.ts");
    assert.match(meteora, /from ["']@realms-today\/spl-governance["']/);
    assert.match(meteora, /from ["']\.\/realms\.ts["']/);
    assert.match(meteora, /getNativeTreasuryAddress/);
    assert.match(meteora, /assertVerifiedGovernanceIdentity/);
    assert.match(meteora, /export async function deriveVerifiedNativeTreasury/);
    assert.match(meteora, /export async function buildHandoffPositionRightsToTreasury/);
    assert.match(meteora, /export async function verifyPositionRightsHandoff/);
    assert.match(meteora, /createAssociatedTokenAccountIdempotentInstruction/);
    assert.match(meteora, /createTransferCheckedInstruction/);
    assert.match(
      meteora,
      /sourcePositionNftAccount\s*=\s*derivePositionNftAccount\(nft\.mint\)/,
    );
    assert.match(meteora, /getAssociatedTokenAddressSync\(\s*mint,\s*owner,\s*true,\s*tokenProgram\s*\)/);
    assert.match(meteora, /BigInt\(nft\.supply\.toString\(\)\)/);
    assert.match(meteora, /POSITION_NFT_SUPPLY = new BN\(1\)/);
    assert.match(meteora, /snapshot\.decimals !== 0/);
    assert.match(meteora, /snapshot\.supply\.eq\(POSITION_NFT_SUPPLY\)/);
    assert.match(meteora, /tokenProgramKind !== ["']token-2022["']/);
    assert.match(meteora, /TOKEN_2022_PROGRAM\.id/);
    assert.match(meteora, /getExtensionTypes/);
    assert.match(meteora, /UNSUPPORTED_TOKEN_EXTENSION/);
    assert.match(meteora, /UNSUPPORTED_POSITION_NFT_EXTENSIONS/);
    assert.match(meteora, /rejectPositionNftTransferExtensions/);
    assert.match(meteora, /ExtensionType\.TransferFeeConfig/);
    assert.match(meteora, /ExtensionType\.ConfidentialTransferMint/);
    assert.match(meteora, /ExtensionType\.DefaultAccountState/);
    assert.match(meteora, /ExtensionType\.NonTransferable/);
    assert.match(meteora, /ExtensionType\.TransferHook/);
    assert.match(meteora, /CALLER_TREASURY/);
    assert.match(meteora, /realmsTreasury/);
    assert.match(meteora, /HANDOFF_TREASURY_AMOUNT/);
    assert.match(meteora, /HANDOFF_SOURCE_STILL_HOLDS/);
    assert.match(meteora, /POSITION_POOL/);
    assert.match(meteora, /required exactly 1/);
    assert.match(meteora, /owner:\s*treasury/);
    assert.match(meteora, /receiver:\s*treasury/);
    assert.match(meteora, /expectedTreasuryPositionNftAta\(nft\.mint,\s*treasury,\s*nft\.ownerProgram\)/);
    assert.match(meteora, /TREASURY_POSITION_NFT_AMOUNT/);
    assert.match(meteora, /claimPositionFee2/);
    assert.match(meteora, /feePayer:\s*treasury/);
    assert.match(meteora, /ASSOCIATED_TOKEN_PROGRAM_ID/);
    assert.match(meteora, /CLAIM_POSITION_FEE2_SHAPE/);
    assert.match(meteora, /insert0/);
    assert.match(meteora, /insert1/);
    assert.match(meteora, /splitClaimPositionFee2Inserts/);
    assert.match(meteora, /positionNftAccount:\s*treasuryAta/);
    assert.doesNotMatch(meteora, /POSITION_NFT_ACCOUNT_NOT_TREASURY_ATA/);
    assert.doesNotMatch(meteora, /params\.positionNftAccount/);
    assert.doesNotMatch(meteora, /params\.realmsTreasury|params\.owner\b/);
    assert.doesNotMatch(meteora, /Keypair\.fromSecretKey|sendAndConfirmTransaction|sendRawTransaction/);
    assert.doesNotMatch(realms, /from ["']\.\/meteora\.ts["']/);
  });

  it("builds unsigned loader Upgrade and Governance upgrade-authority transfer", () => {
    const upgrade = readSrc("upgrade.ts");
    const types = readSrc("types.ts");
    const index = readSrc("index.ts");
    const upgradeFn = exportedFn(upgrade, "buildUpgradeIchorProgram");
    const toGov = exportedFn(upgrade, "buildTransferProgramUpgradeAuthorityToGovernance");
    assert.match(upgrade, /UPGRADE_PROGRAM_DATA = new Uint8Array\(\[3,\s*0,\s*0,\s*0\]\)/);
    assert.match(upgradeFn, /SYSVAR_RENT_PUBKEY/);
    assert.match(upgradeFn, /SYSVAR_CLOCK_PUBKEY/);
    assert.match(upgradeFn, /getNativeTreasuryAddress/);
    assert.match(upgradeFn, /BUFFER_ACCOUNT_COLLISION/);
    assert.doesNotMatch(upgradeFn, /params\.spill/);
    assert.match(toGov, /UPGRADE_AUTHORITY_ALREADY_GOVERNANCE/);
    assert.match(toGov, /newUpgradeAuthority:\s*governance/);
    assert.doesNotMatch(upgrade, /export async function buildTransferProgramUpgradeAuthorityToRealms/);
    assert.doesNotMatch(upgrade, /function buildTransferProgramUpgradeAuthorityToRealms/);
    assert.doesNotMatch(upgrade, /newUpgradeAuthority:\s*treasury/);
    assert.doesNotMatch(index, /buildTransferProgramUpgradeAuthorityToRealms/);
    assert.match(types, /interface BuildUpgradeIchorProgramParams/);
    assert.match(index, /buildUpgradeIchorProgram/);
    assert.match(index, /buildTransferProgramUpgradeAuthorityToGovernance/);
    assert.doesNotMatch(upgrade, /\bBuffer\b|from ["']node:/);
    assert.doesNotMatch(upgrade, /Keypair|sendTransaction|sendRawTransaction|sendAndConfirmTransaction/);
  });

  it("accepts only the documented upgradeable loader owner", () => {
    const network = readSrc("network.ts");
    const preflight = readSrc("preflight.ts");
    assert.match(network, /BPFLoaderUpgradeab1e11111111111111111111111/);
    assert.match(network, /bpf_loader_upgradeable\.rs/);
    assert.match(preflight, /ALLOWED_PROGRAM_LOADERS/);
    assert.match(preflight, /BPF_LOADER_UPGRADEABLE\.id/);
    assert.match(preflight, /PROGRAM_LOADER_UNKNOWN/);
    assert.doesNotMatch(preflight, /BPFLoader1111111111111111111111111111111111/);
    assert.doesNotMatch(preflight, /BPFLoader2111111111111111111111111111111111/);
    assert.doesNotMatch(preflight, /LoaderV411111111111111111111111111111111111/);
  });
});

describe("Token-2022 ICHOR ABI source contracts", () => {
  it("keeps ICHOR mint, convert, and pricing on Token-2022", () => {
    const pricing = readSrc("pricing.ts");
    const burn = readSrc("burn.ts");
    const validation = readSrc("validation.ts");
    const index = readSrc("index.ts");
    assert.match(validation, /export function assertIchorIsToken2022/);
    assert.match(validation, /export function assertLegacySplMint/);
    assert.doesNotMatch(validation, /export function assertIchorIsLegacySpl/);
    assert.match(pricing, /assertIchorIsToken2022/);
    assert.doesNotMatch(pricing, /assertIchorIsLegacySpl/);
    assert.match(burn, /assertIchorIsToken2022\(ichorMint\)/);
    assert.match(burn, /WITHDRAW_WITHHELD_SEED/);
    assert.match(index, /assertIchorIsToken2022/);
    assert.match(index, /withdrawWithheldPda/);
    assert.doesNotMatch(index, /assertIchorIsLegacySpl/);
  });

  it("never rejects approved TransferFeeConfig on ICHOR pool create and never allows TransferHook", () => {
    const meteora = readSrc("meteora.ts");
    const pool = exportedFn(meteora, "buildIchorSolPool");
    assert.doesNotMatch(pool, /UNSUPPORTED_TOKEN_EXTENSION/);
    assert.match(pool, /parseIchorTransferFeeConfig/);
    assert.match(pool, /tokenAInfo:/);
    assert.match(pool, /TRANSFER_HOOK_ACTIVE|validateNoTransferHook/);
    assert.match(meteora, /rejectPositionNftTransferExtensions/);
  });

  it("keeps fee and harvest builders browser-safe and unsigned", () => {
    const fees = readSrc("fees.ts");
    const extensions = readSrc("extensions.ts");
    const index = readSrc("index.ts");
    for (const src of [fees, extensions]) {
      assert.doesNotMatch(src, /\bBuffer\b/);
      assert.doesNotMatch(src, /from ["']node:/);
      assert.doesNotMatch(src, /createHash|createHmac|node:crypto/);
      assert.doesNotMatch(src, /Keypair\.fromSecretKey|sendAndConfirmTransaction|sendRawTransaction/);
      assert.doesNotMatch(src, /connection\.getProgramAccounts|connection\.getTokenAccountsByOwner|connection\.getTokenLargestAccounts/);
    }
    assert.match(fees, /CALLER_SPLIT_FIELDS/);
    assert.match(fees, /CALLER_TREASURY_FIELDS/);
    assert.match(fees, /CALLER_HARVEST_DISCOVERY_FIELDS/);
    assert.match(fees, /createHarvestWithheldTokensToMintInstruction/);
    assert.match(index, /buildSetFeeDistribution/);
    assert.match(index, /buildDistributeTransferFees/);
    assert.match(index, /buildCollectTransferFees/);
    assert.match(index, /buildHarvestWithheldTokensToMint/);
    assert.match(index, /buildClaimCreatorFees/);
    assert.match(index, /buildSweepUnclaimedCreatorFees/);
    assert.match(index, /buildSetCreatorBeneficiary/);
    assert.match(index, /creatorEscrowPda/);
    assert.match(index, /ICHOR_TRANSFER_FEE_MINT_LEN/);
  });
});

describe("atomic defensive-stake hygiene", () => {
  it("keeps the composer unsigned, official-cluster, and GPA-free", () => {
    const stake = readSrc("defensive-stake.ts");
    const bar = readSrc("activation-bar.ts");
    const realms = readSrc("realms.ts");
    const burn = readSrc("burn.ts");
    const index = readSrc("index.ts");
    const types = readSrc("types.ts");
    assert.match(index, /buildAtomicDefensiveStake/);
    assert.match(index, /composeConvertInstructionsFromIssuedConfig/);
    assert.match(index, /buildSetRealmConfigEmergencyBrake/);
    assert.match(index, /readActivationBarModel/);
    assert.match(types, /type ExplicitTokenAmount/);
    assert.match(exportedFn(burn, "buildConvertTransaction"), /"PAUSED"/);
    assert.match(exportedFn(burn, "buildConvertTransaction"), /composeConvertInstructionsFromIssuedConfig/);
    assert.doesNotMatch(exportedFn(burn, "composeConvertInstructionsFromIssuedConfig"), /config\.paused/);
    assert.match(stake, /DEPOSIT_GOVERNING_TOKENS_AMOUNT_IS_GROSS = true/);
    assert.match(stake, /sendImplemented: false/);
    assert.match(stake, /set_paused\(false\)/);
    assert.match(stake, /set_paused\(true\)/);
    assert.match(stake, /SOLANA_MAX_TX_COMPUTE_UNITS = 1_400_000/);
    assert.match(stake, /COMPUTE_MARGIN_PERCENT = 25/);
    assert.match(stake, /COMPUTE_MIN_UNITS = 120_000/);
    assert.match(stake, /COMPUTE_EXCEEDS_PROTOCOL_MAX/);
    assert.match(stake, /MEASURED_OFFLINE/);
    assert.match(stake, /size-only/);
    assert.match(stake, /never broadcast-ready|never be treated as\s+broadcast-ready|never be described as broadcast-ready/);
    assert.match(stake, /encodeDepositGoverningTokensData/);
    assert.match(stake, /DEPOSIT_GOVERNING_TOKENS_KEY_COUNT = 11/);
    assert.match(stake, /getTokenHoldingAddress/);
    assert.match(stake, /independently(?:\s|\n \*)+pins? the exact serialized message/);
    assert.doesNotMatch(stake, /fresh non-default|a fresh\n \* non-default/);
    assert.match(stake, /validateDefensiveStakeGroups/);
    assert.match(stake, /IssuedValidatedDefensiveStakeGroups/);
    assert.match(stake, /cloneTransactionInstruction/);
    assert.match(stake, /DEFENSIVE_STAKE_REALMS_PROGRAM/);
    assert.match(stake, /KEKBULL token program must be Token-2022/);
    assert.match(stake, /assertDerivedRealmPdas|deriveGoverningTokenHoldingAddress/);
    assert.match(stake, /PACKET_DATA_SIZE|SOLANA_PACKET_DATA_SIZE/);
    assert.doesNotMatch(stake, /assembleAtomicDefensiveStakeMessage|unsignedLegacyPacketBytes|assertAtomicDefensiveStakeInstructionOrder/);
    assert.doesNotMatch(index, /assembleAtomicDefensiveStakeMessage|unsignedLegacyPacketBytes/);
    assert.match(realms, /export async function buildSetRealmConfigEmergencyBrake/);
    assert.match(realms, /export async function buildRestoreRealmConfigVoteWeightSource/);
    assert.match(realms, /emergencyBrakeVoteWeightSource/);
    assert.match(bar, /DISTINCT_TOR_COUNT_UNKNOWN_REASON/);
    for (const src of [stake, bar]) {
      assert.doesNotMatch(src, /Keypair\.fromSecretKey|sendAndConfirmTransaction|sendRawTransaction/);
      assert.doesNotMatch(src, /connection\.getProgramAccounts|connection\.getTokenAccountsByOwner|connection\.getTokenLargestAccounts/);
      assert.doesNotMatch(src, /from ["']node:/);
    }
  });
});
