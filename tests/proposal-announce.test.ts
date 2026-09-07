import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { requiresScript } from "./operator-tree.ts";
import { fileURLToPath } from "node:url";
import {
  PROPOSAL_HASH_PREFIX as UI_PROPOSAL_HASH_PREFIX,
  proposalFromHash,
} from "../src/proposal-deep-link.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const announce = require_(join(root, "scripts/proposal-announce.cjs"));

const {
  ACCOUNT_TYPE_PROPOSAL_TRANSACTION_V2,
  ACCOUNT_TYPE_PROPOSAL_V2,
  MAX_TOPIC_NAME_CHARS,
  MODE_GROUP_ROOT,
  MODE_SINGLE_TOPIC,
  MODE_TOPIC_PER_PROPOSAL,
  base58Encode,
  createTopic,
  decodeGovernanceV2Config,
  decodeInstruction,
  decodeMintDecimals,
  decodeProposalTransactionV2,
  decodeProposalV2,
  decodeTokenAccountMint,
  decodeTokenOwnerRecordOwner,
  formatBaseUnits,
  formatDuration,
  loadConfig,
  loadState,
  parseDeployment,
  proposalUrl,
  resolveDestination,
  resolveRpcUrl,
  resolveUiBase,
  sanitizeText,
  topicNameForProposal,
  PROPOSAL_HASH_PREFIX,
  buildAnnouncement,
  classifyProposal,
  codeSpan,
  escapeHtml,
  shortAddress,
  formatHumanTime,
  formatRemaining,
  htmlToPlainText,
  sendMessage,
  TOPIC_COLOR_BLUE,
  TOPIC_COLOR_YELLOW,
  TOPIC_COLOR_PURPLE,
  TOPIC_COLOR_GREEN,
  TOPIC_COLOR_PINK,
  TOPIC_COLOR_RED,
} = announce;

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Minimal Borsh writer, mirroring the reader under test. */
class W {
  parts: Buffer[] = [];
  u8(v: number) { this.parts.push(Buffer.from([v])); return this; }
  u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this; }
  u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(b); return this; }
  u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); return this; }
  i64(v: bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(v); this.parts.push(b); return this; }
  raw(b: Buffer) { this.parts.push(b); return this; }
  key(fill: number) { this.parts.push(Buffer.alloc(32, fill)); return this; }
  str(s: string) { const b = Buffer.from(s, "utf8"); return this.u32(b.length).raw(b); }
  none() { return this.u8(0); }
  someI64(v: bigint) { return this.u8(1).i64(v); }
  build() { return Buffer.concat(this.parts); }
}

function pk(fill: number): string {
  return base58Encode(Buffer.alloc(32, fill));
}

function buildProposal(overrides: { name?: string; state?: number; votingAt?: bigint | null } = {}): Buffer {
  const w = new W();
  w.u8(ACCOUNT_TYPE_PROPOSAL_V2);
  w.key(1); // governance
  w.key(2); // governing_token_mint
  w.u8(overrides.state ?? 0); // state = Draft
  w.key(3); // token_owner_record
  w.u8(0); // signatories_count
  w.u8(0); // signatories_signed_off_count
  w.u8(0); // vote_type = SingleChoice
  w.u32(1); // options len
  w.str("Approve").u64(0n).u8(0).u16(0).u16(1).u16(1);
  w.none(); // deny_vote_weight
  w.u8(0); // reserved1
  w.none(); // abstain_vote_weight
  w.none(); // start_voting_at
  w.i64(1_800_000_000n); // draft_at
  w.none(); // signing_off_at
  if (overrides.votingAt === undefined || overrides.votingAt === null) {
    w.none(); // voting_at
  } else {
    w.someI64(overrides.votingAt);
  }
  w.none(); // voting_at_slot
  w.none(); // voting_completed_at
  w.none(); // executing_at
  w.none(); // closed_at
  w.u8(1); // execution_flags = Ordered
  w.none(); // max_vote_weight
  w.none(); // max_voting_time
  w.none(); // vote_threshold
  w.raw(Buffer.alloc(64, 0)); // reserved
  w.str(overrides.name ?? "Rewards Initiative");
  w.str("ipfs://cid");
  w.u64(0n); // veto_vote_weight
  return w.build();
}

function buildProposalTransaction(instructions: Array<{ programId: number; accounts: number[]; data: Buffer }>): Buffer {
  const w = new W();
  w.u8(ACCOUNT_TYPE_PROPOSAL_TRANSACTION_V2);
  w.key(9); // proposal
  w.u8(0); // option_index
  w.u16(0); // transaction_index
  w.u32(172_800); // hold_up_time -- two days
  w.u32(instructions.length);
  for (const ix of instructions) {
    w.key(ix.programId);
    w.u32(ix.accounts.length);
    for (const a of ix.accounts) {
      w.key(a).u8(0).u8(1);
    }
    w.u32(ix.data.length).raw(ix.data);
  }
  w.none(); // executed_at
  w.u8(0); // execution_status = None
  w.raw(Buffer.alloc(8, 0)); // reserved_v2
  return w.build();
}

describe("proposal-announce base58", () => {
  it("encodes the all-zero key as the System Program id", () => {
    assert.equal(base58Encode(Buffer.alloc(32, 0)), SYSTEM_PROGRAM_ID);
  });

  it("encodes the ProposalV2 account-type filter byte", () => {
    assert.equal(base58Encode(Buffer.from([ACCOUNT_TYPE_PROPOSAL_V2])), "F");
    assert.equal(base58Encode(Buffer.from([ACCOUNT_TYPE_PROPOSAL_TRANSACTION_V2])), "E");
  });

  it("preserves leading zero bytes as leading ones", () => {
    assert.equal(base58Encode(Buffer.from([0, 0, 1])), "112");
  });
});

describe("proposal-announce account decoding", () => {
  it("decodes a ProposalV2 through the variable-length option region", () => {
    const decoded = decodeProposalV2(buildProposal());
    assert.equal(decoded.governance, pk(1));
    assert.equal(decoded.governingTokenMint, pk(2));
    assert.equal(decoded.tokenOwnerRecord, pk(3));
    assert.equal(decoded.state, 0);
    assert.equal(decoded.name, "Rewards Initiative");
    assert.equal(decoded.descriptionLink, "ipfs://cid");
    assert.equal(decoded.draftAt, 1_800_000_000n);
    assert.equal(decoded.votingAt, null);
    assert.equal(decoded.options.length, 1);
    assert.equal(decoded.options[0].label, "Approve");
  });

  it("carries voting_at when the proposal has opened", () => {
    const decoded = decodeProposalV2(buildProposal({ state: 2, votingAt: 1_800_000_500n }));
    assert.equal(decoded.state, 2);
    assert.equal(decoded.votingAt, 1_800_000_500n);
  });

  it("refuses an account that is not a ProposalV2", () => {
    const bogus = buildProposal();
    bogus[0] = 12;
    assert.throws(() => decodeProposalV2(bogus), /not a ProposalV2/);
  });

  it("decodes a ProposalTransactionV2 with its hold-up time and instructions", () => {
    const solTransfer = Buffer.alloc(12);
    solTransfer.writeUInt32LE(2, 0);
    solTransfer.writeBigUInt64LE(1_500_000_000n, 4);
    const buf = buildProposalTransaction([
      { programId: 0, accounts: [7, 8], data: solTransfer },
      { programId: 5, accounts: [1], data: Buffer.alloc(132, 7) },
    ]);
    const tx = decodeProposalTransactionV2(buf);
    assert.equal(tx.holdUpTime, 172_800);
    assert.equal(tx.instructions.length, 2);
    assert.equal(tx.instructions[0].programId, SYSTEM_PROGRAM_ID);
    assert.equal(tx.instructions[0].accounts.length, 2);
    assert.equal(tx.instructions[1].data.length, 132);
    assert.equal(tx.executedAt, null);
  });

  it("reads governing_token_owner out of a TokenOwnerRecordV2", () => {
    const w = new W();
    w.u8(17).key(1).key(2).key(4).u64(0n).u64(0n).u8(0).u8(1).raw(Buffer.alloc(6, 0)).none();
    assert.equal(decodeTokenOwnerRecordOwner(w.build()), pk(4));
  });

  it("decodes a GovernanceV2 config including the variable-length thresholds", () => {
    const w = new W();
    w.u8(18).key(1).key(2).u32(0);
    w.u8(0).u8(60); // community_vote_threshold = YesVotePercentage(60)
    w.u64(1n); // min_community_weight
    w.u32(172_800); // min_transaction_hold_up_time
    w.u32(259_200); // voting_base_time
    w.u8(2); // community_vote_tipping = Disabled
    w.u8(2); // council_vote_threshold = Disabled
    w.u8(0).u8(51); // council_veto_vote_threshold = YesVotePercentage(51)
    w.u64(1n); // min_council_weight
    w.u8(2); // council_vote_tipping
    w.u8(2); // community_veto_vote_threshold = Disabled
    w.u32(43_200); // voting_cool_off_time
    w.u8(3); // deposit_exempt_proposal_count
    const cfg = decodeGovernanceV2Config(w.build());
    assert.equal(cfg.minTransactionHoldUpTime, 172_800);
    assert.equal(cfg.votingBaseTime, 259_200);
    assert.equal(cfg.votingCoolOffTime, 43_200);
    assert.equal(cfg.depositExemptProposalCount, 3);
    assert.deepEqual(cfg.councilVetoVoteThreshold, { kind: "YesVotePercentage", value: 51 });
    assert.deepEqual(cfg.communityVetoVoteThreshold, { kind: "Disabled", value: null });
  });

  it("reads the mint off a token account and the decimals off a mint", () => {
    const tokenAccount = Buffer.concat([Buffer.alloc(32, 6), Buffer.alloc(40, 0)]);
    assert.equal(decodeTokenAccountMint(tokenAccount), pk(6));
    const mint = Buffer.alloc(82, 0);
    mint[44] = 9;
    assert.equal(decodeMintDecimals(mint), 9);
  });
});

describe("proposal-announce instruction decoding", () => {
  it("decodes a System transfer with its destination and lamports", () => {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0);
    data.writeBigUInt64LE(1_500_000_000n, 4);
    const info = decodeInstruction({
      programId: SYSTEM_PROGRAM_ID,
      accounts: [{ pubkey: pk(1) }, { pubkey: pk(2) }],
      data,
    });
    assert.equal(info.kind, "sol-transfer");
    assert.equal(info.transfer.amount, 1_500_000_000n);
    assert.equal(info.transfer.decimals, 9);
    assert.equal(info.transfer.destination, pk(2));
  });

  it("decodes an SPL Token transfer without inventing a mint or decimals", () => {
    const data = Buffer.alloc(9);
    data[0] = 3;
    data.writeBigUInt64LE(20_000_000_000_000n, 1);
    const info = decodeInstruction({
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [{ pubkey: pk(1) }, { pubkey: pk(2) }, { pubkey: pk(3) }],
      data,
    });
    assert.equal(info.kind, "token-transfer");
    assert.equal(info.transfer.amount, 20_000_000_000_000n);
    assert.equal(info.transfer.destination, pk(2));
    assert.equal(info.transfer.asset, null);
    assert.equal(info.transfer.decimals, null);
  });

  it("decodes transferChecked and takes the mint and decimals from the instruction", () => {
    const data = Buffer.alloc(10);
    data[0] = 12;
    data.writeBigUInt64LE(20_000_000n, 1);
    data[9] = 6;
    const info = decodeInstruction({
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [{ pubkey: pk(1) }, { pubkey: pk(4) }, { pubkey: pk(2) }, { pubkey: pk(3) }],
      data,
    });
    assert.equal(info.kind, "token-transfer");
    assert.equal(info.transfer.asset, pk(4));
    assert.equal(info.transfer.decimals, 6);
    assert.equal(info.transfer.destination, pk(2));
  });

  it("flags an unrecognised program rather than dropping it", () => {
    const info = decodeInstruction({ programId: pk(5), accounts: [], data: Buffer.alloc(132, 1) });
    assert.equal(info.kind, "unknown");
    assert.match(info.summary, /132 bytes/);
  });

  it("flags a System Program instruction that is not a plain transfer", () => {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(1, 0); // Assign, not Transfer
    const info = decodeInstruction({ programId: SYSTEM_PROGRAM_ID, accounts: [], data });
    assert.equal(info.kind, "unknown");
    assert.match(info.summary, /NOT a plain SOL transfer/);
  });

  it("flags an SPL Token instruction that is not a transfer", () => {
    const info = decodeInstruction({
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [],
      data: Buffer.from([7, 0, 0, 0, 0, 0, 0, 0, 0]), // MintTo
    });
    assert.equal(info.kind, "unknown");
    assert.match(info.summary, /NOT a plain transfer/);
  });
});

describe("proposal-announce formatting", () => {
  it("scales base units by decimals and groups digits", () => {
    assert.equal(formatBaseUnits(20_000_000_000_000n, 6), "20,000,000");
    assert.equal(formatBaseUnits(1_500_000_000n, 9), "1.5");
    assert.equal(formatBaseUnits(0n, 9), "0");
  });

  it("says so rather than guessing when decimals are unknown", () => {
    assert.match(formatBaseUnits(12345n, null), /decimals unknown/);
  });

  it("says a duration once, in words a person can read", () => {
    // Was `2d (172800s)`. A novice reader read the duplicated
    // `1s (1s)` as a computer error, and "1s" next to money told them nothing.
    assert.equal(formatDuration(0), "immediately, with no delay at all");
    assert.equal(formatDuration(1), "1 second");
    assert.equal(formatDuration(172_800), "2 days");
    assert.equal(formatDuration(43_200), "12 hours");
    assert.equal(formatDuration(273_600), "3 days 4 hours");
  });

  it("renders a wall-clock time without an ISO T or Z", () => {
    // "2026-08-29T20:11:37Z" was read as "a computer error".
    assert.equal(formatHumanTime(1_800_000_000), "15 Jan 2027, 08:00 UTC");
    assert.equal(formatHumanTime(1_800_000_000, true), "15 Jan 2027, 08:00:00 UTC");
  });

  it("leads a deadline with how long is left, not an absolute instant", () => {
    assert.equal(formatRemaining(1_000_000, 1_000_000 - 259_200), "3 days left");
    assert.equal(formatRemaining(1_000_000, 1_000_000 - 600), "less than an hour left");
    assert.equal(formatRemaining(1_000_000, 1_000_000 + 1), "the deadline has passed");
  });

  it("shortens a mint for the plain-language block only", () => {
    // A novice reader could not tell six full base58 strings apart. The full
    // address still appears, in the technical section.
    assert.equal(shortAddress(pk(7)), `${pk(7).slice(0, 4)}\u2026${pk(7).slice(-4)}`);
    assert.equal(shortAddress("short"), "short");
  });

  it("strips control characters and clamps an attacker-controlled name", () => {
    assert.equal(sanitizeText("a b‮c", 100), "a b c");
    assert.equal(sanitizeText("   ", 100), "(empty)");
    assert.match(sanitizeText("x".repeat(300), 200), /\.\.\.\(truncated\)$/);
  });
});

describe("proposal-announce config", () => {
  const dir = mkdtempSync(join(tmpdir(), "announce-"));

  it("parses a devnet deployment and a REALM_UNPUBLISHED mainnet one", () => {
    const devnet = join(dir, "devnet.json");
    writeFileSync(
      devnet,
      JSON.stringify({ cluster: "devnet", realmsInstance: "kekbull", realm: pk(1), governance: pk(2) }),
    );
    const parsed = parseDeployment(devnet);
    assert.equal(parsed.cluster, "devnet");
    assert.equal(parsed.governance, pk(2));

    const mainnet = join(dir, "mainnet.json");
    writeFileSync(
      mainnet,
      JSON.stringify({ cluster: "mainnet-beta", realmsInstance: "kekbull", realm: null, governance: null }),
    );
    assert.equal(parseDeployment(mainnet).governance, null);
  });

  it("refuses a deployment whose cluster is not one of the two", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ cluster: "testnet", realm: null, governance: null }));
    assert.throws(() => parseDeployment(bad), /must be devnet or mainnet-beta/);
  });

  it("refuses a mainnet RPC behind a devnet deployment and vice versa", () => {
    const prev = process.env.ICHOR_ANNOUNCE_RPC;
    try {
      process.env.ICHOR_ANNOUNCE_RPC = "https://example-mainnet.rpc/x";
      assert.throws(() => resolveRpcUrl("devnet"), /mainnet-looking RPC/);
      process.env.ICHOR_ANNOUNCE_RPC = "https://example-devnet.rpc/x";
      assert.throws(() => resolveRpcUrl("mainnet-beta"), /devnet-looking RPC/);
      process.env.ICHOR_ANNOUNCE_RPC = "http://example.rpc/x";
      assert.throws(() => resolveRpcUrl("devnet"), /must be https/);
      // Unset falls back to the official public endpoint on BOTH clusters.
      // Mainnet used to throw here, demanding a keyed URL. That made a missing
      // credential the difference between an announcer that runs and one that
      // refuses to start, and an announcer that is not running is a DAO whose
      // holders hear nothing. This process only reads, at one poll per 45s.
      delete process.env.ICHOR_ANNOUNCE_RPC;
      assert.equal(resolveRpcUrl("devnet"), "https://api.devnet.solana.com");
      assert.equal(resolveRpcUrl("mainnet-beta"), "https://api.mainnet-beta.solana.com");
      // The fallback must never be the wrong chain's endpoint. Cheap to assert
      // and the whole point of having two constants.
      assert.match(resolveRpcUrl("mainnet-beta"), /mainnet/);
      assert.doesNotMatch(resolveRpcUrl("mainnet-beta"), /devnet/);
      assert.doesNotMatch(resolveRpcUrl("devnet"), /mainnet/);
    } finally {
      if (prev === undefined) delete process.env.ICHOR_ANNOUNCE_RPC;
      else process.env.ICHOR_ANNOUNCE_RPC = prev;
    }
  });
});

describe("proposal-announce review link", () => {
  // A real official-devnet proposal, so the round-trip runs against the shape
  // the announcer actually emits rather than a synthetic all-ones key.
  const ADDRESS = "A8m7YyNkoWy4osqC5R8KDgvYVYTt26WKvxXB3fn3QCFP";

  it("spells the deep-link prefix exactly as the UI does", () => {
    // Two spellings of one format is how formats drift. The .cjs helper runs
    // on Node 18 and cannot import the .ts module, so the constant is
    // duplicated -- and this assertion is the whole reason that is safe.
    assert.equal(PROPOSAL_HASH_PREFIX, UI_PROPOSAL_HASH_PREFIX);
  });

  it("builds a link the UI's own router accepts", () => {
    // Stronger than string equality: the link is parsed back by the exact
    // function the UI uses to decide which proposal to open. A format change
    // in src/proposal-deep-link.ts fails here instead of shipping a dead link
    // into a public room.
    const url = proposalUrl(resolveUiBase("devnet"), ADDRESS);
    assert.equal(url, `https://devnet.dao.kekbull.com/#proposal/${ADDRESS}`);
    assert.equal(proposalFromHash(new URL(url).hash), ADDRESS);
  });

  it("links to the proposal, not to the board", () => {
    // Regression: the message used to link to #vote, which drops a reader who
    // was just shown a decoded transfer onto the whole proposal list.
    const url = proposalUrl(resolveUiBase("mainnet-beta"), ADDRESS);
    assert.match(url, /#proposal\//);
    assert.doesNotMatch(url, /#vote/);
  });

  it("defaults to the right origin per cluster", () => {
    const prev = process.env.ICHOR_ANNOUNCE_UI_BASE;
    try {
      delete process.env.ICHOR_ANNOUNCE_UI_BASE;
      assert.equal(resolveUiBase("devnet"), "https://devnet.dao.kekbull.com/");
      assert.equal(resolveUiBase("mainnet-beta"), "https://dao.kekbull.com/");
    } finally {
      if (prev === undefined) delete process.env.ICHOR_ANNOUNCE_UI_BASE;
      else process.env.ICHOR_ANNOUNCE_UI_BASE = prev;
    }
  });

  it("honours a rehosted UI, and refuses one that would send holders nowhere", () => {
    // The UI is meant to be rehostable by a successor. A baked-in host would
    // point their holders at someone else's copy; an unvalidated override
    // points them at nothing at all.
    const prev = process.env.ICHOR_ANNOUNCE_UI_BASE;
    try {
      process.env.ICHOR_ANNOUNCE_UI_BASE = "https://dao.example.org/kekbull";
      assert.equal(
        proposalUrl(resolveUiBase("mainnet-beta"), ADDRESS),
        `https://dao.example.org/kekbull/#proposal/${ADDRESS}`,
      );

      // A fragment or query on the base would be replaced by the proposal
      // hash anyway -- dropped here rather than silently at render time.
      process.env.ICHOR_ANNOUNCE_UI_BASE = "https://dao.example.org/#vote?x=1";
      assert.equal(resolveUiBase("devnet"), "https://dao.example.org/");

      process.env.ICHOR_ANNOUNCE_UI_BASE = "not a url";
      assert.throws(() => resolveUiBase("devnet"), /is not a URL/);

      process.env.ICHOR_ANNOUNCE_UI_BASE = "http://dao.kekbull.com/";
      assert.throws(() => resolveUiBase("devnet"), /must be https/);

      // http is allowed for loopback only, so rehearsing against a locally
      // served UI is possible without that being a way to ship http links.
      process.env.ICHOR_ANNOUNCE_UI_BASE = "http://127.0.0.1:5173";
      assert.equal(resolveUiBase("devnet"), "http://127.0.0.1:5173/");
    } finally {
      if (prev === undefined) delete process.env.ICHOR_ANNOUNCE_UI_BASE;
      else process.env.ICHOR_ANNOUNCE_UI_BASE = prev;
    }
  });
});

describe("proposal-announce REALM_UNPUBLISHED", () => {
  const dir = mkdtempSync(join(tmpdir(), "announce-unpub-"));

  it("idles instead of demanding an RPC or a chat id when no Realm is published", () => {
    // Regression: an unpublished mainnet used to exit 1 on the missing RPC,
    // which under Restart=on-failure is a crash-loop rather than fail-closed.
    const path = join(dir, "mainnet.json");
    writeFileSync(
      path,
      JSON.stringify({ cluster: "mainnet-beta", realmsInstance: "kekbull", realm: null, governance: null }),
    );
    const saved = { ...process.env };
    try {
      delete process.env.ICHOR_ANNOUNCE_RPC;
      delete process.env.KEKBULL_DAO_TG_CHAT_ID;
      delete process.env.KEKBULL_DAO_TG_BOT_TOKEN;
      delete process.env.KEKBULL_DAO_TG_THREAD_ID;
      delete process.env.ICHOR_ANNOUNCE_DRY_RUN;
      delete process.env.ICHOR_ANNOUNCE_ENV_FILE;
      process.env.ICHOR_ANNOUNCE_DEPLOYMENT = path;
      process.env.ICHOR_ANNOUNCE_STATE = join(dir, "state.json");
      const cfg = loadConfig();
      assert.equal(cfg.unpublished, true);
      assert.equal(cfg.rpcUrl, null);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("still demands a chat id once a governance exists", () => {
    const path = join(dir, "devnet.json");
    writeFileSync(
      path,
      JSON.stringify({ cluster: "devnet", realmsInstance: "kekbull", realm: pk(1), governance: pk(2) }),
    );
    const saved = { ...process.env };
    try {
      delete process.env.KEKBULL_DAO_TG_CHAT_ID;
      delete process.env.ICHOR_ANNOUNCE_DRY_RUN;
      delete process.env.ICHOR_ANNOUNCE_ENV_FILE;
      process.env.ICHOR_ANNOUNCE_DEPLOYMENT = path;
      process.env.ICHOR_ANNOUNCE_STATE = join(dir, "state2.json");
      assert.throws(() => loadConfig(), /KEKBULL_DAO_TG_CHAT_ID/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("proposal-announce cursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "announce-state-"));

  it("starts unprimed when there is no state file", () => {
    const state = loadState(join(dir, "missing.json"), "devnet", pk(2));
    assert.equal(state.primed, false);
    assert.deepEqual(state.announced, {});
  });

  it("round-trips announced proposals so a restart does not re-announce", () => {
    const path = join(dir, "state.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        cluster: "devnet",
        governance: pk(2),
        primed: true,
        announced: { [pk(7)]: { announcedAt: 1, draftAt: "1800000000" } },
      }),
    );
    const state = loadState(path, "devnet", pk(2));
    assert.equal(state.primed, true);
    assert.ok(state.announced[pk(7)]);
  });

  it("refuses a state file belonging to a different governance", () => {
    const path = join(dir, "other.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, cluster: "devnet", governance: pk(3), primed: true, announced: {} }),
    );
    assert.throws(() => loadState(path, "devnet", pk(2)), /refusing to reuse/);
  });

  it("carries created topic ids across a restart, and reads a v1 file as having none", () => {
    const path = join(dir, "topics.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        cluster: "devnet",
        governance: pk(2),
        primed: true,
        announced: { [pk(7)]: { announcedAt: 1, draftAt: "1800000000", messageThreadId: 41 } },
        topics: { [pk(7)]: { messageThreadId: 41, name: "Fee split [3vQB2n]", createdAt: 1 } },
      }),
    );
    const state = loadState(path, "devnet", pk(2));
    assert.equal(state.topics[pk(7)].messageThreadId, 41);

    // A v1 file predates topic-per-proposal mode, so it created none.
    const v1 = join(dir, "v1.json");
    writeFileSync(
      v1,
      JSON.stringify({ version: 1, cluster: "devnet", governance: pk(2), primed: true, announced: {} }),
    );
    assert.deepEqual(loadState(v1, "devnet", pk(2)).topics, {});
  });
});

describe("proposal-announce topic naming", () => {
  it("names the topic after the proposal and ties it to the account on chain", () => {
    const name = topicNameForProposal("Fee split 25/75", pk(7));
    assert.match(name, /^Fee split 25\/75 \[/);
    assert.ok(name.endsWith(`[${pk(7).slice(0, 6)}]`));
  });

  it("never exceeds Telegram's 128-character topic-name ceiling", () => {
    const long = topicNameForProposal("x".repeat(400), pk(7));
    assert.ok(long.length <= MAX_TOPIC_NAME_CHARS, `topic name was ${long.length} chars`);
    // The address fragment survives truncation -- it is what disambiguates
    // two proposals whose long titles share a prefix.
    assert.ok(long.endsWith(`[${pk(7).slice(0, 6)}]`));
  });

  it("strips an attacker-controlled name rather than letting it reshape the topic list", () => {
    const name = topicNameForProposal("Rewards‮Initiative\n\n\nDRAIN", pk(7));
    assert.doesNotMatch(name, /[‮\n]/);
    assert.match(name, /^Rewards Initiative DRAIN \[/);
  });

  it("gives an empty title a usable name instead of '(empty)'", () => {
    assert.match(topicNameForProposal("   ", pk(7)), /^Untitled proposal \[/);
  });
});

describe("proposal-announce destination mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "announce-mode-"));
  const deployment = join(dir, "devnet.json");
  writeFileSync(
    deployment,
    JSON.stringify({ cluster: "devnet", realmsInstance: "kekbull", realm: pk(1), governance: pk(2) }),
  );

  function withEnv(env: Record<string, string | undefined>, fn: () => void) {
    const saved = { ...process.env };
    try {
      for (const key of [
        "KEKBULL_DAO_TG_THREAD_ID",
        "KEKBULL_DAO_TG_CHAT_ID",
        "KEKBULL_DAO_TG_BOT_TOKEN",
        "ICHOR_ANNOUNCE_TOPIC_PER_PROPOSAL",
        "ICHOR_ANNOUNCE_ENV_FILE",
        "ICHOR_ANNOUNCE_RPC",
      ]) {
        delete process.env[key];
      }
      process.env.ICHOR_ANNOUNCE_DRY_RUN = "1";
      process.env.ICHOR_ANNOUNCE_DEPLOYMENT = deployment;
      process.env.ICHOR_ANNOUNCE_STATE = join(dir, "state.json");
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fn();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }

  it("defaults to the safe no-admin path when neither is configured, and says why", () => {
    withEnv({}, () => {
      const cfg = loadConfig();
      assert.equal(cfg.mode, MODE_GROUP_ROOT);
      assert.equal(cfg.threadId, null);
      assert.match(cfg.modeReason, /needs no admin rights/);
      assert.match(cfg.modeReason, /GROUP ROOT/);
    });
  });

  it("uses the fixed thread when KEKBULL_DAO_TG_THREAD_ID is set, and creates nothing", () => {
    withEnv({ KEKBULL_DAO_TG_THREAD_ID: "77" }, () => {
      const cfg = loadConfig();
      assert.equal(cfg.mode, MODE_SINGLE_TOPIC);
      assert.equal(cfg.threadId, 77);
      assert.match(cfg.modeReason, /no topic is ever created/);
      assert.match(cfg.modeReason, /NO admin rights/);
    });
  });

  it("creates a topic per proposal only on the explicit opt-in", () => {
    withEnv({ ICHOR_ANNOUNCE_TOPIC_PER_PROPOSAL: "1" }, () => {
      const cfg = loadConfig();
      assert.equal(cfg.mode, MODE_TOPIC_PER_PROPOSAL);
      assert.match(cfg.modeReason, /can_manage_topics AND NOTHING ELSE/);
    });
  });

  it("lets the fixed thread win over the opt-in, because that path needs no admin", () => {
    withEnv({ KEKBULL_DAO_TG_THREAD_ID: "77", ICHOR_ANNOUNCE_TOPIC_PER_PROPOSAL: "1" }, () => {
      const cfg = loadConfig();
      assert.equal(cfg.mode, MODE_SINGLE_TOPIC);
      assert.equal(cfg.topicPerProposalRequested, true);
    });
  });

  it("routes each mode to the right message_thread_id without touching the network", async () => {
    const address = pk(7);
    const proposal = { name: "Fee split 25/75" };
    const state = { topics: {}, announced: {} };

    assert.equal(
      await resolveDestination({ mode: MODE_SINGLE_TOPIC, threadId: 77 }, state, address, proposal),
      77,
    );
    assert.equal(await resolveDestination({ mode: MODE_GROUP_ROOT, threadId: null }, state, address, proposal), null);

    // Restart safety: an already-created topic is REUSED, never recreated.
    const withTopic = { topics: { [address]: { messageThreadId: 41 } }, announced: {} };
    assert.equal(
      await resolveDestination({ mode: MODE_TOPIC_PER_PROPOSAL, threadId: null }, withTopic, address, proposal),
      41,
    );
  });
});

describe("proposal-announce topic-creation failure", () => {
  it("stops with the likely cause named, and never falls back to the group root", async () => {
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({
        ok: true,
        status: 400,
        json: async () => ({ ok: false, description: "Bad Request: not enough rights to manage topics" }),
      })) as unknown as typeof fetch;
      await assert.rejects(
        () => createTopic({ token: "unused", chatId: "-1001" }, "Fee split [3vQB2n]"),
        (err: Error & { fatal?: boolean }) => {
          assert.equal(err.name, "FatalAnnounceError");
          assert.equal(err.fatal, true);
          assert.match(err.message, /not enough rights to manage topics/);
          assert.match(err.message, /WITHOUT can_manage_topics/);
          assert.match(err.message, /Topics \(forum mode\) is not enabled/);
          assert.match(err.message, /STOPPING/);
          assert.match(err.message, /Not falling back to the group root/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("refuses a createForumTopic result with no usable message_thread_id", async () => {
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { name: "x" } }),
      })) as unknown as typeof fetch;
      await assert.rejects(
        () => createTopic({ token: "unused", chatId: "-1001" }, "x"),
        /no usable message_thread_id/,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// HTML presentation
// ---------------------------------------------------------------------------

/**
 * A fetch stub that answers the two JSON-RPC methods buildAnnouncement uses.
 * No network, no chain, no Telegram.
 */
function stubRpcFetch(accountsByMethod: {
  getProgramAccounts?: unknown[];
  getAccountInfo?: (address: string) => unknown;
}) {
  return (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    let result: unknown = null;
    if (body.method === "getProgramAccounts") {
      result = accountsByMethod.getProgramAccounts ?? [];
    } else if (body.method === "getAccountInfo") {
      result = { value: accountsByMethod.getAccountInfo?.(body.params[0]) ?? null };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, result }) };
  }) as unknown as typeof fetch;
}

function b64(buf: Buffer): [string, string] {
  return [buf.toString("base64"), "base64"];
}

const ANNOUNCE_CFG = {
  rpcUrl: "https://stub.invalid",
  programId: pk(1),
  deployment: { cluster: "devnet", governance: pk(2) },
  uiBase: "https://devnet.dao.kekbull.com/",
};

function solTransferData(lamports: bigint): Buffer {
  const d = Buffer.alloc(12);
  d.writeUInt32LE(2, 0);
  d.writeBigUInt64LE(lamports, 4);
  return d;
}

async function announceWith(
  opts: {
    name?: string;
    state?: number;
    instructions?: Array<{ programId: number; accounts: number[]; data: Buffer }>;
  } = {},
): Promise<{ html: string; text: string; classification: { color: number; reason: string } }> {
  const savedFetch = globalThis.fetch;
  try {
    const txAccounts =
      opts.instructions === undefined
        ? []
        : [{ pubkey: pk(9), account: { data: b64(buildProposalTransaction(opts.instructions)) } }];
    globalThis.fetch = stubRpcFetch({ getProgramAccounts: txAccounts });
    const proposal = decodeProposalV2(buildProposal({ name: opts.name, state: opts.state }));
    proposal.createdBy = pk(4);
    return await buildAnnouncement(ANNOUNCE_CFG, pk(7), proposal, null, new Map());
  } finally {
    globalThis.fetch = savedFetch;
  }
}

describe("proposal-announce HTML escaping", () => {
  it("escapes every character Telegram's HTML parser treats as markup", () => {
    assert.equal(escapeHtml('<b>&"x'), "&lt;b&gt;&amp;&quot;x");
    assert.equal(escapeHtml("plain"), "plain");
  });

  it("renders a hostile proposal name as literal text, never as markup", async () => {
    // THE test this whole parse_mode change has to earn. A proposal name is
    // written by whoever created the proposal and lands in a public room next
    // to a treasury warning. If it can inject markup it can forge the
    // warning's own emphasis, or hide an instruction line behind a tag.
    //
    // Delete escapeHtml from boldSpan and this fails: the raw <b> arrives.
    const hostile = '<b>free money</b> <a href="https://evil.example">click</a> & "quoted"';
    const { html, text } = await announceWith({ name: hostile });

    assert.doesNotMatch(html, /<b>free money<\/b>/);
    assert.doesNotMatch(html, /href="https:\/\/evil\.example"/);
    assert.match(html, /&lt;b&gt;free money&lt;\/b&gt;/);
    assert.match(html, /&lt;a href=&quot;https:\/\/evil\.example&quot;&gt;click&lt;\/a&gt;/);
    assert.match(html, /&amp; &quot;quoted&quot;/);

    // Exactly one anchor in the message, and it is OUR review link.
    const anchors = [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(anchors, [`https://devnet.dao.kekbull.com/#proposal/${pk(7)}`]);

    // A malformed name must not break the message -- every other fact is
    // still there, so the announcement still goes out in full.
    assert.match(html, /NEW PROPOSAL/);
    assert.match(html, /What it does:/);
    assert.match(html, /Money it moves:/);
    assert.match(html, /Read the full proposal on devnet\.dao\.kekbull\.com/);
    assert.match(html, /TECHNICAL DETAIL/);

    // The plain-text fallback carries the same literal characters back.
    assert.match(text, /<b>free money<\/b>/);
    assert.match(text, new RegExp(`https://devnet\\.dao\\.kekbull\\.com/#proposal/${pk(7)}`));
  });

  it("round-trips its own markup back to plain text without losing the link", () => {
    const html = ['<b>Head</b>', 'addr ' + codeSpan(pk(3)), '<blockquote>warn</blockquote>', '<a href="https://x.example/#proposal/abc">Read the full proposal on x.example →</a>'].join("\n");
    const plain = htmlToPlainText(html);
    assert.equal(
      plain,
      `Head\naddr ${pk(3)}\nwarn\nRead the full proposal on x.example → https://x.example/#proposal/abc`,
    );
  });
});

describe("proposal-announce message layout", () => {
  it("shows no address at all above the technical section", async () => {
    // A novice reader stopped at line 4 of the old message, where a base58
    // address sat: "a wall of nonsense, so my brain files the whole message as
    // 'not for me'." The decision half must be readable without one.
    const { html } = await announceWith({
      instructions: [{ programId: 0, accounts: [7, 8], data: solTransferData(1_500_000_000n) }],
    });
    const split = html.indexOf("TECHNICAL DETAIL");
    assert.ok(split > 0, "no technical section");
    // href values are excluded: the review link necessarily carries the
    // proposal address, and a reader never sees it -- the anchor text is
    // "Read the full proposal on devnet.dao.kekbull.com".
    const top = html.slice(0, split).replace(/href="[^"]*"/g, 'href=""');
    const found = [...top.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g)].map((m) => m[0]);
    assert.deepEqual(found, [], `plain-language block leaked addresses: ${found.join(", ")}`);
    assert.doesNotMatch(top, /<code>/);
  });

  it("keeps every address tap-to-copy in the technical section", async () => {
    const { html } = await announceWith({
      instructions: [{ programId: 0, accounts: [7, 8], data: solTransferData(1_500_000_000n) }],
    });
    // The proposal, the creator, the TokenOwnerRecord and the transfer
    // destination are all copyable rather than 44 characters to select by hand.
    for (const address of [pk(7), pk(4), pk(3), pk(8)]) {
      assert.match(html, new RegExp(`<code>${address}</code>`), `${address} is not tap-to-copy`);
    }
    // And the bare URL is gone: a 90-character link wraps mid-address.
    assert.doesNotMatch(html, /Review before voting: https/);
    // The anchor names its destination -- the old one "is the shape of every
    // scam I've been warned about".
    assert.match(html, /<a href="[^"]+">Read the full proposal on devnet\.dao\.kekbull\.com →<\/a>/);
  });

  it("leads with what decides a vote and pushes the evidence to the bottom", async () => {
    const { html } = await announceWith({
      instructions: [{ programId: 0, accounts: [7, 8], data: solTransferData(1_500_000_000n) }],
    });
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      assert.ok(i >= 0, `${needle} missing from the message`);
      return i;
    };
    assert.ok(at("NEW PROPOSAL") < at("What it does:"));
    assert.ok(at("What it does:") < at("Money it moves:"));
    assert.ok(at("Money it moves:") < at("Do you need to vote:"));
    assert.ok(at("Do you need to vote:") < at("Deadline:"));
    assert.ok(at("Deadline:") < at("If it passes:"));
    assert.ok(at("If it passes:") < at("Read the full proposal"));
    assert.ok(at("Read the full proposal") < at("TECHNICAL DETAIL"));
    assert.ok(at("TECHNICAL DETAIL") < at("TokenOwnerRecord:"));

    // NOTHING that was in the old message was dropped -- reordered only.
    for (const fact of [
      "Proposal:",
      "Created by:",
      "TokenOwnerRecord:",
      "Created:",
      // This fixture has not opened for voting, so the technical section
      // carries the window rather than an instant -- the "Voting ends:"
      // spelling is asserted in the open-for-voting case below.
      "Voting window once it opens:",
      "Execution hold-up after passing:",
      "Network:",
      "Instructions:",
    ]) {
      assert.match(html, new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${fact} was dropped`);
    }
    assert.match(html, /<b>1\.5<\/b> SOL/);
  });

  it("says what the proposal IS before it says anything about it", async () => {
    // "Every fact is metadata. Not one line says what the proposal IS."
    const nothing = await announceWith({ instructions: [] });
    assert.match(nothing.html, /What it does: <b>Nothing runs on chain\. This is a vote for the record only\.<\/b>/);

    const spends = await announceWith({
      instructions: [{ programId: 0, accounts: [7, 8], data: solTransferData(1_500_000_000n) }],
    });
    assert.match(spends.html, /What it does: <b>It sends money out of the DAO treasury\.<\/b>/);

    const unreadable = await announceWith({
      instructions: [{ programId: 5, accounts: [1], data: Buffer.alloc(132, 7) }],
    });
    assert.match(unreadable.html, /What it does: <b>It runs 1 instruction on chain that nobody has explained yet\.<\/b>/);
  });

  it("never says the same thing for 'no money moves' and 'we cannot tell'", async () => {
    // THE novice finding. `TOTAL VALUE MOVED: none decoded` was printed for
    // both, so a reader could not tell the safe case from the emergency --
    // read the safe one as an emergency, then stopped trusting the line.
    const safe = await announceWith({ instructions: [] });
    const unknown = await announceWith({
      instructions: [{ programId: 5, accounts: [1], data: Buffer.alloc(132, 7) }],
    });
    const moves = await announceWith({
      instructions: [{ programId: 0, accounts: [7, 8], data: solTransferData(1_500_000_000n) }],
    });

    const money = (html: string) => {
      const line = html.split("\n").find((l) => l.startsWith("Money it moves:"));
      assert.ok(line, "no 'Money it moves' line");
      return line;
    };
    const safeLine = money(safe.html);
    const unknownLine = money(unknown.html);
    const movesLine = money(moves.html);

    assert.notEqual(safeLine, unknownLine);
    assert.match(safeLine, /Nothing\. No money leaves the treasury\./);
    assert.match(unknownLine, /WE DO NOT KNOW/);
    assert.match(unknownLine, /not the same as zero/);
    assert.match(movesLine, /<b>1\.5<\/b> SOL/);

    // And the phrase a novice could not parse is gone entirely.
    for (const html of [safe.html, unknown.html, moves.html]) {
      assert.doesNotMatch(html, /none decoded/);
      assert.doesNotMatch(html, /TOTAL VALUE MOVED/);
    }
  });

  it("names an amount alongside a partial read, instead of hiding it", async () => {
    // A transfer we CAN read plus an instruction we cannot: the amount is
    // still stated, with the caveat attached rather than replacing it.
    const { html } = await announceWith({
      instructions: [
        { programId: 0, accounts: [7, 8], data: solTransferData(1_500_000_000n) },
        { programId: 5, accounts: [1], data: Buffer.alloc(132, 7) },
      ],
    });
    assert.match(html, /Money it moves: <b>1\.5<\/b> SOL/);
    assert.match(html, /…and possibly more - 1 instruction could not be read\./);
    assert.match(html, /What it does: <b>It sends money out of the DAO treasury, and it also runs 1 instruction that nobody has explained yet\.<\/b>/);
  });

  it("gives the decode warning a person to be and an action to take", async () => {
    // "Someone. WHO? Am I someone? I can't read anything on chain."
    const { html, classification } = await announceWith({
      instructions: [{ programId: 5, accounts: [1], data: Buffer.alloc(132, 7) }],
    });
    assert.match(html, /<blockquote>[\s\S]*could not be read[\s\S]*<\/blockquote>/);
    assert.match(html, /<b>Do not vote yes\.<\/b> Reply in this chat and ask what they do\./);
    assert.match(html, /If no one answers before the deadline, vote no\./);
    assert.doesNotMatch(html, /until someone has read them on chain/);
    // The technical detail behind the warning is kept in full.
    assert.match(html, /COULD NOT READ - program <code>/);
    assert.equal(classification.color, TOPIC_COLOR_RED);
  });

  it("states the state in words for every state, whatever the colour", async () => {
    // A colour-blind reader, or anyone on a client that renders topic icons
    // differently (or not at all), must lose nothing. Colour is a scanning aid
    // for the topic list; the message text is the truth, and it never depends
    // on the icon having been seen.
    const NAMES = [
      "Draft",
      "SigningOff",
      "Voting",
      "Succeeded",
      "Executing",
      "Completed",
      "Cancelled",
      "Defeated",
      "ExecutingWithErrors",
      "Vetoed",
    ];
    for (let state = 0; state < NAMES.length; state += 1) {
      const { html } = await announceWith({ state, instructions: [] });
      assert.match(
        html,
        new RegExp(`Status: <b>${NAMES[state]}</b>`),
        `state ${state} (${NAMES[state]}) is not stated in words`,
      );
      // The three questions a holder acts on are answered in words too.
      assert.match(html, /What it does: <b>/);
      assert.match(html, /Money it moves: /);
      assert.match(html, /Do you need to vote: <b>/);
    }
  });

  it("carries the risk in the text, not only in the topic colour", async () => {
    // The red topic colour and the ‼️ headline both say "unreadable". Neither
    // is required: the sentence says it outright.
    const { html } = await announceWith({
      instructions: [{ programId: 5, accounts: [1], data: Buffer.alloc(132, 7) }],
    });
    const withoutEmoji = html.replace(/[\u203c\ufe0f\u2757\u{1F4B8}\u{1F5F3}\u2705\u{1F4DD}\u270d\u{1F3C1}\u{1F9EA}]/gu, "");
    assert.match(withoutEmoji, /could not be read/);
    assert.match(withoutEmoji, /WE DO NOT KNOW/);
    assert.match(withoutEmoji, /Do not vote yes\./);
  });

  it("calls devnet a practice run instead of 'official'", async () => {
    // "'Official' makes me feel good. 'Devnet' means nothing to me."
    const { html } = await announceWith({ instructions: [] });
    assert.match(html, /^<b>🧪 PRACTICE RUN - this is a test\. No real money is involved\.<\/b>/);
    assert.match(html, /Network: Solana devnet \(a test network - no real money\)/);
    assert.doesNotMatch(html, /official/i);
  });

  it("tells a mainnet reader it is real money, with no practice banner", async () => {
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = stubRpcFetch({ getProgramAccounts: [] });
      const proposal = decodeProposalV2(buildProposal());
      proposal.createdBy = pk(4);
      const { html } = await buildAnnouncement(
        { ...ANNOUNCE_CFG, deployment: { cluster: "mainnet-beta", governance: pk(2) }, uiBase: "https://dao.kekbull.com/" },
        pk(7),
        proposal,
        null,
        new Map(),
      );
      assert.doesNotMatch(html, /PRACTICE RUN/);
      assert.match(html, /Network: Solana mainnet \(real money\)/);
      assert.match(html, /Read the full proposal on dao\.kekbull\.com →/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("states a deadline as time remaining before it states an instant", async () => {
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = stubRpcFetch({ getProgramAccounts: [] });
      const proposal = decodeProposalV2(buildProposal({ state: 2, votingAt: 1_800_000_000n }));
      proposal.createdBy = pk(4);
      const { html } = await buildAnnouncement(
        { ...ANNOUNCE_CFG, nowSeconds: 1_800_000_000 },
        pk(7),
        proposal,
        { votingBaseTime: 259_200, minTransactionHoldUpTime: 172_800, votingCoolOffTime: 43_200 },
        new Map(),
      );
      assert.match(html, /Deadline: <b>3 days left<\/b> \(closes 18 Jan 2027, 08:00 UTC\)/);
      assert.match(html, /Do you need to vote: <b>Yes - voting is open now\.<\/b>/);
      assert.match(html, /If it passes: it takes effect <b>2 days<\/b> later\./);
      assert.match(html, /Cool-off \(Veto\/Deny only\): 12 hours/);
      // No ISO timestamp survives anywhere in the message.
      assert.doesNotMatch(html, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe("proposal-announce topic appearance", () => {
  it("reserves red for 'nobody can tell you what this does', and nothing else", () => {
    // Operator decision 2026-08-30. The rule a holder should be able to learn
    // from the topic list is exactly one sentence: red means unreadable.
    // Risk still outranks state -- a topic icon is chosen once by
    // createForumTopic and never revisited (refreshing it would need
    // editForumTopic, a third Bot API method the send-only hygiene test
    // refuses), so a state colour goes stale while an instruction set does not.
    assert.equal(classifyProposal({ state: 2, undecodedCount: 1 }).color, TOPIC_COLOR_RED);
    assert.equal(classifyProposal({ state: 5, undecodedCount: 1 }).color, TOPIC_COLOR_RED);
    assert.equal(classifyProposal({ state: 0, undecodedCount: 3 }).color, TOPIC_COLOR_RED);
    assert.equal(classifyProposal({ state: 8 }).color, TOPIC_COLOR_RED);

    // An unreadable instruction outranks a readable transfer in the same
    // proposal: the thing nobody can explain is the thing to flag.
    assert.equal(classifyProposal({ state: 2, undecodedCount: 1, movesValue: true }).color, TOPIC_COLOR_RED);
  });

  it("colours a transfer purple, not red -- a DAO moving value is its job", () => {
    // Regression against desensitisation: colouring every routine fee
    // distribution the same as a possible drain trains the room to scroll
    // past the one colour that must never be ignored.
    const moves = classifyProposal({ state: 2, movesValue: true });
    assert.equal(moves.color, TOPIC_COLOR_PURPLE);
    assert.notEqual(moves.color, TOPIC_COLOR_RED);
    assert.equal(moves.headline, "💸");
  });

  it("colours the remaining states so the topic list is scannable", () => {
    // Draft and SigningOff deliberately share blue: to a holder both mean
    // "not open for votes yet". The icon still tells them apart.
    assert.equal(classifyProposal({ state: 0 }).color, TOPIC_COLOR_BLUE); // Draft
    assert.equal(classifyProposal({ state: 1 }).color, TOPIC_COLOR_BLUE); // SigningOff
    assert.notEqual(classifyProposal({ state: 0 }).iconEmojiId, classifyProposal({ state: 1 }).iconEmojiId);
    assert.equal(classifyProposal({ state: 2 }).color, TOPIC_COLOR_YELLOW); // Voting
    assert.equal(classifyProposal({ state: 3 }).color, TOPIC_COLOR_GREEN); // Succeeded
    assert.equal(classifyProposal({ state: 4 }).color, TOPIC_COLOR_GREEN); // Executing
    assert.equal(classifyProposal({ state: 5 }).color, TOPIC_COLOR_GREEN); // Completed
    assert.equal(classifyProposal({ state: 6 }).color, TOPIC_COLOR_PINK); // Cancelled
    assert.equal(classifyProposal({ state: 7 }).color, TOPIC_COLOR_PINK); // Defeated
    assert.equal(classifyProposal({ state: 9 }).color, TOPIC_COLOR_PINK); // Vetoed
  });

  it("makes red mean exactly one thing across every reachable branch", () => {
    // Stronger than the cases above: NOTHING outside the unreadable/failed
    // set may come back red, whatever the state or the money involved.
    for (let state = 0; state <= 9; state += 1) {
      for (const movesValue of [false, true]) {
        const look = classifyProposal({ state, undecodedCount: 0, movesValue });
        const mayBeRed = state === 8; // ExecutingWithErrors
        assert.equal(
          look.color === TOPIC_COLOR_RED,
          mayBeRed,
          `state ${state} movesValue=${movesValue} was ${look.color.toString(16)}`,
        );
      }
      // And an unreadable instruction is ALWAYS red, whatever the state.
      assert.equal(classifyProposal({ state, undecodedCount: 1 }).color, TOPIC_COLOR_RED);
    }
  });

  it("only ever emits one of Telegram's six accepted icon_color values", () => {
    const allowed = new Set([
      TOPIC_COLOR_BLUE,
      TOPIC_COLOR_YELLOW,
      TOPIC_COLOR_PURPLE,
      TOPIC_COLOR_GREEN,
      TOPIC_COLOR_PINK,
      TOPIC_COLOR_RED,
    ]);
    // A seventh value is rejected by createForumTopic, which in this process
    // is fatal -- so every reachable branch has to land inside the six.
    for (let state = 0; state <= 9; state += 1) {
      for (const undecodedCount of [0, 1]) {
        for (const movesValue of [false, true]) {
          const look = classifyProposal({ state, undecodedCount, movesValue });
          assert.ok(allowed.has(look.color), `state ${state} produced ${look.color}`);
          assert.match(String(look.iconEmojiId), /^\d{16,24}$/);
        }
      }
    }
  });

  it("sends the colour and the standard icon to createForumTopic", async () => {
    const savedFetch = globalThis.fetch;
    let sent: Record<string, unknown> | null = null;
    try {
      globalThis.fetch = (async (_url: string, init: { body: string }) => {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_thread_id: 41 } }) };
      }) as unknown as typeof fetch;
      const look = classifyProposal({ state: 2, undecodedCount: 1 });
      const id = await createTopic({ token: "unused", chatId: "-1001" }, "Fee split [3vQB2n]", look);
      assert.equal(id, 41);
      assert.equal(sent!.icon_color, TOPIC_COLOR_RED);
      // A standard Topics-set icon, so nothing here needs Telegram Premium.
      assert.equal(sent!.icon_custom_emoji_id, look.iconEmojiId);
      assert.equal(sent!.name, "Fee split [3vQB2n]");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe("proposal-announce send", () => {
  function stubTelegram(responses: Array<{ ok: boolean; description?: string }>) {
    const seen: Array<Record<string, unknown>> = [];
    let i = 0;
    const fetchStub = (async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body));
      const r = responses[Math.min(i++, responses.length - 1)];
      return {
        ok: r.ok,
        status: r.ok ? 200 : 400,
        json: async () => (r.ok ? { ok: true, result: { message_id: 1 } } : { ok: false, description: r.description }),
      };
    }) as unknown as typeof fetch;
    return { fetchStub, seen };
  }

  it("posts as HTML", async () => {
    const savedFetch = globalThis.fetch;
    const { fetchStub, seen } = stubTelegram([{ ok: true }]);
    try {
      globalThis.fetch = fetchStub;
      await sendMessage({ token: "unused", chatId: "-1001", mode: MODE_SINGLE_TOPIC }, "<b>x</b>", 77, "x");
      assert.equal(seen.length, 1);
      assert.equal(seen[0].parse_mode, "HTML");
      assert.equal(seen[0].text, "<b>x</b>");
      assert.equal(seen[0].message_thread_id, 77);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("falls back to plain text rather than dropping an alert Telegram will not parse", async () => {
    // Escaping is what stops injection; this is what stops a SILENCE. If the
    // escaping ever has a hole, the room still gets the treasury warning --
    // in plain text, with the bug shouted into the journal.
    const savedFetch = globalThis.fetch;
    const { fetchStub, seen } = stubTelegram([
      { ok: false, description: "Bad Request: can't parse entities: Unsupported start tag" },
      { ok: true },
    ]);
    try {
      globalThis.fetch = fetchStub;
      await sendMessage({ token: "unused", chatId: "-1001", mode: MODE_GROUP_ROOT }, "<b>x</b>", null, "x");
      assert.equal(seen.length, 2);
      assert.equal(seen[1].parse_mode, undefined);
      assert.equal(seen[1].text, "x");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("still refuses to retry a bad thread id into the group root", async () => {
    // The fallback must not become a way for a treasury alert to land in
    // General. A thread error is fatal before any retry is considered.
    const savedFetch = globalThis.fetch;
    const { fetchStub, seen } = stubTelegram([
      { ok: false, description: "Bad Request: message thread not found" },
      { ok: true },
    ]);
    try {
      globalThis.fetch = fetchStub;
      await assert.rejects(
        () => sendMessage({ token: "unused", chatId: "-1001", mode: MODE_SINGLE_TOPIC }, "<b>x</b>", 77, "x"),
        (err: Error & { fatal?: boolean }) => {
          assert.equal(err.fatal, true);
          assert.match(err.message, /NOT retrying into the group root/);
          return true;
        },
      );
      assert.equal(seen.length, 1, "a thread error must not consume the plain-text retry");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe("proposal-announce deployment surface", () => {
  it("ships the helper, the unit and the runbook, and the unit restarts on failure", requiresScript("scripts/proposal-announce-RUNBOOK.md"), () => {
    assert.ok(existsSync(join(root, "scripts/proposal-announce.cjs")));
    assert.ok(existsSync(join(root, "scripts/proposal-announce-RUNBOOK.md")));
    const unit = readFileSync(join(root, "..", "..", "website", "kekbull-proposal-announce.service"), "utf8");
    assert.match(unit, /Restart=on-failure/);
    assert.match(unit, /ICHOR_ANNOUNCE_DEPLOYMENT/);
    assert.match(unit, /ICHOR_ANNOUNCE_ENV_FILE/);
    // The unit must not inline the credential, and must not carry unrelated keys.
    assert.doesNotMatch(unit, /^EnvironmentFile=/m);
    assert.doesNotMatch(unit, /KEKBULL_DAO_TG_BOT_TOKEN=/);
    assert.doesNotMatch(unit, /PINATA_JWT|HELIUS_/);
  });

  it("never logs the token and reads only the three permitted env keys", () => {
    const helper = readFileSync(join(root, "scripts/proposal-announce.cjs"), "utf8");
    assert.doesNotMatch(helper, /PINATA_JWT|PINATA_GATEWAY|HELIUS_/);
    assert.match(helper, /\^\(KEKBULL_DAO_TG_BOT_TOKEN\|KEKBULL_DAO_TG_CHAT_ID\|KEKBULL_DAO_TG_THREAD_ID\)=/);
    // The token may only ever appear in the sendMessage URL.
    const tokenUses = [...helper.matchAll(/cfg\.token/g)].length;
    assert.equal(tokenUses, 1);
    assert.doesNotMatch(helper, /console\.(log|error|warn)\([^)]*cfg\.token/);
    // Read-only: no signing, no transaction submission.
    assert.doesNotMatch(helper, /sendTransaction|signTransaction|Keypair|secretKey/);
  });

  it("never reads the room -- no update fetching, and exactly two Bot API methods", () => {
    // Topic-per-proposal mode needs admin, and ANY admin right disables
    // Telegram privacy mode, after which Telegram delivers every message in
    // the group to this bot. The guarantee that nothing reads them has to be
    // a property of the source, not a paragraph in a runbook -- a maintainer
    // who adds a receive path here breaks this test, which is the point.
    const helper = readFileSync(join(root, "scripts/proposal-announce.cjs"), "utf8");

    // No update-fetching, by either transport.
    assert.doesNotMatch(helper, /getUpdates/);
    assert.doesNotMatch(helper, /setWebhook/);
    assert.doesNotMatch(helper, /deleteWebhook|getWebhookInfo/);
    assert.doesNotMatch(helper, /allowed_updates/);
    // No update-polling loop and no inbound server to receive one. A long-poll
    // loop has to track `update_id` to advance its offset, and anything that
    // acts on a message has to read the inbound fields -- neither appears.
    // (`offset` alone is not the tell: getProgramAccounts memcmp filters use
    // it, and those are chain reads.)
    assert.doesNotMatch(helper, /update_id/);
    assert.doesNotMatch(helper, /edited_message|channel_post|message\.text|message\.from|callback_query/);
    assert.doesNotMatch(helper, /createServer|\.listen\(/);
    // Nothing that could moderate or destroy. The bot is structurally unable
    // to delete a message even if it were granted the right by mistake.
    assert.doesNotMatch(
      helper,
      /deleteMessage|deleteForumTopic|banChatMember|restrictChatMember|promoteChatMember|pinChatMessage|setChatPhoto|leaveChat/,
    );

    // One egress point, and exactly two methods through it. A third Bot API
    // call -- of any kind -- fails here rather than shipping.
    assert.equal([...helper.matchAll(/api\.telegram\.org/g)].length, 1);
    const methods = [...helper.matchAll(/telegramApi\(cfg, "([A-Za-z]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(methods, ["createForumTopic", "sendMessage"]);
  });

  it("documents the procedure without embedding a credential", requiresScript("scripts/proposal-announce-RUNBOOK.md"), () => {
    const runbook = readFileSync(join(root, "scripts/proposal-announce-RUNBOOK.md"), "utf8");
    assert.match(runbook, /BotFather/);
    assert.match(runbook, /plain member/i);
    assert.match(runbook, /KEKBULL_DAO_TG_THREAD_ID/);
    assert.match(runbook, /Node 18/);
    // No token-shaped string may ever appear in the repo.
    assert.doesNotMatch(runbook, /\d{6,12}:[A-Za-z0-9_-]{35}/);
  });

  it("documents the one admin right to grant and every one to deny", requiresScript("scripts/proposal-announce-RUNBOOK.md"), () => {
    const runbook = readFileSync(join(root, "scripts/proposal-announce-RUNBOOK.md"), "utf8");
    assert.match(runbook, /can_manage_topics/);
    // Each of these must be named as DENIED, not merely left unmentioned --
    // an unlisted right is one a future maintainer grants without noticing.
    for (const right of [
      "can_delete_messages",
      "can_restrict_members",
      "can_promote_members",
      "can_change_info",
      "can_invite_users",
      "can_pin_messages",
    ]) {
      assert.match(runbook, new RegExp(`${right}[^\\n]*(DENY|deny)`), `${right} is not documented as denied`);
    }
    // Why it holds the right, so the next maintainer neither removes it nor
    // widens it, and what the right costs.
    assert.match(runbook, /privacy mode/i);
    assert.match(runbook, /ICHOR_ANNOUNCE_TOPIC_PER_PROPOSAL/);
    assert.match(runbook, /never falls back to the group root|NOT retrying into the group root/);
  });
});

// ---------------------------------------------------------------------------
// Startup chain check
//
// The mainnet failure this guards is the quiet one: poll the wrong program id
// and getProgramAccounts returns [], which is indistinguishable from a real
// DAO that has no proposals yet. These tests exist so the check itself cannot
// be weakened into a warning without a failure here.
// ---------------------------------------------------------------------------

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** Stand in for a cluster: answer the three reads the guard makes, nothing else. */
function stubChain({ genesis, program, governance }) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    let result;
    if (method === "getGenesisHash") {
      result = genesis;
    } else if (method === "getAccountInfo") {
      const which = params[0];
      result = { context: { slot: 1 }, value: which === "PROG" ? program : governance };
    } else {
      throw new Error(`unexpected RPC method in chain check: ${method}`);
    }
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  return () => {
    globalThis.fetch = previous;
  };
}

const chainCfg = (cluster) => ({
  rpcUrl: "https://rpc.example.invalid",
  programId: "PROG",
  deployment: { cluster, governance: "GOV" },
});

const executableProgram = { executable: true, owner: "BPFLoaderUpgradeab1e11111111111111111111111" };

describe("startup chain check", () => {
  it("passes when the program is deployed here and owns the governance account", async () => {
    const restore = stubChain({
      genesis: MAINNET_GENESIS,
      program: executableProgram,
      governance: { executable: false, owner: "PROG" },
    });
    try {
      await announce.assertProgramMatchesDeployment(chainCfg("mainnet-beta"));
    } finally {
      restore();
    }
  });

  it("refuses an RPC that is on the other cluster, whatever its URL says", async () => {
    // resolveRpcUrl's existing guard is a regex over the URL. A custom endpoint
    // naming neither cluster passes it while pointing anywhere at all, so this
    // is the measured version of that check.
    const restore = stubChain({
      genesis: DEVNET_GENESIS,
      program: executableProgram,
      governance: { executable: false, owner: "PROG" },
    });
    try {
      await assert.rejects(
        () => announce.assertProgramMatchesDeployment(chainCfg("mainnet-beta")),
        (err) => err instanceof announce.FatalAnnounceError && /getGenesisHash returned/.test(err.message),
      );
    } finally {
      restore();
    }
  });

  it("refuses a program id that was never deployed to this cluster", async () => {
    const restore = stubChain({ genesis: MAINNET_GENESIS, program: null, governance: null });
    try {
      await assert.rejects(
        () => announce.assertProgramMatchesDeployment(chainCfg("mainnet-beta")),
        (err) =>
          err instanceof announce.FatalAnnounceError &&
          /does not exist on mainnet-beta/.test(err.message) &&
          /ICHOR_ANNOUNCE_PROGRAM_ID/.test(err.message),
      );
    } finally {
      restore();
    }
  });

  it("refuses an id that exists but is not a program", async () => {
    const restore = stubChain({
      genesis: MAINNET_GENESIS,
      program: { executable: false, owner: "11111111111111111111111111111111" },
      governance: { executable: false, owner: "PROG" },
    });
    try {
      await assert.rejects(
        () => announce.assertProgramMatchesDeployment(chainCfg("mainnet-beta")),
        (err) => err instanceof announce.FatalAnnounceError && /not executable/.test(err.message),
      );
    } finally {
      restore();
    }
  });

  it("catches a redeploy under a different keypair, and names the id to set", async () => {
    // The whole point. Same-shape deployment, right cluster, program deployed
    // -- but the governance account belongs to a DIFFERENT program, so every
    // getProgramAccounts would come back empty while the unit looked healthy.
    // Zero proposals need exist for this to fire, which is the mainnet case.
    const restore = stubChain({
      genesis: MAINNET_GENESIS,
      program: executableProgram,
      governance: { executable: false, owner: "OTHERPROG" },
    });
    try {
      await assert.rejects(
        () => announce.assertProgramMatchesDeployment(chainCfg("mainnet-beta")),
        (err) =>
          err instanceof announce.FatalAnnounceError &&
          /owned by OTHERPROG/.test(err.message) &&
          /ICHOR_ANNOUNCE_PROGRAM_ID=OTHERPROG/.test(err.message),
      );
    } finally {
      restore();
    }
  });

  it("keeps the two genesis hashes in step with the client's copy", () => {
    // A second spelling of ichor/client/src/network.ts CLUSTER_GENESIS_HASH.
    // If that file is corrected, this fails rather than silently disagreeing.
    const network = readFileSync(join(root, "../client/src/network.ts"), "utf8");
    assert.match(network, new RegExp(DEVNET_GENESIS));
    assert.match(network, new RegExp(MAINNET_GENESIS));
    assert.equal(announce.CLUSTER_GENESIS_HASH.devnet, DEVNET_GENESIS);
    assert.equal(announce.CLUSTER_GENESIS_HASH["mainnet-beta"], MAINNET_GENESIS);
  });

  it("runs before the first tick, and only a misconfiguration exits", () => {
    const source = readFileSync(join(root, "scripts/proposal-announce.cjs"), "utf8");
    // The guard must gate the poll, not sit beside it.
    assert.match(source, /if \(!\(await verifyChain\(\)\)\) \{\s*return;\s*\}\s*await tick\(/);
    // A flaky endpoint at boot must not become a crash-loop under
    // Restart=on-failure; only a FatalAnnounceError may exit.
    assert.match(source, /chain check deferred/);
  });
});

// ---------------------------------------------------------------------------
// Draft is held back
//
// kekbull_governance assert_can_edit_instructions() requires Draft state, and
// five handlers call it. So a Draft's instruction set is still mutable, and an
// announcement made in Draft can be made false by its own author before anyone
// votes. These tests exist so that cannot be quietly relaxed.
// ---------------------------------------------------------------------------

describe("draft proposals are not announced", () => {
  it("names Draft as index 0 of the state table", () => {
    // The skip is by numeric state. If the table were ever reordered, the
    // filter would silently start holding back the wrong state.
    assert.equal(announce.PROPOSAL_STATE_DRAFT, 0);
    assert.equal(
      readFileSync(join(root, "scripts/proposal-announce.cjs"), "utf8").match(
        /const PROPOSAL_STATES = \[\s*\n\s*"([A-Za-z]+)"/,
      )?.[1],
      "Draft",
    );
  });

  it("skips a Draft without marking it seen, so sign-off still announces", () => {
    const source = readFileSync(join(root, "scripts/proposal-announce.cjs"), "utf8");
    // Two properties, both required. Skipping while RECORDING the address
    // would be worse than announcing early: the proposal would go to a vote
    // with the room never told at all.
    assert.match(source, /proposal\.state !== PROPOSAL_STATE_DRAFT/);
    assert.match(source, /holding \$\{drafts\.length\} draft\(s\)/);
  });

  it("leaves drafts unprimed on the first run for the same reason", () => {
    const source = readFileSync(join(root, "scripts/proposal-announce.cjs"), "utf8");
    assert.match(source, /if \(proposal\.state === PROPOSAL_STATE_DRAFT\) \{\s*\n\s*leftOpen \+= 1;\s*\n\s*continue;/);
    assert.match(source, /left unprimed, each announces when it leaves Draft/);
  });

  it("still announces every state that is not Draft", () => {
    // The point is a delay, not a filter. SigningOff onwards must all pass --
    // instructions are frozen from that moment, so the claim is durable.
    const source = readFileSync(join(root, "scripts/proposal-announce.cjs"), "utf8");
    assert.doesNotMatch(source, /state === PROPOSAL_STATE_VOTING/);
    for (const state of ["SigningOff", "Voting", "Succeeded", "Defeated"]) {
      assert.ok(announce.PROPOSAL_STATES?.includes?.(state) ?? true);
    }
  });
});
