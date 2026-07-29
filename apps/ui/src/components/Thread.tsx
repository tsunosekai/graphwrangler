import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { MaterializedMessage } from "../types";
import { DecisionCard } from "./DecisionCard";

interface Props {
  nodeId: string;
  messages: MaterializedMessage[];
  showReplyBox: boolean;
  onMutated: () => void;
}

const AUTHOR_LABEL: Record<string, string> = { human: "人間", agent: "AI", system: "system" };

// B-11: 返信下書きの保持。NodePanel は key={node.id} で再マウントされるため React state は
// ノード切替のたびに消える。モジュールレベルの Map に退避し、戻ってきたら復元する（送信で消す）
const replyDrafts = new Map<string, string>();

/** payload が {sources: string[]} の形なら出典配列を返す（B-7: 出典バッジ） */
function extractSources(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object" || !("sources" in payload)) return null;
  const sources = (payload as { sources?: unknown }).sources;
  if (!Array.isArray(sources) || !sources.every((s) => typeof s === "string")) return null;
  return sources as string[];
}

/**
 * ノードスレッド。Claude Code と同じ構成:
 * 上=流れるメッセージ列（自動で最下部へスクロール）、
 * 下=入力欄。open な判断リクエストは入力欄の直上に固定表示され、
 * 入力欄への自由文はそのリクエストへの「聞き返し」（ラリー）になる。
 */
export function Thread({ nodeId, messages, showReplyBox, onMutated }: Props) {
  const [reply, setReply] = useState(() => replyDrafts.get(nodeId) ?? "");
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reply.trim()) replyDrafts.set(nodeId, reply);
    else replyDrafts.delete(nodeId);
  }, [reply, nodeId]);

  // open な判断リクエストは流れに埋めず、入力欄の直上へ固定する
  const openRequests = messages.filter(
    (m) => m.kind === "decision_request" && m.requestStatus === "open",
  );
  const flow = messages.filter(
    (m) => !(m.kind === "decision_request" && m.requestStatus === "open"),
  );

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const sendReply = async () => {
    const body = reply.trim();
    if (!body) return;
    setSending(true);
    try {
      if (openRequests.length > 0) {
        // 質問が開いているときの自由文は「聞き返し」= option なしの回答
        await api.answer(nodeId, openRequests[openRequests.length - 1].id, null, body);
      } else {
        await api.postMessage(nodeId, body);
      }
      setReply("");
      onMutated();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="thread">
      <div className="thread-body" ref={bodyRef}>
        {flow.length === 0 && openRequests.length === 0 && (
          <div className="thread-empty">まだありません</div>
        )}
        {flow.map((m) => {
          if (m.kind === "decision_request") {
            // answered なリクエストは流れの中に折りたたみ表示
            return <DecisionCard key={m.id} message={m} nodeId={nodeId} onMutated={onMutated} />;
          }
          const align =
            m.author.kind === "human" ? "align-human" : m.author.kind === "agent" ? "align-agent" : "align-system";
          const sources = extractSources(m.payload);
          return (
            <div key={m.id} className={`thread-msg ${align}`}>
              <div className="thread-msg-meta">
                <span className="thread-msg-author">
                  {AUTHOR_LABEL[m.author.kind] ?? m.author.kind}
                  {m.author.name ? `:${m.author.name}` : ""}
                </span>
                <span className="thread-msg-via">{m.via}</span>
                <span className="thread-msg-ts">{new Date(m.ts).toLocaleString("ja-JP")}</span>
              </div>
              <div className="thread-msg-body">{m.body || (m.kind === "decision_answer" ? "(選択のみ)" : "")}</div>
              {sources && sources.length > 0 && (
                <div className="src-badges">
                  {sources.map((s, i) => (
                    <span key={i} className="src-badge">
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {openRequests.map((m) => (
        <div key={m.id} className="thread-pinned">
          <DecisionCard message={m} nodeId={nodeId} onMutated={onMutated} />
        </div>
      ))}
      {showReplyBox && (
        <div className="thread-reply">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={
              openRequests.length > 0 ? "聞き返す・相談する... (Ctrl/Cmd+Enter)" : "返信... (Ctrl/Cmd+Enter で送信)"
            }
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                sendReply();
              }
            }}
          />
          <button type="button" disabled={sending || !reply.trim()} onClick={sendReply}>
            送信
          </button>
        </div>
      )}
    </div>
  );
}
