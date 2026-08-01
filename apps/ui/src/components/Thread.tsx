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

/** 発言者の表示名。生の帰属文字列（task-ai:opus 等）ではなく AI の名前で出す
 *  （2026-07-31 本人指定: ノードの会話欄に Task AI の名前を出す） */
function authorLabel(author: { kind: string; name?: string | null }): string {
  if (author.kind === "human") return "人間";
  if (author.kind === "system") return "system";
  const n = author.name ?? "";
  if (n.startsWith("task-ai") || n.startsWith("thread")) return "Task AI"; // thread: は改名前の旧帰属名
  if (n.startsWith("chat") || n === "mcp") return "Workflow AI";
  if (n.startsWith("executor") || n === "engine") return "実行AI";
  return n || "AI";
}

// 返信下書きの保持。NodePanel は key={node.id} で再マウントされるため React state は
// ノード切替のたびに消える。モジュールレベルの Map に退避し、戻ってきたら復元する（送信で消す）
const replyDrafts = new Map<string, string>();

/** payload が {sources: string[]} の形なら出典配列を返す（出典バッジ） */
function extractSources(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object" || !("sources" in payload)) return null;
  const sources = (payload as { sources?: unknown }).sources;
  if (!Array.isArray(sources) || !sources.every((s) => typeof s === "string")) return null;
  return sources as string[];
}

/**
 * ノードスレッド。Claude Code と同じ構成:
 * 上=流れるメッセージ列（自動で最下部へスクロール）、下=入力欄。
 * open な判断リクエストのカードはここではなく NodePanel が「ノード詳細とチャット欄の間」に
 * 固定表示する（本人指定 2026-07-31）。ただし質問が開いている間の自由文が
 * 「聞き返し」（ラリー）になる挙動はここが持つ。
 */
export function Thread({ nodeId, messages, showReplyBox, onMutated }: Props) {
  const [reply, setReply] = useState(() => replyDrafts.get(nodeId) ?? "");
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reply.trim()) replyDrafts.set(nodeId, reply);
    else replyDrafts.delete(nodeId);
  }, [reply, nodeId]);

  // open な判断リクエストは流れに埋めない（表示は NodePanel 側。ここでは聞き返し判定にだけ使う）
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
          <div className="py-2 text-sm text-muted-foreground">タスクを計画・実行しましょう</div>
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
                <span>{authorLabel(m.author)}</span>
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
      {showReplyBox && (
        <div className="flex flex-shrink-0 items-end gap-2">
          <Textarea
            className="flex-1 resize-y"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={
              openRequests.length > 0
                ? "聞き返す・相談する…（Enter で送信 / Shift+Enter で改行）"
                : "返信…（Enter で送信 / Shift+Enter で改行）"
            }
            rows={2}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey) return;
              e.preventDefault();
              sendReply();
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
