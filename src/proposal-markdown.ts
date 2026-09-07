/**
 * Proposal write-up helpers. The on-chain field is descriptionLink only.
 * Bodies are pinned markdown (text). Images are refused.
 *
 * Rendering returns structured React nodes. No raw HTML passthrough.
 */

import type { ReactNode } from "react";
import { createElement, Fragment } from "react";

export const PROPOSAL_MARKDOWN_MAX_BYTES = 64 * 1024;
export const PIN_PROPOSAL_PATH = "/api/pin-proposal";

const ALLOWED_DESCRIPTION_HOSTS = new Set([
  "ipfs.io",
  "gateway.pinata.cloud",
  "gold-hilarious-monkey-129.mypinata.cloud",
]);

export interface PinProposalResult {
  readonly cid: string;
  readonly descriptionLink: string;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function assertProposalMarkdown(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("proposal markdown is empty");
  }
  if (utf8ByteLength(trimmed) > PROPOSAL_MARKDOWN_MAX_BYTES) {
    throw new Error(
      `proposal markdown exceeds ${String(PROPOSAL_MARKDOWN_MAX_BYTES)} bytes`,
    );
  }
  return trimmed;
}

export function isAllowedDescriptionHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (ALLOWED_DESCRIPTION_HOSTS.has(host)) {
    return true;
  }
  return host.endsWith(".mypinata.cloud");
}

export function parseDescriptionLink(url: string): URL | null {
  const raw = url.trim();
  if (raw.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") {
    return null;
  }
  if (!isAllowedDescriptionHost(parsed.hostname)) {
    return null;
  }
  return parsed;
}

/**
 * Pin markdown via the loopback/VPS pin route. JWT never enters this module.
 *
 * `walletPubkey` is the connected wallet, sent as `X-Wallet-Pubkey`. The route
 * rate-limits on it paired with the client IP. It is shape-checked there, not
 * proven - see the residual-risk note in `scripts/pin-proposal-server.cjs`.
 * the route previously accepted any value, and this module sent
 * none, so every real user shared one bucket.
 */
export async function pinProposalMarkdown(
  markdown: string,
  walletPubkey: string,
): Promise<PinProposalResult> {
  const body = assertProposalMarkdown(markdown);
  const wallet = walletPubkey.trim();
  if (wallet.length === 0) {
    throw new Error("connect a wallet before pinning a proposal body");
  }
  const response = await fetch(PIN_PROPOSAL_PATH, {
    method: "POST",
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "x-wallet-pubkey": wallet,
    },
    body,
  });
  const text = await response.text();
  if (response.status === 404 || response.status === 405) {
    throw new Error(
      "Proposal pinning is not available on this origin. Write proposals on dao.kekbull.com after the programs are published.",
    );
  }
  let parsed: { ok?: boolean; cid?: string; descriptionLink?: string; error?: string };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`pin route returned non-JSON (HTTP ${String(response.status)})`);
  }
  if (!response.ok || parsed.ok !== true || !parsed.cid || !parsed.descriptionLink) {
    throw new Error(parsed.error ?? `pin failed (HTTP ${String(response.status)})`);
  }
  const link = parseDescriptionLink(parsed.descriptionLink);
  if (link === null) {
    throw new Error("pin route returned a descriptionLink this page will not fetch");
  }
  return { cid: parsed.cid, descriptionLink: link.toString() };
}

/** Fetch pinned markdown when the host is allowlisted. Failures return null. */
export async function fetchProposalMarkdown(descriptionLink: string): Promise<string | null> {
  const link = parseDescriptionLink(descriptionLink);
  if (link === null) {
    return null;
  }
  try {
    const response = await fetch(link.toString(), {
      method: "GET",
      headers: { accept: "text/markdown, text/plain, */*" },
    });
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    if (utf8ByteLength(text) > PROPOSAL_MARKDOWN_MAX_BYTES) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

function renderInlineNodes(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`([^`]+)`)|(\[([^\]]+)\]\((https:\/\/[^)\s]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    if (match[2] !== undefined) {
      nodes.push(createElement("code", { key: `${keyPrefix}-c-${String(n++)}` }, match[2]));
    } else if (match[4] !== undefined && match[5] !== undefined) {
      try {
        const url = new URL(match[5]);
        if (url.protocol === "https:") {
          nodes.push(
            createElement(
              "a",
              {
                key: `${keyPrefix}-a-${String(n++)}`,
                href: url.toString(),
                target: "_blank",
                rel: "noreferrer noopener",
              },
              match[4],
            ),
          );
        } else {
          nodes.push(match[0]);
        }
      } catch {
        nodes.push(match[0]);
      }
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

/**
 * Strict markdown subset as React nodes. No raw HTML, no images, no scripts.
 */
export function renderStrictMarkdown(markdown: string): ReactNode {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let block = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3;
      const tag = (`h${String(level)}`) as "h1" | "h2" | "h3";
      blocks.push(
        createElement(
          tag,
          { key: `b-${String(block++)}` },
          ...renderInlineNodes(heading[2]!, `b${String(block)}`),
        ),
      );
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      let item = 0;
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
        items.push(
          createElement(
            "li",
            { key: `li-${String(block)}-${String(item++)}` },
            ...renderInlineNodes((lines[i] ?? "").replace(/^[-*]\s+/, ""), `li${String(block)}-${String(item)}`),
          ),
        );
        i += 1;
      }
      blocks.push(createElement("ul", { key: `b-${String(block++)}` }, items));
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: ReactNode[] = [];
      let item = 0;
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? "")) {
        items.push(
          createElement(
            "li",
            { key: `oli-${String(block)}-${String(item++)}` },
            ...renderInlineNodes((lines[i] ?? "").replace(/^\d+\.\s+/, ""), `oli${String(block)}-${String(item)}`),
          ),
        );
        i += 1;
      }
      blocks.push(createElement("ol", { key: `b-${String(block++)}` }, items));
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (
        next.trim().length === 0 ||
        /^#{1,3}\s+/.test(next) ||
        /^[-*]\s+/.test(next) ||
        /^\d+\.\s+/.test(next)
      ) {
        break;
      }
      para.push(next);
      i += 1;
    }
    blocks.push(
      createElement(
        "p",
        { key: `b-${String(block++)}` },
        ...renderInlineNodes(para.join(" "), `p${String(block)}`),
      ),
    );
  }
  return createElement(Fragment, null, blocks);
}
