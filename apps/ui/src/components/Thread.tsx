import { useState } from "react";
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

export function Thread({ nodeId, messages, showReplyBox, onMutated }: Props) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const sendReply = async () => {
    const body = reply.trim();
    if (!body) return;
    setSending(true);
    try {
      await api.postMessage(nodeId, body);
      setReply("");
      onMutated();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="thread">
      <div className="thread-body">
        {messages.length === 0 && <div className="thread-empty">まだありません</div>}
        {messages.map((m) => {
          if (m.kind === "decision_request") {
            return <DecisionCard key={m.id} message={m} nodeId={nodeId} onMutated={onMutated} />;
          }
          const align =
            m.author.kind === "human" ? "align-human" : m.author.kind === "agent" ? "align-agent" : "align-system";
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
            </div>
          );
        })}
      </div>
      {showReplyBox && (
        <div className="thread-reply">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="返信... (Ctrl/Cmd+Enter で送信)"
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
