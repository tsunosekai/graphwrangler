import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import type { MaterializedMessage } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
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
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1" ref={bodyRef}>
        {flow.length === 0 && openRequests.length === 0 && (
          <div className="py-2 text-sm text-muted-foreground">まだありません</div>
        )}
        {flow.map((m) => {
          if (m.kind === "decision_request") {
            // answered なリクエストは流れの中に折りたたみ表示
            return <DecisionCard key={m.id} message={m} nodeId={nodeId} onMutated={onMutated} />;
          }
          const alignSelf =
            m.author.kind === "human" ? "self-end" : m.author.kind === "agent" ? "self-start" : "self-center";
          const borderColor =
            m.author.kind === "human"
              ? "border-human/40"
              : m.author.kind === "agent"
                ? "border-ai/40"
                : "border-border";
          const sources = extractSources(m.payload);
          return (
            <div
              key={m.id}
              className={cn(
                "max-w-[88%] rounded-md border bg-card px-3 py-2",
                alignSelf,
                borderColor,
                m.author.kind === "system" && "text-sm opacity-70",
              )}
            >
              <div className="mb-1 flex gap-2 text-xs text-muted-foreground">
                <span>
                  {AUTHOR_LABEL[m.author.kind] ?? m.author.kind}
                  {m.author.name ? `:${m.author.name}` : ""}
                </span>
                <span>{m.via}</span>
                <span>{new Date(m.ts).toLocaleString("ja-JP")}</span>
              </div>
              <div className="whitespace-pre-wrap break-words text-sm">
                {m.body || (m.kind === "decision_answer" ? "(選択のみ)" : "")}
              </div>
              {sources && sources.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {sources.map((s, i) => (
                    <Badge key={i} variant="outline">
                      {s}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {openRequests.map((m) => (
        <div key={m.id} className="flex-shrink-0">
          <DecisionCard message={m} nodeId={nodeId} onMutated={onMutated} />
        </div>
      ))}
      {showReplyBox && (
        <div className="flex flex-shrink-0 items-end gap-2">
          <Textarea
            className="flex-1 resize-y"
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
          <Button type="button" variant="secondary" disabled={sending || !reply.trim()} onClick={sendReply}>
            送信
          </Button>
        </div>
      )}
    </div>
  );
}
