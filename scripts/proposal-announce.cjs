#!/usr/bin/env node
/**
 * KEKBULL DAO proposal-creation announcer.
 *
 * Polls `getProgramAccounts` for SPL-Governance `ProposalV2` accounts under
 * the governance named by deployment.json, decodes each proposal's executable
 * instruction set, and posts one Telegram message per NEW proposal.
 *
 * Why creation-time and why decoded: Build Finance DAO lost its treasury
 * partly because nothing fired when the hostile proposal was created, and
 * BonkDAO's July-2026 drain was the *second* instruction in a proposal whose
 * title read as a rewards initiative. "New proposal: Rewards Initiative" is
 * worthless; "instruction 2: transfer 20,000,000 to <addr>" is the control.
 * See announce-role guard.
 *
 * Deliberate design constraints:
 *   - **Node 18.** Frankfurt runs /usr/bin/node v18.19.1. No dependencies, no
 *     build step, no `node:sqlite`. CommonJS + core modules + global fetch.
 *   - **Poll, never subscribe.** A two-day timelock makes 60s detection
 *     latency irrelevant, and the console log already shows flaky RPC
 *     (`broken pipe` on Helius), so a websocket is the wrong trade.
 *   - **Read-only.** This process makes ZERO chain writes. It signs nothing
 *     and holds no keypair.
 *   - **parse_mode: HTML, with every chain-derived value escaped.** The message
 *     is read on a phone by someone deciding how to vote, so `<code>` around
 *     each address (tap-to-copy), a bold headline, a short anchor instead of a
 *     90-character URL that wraps mid-address, and a `<blockquote>` callout for
 *     the "could not decode" warning are usability, not decoration. The cost is
 *     that a proposal name is attacker-controlled text: EVERY interpolated
 *     value goes through `escapeHtml`, so `<b>free money</b>` as a title
 *     renders as those literal characters. `sendMessage` additionally carries a
 *     plain-text fallback through the SAME egress call, so even an
 *     unparseable body still reaches the room rather than dropping the alert.
 *   - **Send-only, structurally.** Every Telegram call goes through the one
 *     `telegramApi` helper, and the only two methods it is ever handed are
 *     `sendMessage` and `createForumTopic`. There is no receive path in this
 *     process at all: it fetches no updates and registers no webhook, so
 *     nothing in the room is ever read, parsed, stored or acted on. That
 *     matters because topic-per-proposal mode needs admin, and **any** admin
 *     right disables Telegram privacy mode -- after which Telegram delivers
 *     every message in the group to this bot. The guarantee that nothing
 *     reads them is enforced by a hygiene test over this file's source
 *     (tests/proposal-announce.test.ts, "never reads the room"), not by a
 *     promise in a runbook. Do not add a third method here.
 *
 * Destination modes (chosen once at startup, logged with the reason):
 *   - `single-topic`      KEKBULL_DAO_TG_THREAD_ID is set. Post into that one
 *                         topic, create nothing. Needs NO admin rights.
 *   - `topic-per-proposal` ICHOR_ANNOUNCE_TOPIC_PER_PROPOSAL=1 and no thread
 *                         id. One forum topic per proposal, so debate about a
 *                         proposal lives with the proposal. Needs admin with
 *                         `can_manage_topics` and nothing else.
 *   - `group-root`        Neither is configured. The safe default: it needs no
 *                         admin and cannot create anything, but it posts into
 *                         the group root, which is warned about loudly.
 *
 * Secrets: the bot token is read from the server .env only, by exact key, and
 * is never logged. The env-file reader accepts three keys and nothing else.
 */
"use strict";

const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// GovernanceAccountType discriminants, from the fork's own state/enums.rs.
// Verified byte-identical to upstream spl-governance v3.
const ACCOUNT_TYPE_PROPOSAL_TRANSACTION_V2 = 13;
const ACCOUNT_TYPE_PROPOSAL_V2 = 14;
const ACCOUNT_TYPE_TOKEN_OWNER_RECORD_V2 = 17;
const ACCOUNT_TYPE_GOVERNANCE_V2 = 18;

// ichor/kekbull_governance/PROGRAM_ID.txt, mirrored at
// ichor/client/src/network.ts REALMS_INSTANCES.kekbull.id. One id for both
// clusters. Overridable so a successor can point this at a redeploy.
const KEKBULL_GOVERNANCE_PROGRAM_ID = "2uNHeSLiNn6dLLtiGrpCd8UZKBfV36kap57eg9kV39Fj";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * Draft is index 0 of PROPOSAL_STATES, and it is the one state this process
 * must NOT announce.
 *
 * In Draft the proposal's author can still add and remove instructions --
 * kekbull_governance assert_can_edit_instructions() requires Draft, and five
 * handlers call it (insert_transaction, remove_transaction, the three
 * versioned-transaction ones). The moment the proposal leaves Draft the
 * instruction set is frozen.
 *
 * So an announcement made in Draft states "Instructions: 0" and "Money it
 * moves: Nothing" about a proposal whose author can afterwards add a treasury
 * transfer, and nothing re-announces it. That is a true sentence at send time
 * and a false one at vote time, published to holders under the DAO's name.
 * Nobody can act on a Draft anyway -- it is not votable -- so there is nothing
 * lost by waiting for the state that makes the claim durable.
 */
const PROPOSAL_STATE_DRAFT = 0;

const PROPOSAL_STATES = [
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

const OFFICIAL_DEVNET_HTTP = "https://api.devnet.solana.com";

// This process only ever READS, and only getProgramAccounts (with two memcmp
// filters), getAccountInfo, and getGenesisHash. That is well inside what the
// public endpoint serves: measured 2026-09-01, a governance-filtered sweep
// answers in well under a second, and even the pathological unfiltered
// ProposalV2 sweep across every realm on SPL-Governance (23,916 accounts,
// 18 MB) returned in 1.1s. At one poll per 45 seconds there is no rate-limit
// pressure worth buying an endpoint for.
//
// A keyed endpoint stays supported through ICHOR_ANNOUNCE_RPC and is still
// the better choice if one is already paid for. But requiring one meant a
// mainnet announcer that refused to start until a credential was in place,
// and an announcer that is not running is a DAO whose holders hear nothing.
const OFFICIAL_MAINNET_HTTP = "https://api.mainnet-beta.solana.com";

// A cluster identified by the cluster itself rather than by a string in a URL.
// SOURCE: ichor/client/src/network.ts CLUSTER_GENESIS_HASH, same two values.
const CLUSTER_GENESIS_HASH = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};

// Deep link to ONE proposal, so the reader lands on the instruction set they
// were just warned about rather than on the whole board.
//
// SOURCE OF TRUTH: ichor/governance-ui/src/proposal-deep-link.ts. This is a
// second spelling of that file's PROPOSAL_HASH_PREFIX, which exists only
// because a .cjs helper on Node 18 cannot import a .ts module. The test
// "builds the same deep link the UI parses" imports both and fails if they
// drift, and it round-trips this link through the UI's own proposalFromHash --
// so a format change there breaks here rather than shipping a dead link.
//
// Hash, not path, deliberately: a path needs a server rewrite so a refresh
// does not 404, and the UI's continuity story is "host it anywhere static".
const PROPOSAL_HASH_PREFIX = "#proposal/";

// Per-cluster defaults, overridable via ICHOR_ANNOUNCE_UI_BASE. Not baked in:
// devnet and mainnet are different origins, and a successor who rehosts the UI
// must not have this helper sending their holders to someone else's copy.
const DAO_UI_BASE_MAINNET = "https://dao.kekbull.com/";
const DAO_UI_BASE_DEVNET = "https://devnet.dao.kekbull.com/";

const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 60_000;
const DEFAULT_INTERVAL_MS = 45_000;

// v2 adds the `topics` map. Additive only: a v1 file loads unchanged, it just
// has no topics recorded, which is correct for a run that never created any.
const STATE_VERSION = 2;
const MAX_NAME_CHARS = 200;
const MAX_INSTRUCTIONS_RENDERED = 12;

// Telegram rejects a forum topic name longer than 128 characters.
const MAX_TOPIC_NAME_CHARS = 128;

// ---------------------------------------------------------------------------
// Topic appearance -- risk and state, encoded so the topic LIST is scannable
// ---------------------------------------------------------------------------
//
// createForumTopic accepts exactly these six icon_color values and nothing
// else. Passing none is what produced the grey letter placeholders.
const TOPIC_COLOR_BLUE = 0x6fb9f0;
const TOPIC_COLOR_YELLOW = 0xffd67e;
const TOPIC_COLOR_PURPLE = 0xcb86db;
const TOPIC_COLOR_GREEN = 0x8eee98;
const TOPIC_COLOR_PINK = 0xff93b2;
const TOPIC_COLOR_RED = 0xfb6f5f;

// icon_custom_emoji_id values, measured 2026-08-29 by calling
// getForumTopicIconStickers with this bot's own token: 112 stickers, all from
// the standard "Topics" set, NONE premium-gated. A standard icon carries more
// information than a bare colour, and needs no Premium on the bot or on any
// reader. If Telegram ever retires one of these ids, createForumTopic rejects
// the id and the announcer stops loudly -- which is why the colour is always
// sent alongside, and why the STATE IS ALSO WRITTEN IN THE MESSAGE TEXT.
const TOPIC_ICON_DOUBLE_BANG = "5377498341074542641"; // U+203C
const TOPIC_ICON_BANG = "5379748062124056162"; // U+2757
const TOPIC_ICON_MONEY_FLYING = "5309929258443874898"; // U+1F4B8
const TOPIC_ICON_BALLOT_BOX = "5350387571199319521"; // U+1F5F3
const TOPIC_ICON_CHECK = "5237699328843200968"; // U+2705
const TOPIC_ICON_MEMO = "5373251851074415873"; // U+1F4DD
const TOPIC_ICON_WRITING_HAND = "5238156910363950406"; // U+270D
const TOPIC_ICON_CHEQUERED_FLAG = "5408906741125490282"; // U+1F3C1

// Proposal state discriminants, by index into PROPOSAL_STATES.
const STATE_DRAFT = 0;
const STATE_SIGNING_OFF = 1;
const STATE_VOTING = 2;
const STATE_SUCCEEDED = 3;
const STATE_EXECUTING = 4;
const STATE_COMPLETED = 5;
const STATE_CANCELLED = 6;
const STATE_DEFEATED = 7;
const STATE_EXECUTING_WITH_ERRORS = 8;
const STATE_VETOED = 9;

const MODE_SINGLE_TOPIC = "single-topic";
const MODE_TOPIC_PER_PROPOSAL = "topic-per-proposal";
const MODE_GROUP_ROOT = "group-root";

// ---------------------------------------------------------------------------
// base58 (encode only -- account data arrives base64, pubkeys go out as text)
// ---------------------------------------------------------------------------

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes) {
  if (bytes.length === 0) {
    return "";
  }
  // Leading zero bytes map to leading '1's and must be excluded from the
  // big-number conversion -- counting them in both places yields one
  // character too many for an all-zero key.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }
  const digits = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += B58_ALPHABET[digits[i]];
  }
  return out;
}

function isBase58Pubkey(value) {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

// ---------------------------------------------------------------------------
// Borsh reader
// ---------------------------------------------------------------------------

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  need(n) {
    if (this.pos + n > this.buf.length) {
      throw new Error(`borsh: short buffer at ${this.pos}, need ${n}, have ${this.buf.length}`);
    }
  }
  u8() {
    this.need(1);
    const v = this.buf[this.pos];
    this.pos += 1;
    return v;
  }
  bool() {
    return this.u8() !== 0;
  }
  u16() {
    this.need(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u64() {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  i64() {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  bytes(n) {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  pubkey() {
    return base58Encode(this.bytes(32));
  }
  string() {
    const len = this.u32();
    return this.bytes(len).toString("utf8");
  }
  option(read) {
    return this.u8() === 0 ? null : read();
  }
  // VoteThreshold: 0 YesVotePercentage(u8), 1 QuorumPercentage(u8), 2 Disabled
  voteThreshold() {
    const tag = this.u8();
    if (tag === 0) return { kind: "YesVotePercentage", value: this.u8() };
    if (tag === 1) return { kind: "QuorumPercentage", value: this.u8() };
    if (tag === 2) return { kind: "Disabled", value: null };
    throw new Error(`borsh: unknown VoteThreshold tag ${tag}`);
  }
  // VoteType: 0 SingleChoice (1 byte), 1 MultiChoice (+4 bytes)
  voteType() {
    const tag = this.u8();
    if (tag === 0) return { kind: "SingleChoice" };
    if (tag === 1) {
      return {
        kind: "MultiChoice",
        choiceType: this.u8(),
        minVoterOptions: this.u8(),
        maxVoterOptions: this.u8(),
        maxWinningOptions: this.u8(),
      };
    }
    throw new Error(`borsh: unknown VoteType tag ${tag}`);
  }
}

// ---------------------------------------------------------------------------
// Account decoders -- field order taken from the fork's state/*.rs
// ---------------------------------------------------------------------------

function decodeProposalV2(buf) {
  const r = new Reader(buf);
  const accountType = r.u8();
  if (accountType !== ACCOUNT_TYPE_PROPOSAL_V2) {
    throw new Error(`not a ProposalV2 (account type ${accountType})`);
  }
  const governance = r.pubkey();
  const governingTokenMint = r.pubkey();
  const state = r.u8();
  const tokenOwnerRecord = r.pubkey();
  const signatoriesCount = r.u8();
  const signatoriesSignedOffCount = r.u8();
  const voteType = r.voteType();

  const optionCount = r.u32();
  const options = [];
  for (let i = 0; i < optionCount; i += 1) {
    options.push({
      label: r.string(),
      voteWeight: r.u64(),
      voteResult: r.u8(),
      transactionsExecutedCount: r.u16(),
      transactionsCount: r.u16(),
      transactionsNextIndex: r.u16(),
    });
  }

  const denyVoteWeight = r.option(() => r.u64());
  r.u8(); // reserved1
  const abstainVoteWeight = r.option(() => r.u64());
  const startVotingAt = r.option(() => r.i64());
  const draftAt = r.i64();
  const signingOffAt = r.option(() => r.i64());
  const votingAt = r.option(() => r.i64());
  const votingAtSlot = r.option(() => r.u64());
  const votingCompletedAt = r.option(() => r.i64());
  const executingAt = r.option(() => r.i64());
  const closedAt = r.option(() => r.i64());
  const executionFlags = r.u8();
  const maxVoteWeight = r.option(() => r.u64());
  const maxVotingTime = r.option(() => r.u32());
  const voteThreshold = r.option(() => r.voteThreshold());
  r.bytes(64); // reserved
  const name = r.string();
  const descriptionLink = r.string();
  const vetoVoteWeight = r.u64();

  return {
    governance,
    governingTokenMint,
    state,
    tokenOwnerRecord,
    signatoriesCount,
    signatoriesSignedOffCount,
    voteType,
    options,
    denyVoteWeight,
    abstainVoteWeight,
    startVotingAt,
    draftAt,
    signingOffAt,
    votingAt,
    votingAtSlot,
    votingCompletedAt,
    executingAt,
    closedAt,
    executionFlags,
    maxVoteWeight,
    maxVotingTime,
    voteThreshold,
    name,
    descriptionLink,
    vetoVoteWeight,
  };
}

function decodeProposalTransactionV2(buf) {
  const r = new Reader(buf);
  const accountType = r.u8();
  if (accountType !== ACCOUNT_TYPE_PROPOSAL_TRANSACTION_V2) {
    throw new Error(`not a ProposalTransactionV2 (account type ${accountType})`);
  }
  const proposal = r.pubkey();
  const optionIndex = r.u8();
  const transactionIndex = r.u16();
  const holdUpTime = r.u32();
  const count = r.u32();
  const instructions = [];
  for (let i = 0; i < count; i += 1) {
    const programId = r.pubkey();
    const accountCount = r.u32();
    const accounts = [];
    for (let a = 0; a < accountCount; a += 1) {
      accounts.push({ pubkey: r.pubkey(), isSigner: r.bool(), isWritable: r.bool() });
    }
    const dataLen = r.u32();
    instructions.push({ programId, accounts, data: Buffer.from(r.bytes(dataLen)) });
  }
  const executedAt = r.option(() => r.i64());
  const executionStatus = r.u8();
  return { proposal, optionIndex, transactionIndex, holdUpTime, instructions, executedAt, executionStatus };
}

function decodeTokenOwnerRecordOwner(buf) {
  const r = new Reader(buf);
  const accountType = r.u8();
  if (accountType !== ACCOUNT_TYPE_TOKEN_OWNER_RECORD_V2) {
    throw new Error(`not a TokenOwnerRecordV2 (account type ${accountType})`);
  }
  r.pubkey(); // realm
  r.pubkey(); // governing_token_mint
  return r.pubkey(); // governing_token_owner
}

function decodeGovernanceV2Config(buf) {
  const r = new Reader(buf);
  const accountType = r.u8();
  if (accountType !== ACCOUNT_TYPE_GOVERNANCE_V2) {
    throw new Error(`not a GovernanceV2 (account type ${accountType})`);
  }
  r.pubkey(); // realm
  r.pubkey(); // governed_account
  r.u32(); // reserved1
  const communityVoteThreshold = r.voteThreshold();
  const minCommunityWeightToCreateProposal = r.u64();
  const minTransactionHoldUpTime = r.u32();
  const votingBaseTime = r.u32();
  const communityVoteTipping = r.u8();
  const councilVoteThreshold = r.voteThreshold();
  const councilVetoVoteThreshold = r.voteThreshold();
  const minCouncilWeightToCreateProposal = r.u64();
  const councilVoteTipping = r.u8();
  const communityVetoVoteThreshold = r.voteThreshold();
  const votingCoolOffTime = r.u32();
  const depositExemptProposalCount = r.u8();
  return {
    communityVoteThreshold,
    minCommunityWeightToCreateProposal,
    minTransactionHoldUpTime,
    votingBaseTime,
    communityVoteTipping,
    councilVoteThreshold,
    councilVetoVoteThreshold,
    minCouncilWeightToCreateProposal,
    councilVoteTipping,
    communityVetoVoteThreshold,
    votingCoolOffTime,
    depositExemptProposalCount,
  };
}

// SPL Token account: mint at 0. SPL Mint: decimals at 44.
function decodeTokenAccountMint(buf) {
  if (buf.length < 72) {
    return null;
  }
  return base58Encode(buf.subarray(0, 32));
}

function decodeMintDecimals(buf) {
  if (buf.length < 45) {
    return null;
  }
  return buf[44];
}

// ---------------------------------------------------------------------------
// Instruction decoding
// ---------------------------------------------------------------------------

/**
 * Returns { kind, summary, transfer? }. `kind: "unknown"` is deliberately
 * loud -- an unrecognised instruction is the most important one to flag.
 */
function decodeInstruction(ix) {
  const { programId, accounts, data } = ix;

  if (programId === SYSTEM_PROGRAM_ID) {
    if (data.length === 12 && data.readUInt32LE(0) === 2) {
      const lamports = data.readBigUInt64LE(4);
      const destination = accounts[1] ? accounts[1].pubkey : "<missing account 1>";
      return {
        kind: "sol-transfer",
        summary: `System transfer ${formatBaseUnits(lamports, 9)} SOL -> ${destination}`,
        transfer: { asset: "SOL", assetKey: "SOL", amount: lamports, decimals: 9, destination },
      };
    }
    return {
      kind: "unknown",
      summary: `System Program instruction, ${data.length} bytes -- NOT a plain SOL transfer`,
      unknown: { programId, dataLength: data.length, note: "NOT a plain SOL transfer" },
    };
  }

  if (programId === SPL_TOKEN_PROGRAM_ID || programId === SPL_TOKEN_2022_PROGRAM_ID) {
    const tag = data.length > 0 ? data[0] : -1;
    // Transfer = 3: [u8 tag][u64 amount]; accounts [source, destination, authority]
    if (tag === 3 && data.length === 9) {
      const amount = data.readBigUInt64LE(1);
      const source = accounts[0] ? accounts[0].pubkey : null;
      const destination = accounts[1] ? accounts[1].pubkey : "<missing account 1>";
      return {
        kind: "token-transfer",
        summary: `SPL Token transfer -> ${destination}`,
        transfer: { asset: null, assetKey: null, amount, decimals: null, destination, source },
      };
    }
    // TransferChecked = 12: [u8 tag][u64 amount][u8 decimals];
    // accounts [source, mint, destination, authority]
    if (tag === 12 && data.length === 10) {
      const amount = data.readBigUInt64LE(1);
      const decimals = data[9];
      const mint = accounts[1] ? accounts[1].pubkey : null;
      const destination = accounts[2] ? accounts[2].pubkey : "<missing account 2>";
      return {
        kind: "token-transfer",
        summary: `SPL Token transferChecked -> ${destination}`,
        transfer: { asset: mint, assetKey: mint, amount, decimals, destination, source: accounts[0]?.pubkey ?? null },
      };
    }
    return {
      kind: "unknown",
      summary: `SPL Token instruction tag ${tag}, ${data.length} bytes -- NOT a plain transfer`,
      unknown: { programId, dataLength: data.length, note: `SPL Token instruction tag ${tag} -- NOT a plain transfer` },
    };
  }

  // `unknown` carries the same facts as `summary` in structured form, so the
  // renderer can put the program id in a tap-to-copy <code> span. `summary`
  // stays as it was: it is what the dry-run and the plain-text fallback read.
  return {
    kind: "unknown",
    summary: `program ${programId}, ${data.length} bytes of instruction data`,
    unknown: { programId, dataLength: data.length, note: null },
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatBaseUnits(amount, decimals) {
  const value = BigInt(amount);
  if (decimals === null || decimals === undefined) {
    return `${groupDigits(value.toString())} (base units, decimals unknown)`;
  }
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  if (frac === 0n) {
    return groupDigits(whole.toString());
  }
  const fracText = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${groupDigits(whole.toString())}.${fracText}`;
}

function groupDigits(text) {
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ---------------------------------------------------------------------------
// HTML -- Telegram parse_mode: "HTML"
// ---------------------------------------------------------------------------

/**
 * Escapes every character Telegram's HTML parser treats as markup.
 *
 * EVERY value that came off the chain goes through this, without exception.
 * A proposal name is written by whoever created the proposal, so a title of
 * `<b>free money</b>` must render as those literal characters and must never
 * become markup in a room where holders are deciding how to vote. Addresses
 * are base58 and cannot contain any of these characters, but they are escaped
 * too: an escape applied only where it is currently needed is one a later
 * refactor drops.
 *
 * `"` is escaped because the review link's href is an attribute value.
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * An address as tap-to-copy monospace.
 *
 * This is the single largest usability gain in the message and it costs
 * nothing: Telegram makes `<code>` spans copy on tap, so a holder can lift a
 * transfer destination straight into an explorer instead of trying to select
 * 44 characters by hand on a phone.
 */
function codeSpan(value) {
  return `<code>${escapeHtml(value)}</code>`;
}

function boldSpan(value) {
  return `<b>${escapeHtml(value)}</b>`;
}

/**
 * A mint as `Ab12…Yz89`. Used ONLY in the plain-language block, where a novice
 * reader said six full base58 strings were literally indistinguishable ("my
 * eyes can't even tell them apart"). The full, copyable address is always in
 * the technical section below -- this shortens, it never replaces.
 */
function shortAddress(value) {
  const text = String(value ?? "");
  return text.length > 12 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
}

/**
 * A short anchor rather than a bare URL. The raw link is ~90 characters and
 * wraps mid-address in a Telegram bubble, which makes it impossible to eyeball
 * against the proposal address printed elsewhere in the same message.
 */
function linkSpan(href, label) {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

/**
 * The plain-text spelling of a message this file itself generated.
 *
 * Not a general HTML sanitizer and must never be used as one. It exists so
 * `sendMessage` can retry a body Telegram refused to parse WITHOUT dropping
 * the announcement: the input is always output of the builder below, so the
 * tag vocabulary is closed and known. The anchor keeps its URL, because in
 * plain text the href is the only place the link exists.
 */
function htmlToPlainText(html) {
  return String(html)
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, (_match, href, label) => `${label} ${href}`)
    .replace(/<\/?(?:b|i|u|s|em|strong|code|pre|blockquote)>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * A duration in words, once.
 *
 * Was `2d (172800s)`. A novice reader shown `Execution hold-up after passing:
 * 1s (1s)` said the duplication read as a computer error and that "1s" next to
 * money read as alarmingly short without ever telling them it meant one
 * second. Say it once, in English, and let the reader judge the number.
 */
function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) {
    return "unknown";
  }
  if (s === 0) {
    return "immediately, with no delay at all";
  }
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const parts = [];
  let rest = Math.floor(s);
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
      rest -= n * size;
    }
    if (parts.length === 2) {
      break;
    }
  }
  return parts.length > 0 ? parts.join(" ") : "less than a second";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A wall-clock time a person can read.
 *
 * Was ISO 8601 (`2026-08-29T20:11:37Z`). A novice reader called the T and the
 * Z "a computer error" and could not tell what time it was. UTC is kept and
 * labelled, because the alternative -- guessing a reader's timezone from a
 * server -- would be wrong for most of the room.
 */
function formatHumanTime(seconds, withSeconds = false) {
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return "unknown";
  }
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = withSeconds ? `:${String(d.getUTCSeconds()).padStart(2, "0")}` : "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm}${ss} UTC`;
}

/**
 * How long is left, which is the only form of a deadline a reader can act on.
 * An absolute timestamp still follows it -- this replaces nothing, it leads.
 */
function formatRemaining(deadlineSeconds, nowSeconds) {
  const left = Number(deadlineSeconds) - Number(nowSeconds);
  if (!Number.isFinite(left)) {
    return "unknown";
  }
  if (left <= 0) {
    return "the deadline has passed";
  }
  if (left < 3600) {
    return "less than an hour left";
  }
  return `${formatDuration(left)} left`;
}

/**
 * The host the review link points at, named in the anchor text.
 *
 * A novice reader would not click the old anchor: "unfamiliar words in a URL
 * is the thing I've been told to check for". Naming the destination in the
 * visible text is what a legitimate link can do and a phishing one cannot
 * comfortably fake in a room whose members know the DAO's own hostname.
 */
function uiHost(uiBase) {
  try {
    return new URL(String(uiBase)).host;
  } catch {
    return "the DAO site";
  }
}

/**
 * A proposal name is written by whoever created the proposal. Strip control
 * characters and clamp the length so it cannot reshape the message.
 */
function sanitizeText(text, maxChars) {
  const flat = String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length === 0) {
    return "(empty)";
  }
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}...(truncated)` : flat;
}

const TRUNCATION_MARKER = "...(truncated)";

/**
 * Forum topic name for a proposal: the proposal's own title, sanitized the
 * same way the message body is, plus a short address fragment.
 *
 * The fragment is not decoration. Two proposals can carry the same title --
 * a room of identically named topics is unnavigable, and a hostile proposal
 * deliberately named after an honest one would be indistinguishable in the
 * topic list. Six base58 characters tie the topic to an account on chain.
 *
 * Clamped to Telegram's 128-character ceiling; createForumTopic rejects 129.
 */
function topicNameForProposal(name, address) {
  const tag = isBase58Pubkey(address) ? ` [${String(address).slice(0, 6)}]` : "";
  const budget = MAX_TOPIC_NAME_CHARS - tag.length;
  // sanitizeText appends its own marker, which would itself push the name
  // past the ceiling, so it is sanitized with room for the marker and then
  // clamped defensively.
  let title = sanitizeText(name, Math.max(1, budget - TRUNCATION_MARKER.length));
  if (title === "(empty)") {
    title = "Untitled proposal";
  }
  if (title.length > budget) {
    title = title.slice(0, budget);
  }
  return `${title}${tag}`;
}

/**
 * One read of a proposal's risk and state, used for BOTH the topic icon and
 * the headline glyph so the two can never disagree.
 *
 * RISK OUTRANKS STATE, deliberately, and the reason is that a topic's icon is
 * chosen once at creation and is never revisited: this process calls exactly
 * two Bot API methods (createForumTopic, sendMessage) and adding
 * `editForumTopic` to refresh a colour would be a third, which the send-only
 * hygiene test refuses. So a state colour goes stale the moment the proposal
 * advances -- within hours -- while an instruction set is fixed by the time it
 * is announced. Colouring by the immutable property is the one that stays
 * true. That is also why the state is ALWAYS spelled out in the message text:
 * colour is a scanning aid for the topic list, never the only signal, and a
 * reader who opens the topic sees the state in words.
 *
 * The colour vocabulary, in precedence order. THE ONE RULE A HOLDER SHOULD BE
 * ABLE TO LEARN FROM THE TOPIC LIST IS: **red means nobody can tell you what
 * this does.** Nothing else is red, so red never has to compete for attention.
 *   red    an instruction could not be read, or execution failed
 *   purple the proposal moves value -- money moves, but we know what it does
 *   yellow open for voting right now -- the one that needs a holder to act
 *   green  passed / executed
 *   pink   closed without passing (cancelled, defeated, vetoed)
 *   blue   not open for votes yet (draft or signing off)
 */
function classifyProposal({ state, undecodedCount = 0, movesValue = false } = {}) {
  if (undecodedCount > 0) {
    return {
      color: TOPIC_COLOR_RED,
      iconEmojiId: TOPIC_ICON_DOUBLE_BANG,
      headline: "‼️",
      reason: "an instruction could not be decoded",
    };
  }
  if (state === STATE_EXECUTING_WITH_ERRORS) {
    return {
      color: TOPIC_COLOR_RED,
      iconEmojiId: TOPIC_ICON_BANG,
      headline: "❗️",
      reason: "execution failed",
    };
  }
  // Purple, NOT red. Operator decision 2026-08-30: red is reserved for "nobody
  // can tell you what this does". A DAO's whole purpose is moving value, so
  // coding every routine fee distribution the same as a possible drain trains
  // the room to scroll past the one colour that must never be ignored.
  if (movesValue) {
    return {
      color: TOPIC_COLOR_PURPLE,
      iconEmojiId: TOPIC_ICON_MONEY_FLYING,
      headline: "💸",
      reason: "moves value out of the treasury",
    };
  }
  if (state === STATE_VOTING) {
    return {
      color: TOPIC_COLOR_YELLOW,
      iconEmojiId: TOPIC_ICON_BALLOT_BOX,
      headline: "🗳️",
      reason: "open for voting",
    };
  }
  if (state === STATE_SUCCEEDED || state === STATE_EXECUTING || state === STATE_COMPLETED) {
    return {
      color: TOPIC_COLOR_GREEN,
      iconEmojiId: TOPIC_ICON_CHECK,
      headline: "✅",
      reason: "passed",
    };
  }
  // Blue, sharing with Draft on purpose: to a holder both mean "not open for
  // votes yet", which is the only distinction that changes what they do today.
  // The icon still tells the two apart for anyone who wants the detail.
  if (state === STATE_SIGNING_OFF) {
    return {
      color: TOPIC_COLOR_BLUE,
      iconEmojiId: TOPIC_ICON_WRITING_HAND,
      headline: "✍️",
      reason: "signing off",
    };
  }
  if (state === STATE_CANCELLED || state === STATE_DEFEATED || state === STATE_VETOED) {
    return {
      color: TOPIC_COLOR_PINK,
      iconEmojiId: TOPIC_ICON_CHEQUERED_FLAG,
      headline: "🏁",
      reason: "closed without passing",
    };
  }
  return {
    color: TOPIC_COLOR_BLUE,
    iconEmojiId: TOPIC_ICON_MEMO,
    headline: "📝",
    reason: state === STATE_DRAFT ? "draft" : `state ${state}`,
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Reads only the three keys this process is allowed to know. Everything else
 * in the file (RPC, pin, and social keys) is not imported.
 */
function readEnvFile(path) {
  if (!path || !existsSync(path)) {
    return;
  }
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const match = /^(KEKBULL_DAO_TG_BOT_TOKEN|KEKBULL_DAO_TG_CHAT_ID|KEKBULL_DAO_TG_THREAD_ID)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const value = String(match[2] ?? "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value.length > 0 && !process.env[match[1]]) {
      process.env[match[1]] = value;
    }
  }
}

function parseDeployment(path) {
  if (!existsSync(path)) {
    throw new Error(`deployment file not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const cluster = raw.cluster === "devnet" ? "devnet" : raw.cluster === "mainnet-beta" ? "mainnet-beta" : null;
  if (cluster === null) {
    throw new Error(`deployment.cluster must be devnet or mainnet-beta, got ${JSON.stringify(raw.cluster)}`);
  }
  for (const key of ["realm", "governance"]) {
    if (raw[key] !== null && !isBase58Pubkey(raw[key])) {
      throw new Error(`deployment.${key} is neither null nor base58`);
    }
  }
  return {
    cluster,
    realmsInstance: String(raw.realmsInstance ?? ""),
    realm: raw.realm ?? null,
    governance: raw.governance ?? null,
  };
}

function resolveRpcUrl(cluster) {
  const configured = String(process.env.ICHOR_ANNOUNCE_RPC ?? "").trim();
  if (configured.length === 0) {
    return cluster === "devnet" ? OFFICIAL_DEVNET_HTTP : OFFICIAL_MAINNET_HTTP;
  }
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("ICHOR_ANNOUNCE_RPC is not a URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("ICHOR_ANNOUNCE_RPC must be https");
  }
  // A mainnet RPC left behind a devnet deployment would read the wrong chain.
  const looksMainnet = /mainnet/i.test(configured);
  const looksDevnet = /devnet/i.test(configured);
  if (cluster === "devnet" && looksMainnet) {
    throw new Error("refusing a mainnet-looking RPC for a devnet deployment");
  }
  if (cluster === "mainnet-beta" && looksDevnet) {
    throw new Error("refusing a devnet-looking RPC for a mainnet deployment");
  }
  return configured;
}

/**
 * Base URL the per-proposal review link is built on, always ending in "/".
 *
 * Validated rather than trusted. This URL is read by holders in a public room
 * immediately after a treasury warning, so a malformed or plaintext one sends
 * exactly the audience that is paying attention somewhere that is not the DAO.
 * http is allowed for loopback only, so a successor can rehearse against a
 * locally served copy of the UI without that being a way to ship http links.
 *
 * Any query or fragment on the configured value is dropped: the proposal hash
 * is appended below and would replace a fragment anyway, and silently
 * discarding one at render time is worse than dropping it here.
 */
function resolveUiBase(cluster) {
  const configured = String(process.env.ICHOR_ANNOUNCE_UI_BASE ?? "").trim();
  if (configured.length === 0) {
    return cluster === "devnet" ? DAO_UI_BASE_DEVNET : DAO_UI_BASE_MAINNET;
  }
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("ICHOR_ANNOUNCE_UI_BASE is not a URL");
  }
  const loopback =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("ICHOR_ANNOUNCE_UI_BASE must be https (http is allowed only for loopback)");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
}

/** The shareable link to one proposal, in the format the UI's router parses. */
function proposalUrl(uiBase, address) {
  return `${uiBase}${PROPOSAL_HASH_PREFIX}${address}`;
}

function loadConfig() {
  readEnvFile(String(process.env.ICHOR_ANNOUNCE_ENV_FILE ?? "").trim());

  const deploymentPath = String(process.env.ICHOR_ANNOUNCE_DEPLOYMENT ?? "").trim();
  if (deploymentPath.length === 0) {
    throw new Error("ICHOR_ANNOUNCE_DEPLOYMENT is required");
  }
  const deployment = parseDeployment(deploymentPath);

  // REALM_UNPUBLISHED is reached before every other requirement, so an
  // unpublished mainnet idles quietly instead of exiting 1 and crash-looping
  // under Restart=on-failure. Nothing will ever be read or sent, so neither an
  // RPC nor a Telegram destination is demanded yet.
  const unpublished = deployment.governance === null || deployment.realm === null;

  const dryRun = String(process.env.ICHOR_ANNOUNCE_DRY_RUN ?? "") === "1";
  const backfill = String(process.env.ICHOR_ANNOUNCE_BACKFILL ?? "") === "1";

  const chatId = String(process.env.KEKBULL_DAO_TG_CHAT_ID ?? "").trim();
  if (!dryRun && !unpublished && !/^-?\d+$/.test(chatId)) {
    throw new Error("KEKBULL_DAO_TG_CHAT_ID must be set to a numeric chat id");
  }

  // Topics (forum mode) is being enabled on THE HERD and the announcer must
  // post into a topic, not the group root. Silently posting into General
  // instead of Proposals is the failure mode here, so an unset id is warned
  // about loudly at startup and a bad id surfaces as a hard error rather than
  // a retry into the root.
  const threadRaw = String(process.env.KEKBULL_DAO_TG_THREAD_ID ?? "").trim();
  let threadId = null;
  if (threadRaw.length > 0) {
    if (!/^\d+$/.test(threadRaw) || Number(threadRaw) <= 0) {
      throw new Error("KEKBULL_DAO_TG_THREAD_ID must be a positive integer when set");
    }
    threadId = Number(threadRaw);
  }

  const topicPerProposalRequested = String(process.env.ICHOR_ANNOUNCE_TOPIC_PER_PROPOSAL ?? "") === "1";

  // Mode is decided once, here, and never re-decided per message. A fixed
  // thread id always wins: that path creates nothing and needs no admin, so
  // it can never be the more dangerous of the two.
  let mode;
  let modeReason;
  if (threadId !== null) {
    mode = MODE_SINGLE_TOPIC;
    modeReason =
      `KEKBULL_DAO_TG_THREAD_ID=${threadId} is set, so every announcement goes into that one topic ` +
      "and no topic is ever created. This path needs NO admin rights.";
  } else if (topicPerProposalRequested) {
    mode = MODE_TOPIC_PER_PROPOSAL;
    modeReason =
      "ICHOR_ANNOUNCE_TOPIC_PER_PROPOSAL=1 and KEKBULL_DAO_TG_THREAD_ID is unset, so one forum topic " +
      "is created per new proposal and the announcement is posted into it. This path needs the bot to " +
      "be an administrator with can_manage_topics AND NOTHING ELSE (see the runbook).";
  } else {
    mode = MODE_GROUP_ROOT;
    modeReason =
      "neither KEKBULL_DAO_TG_THREAD_ID nor ICHOR_ANNOUNCE_TOPIC_PER_PROPOSAL=1 is set. This is the " +
      "safe default -- it needs no admin rights and cannot create anything -- but announcements land " +
      "in the GROUP ROOT, not in a topic. Set one of the two.";
  }

  const token = String(process.env.KEKBULL_DAO_TG_BOT_TOKEN ?? "").trim();
  if (!dryRun && !unpublished && token.length === 0) {
    throw new Error("KEKBULL_DAO_TG_BOT_TOKEN is not set");
  }

  const intervalRaw = Number(process.env.ICHOR_ANNOUNCE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const intervalMs = Math.min(
    MAX_INTERVAL_MS,
    Math.max(MIN_INTERVAL_MS, Number.isFinite(intervalRaw) ? intervalRaw : DEFAULT_INTERVAL_MS),
  );

  const statePath =
    String(process.env.ICHOR_ANNOUNCE_STATE ?? "").trim() ||
    join(process.env.HOME ?? ".", "www", `kekbull-dao-announce-${deployment.cluster}.json`);

  const programId = String(process.env.ICHOR_ANNOUNCE_PROGRAM_ID ?? "").trim() || KEKBULL_GOVERNANCE_PROGRAM_ID;
  if (!isBase58Pubkey(programId)) {
    throw new Error("ICHOR_ANNOUNCE_PROGRAM_ID is not base58");
  }

  return {
    deployment,
    unpublished,
    rpcUrl: unpublished ? null : resolveRpcUrl(deployment.cluster),
    programId,
    token,
    chatId,
    threadId,
    mode,
    modeReason,
    topicPerProposalRequested,
    intervalMs,
    statePath,
    dryRun,
    backfill,
    // Skipped while unpublished, exactly as rpcUrl is: nothing will be
    // rendered, and a malformed override must not turn an idle mainnet into a
    // crash-loop under Restart=on-failure.
    uiBase: unpublished ? null : resolveUiBase(deployment.cluster),
  };
}

// ---------------------------------------------------------------------------
// Cursor -- survives restart without re-announcing or missing
// ---------------------------------------------------------------------------

function loadState(path, cluster, governance) {
  if (!existsSync(path)) {
    return { version: STATE_VERSION, cluster, governance, announced: {}, topics: {}, primed: false };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`state file ${path} is not readable JSON: ${err.message}`);
  }
  // A state file from a different governance must never be trusted -- it would
  // suppress announcements for the governance actually being watched.
  if (raw.cluster !== cluster || raw.governance !== governance) {
    throw new Error(
      `state file ${path} belongs to ${raw.cluster}/${raw.governance}, refusing to reuse it for ${cluster}/${governance}`,
    );
  }
  return {
    version: STATE_VERSION,
    cluster,
    governance,
    announced: raw.announced && typeof raw.announced === "object" ? raw.announced : {},
    // `topics` is keyed by proposal pubkey and is written the instant a topic
    // is created, BEFORE the announcement is sent. A crash in that window
    // would otherwise leave an orphan topic and create a second one on the
    // next run. Absent in a v1 file, which is correct -- that run created none.
    topics: raw.topics && typeof raw.topics === "object" ? raw.topics : {},
    primed: raw.primed === true,
  };
}

function saveState(path, state) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

let rpcId = 0;

async function rpc(url, method, params, { timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: (rpcId += 1), method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${method} HTTP ${response.status}`);
    }
    const json = await response.json();
    if (json.error) {
      throw new Error(`${method} RPC error ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

function accountBuffer(account) {
  if (!account || !Array.isArray(account.data) || account.data[1] !== "base64") {
    return null;
  }
  return Buffer.from(account.data[0], "base64");
}

/**
 * Startup guard: prove against the chain that the program about to be polled
 * is the one that actually owns this deployment's governance account.
 *
 * This exists because a wrong program id is the ONLY misconfiguration in this
 * file that fails silently. Every other one is loud -- a missing mainnet RPC
 * throws, a devnet-looking RPC under a mainnet deployment throws, an
 * unpublished Realm idles and says which. But `getProgramAccounts` against the
 * wrong program returns `[]`, which is byte-identical to what a correctly
 * configured brand-new DAO returns. The journal reads "primed with 0 existing
 * proposal(s)", the unit sits there `active`, and it announces nothing for as
 * long as nobody looks. A launch-day DAO is exactly when nobody looks.
 *
 * KEKBULL_GOVERNANCE_PROGRAM_ID was measured from the official-devnet deploy,
 * and the intent recorded above it is that mainnet reuses the same program
 * keypair, which would keep the id identical. That is an intention, not a
 * measurement: deploy the fork under a different keypair and the id changes
 * while nothing in this process notices. So ask the chain instead.
 *
 * Three reads, each catching a different mistake:
 *
 *   1. genesis hash -- the RPC is really on the cluster the deployment claims.
 *      `resolveRpcUrl` already guards this, but as a regex over the URL, which
 *      any custom endpoint naming neither cluster passes while pointing
 *      wherever it likes. This one is measured rather than inferred.
 *
 *   2. program account -- it exists here and is executable. Catches "never
 *      deployed to this cluster" with a message that says so.
 *
 *   3. governance owner -- the deployment's governance account is OWNED by
 *      that program. This is the check that catches a right-shape-wrong-id
 *      redeploy, and it is the only one of the three that still works when
 *      the DAO has zero proposals, which is precisely the mainnet case.
 *
 * Fatal rather than a warning: each of these means every subsequent tick reads
 * the wrong chain or the wrong program, and no amount of retrying fixes an id.
 */
async function assertProgramMatchesDeployment(cfg) {
  const expectedGenesis = CLUSTER_GENESIS_HASH[cfg.deployment.cluster];
  const genesis = await rpc(cfg.rpcUrl, "getGenesisHash", []);
  if (expectedGenesis !== undefined && genesis !== expectedGenesis) {
    throw new FatalAnnounceError(
      `RPC is not on ${cfg.deployment.cluster}: getGenesisHash returned ${genesis}, expected ` +
        `${expectedGenesis}. The deployment file and ICHOR_ANNOUNCE_RPC disagree about the cluster.`,
    );
  }

  const programInfo = (await rpc(cfg.rpcUrl, "getAccountInfo", [
    cfg.programId,
    { encoding: "base64", commitment: "confirmed" },
  ]))?.value ?? null;
  if (programInfo === null) {
    throw new FatalAnnounceError(
      `governance program ${cfg.programId} does not exist on ${cfg.deployment.cluster}. It was ` +
        "never deployed to this cluster, or the id is wrong. Set ICHOR_ANNOUNCE_PROGRAM_ID.",
    );
  }
  if (programInfo.executable !== true) {
    throw new FatalAnnounceError(
      `${cfg.programId} exists on ${cfg.deployment.cluster} but is not executable, so it is an ` +
        "account of some other kind and not the governance program.",
    );
  }

  const governanceInfo = (await rpc(cfg.rpcUrl, "getAccountInfo", [
    cfg.deployment.governance,
    { encoding: "base64", commitment: "confirmed" },
  ]))?.value ?? null;
  if (governanceInfo === null) {
    throw new FatalAnnounceError(
      `governance account ${cfg.deployment.governance} does not exist on ` +
        `${cfg.deployment.cluster}. The deployment file names a Realm that is not on this chain.`,
    );
  }
  if (governanceInfo.owner !== cfg.programId) {
    throw new FatalAnnounceError(
      `governance account ${cfg.deployment.governance} is owned by ${governanceInfo.owner}, not ` +
        `by the program being polled (${cfg.programId}). getProgramAccounts would return nothing ` +
        "forever while this unit looked healthy. If that owner is the right redeploy, set " +
        `ICHOR_ANNOUNCE_PROGRAM_ID=${governanceInfo.owner}.`,
    );
  }

  console.log(
    `[announce] chain check OK: ${cfg.deployment.cluster} genesis ${genesis}; program ` +
      `${cfg.programId} is executable; governance ${cfg.deployment.governance} is owned by it.`,
  );
}

async function fetchProposals(cfg) {
  const result = await rpc(cfg.rpcUrl, "getProgramAccounts", [
    cfg.programId,
    {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: 0, bytes: base58Encode(Buffer.from([ACCOUNT_TYPE_PROPOSAL_V2])) } },
        { memcmp: { offset: 1, bytes: cfg.deployment.governance } },
      ],
    },
  ]);
  const out = [];
  for (const entry of result ?? []) {
    const buf = accountBuffer(entry.account);
    if (!buf) continue;
    try {
      out.push({ address: entry.pubkey, proposal: decodeProposalV2(buf) });
    } catch (err) {
      console.error(`[announce] undecodable proposal account ${entry.pubkey}: ${err.message}`);
    }
  }
  return out;
}

async function fetchProposalTransactions(cfg, proposalAddress) {
  const result = await rpc(cfg.rpcUrl, "getProgramAccounts", [
    cfg.programId,
    {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: 0, bytes: base58Encode(Buffer.from([ACCOUNT_TYPE_PROPOSAL_TRANSACTION_V2])) } },
        { memcmp: { offset: 1, bytes: proposalAddress } },
      ],
    },
  ]);
  const out = [];
  for (const entry of result ?? []) {
    const buf = accountBuffer(entry.account);
    if (!buf) continue;
    try {
      out.push(decodeProposalTransactionV2(buf));
    } catch (err) {
      console.error(`[announce] undecodable proposal transaction ${entry.pubkey}: ${err.message}`);
      out.push({ undecodable: true, address: entry.pubkey, instructions: [], holdUpTime: 0, optionIndex: 0, transactionIndex: 0 });
    }
  }
  out.sort((a, b) => a.optionIndex - b.optionIndex || a.transactionIndex - b.transactionIndex);
  return out;
}

async function fetchAccountBuffer(cfg, address) {
  const result = await rpc(cfg.rpcUrl, "getAccountInfo", [
    address,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  return accountBuffer(result?.value ?? null);
}

// ---------------------------------------------------------------------------
// Message composition
// ---------------------------------------------------------------------------

async function resolveTokenTransferAsset(cfg, transfer, mintCache) {
  // A bare SPL `Transfer` does not carry the mint or the decimals. Read them
  // from the chain rather than guessing -- an amount printed at the wrong
  // scale is worse than no amount at all.
  if (transfer.asset && transfer.decimals !== null) {
    return transfer;
  }
  let mint = transfer.asset;
  try {
    if (!mint && transfer.destination && isBase58Pubkey(transfer.destination)) {
      const buf = await fetchAccountBuffer(cfg, transfer.destination);
      mint = buf ? decodeTokenAccountMint(buf) : null;
    }
    if (mint && transfer.decimals === null) {
      if (!mintCache.has(mint)) {
        const buf = await fetchAccountBuffer(cfg, mint);
        mintCache.set(mint, buf ? decodeMintDecimals(buf) : null);
      }
      return { ...transfer, asset: mint, assetKey: mint, decimals: mintCache.get(mint) };
    }
  } catch (err) {
    console.error(`[announce] could not resolve mint/decimals: ${err.message}`);
  }
  return { ...transfer, asset: mint, assetKey: mint ?? transfer.destination };
}

/**
 * Renders one proposal into the message that lands in the room.
 *
 * TWO LAYERS, AND THE TOP ONE IS FOR SOMEONE WHO DOES NOT KNOW WHAT A DAO IS.
 *
 * This shape is the direct result of showing two real announcements to a
 * crypto novice and treating what they said as a requirement:
 *
 *   - They stopped reading at line 4, because a base58 address sat there:
 *     "a wall of nonsense, so my brain files the whole message as 'not for
 *     me'." NO ADDRESS APPEARS ABOVE THE TECHNICAL SECTION. Not one.
 *   - "TOTAL VALUE MOVED: none decoded" was read as an emergency -- they could
 *     not tell "no money moved" from "we don't know how much moved", and
 *     seeing the same string on a proposal with no instructions at all made
 *     them stop believing the line. Those are now three different sentences.
 *   - No line said what the proposal WAS: "every fact is metadata". `What it
 *     does` is now the first thing under the title.
 *   - "Do not vote yes until someone has read them on chain" assigned the job
 *     to nobody: "Someone. WHO? Am I someone? I can't read anything on chain."
 *     The warning now says what to do and what to do if no answer comes.
 *   - "official-devnet" read as a promotion, not a warning. Devnet now leads
 *     with a plain practice-run banner and the word "official" is gone.
 *   - The link "is the shape of every scam I've been warned about", so the
 *     anchor names the host.
 *   - ISO timestamps "look like a computer error"; deadlines are a duration
 *     first, and every absolute time is human-readable.
 *
 * The model for every label line is `State: Voting`, the one line they
 * understood instantly: plain English label, plain English value.
 *
 * NOTHING WAS REMOVED. Every fact the old message carried -- addresses, the
 * instruction set, the TokenOwnerRecord, the cluster, the cool-off -- is still
 * here, below a separator, where a person verifying on chain will find it and
 * a person deciding how to vote is not made to wade through it. The
 * COULD NOT DECODE detail is the BonkDAO defence and it is kept in full.
 *
 * Returns the HTML body, a plain-text spelling of the same message for the
 * fallback path, and the risk/state classification, so the topic icon and the
 * headline glyph are decided once from the same read.
 */
async function buildAnnouncement(cfg, address, proposal, governanceConfig, mintCache) {
  const transactions = await fetchProposalTransactions(cfg, address);
  const nowSeconds = cfg.nowSeconds ?? Math.floor(Date.now() / 1000);

  const entries = [];
  let undecodedCount = 0;
  let instructionNumber = 0;
  const totals = new Map(); // assetKey -> { amount, decimals, label }

  for (const tx of transactions) {
    if (tx.undecodable) {
      undecodedCount += 1;
      instructionNumber += 1;
      entries.push([
        `  ${instructionNumber}. ‼️ COULD NOT READ the transaction account ${codeSpan(tx.address)}`,
      ]);
      continue;
    }
    for (const ix of tx.instructions) {
      instructionNumber += 1;
      const info = decodeInstruction(ix);
      if (info.kind === "unknown") {
        undecodedCount += 1;
        const detail = info.unknown ?? { programId: ix.programId, dataLength: ix.data.length, note: null };
        entries.push([
          `  ${instructionNumber}. ‼️ COULD NOT READ - program ${codeSpan(detail.programId)}, ` +
            `${escapeHtml(String(detail.dataLength))} byte${detail.dataLength === 1 ? "" : "s"}` +
            `${detail.note ? ` - ${escapeHtml(detail.note)}` : ""}`,
        ]);
        continue;
      }
      let transfer = info.transfer;
      if (info.kind === "token-transfer") {
        transfer = await resolveTokenTransferAsset(cfg, transfer, mintCache);
      }
      const key = transfer.assetKey ?? `unknown:${transfer.destination}`;
      const prev = totals.get(key);
      totals.set(key, {
        amount: (prev ? prev.amount : 0n) + BigInt(transfer.amount),
        decimals: transfer.decimals,
        asset: transfer.asset,
        label: transfer.asset === "SOL" ? "SOL" : transfer.asset ? `mint ${transfer.asset}` : "unidentified token",
      });
      if (transfer.asset === "SOL") {
        entries.push([
          `  ${instructionNumber}. transfer ${boldSpan(formatBaseUnits(transfer.amount, 9))} SOL`,
          `     → ${codeSpan(transfer.destination)}`,
        ]);
      } else {
        entries.push([
          `  ${instructionNumber}. transfer ${boldSpan(formatBaseUnits(transfer.amount, transfer.decimals))}` +
            `${transfer.asset ? ` of mint ${codeSpan(transfer.asset)}` : " (mint unidentified)"}`,
          `     → token account ${codeSpan(transfer.destination)}`,
        ]);
      }
    }
  }

  const holdUpSeconds = transactions.reduce((max, tx) => Math.max(max, tx.holdUpTime ?? 0), 0);
  const effectiveHoldUp = transactions.length === 0 ? governanceConfig?.minTransactionHoldUpTime ?? null : holdUpSeconds;

  const votingBase = proposal.maxVotingTime ?? governanceConfig?.votingBaseTime ?? null;
  const coolOff = governanceConfig?.votingCoolOffTime ?? null;

  const stateLabel = PROPOSAL_STATES[proposal.state] ?? `unknown(${proposal.state})`;
  const isDevnet = cfg.deployment.cluster === "devnet";
  const movesValue = totals.size > 0;
  const classification = classifyProposal({ state: proposal.state, undecodedCount, movesValue });

  const lines = [];

  // --- is this even real money? -------------------------------------------
  // "official-devnet" read to a novice as a mark of authenticity: "'official'
  // makes me feel good, 'devnet' means nothing". So the practice run says so
  // in words, first, and the word "official" does not appear.
  if (isDevnet) {
    lines.push("<b>🧪 PRACTICE RUN - this is a test. No real money is involved.</b>");
    lines.push("");
  }
  lines.push(`<b>${classification.headline} KEKBULL DAO - NEW PROPOSAL</b>`);
  lines.push("");
  lines.push(boldSpan(sanitizeText(proposal.name, MAX_NAME_CHARS)));
  lines.push("");

  // --- what it is, in one sentence ----------------------------------------
  // Every decoded instruction this file recognises IS a transfer, so
  // "instructions but no value" means they could not be read.
  let whatItDoes;
  if (instructionNumber === 0) {
    whatItDoes = "Nothing runs on chain. This is a vote for the record only.";
  } else if (movesValue && undecodedCount > 0) {
    whatItDoes =
      `It sends money out of the DAO treasury, and it also runs ${undecodedCount} ` +
      `instruction${undecodedCount === 1 ? "" : "s"} that nobody has explained yet.`;
  } else if (movesValue) {
    whatItDoes = "It sends money out of the DAO treasury.";
  } else {
    whatItDoes =
      `It runs ${undecodedCount} instruction${undecodedCount === 1 ? "" : "s"} on chain ` +
      "that nobody has explained yet.";
  }
  lines.push(`What it does: ${boldSpan(whatItDoes)}`);

  // --- does it cost anything ----------------------------------------------
  // Three separate sentences, on purpose. The old message said
  // "TOTAL VALUE MOVED: none decoded" for all three, and a novice reader could
  // not tell "nothing moves" from "we could not work out what moves" -- they
  // read the safe case as the emergency, then stopped trusting the line.
  if (movesValue) {
    const amounts = [];
    for (const entry of totals.values()) {
      const amount = boldSpan(formatBaseUnits(entry.amount, entry.decimals));
      if (entry.asset === "SOL") {
        amounts.push(`${amount} SOL`);
      } else if (entry.asset) {
        amounts.push(`${amount} of the token ${escapeHtml(shortAddress(entry.asset))}`);
      } else {
        amounts.push(`${amount} of a token we could not identify`);
      }
    }
    lines.push(`Money it moves: ${amounts.join(", ")}`);
    if (undecodedCount > 0) {
      lines.push(`  …and possibly more - ${undecodedCount} instruction${undecodedCount === 1 ? "" : "s"} could not be read.`);
    }
  } else if (undecodedCount > 0) {
    lines.push(
      "Money it moves: <b>WE DO NOT KNOW.</b> Part of this proposal could not be read, " +
        "so the amount cannot be worked out. This is not the same as zero.",
    );
  } else {
    lines.push("Money it moves: <b>Nothing. No money leaves the treasury.</b>");
  }

  // --- do you have to act, and by when ------------------------------------
  const votingOpen = proposal.votingAt !== null && proposal.votingAt !== undefined;
  const terminal =
    proposal.state === STATE_CANCELLED ||
    proposal.state === STATE_DEFEATED ||
    proposal.state === STATE_VETOED ||
    proposal.state === STATE_COMPLETED ||
    proposal.state === STATE_EXECUTING ||
    proposal.state === STATE_SUCCEEDED ||
    proposal.state === STATE_EXECUTING_WITH_ERRORS;
  const deadline = votingOpen && votingBase !== null ? BigInt(proposal.votingAt) + BigInt(votingBase) : null;

  if (terminal) {
    lines.push("Do you need to vote: <b>No. Voting is over.</b>");
  } else if (proposal.state === STATE_VOTING) {
    lines.push("Do you need to vote: <b>Yes - voting is open now.</b>");
  } else {
    lines.push("Do you need to vote: <b>Not yet - voting has not opened.</b>");
  }

  if (deadline !== null) {
    lines.push(
      `Deadline: ${boldSpan(formatRemaining(deadline, nowSeconds))} ` +
        `(closes ${escapeHtml(formatHumanTime(deadline))})`,
    );
  } else if (votingOpen) {
    lines.push("Deadline: <b>unknown</b>");
  } else {
    lines.push(
      `Deadline: <b>voting has not opened.</b> Once it does, there will be ` +
        `${escapeHtml(votingBase === null ? "an unknown amount of time" : formatDuration(votingBase))} to vote.`,
    );
  }

  lines.push(
    `If it passes: it takes effect ${boldSpan(
      effectiveHoldUp === null ? "after an unknown delay" : formatDuration(effectiveHoldUp),
    )}${effectiveHoldUp === null || effectiveHoldUp === 0 ? "" : " later"}.`,
  );
  lines.push(`Status: ${boldSpan(stateLabel)}`);
  lines.push("");

  // --- the warning, addressed to a specific person doing a specific thing --
  if (undecodedCount > 0) {
    lines.push(
      `<blockquote>‼️ ${escapeHtml(String(undecodedCount))} instruction` +
        `${undecodedCount === 1 ? "" : "s"} in this proposal could not be read, and nobody has ` +
        "explained what they do.\n" +
        "<b>Do not vote yes.</b> Reply in this chat and ask what they do. If no one answers " +
        "before the deadline, vote no.</blockquote>",
    );
    lines.push("");
  }

  lines.push("Not sure? Reply in this chat and ask before you vote.");
  lines.push("");
  lines.push(
    linkSpan(proposalUrl(cfg.uiBase, address), `Read the full proposal on ${uiHost(cfg.uiBase)} →`),
  );
  lines.push("");

  // --- everything above is the decision; everything below is the evidence --
  lines.push("--------------------");
  lines.push("<b>TECHNICAL DETAIL</b> - for anyone checking this on chain");
  lines.push("");
  lines.push(
    `Network: ${escapeHtml(isDevnet ? "Solana devnet (a test network - no real money)" : "Solana mainnet (real money)")}`,
  );
  lines.push(
    `Instructions: ${escapeHtml(String(instructionNumber))}` +
      `${undecodedCount > 0 ? ` (${escapeHtml(String(undecodedCount))} could not be read)` : ""}`,
  );
  if (instructionNumber === 0) {
    lines.push("  (none - this proposal executes nothing on chain)");
  }
  for (const entry of entries.slice(0, MAX_INSTRUCTIONS_RENDERED)) {
    for (const line of entry) {
      lines.push(line);
    }
  }
  if (entries.length > MAX_INSTRUCTIONS_RENDERED) {
    lines.push(
      `  … ${escapeHtml(String(entries.length - MAX_INSTRUCTIONS_RENDERED))} more instructions not shown - ` +
        "read them on chain",
    );
  }
  lines.push("");
  if (deadline !== null) {
    lines.push(`Voting ends: ${escapeHtml(formatHumanTime(deadline, true))}`);
  } else {
    lines.push(
      `Voting window once it opens: ${escapeHtml(votingBase === null ? "unknown" : formatDuration(votingBase))}`,
    );
  }
  if (coolOff !== null && coolOff > 0) {
    lines.push(`Cool-off (Veto/Deny only): ${escapeHtml(formatDuration(coolOff))}`);
  }
  lines.push(
    `Execution hold-up after passing: ${escapeHtml(effectiveHoldUp === null ? "unknown" : formatDuration(effectiveHoldUp))}`,
  );
  lines.push(`Created: ${escapeHtml(formatHumanTime(proposal.draftAt, true))}`);
  lines.push(`Proposal: ${codeSpan(address)}`);
  lines.push(`Created by: ${proposal.createdBy ? codeSpan(proposal.createdBy) : "unknown"}`);
  lines.push(`TokenOwnerRecord: ${codeSpan(proposal.tokenOwnerRecord)}`);

  const html = lines.join("\n");
  return { html, text: htmlToPlainText(html), classification };
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

/**
 * An error the poll loop must NOT swallow. Flaky RPC is expected and retried;
 * a missing admin right is not going to fix itself on the next tick, and a
 * loop that keeps quietly failing is indistinguishable from one that is idle.
 */
class FatalAnnounceError extends Error {
  constructor(message) {
    super(message);
    this.name = "FatalAnnounceError";
    this.fatal = true;
  }
}

/**
 * The single Telegram egress point. Every call in this file goes through here,
 * and `method` is only ever the two literals below -- see the file header on
 * why this process has no receive path.
 */
async function telegramApi(cfg, method, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json || json.ok !== true) {
      const description = json && typeof json.description === "string" ? json.description : `HTTP ${response.status}`;
      const err = new Error(`${method} failed: ${description}`);
      err.description = description;
      throw err;
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one announcement.
 *
 * The body goes as `parse_mode: "HTML"`, and every chain-derived value in it
 * was escaped by the builder. The `plainText` argument is the same message
 * with the tags removed, and it is used for ONE retry if -- and only if --
 * Telegram rejects the body as unparseable entities. That retry is not
 * cosmetic: a proposal name is attacker-controlled, and an alert that Telegram
 * refuses to render is an alert the room never sees, which is the exact
 * failure this unit exists to prevent. Anything else Telegram objects to (a
 * bad thread id, a missing right) is raised, never retried.
 *
 * Both attempts go through the ONE telegramApi call site below. Adding a
 * second call site would break the send-only hygiene test that pins this file
 * to exactly two Bot API methods, and that test is worth more than the tidier
 * spelling.
 */
async function sendMessage(cfg, html, threadId, plainText) {
  const base = { chat_id: cfg.chatId, disable_web_page_preview: true };
  if (threadId !== null && threadId !== undefined) {
    base.message_thread_id = threadId;
  }
  const attempts = [
    { text: html, parse_mode: "HTML" },
    ...(plainText ? [{ text: plainText }] : []),
  ];

  let lastError = null;
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    try {
      return await telegramApi(cfg, "sendMessage", { ...base, ...attempts[attempt] });
    } catch (err) {
      const description = err.description ?? err.message;
      // A bad message_thread_id must surface, never silently retry into the
      // group root -- posting a treasury alert into General instead of the
      // Proposals topic is the failure this guard exists to prevent.
      if (threadId !== null && threadId !== undefined && /thread|topic/i.test(description)) {
        const fix =
          cfg.mode === MODE_SINGLE_TOPIC
            ? "Fix KEKBULL_DAO_TG_THREAD_ID"
            : `The topic this announcer created (message_thread_id=${threadId}) is gone or unusable; ` +
              "delete its entry from the `topics` map in the state file to have it recreated";
        throw new FatalAnnounceError(
          `sendMessage rejected message_thread_id=${threadId}: ${description}. ` +
            `${fix}; NOT retrying into the group root.`,
        );
      }
      lastError = err;
      const unparseable = /can't parse entities|can.t parse entities|entity|parse_mode/i.test(description);
      if (attempt + 1 < attempts.length && unparseable) {
        console.error(
          `[announce] Telegram refused the HTML body (${description}). ` +
            "Resending the SAME message as plain text so the alert still lands. " +
            "This is a bug in the escaping -- report the proposal name.",
        );
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Creates one forum topic and returns its message_thread_id.
 *
 * Failure is fatal on purpose. The plausible causes -- the bot is not an
 * administrator, it is an administrator without `can_manage_topics`, or
 * Topics (forum mode) was never enabled on the group -- all need a human, and
 * none of them get better by trying again in 45 seconds. There is deliberately
 * no fallback to the group root: an announcement that lands where nobody is
 * watching is the failure mode this whole unit exists to prevent, and it would
 * look like success in the journal.
 */
async function createTopic(cfg, name, classification) {
  // icon_color and icon_custom_emoji_id are what turn a grey letter
  // placeholder into a topic list that can be read at a glance. Both are sent:
  // the colour is the guaranteed-supported field, the standard-set icon is the
  // richer one, and neither requires Telegram Premium on the bot or on any
  // reader. See classifyProposal for the vocabulary and for why RISK, not
  // state, wins the colour.
  const look = classification ?? classifyProposal({});
  const body = { chat_id: cfg.chatId, name, icon_color: look.color };
  if (look.iconEmojiId) {
    body.icon_custom_emoji_id = look.iconEmojiId;
  }
  let result;
  try {
    result = await telegramApi(cfg, "createForumTopic", body);
  } catch (err) {
    const description = err.description ?? err.message;
    throw new FatalAnnounceError(
      `could not create the forum topic ${JSON.stringify(name)} in chat ${cfg.chatId}: ${description}\n` +
        "  Likely cause, in the order worth checking:\n" +
        "    1. the bot is not an administrator of this group, or is an administrator\n" +
        "       WITHOUT can_manage_topics -- grant exactly that right and nothing else;\n" +
        "    2. Topics (forum mode) is not enabled on the group at all;\n" +
        "    3. the bot is not a member of this chat, or KEKBULL_DAO_TG_CHAT_ID is wrong;\n" +
        "    4. a transient Telegram outage -- the unit retries this on restart.\n" +
        "  STOPPING. Not falling back to the group root: an announcement nobody is\n" +
        "  watching would look like success. Nothing was announced for this proposal,\n" +
        "  so it is announced in full once the right is granted.\n" +
        "  Single-topic mode (KEKBULL_DAO_TG_THREAD_ID) needs no admin rights at all.",
    );
  }
  const threadId = result?.message_thread_id;
  if (typeof threadId !== "number" || !Number.isInteger(threadId) || threadId <= 0) {
    throw new FatalAnnounceError(
      `createForumTopic returned no usable message_thread_id for ${JSON.stringify(name)}. STOPPING.`,
    );
  }
  return threadId;
}

/**
 * The message_thread_id this proposal's announcement must be posted into, or
 * null for the group root. In topic-per-proposal mode the created id is
 * persisted BEFORE the announcement is sent, so a crash between the two never
 * produces a second topic for the same proposal.
 */
async function resolveDestination(cfg, state, address, proposal, classification) {
  if (cfg.mode === MODE_SINGLE_TOPIC) {
    return cfg.threadId;
  }
  if (cfg.mode !== MODE_TOPIC_PER_PROPOSAL) {
    return null;
  }
  const existing = state.topics[address];
  if (existing && Number.isInteger(existing.messageThreadId) && existing.messageThreadId > 0) {
    console.log(`[announce] reusing topic ${existing.messageThreadId} for ${address}`);
    return existing.messageThreadId;
  }
  const name = topicNameForProposal(proposal.name, address);
  if (cfg.dryRun) {
    console.log(`[announce] DRY RUN: would create forum topic ${JSON.stringify(name)} for ${address}`);
    return null;
  }
  const threadId = await createTopic(cfg, name, classification);
  state.topics[address] = { messageThreadId: threadId, name, createdAt: Math.floor(Date.now() / 1000) };
  saveState(cfg.statePath, state);
  console.log(`[announce] created topic ${threadId} (${JSON.stringify(name)}) for ${address}`);
  return threadId;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function tick(cfg, state, mintCache) {
  const proposals = await fetchProposals(cfg);

  // First run against this governance: record the backlog as seen and say
  // nothing. Enabling the unit must not replay every historical proposal into
  // the room. ICHOR_ANNOUNCE_BACKFILL=1 overrides deliberately.
  if (!state.primed && !cfg.backfill) {
    let primed = 0;
    let leftOpen = 0;
    for (const { address, proposal } of proposals) {
      // A Draft is deliberately NOT primed. It has not been announced and its
      // instruction set is not final, so recording it as seen would mean it
      // signs off later and the room never hears about it at all. Leaving it
      // unrecorded is what makes the announcement happen at sign-off.
      if (proposal.state === PROPOSAL_STATE_DRAFT) {
        leftOpen += 1;
        continue;
      }
      state.announced[address] = { primedAt: Math.floor(Date.now() / 1000), draftAt: String(proposal.draftAt) };
      primed += 1;
    }
    state.primed = true;
    saveState(cfg.statePath, state);
    console.log(
      `[announce] primed with ${primed} existing proposal(s); none announced` +
        (leftOpen > 0
          ? `; ${leftOpen} draft(s) left unprimed, each announces when it leaves Draft`
          : ""),
    );
    return;
  }
  state.primed = true;

  let governanceConfig = null;
  // Not marked as seen -- skipped, and picked up on the tick after sign-off.
  const drafts = proposals.filter(
    ({ address, proposal }) => !state.announced[address] && proposal.state === PROPOSAL_STATE_DRAFT,
  );
  if (drafts.length > 0) {
    console.log(
      `[announce] holding ${drafts.length} draft(s): instructions can still change in Draft, ` +
        "so they are announced once they leave it",
    );
  }
  const fresh = proposals.filter(
    ({ address, proposal }) => !state.announced[address] && proposal.state !== PROPOSAL_STATE_DRAFT,
  );
  if (fresh.length > 0) {
    try {
      const buf = await fetchAccountBuffer(cfg, cfg.deployment.governance);
      governanceConfig = buf ? decodeGovernanceV2Config(buf) : null;
    } catch (err) {
      console.error(`[announce] could not read governance config: ${err.message}`);
    }
  }

  // Oldest first, so the room reads in creation order.
  fresh.sort((a, b) => (a.proposal.draftAt < b.proposal.draftAt ? -1 : a.proposal.draftAt > b.proposal.draftAt ? 1 : 0));

  for (const { address, proposal } of fresh) {
    try {
      if (isBase58Pubkey(proposal.tokenOwnerRecord)) {
        const buf = await fetchAccountBuffer(cfg, proposal.tokenOwnerRecord);
        proposal.createdBy = buf ? decodeTokenOwnerRecordOwner(buf) : null;
      }
    } catch (err) {
      console.error(`[announce] could not read TokenOwnerRecord for ${address}: ${err.message}`);
    }

    // The classification comes out of the render, so the topic icon and the
    // headline glyph are one decision made once from one read of the chain.
    const { html, text, classification } = await buildAnnouncement(
      cfg,
      address,
      proposal,
      governanceConfig,
      mintCache,
    );

    // The topic is created (or reused) before the message is built into a
    // destination, and a creation failure stops the process rather than
    // degrading to the group root.
    const threadId = await resolveDestination(cfg, state, address, proposal, classification);

    if (cfg.dryRun) {
      console.log(
        `----- DRY RUN: would send for ${address} (topic colour #${classification.color
          .toString(16)
          .padStart(6, "0")}, ${classification.reason}) -----\n${text}\n----- raw HTML -----\n${html}\n-----`,
      );
    } else {
      await sendMessage(cfg, html, threadId, text);
      console.log(`[announce] announced ${address}${threadId === null ? " (group root)" : ` into topic ${threadId}`}`);
    }

    // Persist only after a successful send, one at a time, so a failure
    // mid-batch re-announces exactly the ones that did not land.
    state.announced[address] = {
      announcedAt: Math.floor(Date.now() / 1000),
      draftAt: String(proposal.draftAt),
      messageThreadId: threadId,
    };
    saveState(cfg.statePath, state);
  }
}

async function main() {
  const cfg = loadConfig();

  console.log(
    `[announce] cluster=${cfg.deployment.cluster} program=${cfg.programId} interval=${cfg.intervalMs}ms ` +
      `state=${cfg.statePath} dryRun=${cfg.dryRun}`,
  );

  if (cfg.unpublished) {
    // Mainnet has no Realm yet. Fail closed and quietly -- idle rather than
    // exit, so systemd does not crash-loop this unit for a normal condition.
    console.log("[announce] REALM_UNPUBLISHED: deployment has no realm/governance. Idling, nothing to watch.");
    setInterval(() => {}, 1 << 30);
    return;
  }

  // Which destination mode, and why, on every start. A reader of the journal
  // must never have to infer where the announcements are going.
  if (cfg.mode === MODE_GROUP_ROOT) {
    console.warn(`[announce] mode=${cfg.mode} -- WARNING: ${cfg.modeReason}`);
    console.warn(
      "[announce] Set KEKBULL_DAO_TG_THREAD_ID to an existing topic (no admin needed), or " +
        "ICHOR_ANNOUNCE_TOPIC_PER_PROPOSAL=1 to have one topic created per proposal " +
        "(needs admin with can_manage_topics only). See tools/herd/LAUNCH_CHECKLIST.md, Telegram Topics.",
    );
  } else {
    console.log(`[announce] mode=${cfg.mode} -- ${cfg.modeReason}`);
  }
  if (cfg.mode === MODE_SINGLE_TOPIC && cfg.topicPerProposalRequested) {
    console.warn(
      "[announce] ICHOR_ANNOUNCE_TOPIC_PER_PROPOSAL=1 is IGNORED because KEKBULL_DAO_TG_THREAD_ID is set. " +
        "Unset the thread id to create a topic per proposal.",
    );
  }
  if (cfg.mode === MODE_TOPIC_PER_PROPOSAL && cfg.backfill) {
    console.warn(
      "[announce] ICHOR_ANNOUNCE_BACKFILL=1 in topic-per-proposal mode will create ONE TOPIC PER EXISTING " +
        "PROPOSAL, not just for new ones. Use ICHOR_ANNOUNCE_DRY_RUN=1 first if that is not what you meant.",
    );
  }

  const state = loadState(cfg.statePath, cfg.deployment.cluster, cfg.deployment.governance);
  const mintCache = new Map();

  // The chain check has to pass before the first announcement, but an RPC that
  // is merely unreachable at boot is not a misconfiguration. So a
  // FatalAnnounceError exits and anything else is retried on the normal
  // interval: a flaky endpoint must not turn into a crash-loop, and a wrong
  // program id must not be waited out.
  let chainVerified = false;
  const verifyChain = async () => {
    if (chainVerified) {
      return true;
    }
    try {
      await assertProgramMatchesDeployment(cfg);
      chainVerified = true;
      return true;
    } catch (err) {
      if (err instanceof FatalAnnounceError) {
        console.error(`[announce] FATAL: ${err.message}`);
        process.exit(1);
      }
      console.error(`[announce] chain check deferred, RPC did not answer: ${err.message}`);
      return false;
    }
  };

  let running = false;
  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      if (!(await verifyChain())) {
        return;
      }
      await tick(cfg, state, mintCache);
    } catch (err) {
      if (err instanceof FatalAnnounceError) {
        // Not a blip. A missing admin right or a group without Topics needs a
        // human, and a loop that keeps failing quietly reads as a healthy one.
        // Exiting non-zero makes it loud, and Restart=on-failure means the
        // unit recovers by itself the moment the right is granted.
        console.error(`[announce] FATAL: ${err.message}`);
        process.exit(1);
      }
      // Flaky RPC is expected. Keep the cursor, log, try again next tick.
      console.error(`[announce] poll failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  await run();
  setInterval(run, cfg.intervalMs);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[announce] fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  base58Encode,
  classifyProposal,
  escapeHtml,
  codeSpan,
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
  loadConfig,
  buildAnnouncement,
  topicNameForProposal,
  createTopic,
  resolveDestination,
  FatalAnnounceError,
  MAX_TOPIC_NAME_CHARS,
  MODE_GROUP_ROOT,
  MODE_SINGLE_TOPIC,
  MODE_TOPIC_PER_PROPOSAL,
  decodeGovernanceV2Config,
  decodeInstruction,
  decodeMintDecimals,
  decodeProposalTransactionV2,
  decodeProposalV2,
  decodeTokenAccountMint,
  decodeTokenOwnerRecordOwner,
  formatBaseUnits,
  formatDuration,
  loadState,
  parseDeployment,
  proposalUrl,
  resolveRpcUrl,
  resolveUiBase,
  sanitizeText,
  PROPOSAL_HASH_PREFIX,
  ACCOUNT_TYPE_PROPOSAL_V2,
  ACCOUNT_TYPE_PROPOSAL_TRANSACTION_V2,
  KEKBULL_GOVERNANCE_PROGRAM_ID,
  PROPOSAL_STATE_DRAFT,
  OFFICIAL_DEVNET_HTTP,
  OFFICIAL_MAINNET_HTTP,
  CLUSTER_GENESIS_HASH,
  assertProgramMatchesDeployment,
};
