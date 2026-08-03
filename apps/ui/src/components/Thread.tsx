import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  /** パネルを開いた時点の前回既読時刻（ISO）。これより新しいメッセージの直前に
   *  「ここから未読」区切りを出す（未読バッジの理由をノードを開いたときに見せる。
   *  2026-08-02 本人要望）。null = 既読記録なし（初見ノード。区切りは出さない） */
  unreadSince?: string | null;
  /** Task AI が応答生成中か（「考え中」表示。Workflow AI＝ChatDrawer と同じ見た目にする） */
  aiBusy?: boolean;
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
export function Thread({ nodeId, messages, unreadSince, aiBusy, showReplyBox, onMutated }: Props) {
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

  // 「ここから未読」区切りの位置: 前回既読より新しい最初のメッセージ。全部既読なら出さない。
  // **既読記録が無い（この端末では初見）ときは全部未読として先頭に出す**——カード/レールの
  // 未読バッジが初見を未読と数えている（GraphView: !readTs || lastMsgTs > readTs）ので、
  // ここで抑制すると「バッジは付いているのに開いても何も無い」になる（2026-08-02 本人報告）。
  // 既読は端末ごと（localStorage）なので、PC で読んだノードもスマホでは初見になる
  const firstUnreadIndex =
    unreadSince !== undefined ? flow.findIndex((m) => m.ts > (unreadSince ?? "")) : -1;

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, aiBusy]);

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
        {flow.map((m, idx) => {
          // 未読区切り（この位置から上が既読・下が未読）。メッセージ本体の前に挟む
          const unreadDivider =
            idx === firstUnreadIndex ? (
              <div key={`unread-${m.id}`} className="flex items-center gap-2 py-0.5 text-xs text-ai">
                <span className="h-px flex-1 bg-ai/40" />
                ここから未読
                <span className="h-px flex-1 bg-ai/40" />
              </div>
            ) : null;
          if (m.kind === "decision_request") {
            // answered なリクエストは流れの中に折りたたみ表示
            return (
              <div key={m.id} className="contents">
                {unreadDivider}
                <DecisionCard message={m} nodeId={nodeId} onMutated={onMutated} />
              </div>
            );
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
            <div key={m.id} className="contents">
            {unreadDivider}
            <div
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
              {/* AI（agent）の本文はマークダウンで描画（2026-08-01 本人要望「Task AI でも
                  markdown が正しくレンダリングされるように」。スタイルは Workflow AI と共通の
                  .chat-md）。人間・システムの本文は入力そのまま */}
              {m.author.kind === "agent" && m.body ? (
                <div className="chat-md break-words text-sm">
                  <Markdown remarkPlugins={[remarkGfm]}>{m.body}</Markdown>
                </div>
              ) : (
                <div className="whitespace-pre-wrap break-words text-sm">
                  {m.body || (m.kind === "decision_answer" ? "(選択のみ)" : "")}
                </div>
              )}
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
            </div>
          );
        })}
        {/* Task AI の「考え中」。Workflow AI（ChatDrawer）と同じ見た目・同じアニメーション */}
        {aiBusy && (
          <div className="flex items-center gap-1.5 self-start px-1 py-1 text-sm text-text-lo">
            <span className="animate-pulse">✳</span>
            <span>考え中</span>
            <span className="inline-flex items-center gap-0.5">
              <span className="size-1 animate-bounce rounded-full bg-text-lo" style={{ animationDelay: "0ms" }} />
              <span className="size-1 animate-bounce rounded-full bg-text-lo" style={{ animationDelay: "150ms" }} />
              <span className="size-1 animate-bounce rounded-full bg-text-lo" style={{ animationDelay: "300ms" }} />
            </span>
          </div>
        )}
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
