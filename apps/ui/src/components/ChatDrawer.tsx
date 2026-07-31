// 内蔵チャット（M4: グラフ整理の Workflow AI）。TopBar の 💬 から開く右ドロワー。
// @ai-sdk/react の useChat + ai の DefaultChatTransport で UIMessageStream(SSE) を処理する
// （B-x: Claude Code 風UX化に伴い、自前の fetch+ReadableStream パース(readSse/applyChunk)から
// 移行。ai / @ai-sdk/react は apps/ui の依存としてこのタスクで追加した。
// docs/agent-contracts.md の「pnpm add 禁止」は既定の規律で、依頼元プロンプトで明示許可された例外）。
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { History, MessageSquare } from "lucide-react";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { pushToast } from "../lib/toast";
import { Button } from "./ui/button";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";
import { ChatMessageView, toolActivityLabel } from "./ChatMessage";
import { Icon } from "./Icon";

interface Props {
  pageId: string | null;
  pageTitle: string | null;
  /** 選択中ノード（あれば）。チャットへ渡し「これ」で通じるようにする */
  selectedNodeId: string | null;
  onMutated: () => void;
  onClose: () => void;
}

// B-7改: チャット履歴の永続化はサーバ（sidecar/chats/<pageId>.json、コミット対象）。
// localStorage 保存は廃止（2026-07-31 本人要望「会話履歴も見れるように」——ブラウザ縛りを
// やめ、スレッドと同じく経緯ごと版管理する）
function chatKeyOf(pageId: string | null): string {
  return pageId ?? "global";
}

async function loadHistory(pageId: string | null): Promise<UIMessage[]> {
  try {
    const res = await fetch(`/api/chats/${chatKeyOf(pageId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.messages) ? (data.messages as UIMessage[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(pageId: string | null, messages: UIMessage[]): void {
  void fetch(`/api/chats/${chatKeyOf(pageId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  }).catch(() => {
    // 保存失敗は無視（履歴の永続化は補助機能）
  });
}

/** 「新しい会話」で退避した過去セッション1件（サーバの ChatArchiveSession と対応） */
interface ArchiveSession {
  id: string;
  ts: string;
  messages: UIMessage[];
}

/** 現行の会話をアーカイブへ1件追記する。成否を返す（失敗時は呼び出し側で会話を消さない） */
async function archiveCurrentChat(pageId: string | null, messages: UIMessage[]): Promise<boolean> {
  try {
    const res = await fetch(`/api/chats/${chatKeyOf(pageId)}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadArchive(pageId: string | null): Promise<ArchiveSession[]> {
  try {
    const res = await fetch(`/api/chats/${chatKeyOf(pageId)}/archive`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.sessions) ? (data.sessions as ArchiveSession[]) : [];
  } catch {
    return [];
  }
}

/** 履歴タブの1行に出す「最初のユーザー発言の先頭40字」 */
function firstUserPreview(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first?.parts.find((p) => p.type === "text")?.text ?? "";
  return text.slice(0, 40) || "(発言なし)";
}

/** 400等のJSONエラー本文（{error:"..."}）なら中身を、そうでなければそのまま返す */
function formatChatError(error: Error): string {
  const raw = error.message || "チャットでエラーが発生しました";
  try {
    const data = JSON.parse(raw);
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // JSONでなければそのまま表示
  }
  return raw;
}

/** fetch自体の失敗（サーバ未起動等）を分かりやすい文言に変換してから投げ直す */
const chatFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error("サーバに接続できません");
  }
};

export function ChatDrawer({ pageId, pageTitle, selectedNodeId, onMutated, onClose }: Props) {
  const [width, startResize] = useResizableWidth("chatW", 360, 300, 640);
  const [input, setInput] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  // 会話/履歴タブ（2026-07-31 本人要望「切り替えるUIが無い」）。永続化不要のローカル状態
  const [tab, setTab] = useState<"talk" | "history">("talk");
  const [archiveSessions, setArchiveSessions] = useState<ArchiveSession[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [startingNewChat, setStartingNewChat] = useState(false);

  // transportはstatic（apiパスのみ）。pageId/selectedNodeIdは送信のたびにsendMessageのoptions
  // で渡す（最新値を確実に反映するため。transport生成時のクロージャに古い値を焼き込まない）
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat", fetch: chatFetch }), []);

  // id を pageId に紐づけることで、ページ切替時に useChat 内部が Chat インスタンスを
  // 作り直す（=履歴を loadHistory(pageId) で読み込み直す）。旧実装の「pageId変更→useEffectで
  // 読み込み直す」に相当する
  const { messages, setMessages, sendMessage, status, error, stop } = useChat({
    id: pageId ?? "global",
    transport,
    onFinish: () => onMutated(),
  });

  // ページ切替時にサーバから履歴を読み込む（保存は下の messages 変更 effect が担う。
  // 読み込み完了までの間に古いページの内容を保存しないよう、ロード済みキーを追跡する）
  const loadedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = chatKeyOf(pageId);
    loadedKeyRef.current = null;
    setTab("talk"); // ページ切替時は会話タブに戻す
    void loadHistory(pageId).then((history) => {
      setMessages(history);
      loadedKeyRef.current = key;
    });
    // setMessages は useChat の安定参照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  // 履歴タブを開くたびにサーバから最新のアーカイブ一覧を読み込む
  useEffect(() => {
    if (tab !== "history") return;
    let cancelled = false;
    setArchiveLoading(true);
    void loadArchive(pageId).then((sessions) => {
      if (cancelled) return;
      setArchiveSessions(sessions);
      setArchiveLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, pageId]);

  const busy = status === "submitted" || status === "streaming";

  // 「考え中」の文言を、実行中のツールに応じた進行形にする（2026-07-31 本人要望
  // 「ファイルを読んでます、とか出せない？」）。最後のアシスタントメッセージ末尾から、
  // まだ結果が返っていないツールパートを探す
  const workingLabel = (() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return "考え中";
    for (let i = last.parts.length - 1; i >= 0; i--) {
      const p = last.parts[i];
      if (p.type === "dynamic-tool" && p.state !== "output-available" && p.state !== "output-error") {
        return toolActivityLabel(p.toolName);
      }
    }
    return "考え中";
  })();

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, busy]);

  // メッセージが変わるたびに該当ページの履歴としてサーバへ保存する（応答中は流れるので
  // 完了時=busyでない時だけ。ロード完了前のページは保存しない）
  useEffect(() => {
    if (busy) return;
    if (loadedKeyRef.current !== chatKeyOf(pageId)) return;
    saveHistory(pageId, messages);
  }, [messages, pageId, busy]);

  // 「新しい会話」: 現在の会話が空でなければアーカイブへ退避してから空にする
  // （2026-07-31 本人要望。旧「履歴をクリア」は消して終わりだったが、アーカイブして
  // 履歴タブから読み返せるようにする）
  const startNewChat = async () => {
    if (busy || startingNewChat) return;
    setStartingNewChat(true);
    try {
      if (messages.length > 0) {
        const ok = await archiveCurrentChat(pageId, messages);
        if (!ok) {
          pushToast("履歴の保存に失敗しました", "error");
          return;
        }
        pushToast("会話を履歴へ移しました", "info");
      }
      setMessages([]);
      saveHistory(pageId, []);
      setTab("talk");
    } finally {
      setStartingNewChat(false);
    }
  };

  // 履歴タブの行クリック: そのセッションを会話タブへ読み込む（以後は続きとして会話でき、
  // 現行スナップショットとして上書き保存される＝上の messages 変更 effect が担う）
  const loadArchiveSession = (session: ArchiveSession) => {
    if (busy) return;
    setMessages(session.messages);
    setTab("talk");
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage({ text }, { body: { pageId, selectedNodeId } });
  };

  return (
    <div
      // data-shortcuts-block: グラフのキーボードショートカット(GraphView)を無効化する目印
      // （このドロワーは role="dialog" を持たない素の常設パネルのため、入力欄以外にも及ぶよう明示する）
      data-shortcuts-block
      className="relative flex flex-shrink-0 flex-col overflow-hidden border-l bg-background"
      style={{ width }}
    >
      <div className="resize-handle resize-handle-left" onPointerDown={(e) => startResize(e, -1)} />
      <div className="flex flex-shrink-0 items-center gap-2 border-b px-4 py-3">
        <span className="inline-flex items-center gap-2 font-semibold">
          <Icon name="chat" size={15} /> Workflow AI
        </span>
        {pageTitle && (
          <span className="min-w-0 flex-1 truncate text-right text-sm text-muted-foreground">{pageTitle}</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="flex-shrink-0 text-muted-foreground"
          disabled={busy || startingNewChat}
          onClick={() => void startNewChat()}
        >
          新しい会話
        </Button>
        <Button type="button" variant="ghost" size="icon" onClick={onClose}>
          <Icon name="x" size={15} />
        </Button>
      </div>
      <div className="flex flex-shrink-0 items-center border-b px-4 py-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "talk" | "history")}>
          <TabsList>
            <TabsTrigger value="talk">
              <MessageSquare className="size-3.5" /> 会話
            </TabsTrigger>
            <TabsTrigger value="history">
              <History className="size-3.5" /> 履歴
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {tab === "talk" ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" ref={bodyRef}>
            {messages.length === 0 && !error && (
              <div className="py-2 text-sm text-muted-foreground">グラフの整理を話しかけてみてください</div>
            )}
            {messages.map((m) => (
              <ChatMessageView key={m.id} message={m} />
            ))}
            {busy && (
              <div className="flex items-center gap-1.5 self-start px-1 py-1 text-sm text-text-lo">
                <span className="animate-pulse">✳</span>
                <span>{workingLabel}</span>
                <span className="inline-flex items-center gap-0.5">
                  <span
                    className="size-1 animate-bounce rounded-full bg-text-lo"
                    style={{ animationDelay: "0ms" }}
                  />
                  <span
                    className="size-1 animate-bounce rounded-full bg-text-lo"
                    style={{ animationDelay: "150ms" }}
                  />
                  <span
                    className="size-1 animate-bounce rounded-full bg-text-lo"
                    style={{ animationDelay: "300ms" }}
                  />
                </span>
              </div>
            )}
            {error && (
              <div className="self-stretch whitespace-pre-wrap rounded-md border border-destructive/35 bg-destructive/[0.08] px-3 py-2 text-sm text-destructive">
                {formatChatError(error)}
              </div>
            )}
          </div>
          <div className="flex flex-shrink-0 items-end gap-2 border-t p-4">
            <Textarea
              className="flex-1 resize-y"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="メッセージを入力…（Enter で送信 / Shift+Enter で改行）"
              rows={2}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey) return;
                e.preventDefault();
                send();
              }}
            />
            {busy ? (
              <Button type="button" variant="secondary" size="icon" onClick={() => stop()} title="停止">
                <Icon name="x" size={15} />
              </Button>
            ) : (
              <Button type="button" variant="secondary" size="icon" disabled={!input.trim()} onClick={send}>
                <Icon name="send" size={15} />
              </Button>
            )}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
          {archiveLoading && <div className="p-2 text-sm text-muted-foreground">読み込み中…</div>}
          {!archiveLoading && archiveSessions.length === 0 && (
            <div className="p-2 text-sm text-muted-foreground">まだありません</div>
          )}
          {!archiveLoading &&
            archiveSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                disabled={busy}
                className="flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => loadArchiveSession(session)}
              >
                <span className="text-xs text-muted-foreground">
                  {new Date(session.ts).toLocaleString("ja-JP")} ・ {session.messages.length}件
                </span>
                <span className="truncate">{firstUserPreview(session.messages)}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
