import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const feesSrc = readFileSync(join(clientRoot, "src/fees.ts"), "utf8");
const extensionsSrc = readFileSync(join(clientRoot, "src/extensions.ts"), "utf8");
const typesSrc = readFileSync(join(clientRoot, "src/types.ts"), "utf8");
const indexSrc = readFileSync(join(clientRoot, "src/index.ts"), "utf8");
const deploymentSrc = readFileSync(join(clientRoot, "src/deployment.ts"), "utf8");

function sha256Prefix(preimage: string): Buffer {
  return createHash("sha256").update(preimage).digest().subarray(0, 8);
}

function pinnedUint8Const(src: string, name: string): Buffer {
  const match = src.match(new RegExp(`export const ${name} = new Uint8Array\\(\\[([^\\]]+)\\]\\)`));
  assert.ok(match, `missing pinned ${name}`);
  return Buffer.from(
    match[1]
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => Number(part))
      .filter((n) => !Number.isNaN(n)),
  );
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

/** Token-2022 ceiling: (amount * bps + 9999) / 10000, capped at max. */
function token2022Fee(amount: bigint, bps: bigint, maximumFee: bigint): bigint {
  if (bps === 0n || amount === 0n) {
    return 0n;
  }
  const raw = (amount * bps + 9999n) / 10000n;
  return raw > maximumFee ? maximumFee : raw;
}

function split2500_7500(amount: bigint): { creator: bigint; realms: bigint } {
  const creator = (amount * 2500n) / 10000n;
  return { creator, realms: amount - creator };
}

const FEE_IX = [
  ["COMMIT_DAO_DESTINATION_DISCRIMINATOR", "global:commit_dao_destination"],
  ["SET_FEE_DISTRIBUTION_DISCRIMINATOR", "global:set_fee_distribution"],
  ["DISTRIBUTE_TRANSFER_FEES_DISCRIMINATOR", "global:distribute_transfer_fees"],
  ["SET_TRANSFER_FEE_DISCRIMINATOR", "global:set_transfer_fee"],
  ["REVOKE_TRANSFER_FEE_AUTHORITY_DISCRIMINATOR", "global:revoke_transfer_fee_authority"],
  ["CLAIM_CREATOR_FEES_DISCRIMINATOR", "global:claim_creator_fees"],
  ["SWEEP_UNCLAIMED_CREATOR_FEES_DISCRIMINATOR", "global:sweep_unclaimed_creator_fees"],
  ["SET_CREATOR_BENEFICIARY_DISCRIMINATOR", "global:set_creator_beneficiary"],
] as const;

describe("fee instruction discriminators", () => {
  it("pins every fee sighash to sha256(global:<name>) independently of source bytes", () => {
    for (const [name, preimage] of FEE_IX) {
      assert.deepEqual(pinnedUint8Const(feesSrc, name), sha256Prefix(preimage), name);
    }
    assert.notDeepEqual(
      pinnedUint8Const(feesSrc, "SET_FEE_DISTRIBUTION_DISCRIMINATOR"),
      pinnedUint8Const(feesSrc, "DISTRIBUTE_TRANSFER_FEES_DISCRIMINATOR"),
    );
  });
});

describe("Token-2022 ceiling fee and 2500/7500 split", () => {
  it("uses ceiling fee, not floor, and caps at u64::MAX", () => {
    assert.equal(token2022Fee(1n, 25n, 0xffff_ffff_ffff_ffffn), 1n);
    assert.equal(token2022Fee(399n, 25n, 0xffff_ffff_ffff_ffffn), 1n);
    assert.equal(token2022Fee(1_000_000n, 25n, 0xffff_ffff_ffff_ffffn), 2_500n);
    assert.equal(token2022Fee(1n, 25n, 0n), 0n);
    assert.match(extensionsSrc, /BPS_CEIL_PAD/);
    assert.match(extensionsSrc, /calculateToken2022TransferFee/);
    assert.match(extensionsSrc, /TRANSFER_FEE_BASIS_POINTS = 25/);
    assert.match(extensionsSrc, /FEE_SPLIT_CREATOR_BPS = 2_500/);
    assert.match(extensionsSrc, /FEE_SPLIT_REALMS_BPS = 7_500/);
    assert.match(extensionsSrc, /ICHOR_TRANSFER_FEE_MINT_LEN = 278/);
  });

  it("splits harvested fees 2500/7500 with remainder on Realms", () => {
    assert.deepEqual(split2500_7500(1_000_000n), { creator: 250_000n, realms: 750_000n });
    assert.deepEqual(split2500_7500(3n), { creator: 0n, realms: 3n });
    assert.deepEqual(split2500_7500(7n), { creator: 1n, realms: 6n });
    assert.match(extensionsSrc, /splitHarvestedFees/);
    assert.match(extensionsSrc, /creator \+ realms == amount|total\.sub\(creator\)/);
  });

  it("reports second-hop fee and destination nets distinctly from gross withdrawn", () => {
    const gross = 1_000_000n;
    const { creator, realms } = split2500_7500(gross);
    const creatorFee = token2022Fee(creator, 25n, 0xffff_ffff_ffff_ffffn);
    const realmsFee = token2022Fee(realms, 25n, 0xffff_ffff_ffff_ffffn);
    assert.equal(creator, 250_000n);
    assert.equal(realms, 750_000n);
    assert.equal(creatorFee, 625n);
    assert.equal(realmsFee, 1_875n);
    assert.equal(creator - creatorFee, 249_375n);
    assert.equal(realms - realmsFee, 748_125n);
    assert.notEqual(gross, creator - creatorFee);
    assert.notEqual(creator, creator - creatorFee);
    const distribute = exportedFn(feesSrc, "buildDistributeTransferFees");
    assert.match(distribute, /expectedGrossWithdrawn/);
    assert.match(distribute, /creatorSecondHop/);
    assert.match(distribute, /realmsSecondHop/);
    assert.match(distribute, /expectedCreatorNet/);
    assert.match(distribute, /expectedRealmsNet/);
    assert.match(distribute, /creatorDestination/);
    assert.match(distribute, /expectedOwner:\s*config\.creatorBeneficiary/);
    assert.doesNotMatch(distribute, /creatorEscrowPda/);
    assert.match(typesSrc, /expectedGrossWithdrawn/);
    assert.match(typesSrc, /expectedCreatorNet/);
    assert.match(typesSrc, /expectedRealmsNet/);
    assert.match(typesSrc, /readonly creatorDestination: PublicKey/);
    assert.match(extensionsSrc, /secondHopAfterTransfer/);
    assert.match(extensionsSrc, /previewDistributeTransferFees/);
  });

  it("applies the next 2500/7500 split to recycled second-hop withheld, not destination nets", () => {
    const first = split2500_7500(1_000_000n);
    const recycled =
      token2022Fee(first.creator, 25n, 0xffff_ffff_ffff_ffffn) +
      token2022Fee(first.realms, 25n, 0xffff_ffff_ffff_ffffn);
    assert.equal(recycled, 2_500n);
    const next = split2500_7500(recycled);
    assert.deepEqual(next, { creator: 625n, realms: 1_875n });
    assert.notEqual(next.creator, 249_375n);
    assert.match(extensionsSrc, /previewNextHarvestFromRecycled/);
    assert.match(extensionsSrc, /splitHarvestedFees\(preview\.recycledWithheld\)/);
  });
});

describe("unsigned fee builders and harvest sources", () => {
  it("binds the fixed 2500/7500 split and proof-derived treasury with no caller split", () => {
    assert.match(feesSrc, /CALLER_SPLIT_FIELDS/);
    assert.match(feesSrc, /CALLER_TREASURY_FIELDS/);
    assert.match(exportedFn(feesSrc, "buildSetFeeDistribution"), /CALLER_SPLIT/);
    assert.match(exportedFn(feesSrc, "buildSetFeeDistribution"), /CALLER_TREASURY/);
    assert.match(exportedFn(feesSrc, "buildSetFeeDistribution"), /readCommittedDaoDestination/);
    assert.match(exportedFn(feesSrc, "buildSetFeeDistribution"), /assertDaoDestinationMatchesCommitment/);
    assert.match(exportedFn(feesSrc, "buildSetFeeDistribution"), /assertVerifiedGovernanceIdentity/);
    assert.match(feesSrc, /getNativeTreasuryAddress/);
    assert.doesNotMatch(exportedFn(feesSrc, "buildSetFeeDistribution"), /params\.creatorBps|params\.split/);
    assert.match(exportedFn(feesSrc, "buildDistributeTransferFees"), /CALLER_SPLIT/);
    assert.match(exportedFn(feesSrc, "buildSetTransferFee"), /requirePilotTransferFee/);
    assert.match(extensionsSrc, /requirePilotTransferFee/);
    assert.match(extensionsSrc, /basisPoints !== TRANSFER_FEE_BASIS_POINTS/);
    assert.match(extensionsSrc, /maximumFee\.eq\(TRANSFER_FEE_MAXIMUM_FEE\)/);
    const setFee = exportedFn(feesSrc, "buildSetFeeDistribution");
    assert.match(setFee, /FEE_BENEFICIARIES_ALREADY_BOUND/);
    assert.match(setFee, /PublicKey\.isOnCurve/);
    assert.match(setFee, /commitment\.realm/);
    assert.match(exportedFn(feesSrc, "assertDaoDestinationMatchesCommitment"), /requireCommitmentRealmsProgram/);
    assert.match(feesSrc, /function requireCommitmentRealmsProgram/);
    assert.match(feesSrc, /GTEST_REFUSED/);
    assert.match(feesSrc, /function refuseGtestRealmsProgram/);
    assert.match(exportedFn(feesSrc, "buildCommitDaoDestination"), /requireCommitmentRealmsProgram/);
    assert.match(exportedFn(feesSrc, "buildCommitDaoDestination"), /assertMainnetKekbullGovernance/);
    assert.doesNotMatch(exportedFn(feesSrc, "buildCommitDaoDestination"), /publishedRealms/);
    assert.match(feesSrc, /REALMS_INSTANCES/);
    assert.match(feesSrc, /REALMS_INSTANCES\.kekbull/);
    assert.match(feesSrc, /neither GovER5/);
    assert.match(feesSrc, /nor kekbull/);
    const requireCommitment = feesSrc.slice(
      feesSrc.indexOf("function requireCommitmentRealmsProgram"),
      feesSrc.indexOf("function requireCommitmentRealmsProgram") + 900,
    );
    assert.match(requireCommitment, /GOVER5_REALMS_PROGRAM/);
    assert.match(requireCommitment, /kekbull/);
    assert.doesNotMatch(requireCommitment, /is not GovER5 \$\{GOVER5/);
    assert.match(
      extensionsSrc,
      /expectedAccountType === TOKEN_2022_ACCOUNT_TYPE_MINT/,
    );
    const distribute = exportedFn(feesSrc, "buildDistributeTransferFees");
    assert.match(distribute, /createAssociatedTokenAccountIdempotentInstruction/);
    assert.match(distribute, /withdraw\.address/);
    assert.match(distribute, /instructions:\s*\[/);
  });

  it("requires caller-supplied harvest sources and rejects discovery", () => {
    const harvest = exportedFn(feesSrc, "buildHarvestWithheldTokensToMint");
    assert.match(harvest, /CALLER_ACCOUNT_DISCOVERY/);
    assert.match(harvest, /HARVEST_SOURCES_EMPTY/);
    assert.match(harvest, /parseIchorTransferFeeAmount/);
    assert.match(harvest, /createHarvestWithheldTokensToMintInstruction/);
    assert.doesNotMatch(harvest, /getProgramAccounts|getTokenAccountsByOwner|getTokenLargestAccounts/);
    assert.match(feesSrc, /CALLER_HARVEST_DISCOVERY_FIELDS/);
  });

  it("sizes the ICHOR mint for exactly TransferFeeConfig (278 bytes)", () => {
    assert.equal(165 + 1 + 4 + 108, 278);
    assert.match(extensionsSrc, /ICHOR_TRANSFER_FEE_MINT_LEN = 278/);
    assert.match(deploymentSrc, /getMintLen\(\[ExtensionType\.TransferFeeConfig\]\)/);
    assert.match(deploymentSrc, /MINT_LEN_SDK_DRIFT/);
    assert.match(exportedFn(deploymentSrc, "buildCreateIchorMintAccount"), /createInitializeTransferFeeConfigInstruction/);
    const feePos = exportedFn(deploymentSrc, "buildCreateIchorMintAccount").indexOf(
      "createInitializeTransferFeeConfigInstruction",
    );
    const mintPos = exportedFn(deploymentSrc, "buildCreateIchorMintAccount").indexOf(
      "createInitializeMint2Instruction",
    );
    assert.ok(feePos !== -1 && feePos < mintPos);
  });

  it("exports builders without leaking issued brands or sending", () => {
    assert.match(indexSrc, /buildCommitDaoDestination/);
    assert.match(indexSrc, /buildSetFeeDistribution/);
    assert.match(indexSrc, /COMMIT_DAO_DESTINATION_DISCRIMINATOR/);
    assert.match(indexSrc, /readCommittedDaoDestination/);
    assert.match(indexSrc, /assertDaoDestinationMatchesCommitment/);
    assert.match(indexSrc, /buildDistributeTransferFees/);
    assert.match(indexSrc, /buildCollectTransferFees/);
    assert.match(indexSrc, /measureCanonicalHarvestSources/);
    assert.match(exportedFn(feesSrc, "measureCanonicalHarvestSources"), /realmsVoteVault/);
    assert.match(exportedFn(feesSrc, "measureCanonicalHarvestSources"), /holding\.toBase58\(\)/);
    assert.match(exportedFn(feesSrc, "measureCanonicalHarvestSources"), /canonicalHarvestSource/);
    assert.match(indexSrc, /buildSetTransferFee/);
    assert.match(indexSrc, /buildRevokeTransferFeeAuthority/);
    assert.match(indexSrc, /buildHarvestWithheldTokensToMint/);
    assert.match(indexSrc, /buildClaimCreatorFees/);
    assert.match(indexSrc, /buildSweepUnclaimedCreatorFees/);
    assert.match(indexSrc, /buildSetCreatorBeneficiary/);
    assert.match(indexSrc, /SET_FEE_DISTRIBUTION_DISCRIMINATOR/);
    assert.doesNotMatch(indexSrc, /IssuedVerifiedIchorConfig/);
    assert.doesNotMatch(feesSrc, /\bBuffer\b/);
    assert.doesNotMatch(feesSrc, /from ["']node:/);
    assert.doesNotMatch(feesSrc, /Keypair\.fromSecretKey|sendAndConfirmTransaction|sendRawTransaction/);
  });
});

describe("Token-2022 token-account TLV prefix", () => {
  it("does not require mint-padding zeros on an initialized token account", () => {
    const data = new Uint8Array(178);
    data[108] = 1;
    data[165] = 2;
    data[166] = 2;
    data[167] = 0;
    data[168] = 8;
    data[169] = 0;
    assert.equal(data.subarray(82, 165).some((byte) => byte !== 0), true);
    const walkStart = extensionsSrc.indexOf("function walkTlv");
    const walkEnd = extensionsSrc.indexOf("export function parseIchorTransferFeeConfig");
    assert.ok(walkStart !== -1 && walkEnd > walkStart);
    const walk = extensionsSrc.slice(walkStart, walkEnd);
    assert.match(walk, /expectedAccountType === TOKEN_2022_ACCOUNT_TYPE_MINT/);
    const withoutMintGuard = walk.replace(
      /if \(expectedAccountType === TOKEN_2022_ACCOUNT_TYPE_MINT\) \{\s*if \(data\.subarray\(82, TOKEN_2022_ACCOUNT_TYPE_OFFSET\)\.some\(\(byte\) => byte !== 0\)\) \{[\s\S]*?\}\s*\}/,
      "",
    );
    assert.doesNotMatch(withoutMintGuard, /subarray\(82/);
  });
});

describe("creator-share succession (push→pull)", () => {
  it("CALLS decay comparison: elapsed only when now - last > decay; fail-closed on 0 and inversion", () => {
    function elapsed(now: bigint, last: bigint, decay: bigint): boolean {
      if (decay === 0n) throw new Error("CREATOR_DECAY_ZERO");
      if (now < 0n || last < 0n || now < last) throw new Error("CLOCK_INVERSION");
      return now - last > decay;
    }
    assert.equal(elapsed(100n, 0n, 100n), false);
    assert.equal(elapsed(101n, 0n, 100n), true);
    assert.equal(elapsed(50n, 50n, 1n), false);
    assert.throws(() => elapsed(10n, 20n, 1n), /CLOCK_INVERSION/);
    assert.throws(() => elapsed(10n, 0n, 0n), /CREATOR_DECAY_ZERO/);
    const helper = exportedFn(feesSrc, "creatorDecayHasElapsed");
    assert.match(helper, /now\.sub\(lastClaimTs\)\.gt\(decay\)/);
    assert.match(helper, /CREATOR_DECAY_ZERO/);
    assert.match(helper, /CLOCK_INVERSION/);
    assert.match(helper, /decay\.isZero\(\)/);
  });

  it("claim rejects unauthorized signer; sweep is permissionless after decay", () => {
    const claim = exportedFn(feesSrc, "buildClaimCreatorFees");
    const sweep = exportedFn(feesSrc, "buildSweepUnclaimedCreatorFees");
    const assertSigner = exportedFn(feesSrc, "assertCreatorBeneficiarySigner");
    assert.match(assertSigner, /UNAUTHORIZED_CREATOR_CLAIM/);
    assert.match(claim, /assertCreatorBeneficiarySigner/);
    assert.match(claim, /CLOCK_INVERSION/);
    assert.match(sweep, /creatorDecayHasElapsed/);
    assert.match(sweep, /CREATOR_DECAY_NOT_ELAPSED/);
    assert.doesNotMatch(sweep, /assertCreatorBeneficiarySigner/);
  });

  it("authority cannot appear as signer on set_creator_beneficiary", () => {
    const setBn = exportedFn(feesSrc, "buildSetCreatorBeneficiary");
    assert.match(setBn, /assertCreatorBeneficiarySigner/);
    assert.doesNotMatch(setBn, /requireMatchingAuthority/);
    assert.doesNotMatch(setBn, /params\.authority/);
    assert.doesNotMatch(setBn, /config\.authority/);
    assert.match(setBn, /pubkey: creator, isSigner: true/);
    assert.match(feesSrc, /buildSetCreatorBeneficiary/);
    assert.match(indexSrc, /buildSetCreatorBeneficiary/);
  });
});
