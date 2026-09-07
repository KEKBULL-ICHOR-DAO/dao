/**
 * Client for /api/proposal-chat. Pinata stays out of this module.
 * The helper verifies the signature + live TOR; this file only builds
 * the v1 message a wallet must sign.
 */

export const PROPOSAL_CHAT_PATH = "/api/proposal-chat";
export const COMMENT_MARKDOWN_MAX_BYTES = 8 * 1024;

export interface ChatComment {
  readonly id: string;
  readonly parentId: string | null;
  readonly wallet: string;
  readonly body: string | null;
  readonly hidden: boolean;
  readonly createdAt: number;
  readonly depth: number;
  readonly children: readonly ChatComment[];
  readonly childNextBefore: string | null;
  readonly childCount: number;
}

export interface CommentPage {
  readonly comments: readonly ChatComment[];
  readonly nextBefore: string | null;
  readonly total: number;
}

export function assertCommentMarkdown(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("comment is empty");
  }
  if (new TextEncoder().encode(trimmed).length > COMMENT_MARKDOWN_MAX_BYTES) {
    throw new Error(`comment exceeds ${String(COMMENT_MARKDOWN_MAX_BYTES)} bytes`);
  }
  return trimmed;
}

export function buildChatMessage(fields: {
  readonly cluster: string;
  readonly realm: string;
  readonly action: "post" | "hide";
  readonly proposal: string;
  readonly parent: string;
  readonly id: string;
  readonly nonce: string;
  readonly bodySha256: string;
}): string {
  return [
    "kekbull-proposal-chat/v1",
    `cluster=${fields.cluster}`,
    `realm=${fields.realm}`,
    `action=${fields.action}`,
    `proposal=${fields.proposal}`,
    `parent=${fields.parent}`,
    `id=${fields.id}`,
    `nonce=${fields.nonce}`,
    `body_sha256=${fields.bodySha256}`,
  ].join("\n");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

async function readJson(path: string, init?: RequestInit): Promise<{
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(path, init);
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`chat route returned non-JSON (HTTP ${String(response.status)})`);
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

export async function fetchChatNonce(): Promise<{ nonce: string; realm: string | null; cluster: string }> {
  const { ok, status, body } = await readJson(`${PROPOSAL_CHAT_PATH}/nonce`);
  if (!ok || body.ok !== true || typeof body.nonce !== "string") {
    throw new Error(typeof body.error === "string" ? body.error : `nonce failed (HTTP ${String(status)})`);
  }
  return {
    nonce: body.nonce,
    realm: typeof body.realm === "string" ? body.realm : null,
    cluster: typeof body.cluster === "string" ? body.cluster : "",
  };
}

export async function listProposalComments(
  proposal: string,
  opts: { parent?: string; before?: string | null; limit?: number } = {},
): Promise<CommentPage> {
  const query = new URLSearchParams({ proposal });
  if (opts.parent) {
    query.set("parent", opts.parent);
  }
  if (opts.before) {
    query.set("before", opts.before);
  }
  if (opts.limit != null) {
    query.set("limit", String(opts.limit));
  }
  const { ok, status, body } = await readJson(`${PROPOSAL_CHAT_PATH}?${query.toString()}`);
  if (!ok || body.ok !== true || !Array.isArray(body.comments)) {
    throw new Error(typeof body.error === "string" ? body.error : `list failed (HTTP ${String(status)})`);
  }
  return {
    comments: body.comments as ChatComment[],
    nextBefore: typeof body.nextBefore === "string" ? body.nextBefore : null,
    total: typeof body.total === "number" ? body.total : 0,
  };
}

export async function postProposalComment(params: {
  readonly cluster: string;
  readonly realm: string;
  readonly proposal: string;
  readonly parent: string;
  readonly body: string;
  readonly wallet: string;
  readonly signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}): Promise<string> {
  const body = assertCommentMarkdown(params.body);
  const issued = await fetchChatNonce();
  if (issued.realm !== params.realm) {
    throw new Error("chat helper realm does not match this page");
  }
  const message = buildChatMessage({
    cluster: params.cluster,
    realm: params.realm,
    action: "post",
    proposal: params.proposal,
    parent: params.parent,
    id: "-",
    nonce: issued.nonce,
    bodySha256: await sha256Hex(body),
  });
  const signature = bytesToBase64(await params.signMessage(new TextEncoder().encode(message)));
  const { ok, status, body: res } = await readJson(PROPOSAL_CHAT_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "post",
      wallet: params.wallet,
      proposal: params.proposal,
      parent: params.parent,
      body,
      nonce: issued.nonce,
      signature,
    }),
  });
  if (!ok || res.ok !== true || typeof res.id !== "string") {
    throw new Error(typeof res.error === "string" ? res.error : `post failed (HTTP ${String(status)})`);
  }
  return res.id;
}

export async function hideProposalComment(params: {
  readonly cluster: string;
  readonly realm: string;
  readonly proposal: string;
  readonly id: string;
  readonly wallet: string;
  readonly signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}): Promise<void> {
  const issued = await fetchChatNonce();
  if (issued.realm !== params.realm) {
    throw new Error("chat helper realm does not match this page");
  }
  const message = buildChatMessage({
    cluster: params.cluster,
    realm: params.realm,
    action: "hide",
    proposal: params.proposal,
    parent: "root",
    id: params.id,
    nonce: issued.nonce,
    bodySha256: "-",
  });
  const signature = bytesToBase64(await params.signMessage(new TextEncoder().encode(message)));
  const { ok, status, body: res } = await readJson(PROPOSAL_CHAT_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "hide",
      wallet: params.wallet,
      proposal: params.proposal,
      id: params.id,
      nonce: issued.nonce,
      signature,
    }),
  });
  if (!ok || res.ok !== true) {
    throw new Error(typeof res.error === "string" ? res.error : `hide failed (HTTP ${String(status)})`);
  }
}
