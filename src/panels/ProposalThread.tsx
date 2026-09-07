import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatError } from "../format.ts";
import {
  hideProposalComment,
  listProposalComments,
  postProposalComment,
  type ChatComment,
} from "../proposal-chat.ts";
import { renderStrictMarkdown } from "../proposal-markdown.ts";

function mergePage(
  existing: readonly ChatComment[],
  incoming: readonly ChatComment[],
): ChatComment[] {
  const seen = new Set(existing.map((row) => row.id));
  const extra = incoming.filter((row) => !seen.has(row.id));
  return [...existing, ...extra];
}

function replaceNode(
  nodes: readonly ChatComment[],
  id: string,
  update: (node: ChatComment) => ChatComment,
): ChatComment[] {
  return nodes.map((node) => {
    if (node.id === id) {
      return update(node);
    }
    if (node.children.length === 0) {
      return node;
    }
    return { ...node, children: replaceNode(node.children, id, update) };
  });
}

export function ProposalThread(props: {
  readonly proposal: string;
  readonly cluster: "devnet" | "mainnet-beta";
  readonly realm: string | null;
  readonly deposited: boolean;
  readonly windowOpen: boolean;
  readonly connected: boolean;
  readonly wallet: string | null;
  readonly signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
}) {
  const [comments, setComments] = useState<readonly ChatComment[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState<string>("root");
  const [draft, setDraft] = useState("");

  const loadRoots = useCallback(
    async (before: string | null, append: boolean) => {
      const page = await listProposalComments(props.proposal, { before: before ?? undefined });
      setComments((prev) => (append && prev ? mergePage(prev, page.comments) : page.comments));
      setNextBefore(page.nextBefore);
      setTotal(page.total);
      setError(null);
    },
    [props.proposal],
  );

  useEffect(() => {
    void loadRoots(null, false).catch((err: unknown) => {
      setError(formatError(err));
      setComments([]);
    });
  }, [loadRoots]);

  const canSign = typeof props.signMessage === "function";
  const canPost =
    props.connected &&
    props.realm != null &&
    props.deposited &&
    props.windowOpen &&
    canSign &&
    props.wallet != null;

  function composerReason(): string | null {
    if (!props.connected) {
      return "Connect a wallet to comment.";
    }
    if (props.realm == null) {
      return "Realm unpublished. Comments stay closed until D.";
    }
    if (!canSign) {
      return "This wallet cannot sign messages, so it cannot post.";
    }
    if (!props.deposited) {
      return "Deposit ICHOR before commenting.";
    }
    if (!props.windowOpen) {
      return "This proposal is closed for comments.";
    }
    return null;
  }

  async function submit(): Promise<void> {
    if (!canPost || !props.realm || !props.wallet || !props.signMessage) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postProposalComment({
        cluster: props.cluster,
        realm: props.realm,
        proposal: props.proposal,
        parent: replyTo,
        body: draft,
        wallet: props.wallet,
        signMessage: props.signMessage,
      });
      setDraft("");
      setReplyTo("root");
      await loadRoots(null, false);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function hide(id: string): Promise<void> {
    if (!props.realm || !props.wallet || !props.signMessage) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await hideProposalComment({
        cluster: props.cluster,
        realm: props.realm,
        proposal: props.proposal,
        id,
        wallet: props.wallet,
        signMessage: props.signMessage,
      });
      await loadRoots(null, false);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadOlder(): Promise<void> {
    if (!nextBefore) {
      return;
    }
    setBusy(true);
    try {
      await loadRoots(nextBefore, true);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadReplies(node: ChatComment): Promise<void> {
    setBusy(true);
    try {
      const page = await listProposalComments(props.proposal, {
        parent: node.id,
        before: node.children.length > 0 ? node.childNextBefore : undefined,
      });
      setComments((prev) =>
        prev
          ? replaceNode(prev, node.id, (current) => ({
              ...current,
              children: mergePage(current.children, page.comments),
              childNextBefore: page.nextBefore,
              childCount: page.total,
            }))
          : prev,
      );
      setError(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  const shown = comments?.length ?? 0;

  return (
    <section className="proposal-thread" aria-label="Proposal discussion">
      <h4>Discussion</h4>
      <p className="field-note">
        Off-chain on this VPS. The host can remove illegal content. That is not a
        votable DAO role and is not a wallet allowlist. Only deposited ICHOR can
        post. Authors can hide their own comments. Newest first; older pages stay
        off the one-pager until you ask.
      </p>
      {error ? <p className="gate-fail">{error}</p> : null}
      {comments === null ? (
        <p className="muted">Loading thread…</p>
      ) : comments.length === 0 ? (
        <p className="muted">No comments yet.</p>
      ) : (
        <>
          <p className="muted">
            Showing {String(shown)} of {String(total)} top-level comments.
          </p>
          <ol className="thread-roots">{comments.map((node) => renderNode(node, 0))}</ol>
          {nextBefore ? (
            <button type="button" className="secondary" onClick={() => void loadOlder()} disabled={busy}>
              {busy ? "Loading…" : "Older comments"}
            </button>
          ) : null}
        </>
      )}
      {canPost ? (
        <div className="thread-composer">
          {replyTo !== "root" ? (
            <p className="field-note">
              Replying to {replyTo.slice(0, 8)}…{" "}
              <button type="button" className="secondary" onClick={() => setReplyTo("root")}>
                Cancel reply
              </button>
            </p>
          ) : null}
          <label>
            Comment
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={4}
              maxLength={8000}
            />
          </label>
          <button type="button" onClick={() => void submit()} disabled={busy || draft.trim().length === 0}>
            {busy ? "Signing…" : "Post comment"}
          </button>
        </div>
      ) : (
        <p className="muted">{composerReason()}</p>
      )}
    </section>
  );

  function renderNode(node: ChatComment, depth: number): ReactNode {
    const own = props.wallet != null && node.wallet === props.wallet;
    const moreReplies = node.childCount > node.children.length;
    const classes = [
      depth === 0 ? "thread-block" : undefined,
      node.hidden ? "thread-hidden" : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <li key={node.id} className={classes || undefined}>
        <div className="thread-meta">
          <span className="mono">{node.wallet.slice(0, 4)}…{node.wallet.slice(-4)}</span>
          <span className="muted">{new Date(node.createdAt).toISOString()}</span>
        </div>
        {node.hidden ? (
          <p className="muted">hidden</p>
        ) : (
          <div className="thread-body">{renderStrictMarkdown(node.body ?? "")}</div>
        )}
        <div className="thread-actions">
          {canPost && depth < 8 ? (
            <button type="button" className="secondary" onClick={() => setReplyTo(node.id)}>
              Reply
            </button>
          ) : null}
          {own && !node.hidden ? (
            <button type="button" className="secondary" onClick={() => void hide(node.id)} disabled={busy}>
              Hide
            </button>
          ) : null}
        </div>
        {node.children.length > 0 ? (
          <ol className="thread-list">{node.children.map((child) => renderNode(child, depth + 1))}</ol>
        ) : null}
        {moreReplies ? (
          <button type="button" className="secondary" onClick={() => void loadReplies(node)} disabled={busy}>
            {node.children.length === 0
              ? `Load ${String(node.childCount)} ${node.childCount === 1 ? "reply" : "replies"}`
              : `Older replies (${String(node.childCount - node.children.length)} left)`}
          </button>
        ) : null}
      </li>
    );
  }
}
