// 内蔵チャット（グラフ整理の Workflow AI）。TopBar の 💬 から開く右ドロワー。
// @ai-sdk/react の useChat + ai の DefaultChatTransport で UIMessageStream(SSE) を処理する。
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

// チャット履歴の永続化はサーバ（sidecar/chats/global.json、コミット対象）。
// localStorage 保存は廃止（2026-07-31 本人要望「会話履歴も見れるように」——ブラウザ縛りを
// やめ、スレッドと同じく経緯ごと版管理する）。
// 2026-08-02 本人要望「プロジェクトを別でチャットが別れないようにして」: 会話はページ別に
// 分けず、常に1本のグローバル会話にする（chats/global.json のみ使用。旧 chats/<pageId>.json は
// 遺構として残るが読み書きしない）。ページの文脈は送信のたびに body.pageId で渡るため、
// 会話を切り替えなくても「今見ているページの話」として続けられる
const CHAT_KEY = "global";

async function loadHistory(): Promise<UIMessage[]> {
  try {
    const res = await fetch(`/api/chats/${CHAT_KEY}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.messages) ? (data.messages as UIMessage[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(messages: UIMessage[]): void {
  void fetch(`/api/chats/${CHAT_KEY}`, {
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
async function archiveCurrentChat(messages: UIMessage[]): Promise<boolean> {
  try {
    const res = await fetch(`/api/chats/${CHAT_KEY}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadArchive(): Promise<ArchiveSession[]> {
  try {
    const res = await fetch(`/api/chats/${CHAT_KEY}/archive`);
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

  // 会話は1本のグローバル会話（2026-08-02 本人要望「プロジェクトを別でチャットが
  // 別れないようにして」）。id を固定することでページを切り替えても useChat の
  // Chat インスタンスは作り直されず、会話がそのまま続く。ページの文脈は send() が
  // 送信のたびに body.pageId で渡す
  const { messages, setMessages, sendMessage, status, error, stop } = useChat({
    id: CHAT_KEY,
    transport,
    onFinish: () => onMutated(),
  });

  // マウント時にサーバから履歴を読み込む（保存は下の messages 変更 effect が担う。
  // 読み込み完了までの間に保存しないよう、ロード済みフラグを追跡する）
  const loadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    void loadHistory().then((history) => {
      if (cancelled) return;
      setMessages(history);
      loadedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
    // setMessages は useChat の安定参照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 「最後に見た messages」の控え。ストリーミング中は下の保存 effect がスキップするため、
  // 応答中にドロワーを閉じる（アンマウント）と会話が未保存のまま消えることがある
  // （2026-08-01 の会話消失バグの同型）。アンマウントのクリーンアップで必ず保存する。
  // 応答ストリーミング中なら途中までの内容が保存される（何も残らないより途中まで
  // 残るほうがよい。ストリームの残りはサーバ側で完走するが本文は拾えない既知の制限）
  const lastMessagesRef = useRef<UIMessage[]>([]);
  useEffect(() => {
    lastMessagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    return () => {
      if (!loadedRef.current) return; // ロード完了前に閉じた（上書き事故を防ぐ）
      if (lastMessagesRef.current.length > 0) saveHistory(lastMessagesRef.current);
    };
  }, []);

  // 履歴タブを開くたびにサーバから最新のアーカイブ一覧を読み込む
  useEffect(() => {
    if (tab !== "history") return;
    let cancelled = false;
    setArchiveLoading(true);
    void loadArchive().then((sessions) => {
      if (cancelled) return;
      setArchiveSessions(sessions);
      setArchiveLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [tab]);

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

  // メッセージが変わるたびにグローバル履歴としてサーバへ保存する（ロード完了前は保存しない）。
  // 応答ストリーミング中も2秒間隔で間引き保存する——ブラウザのリロード/タブ閉じでは React の
  // アンマウントクリーンアップが走らないため、完了時だけの保存だと応答中のリロードで
  // 送信ごと会話が消えていた（2026-08-02 本人指摘「リロード耐性についてチェック」で発覚）
  const lastSaveAtRef = useRef(0);
  const pendingSaveRef = useRef<number | null>(null);
  useEffect(() => {
    if (!loadedRef.current) return;
    const doSave = () => {
      lastSaveAtRef.current = Date.now();
      saveHistory(lastMessagesRef.current);
    };
    if (!busy) {
      if (pendingSaveRef.current !== null) {
        clearTimeout(pendingSaveRef.current);
        pendingSaveRef.current = null;
      }
      doSave();
      return;
    }
    const since = Date.now() - lastSaveAtRef.current;
    if (since >= 2000) {
      doSave();
      return;
    }
    if (pendingSaveRef.current === null) {
      pendingSaveRef.current = window.setTimeout(() => {
        pendingSaveRef.current = null;
        doSave();
      }, 2000 - since);
    }
  }, [messages, busy]);
  useEffect(() => {
    return () => {
      if (pendingSaveRef.current !== null) clearTimeout(pendingSaveRef.current);
    };
  }, []);

  // リロード/タブ閉じの直前の最終保存（best-effort）。keepalive はボディ 64KiB 上限があるため
  // 長い履歴では送れないことがあるが、その場合も上の2秒間引き保存が直近状態を押さえている
  useEffect(() => {
    const onPageHide = () => {
      if (!loadedRef.current || lastMessagesRef.current.length === 0) return;
      try {
        void fetch(`/api/chats/${CHAT_KEY}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: lastMessagesRef.current }),
          keepalive: true,
        });
      } catch {
        // best-effort
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // 「新しい会話」: 現在の会話が空でなければアーカイブへ退避してから空にする
  // （2026-07-31 本人要望。旧「履歴をクリア」は消して終わりだったが、アーカイブして
  // 履歴タブから読み返せるようにする）
  const startNewChat = async () => {
    if (busy || startingNewChat) return;
    setStartingNewChat(true);
    try {
      if (messages.length > 0) {
        const ok = await archiveCurrentChat(messages);
        if (!ok) {
          pushToast("履歴の保存に失敗しました", "error");
          return;
        }
        pushToast("会話を履歴へ移しました", "info");
      }
      setMessages([]);
      saveHistory([]);
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
      data-mobile-panel="right"
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
      {/* タブ行に下線は付けない・タブ下の余白は NodePanel=Task AI 側の gap-3(12px) に揃える
          （本人指定）。タブ行は下パディング無しにし、下の各コンテナが pt-3 を持つ */}
      <div className="flex flex-shrink-0 items-center px-4 pt-2">
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
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 pt-3" ref={bodyRef}>
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
          {/* 入力欄は NodePanel（Task AI）の返信欄と同じ見た目に揃える（境界線なし・テキストボタン。
              2026-08-01 本人指摘「線が要らない・2つのチャットを合わせて」） */}
          <div className="flex flex-shrink-0 items-end gap-2 px-4 pb-4">
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
              <Button type="button" variant="secondary" onClick={() => stop()} title="応答を止める">
                停止
              </Button>
            ) : (
              <Button type="button" variant="secondary" disabled={!input.trim()} onClick={send}>
                送信
              </Button>
            )}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2 pt-3">
          {/* 今の会話は話し始めた瞬間からここに出す（2026-08-02 本人要望「チャット履歴は
              話し始めた瞬間に生成してほしい。無いのが不安になる」）。実体は送信の瞬間から
              サーバへ保存済みで、これはその見える化。クリックで会話タブへ戻る */}
          {messages.length > 0 && (
            <button
              type="button"
              className="flex flex-col gap-0.5 rounded-md border border-ai/40 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
              onClick={() => setTab("talk")}
            >
              <span className="text-xs text-ai">今の会話 ・ {messages.length}件（保存済み）</span>
              <span className="truncate">{firstUserPreview(messages)}</span>
            </button>
          )}
          {archiveLoading && <div className="p-2 text-sm text-muted-foreground">読み込み中…</div>}
          {!archiveLoading && archiveSessions.length === 0 && messages.length === 0 && (
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
