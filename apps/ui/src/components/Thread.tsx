import { useEffect, useRef, useState } from "react";
import { Square } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import { Linkify, mdComponents } from "../lib/linkify";
import { displayNameOf, useTeam, type TeamUser } from "../lib/team";
import { cn } from "../lib/utils";
import type { MaterializedMessage, Node } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ChatComposer, ThinkingIndicator } from "./ChatComposer";
import { DecisionCard } from "./DecisionCard";

interface Props {
  nodeId: string;
  messages: MaterializedMessage[];
  /** パネルを開いた時点の前回既読時刻（ISO）。これより新しいメッセージの直前に
   *  「ここから未読」区切りを出す（未読バッジの理由をノードを開いたときに見せる。
   *  2026-08-02 本人要望）。null = 既読記録なし（初見ノード。区切りは出さない） */
  unreadSince?: string | null;
  /** Task AI が応答生成中か（「考え中」表示。GraphWrangler AI＝ChatDrawer と同じ見た目にする） */
  aiBusy?: boolean;
  /** 応答中に書いた分を受けて、終わり次第もう一度応答する予約があるか（2026-08-05） */
  aiQueued?: boolean;
  showReplyBox: boolean;
  /** このノードの AI モデル/エフォート（入力欄のセレクタ。変更はノードへ保存される。
   *  2026-08-07 モデル/エフォート切替 + 入力欄共通化） */
  aiModel?: string | null;
  aiEffort?: Node["aiEffort"];
  onAiModelChange?: (v: string | null) => void;
  onAiEffortChange?: (v: string | null) => void;
  onMutated: () => void;
}

/** 発言者の表示名。生の帰属文字列（task-ai:opus 等）ではなく AI の名前で出す
 *  （2026-07-31 本人指定: ノードの会話欄に Task AI の名前を出す） */
function authorLabel(author: { kind: string; name?: string | null }, users: TeamUser[]): string {
  // human の name にはメールが入る（複数人運用の帰属）。ロスターの displayName へ解決し、
  // 無ければ @ より前だけ出す（チーム化 2026-08-04。displayNameOf がその両方を持つ）
  if (author.kind === "human") return author.name ? displayNameOf(author.name, users) : "人間";
  if (author.kind === "system") return "system";
  const n = author.name ?? "";
  if (n.startsWith("task-ai") || n.startsWith("thread")) return "Task AI"; // thread: は改名前の旧帰属名
  if (n.startsWith("chat") || n === "mcp") return "GraphWrangler AI";
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
export function Thread({
  nodeId,
  messages,
  unreadSince,
  aiBusy,
  aiQueued,
  showReplyBox,
  aiModel,
  aiEffort,
  onAiModelChange,
  onAiEffortChange,
  onMutated,
}: Props) {
  // 発言者の表示名解決と「自分/他人の human 発言」の描き分け（チーム化 2026-08-04）
  const { me, users } = useTeam();
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

  // 追従スクロールは「最下部付近にいる間だけ」（2026-08-07 本人要望「スクロールを改善」。
  // ChatDrawer と同じ流儀）。自分の送信時は sendReply が stick を立てて最下部へ戻す
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, aiBusy]);

  /** ChatComposer から組み立て済み本文（添付行込み）を受けて投稿する */
  const sendReply = async (body: string) => {
    stickToBottomRef.current = true; // 自分の送信では最下部へ戻す
    setSending(true);
    try {
      if (openRequests.length > 0) {
        // 質問が開いているときの自由文は「聞き返し」= option なしの回答
        await api.answer(nodeId, openRequests[openRequests.length - 1].id, null, body);
      } else {
        await api.postMessage(nodeId, body);
      }
      onMutated();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1"
        ref={bodyRef}
        onScroll={() => {
          const el = bodyRef.current;
          if (!el) return;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {flow.length === 0 && openRequests.length === 0 && (
          <div className="py-2 text-sm text-text-lo">タスクを計画・実行しましょう</div>
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
          // 自分以外の human 発言は左寄せ（agent と同じ側）+ human 枠色にして、自分の発言と
          // 区別する（「右寄せ=自分」のチャット慣行。チーム化 2026-08-04）。
          // 未ログイン時・帰属メールの無い旧メッセージは従来どおり右寄せ
          const otherHuman =
            m.author.kind === "human" && !!me.email && !!m.author.name && m.author.name !== me.email;
          const alignSelf =
            m.author.kind === "human"
              ? otherHuman
                ? "self-start"
                : "self-end"
              : m.author.kind === "agent"
                ? "self-start"
                : "self-center";
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
              {/* メタ行は読み飛ばしてよい情報なので薄く（2026-08-07 文字削減）。
                  via（ui/chat/engine/mcp）は内部用語なので常時表示をやめ、時刻の title に畳む */}
              <div className="mb-1 flex gap-2 text-xs text-text-lo">
                <span>{authorLabel(m.author, users)}</span>
                <span title={`経路: ${m.via}`}>{new Date(m.ts).toLocaleString("ja-JP")}</span>
              </div>
              {/* AI（agent）の本文はマークダウンで描画（2026-08-01 本人要望「Task AI でも
                  markdown が正しくレンダリングされるように」。スタイルは GraphWrangler AI と共通の
                  .chat-md）。人間・システムの本文は入力そのまま */}
              {m.author.kind === "agent" && m.body ? (
                <div className="chat-md break-words text-sm">
                  <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {m.body}
                  </Markdown>
                </div>
              ) : (
                <div className="whitespace-pre-wrap break-words text-sm">
                  {m.body ? (
                    <Linkify text={m.body} />
                  ) : m.kind === "decision_answer" ? (
                    "(選択のみ)"
                  ) : (
                    ""
                  )}
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
        {/* Task AI の「考え中」。GraphWrangler AI（ChatDrawer）と同じ見た目・同じアニメーション。
            右に停止ボタン（2026-08-05 本人要望「AIの会話を止められる機能」）と、送信予約の
            予約表示（応答中に書いた分は捨てず、終わり次第まとめて返事が来る） */}
        {aiBusy && (
          <ThinkingIndicator label={aiQueued ? "考え中（続きの返信は応答後に届きます）" : "考え中"}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                void api.stopThreadAi(nodeId).then(() => onMutated());
              }}
            >
              <Square className="size-3" /> 停止
            </Button>
          </ThinkingIndicator>
        )}
      </div>
      {/* 入力欄は ChatComposer（GraphWrangler AI=ChatDrawer と共通。2026-08-07 本人要望
          「UI を分けずに同じコンポーネントに」）。応答中の送信はサーバ側が予約して
          応答後にもう一度返す（2026-08-05）ため、そのまま投稿してよい */}
      {showReplyBox && (
        <ChatComposer
          value={reply}
          onChange={setReply}
          busy={!!aiBusy}
          disabled={sending}
          onSend={(full) => void sendReply(full)}
          onStop={() => {
            void api.stopThreadAi(nodeId).then(() => onMutated());
          }}
          placeholderIdle={openRequests.length > 0 ? "聞き返す・相談する…" : "返信…"}
          placeholderBusy="続けて入力…（応答後に届きます）"
          model={aiModel ?? null}
          onModelChange={onAiModelChange}
          effort={aiEffort ?? null}
          onEffortChange={onAiEffortChange}
        />
      )}
    </div>
  );
}
