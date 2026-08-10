// 内蔵チャット（グラフ整理の GraphWrangler AI）。TopBar の 💬 から開く右ドロワー。
// @ai-sdk/react の useChat + ai の DefaultChatTransport で UIMessageStream(SSE) を処理する。
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { History, MessageSquare, SquarePen } from "lucide-react";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { pushToast } from "../lib/toast";
import { Button } from "./ui/button";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { ChatComposer, ThinkingIndicator } from "./ChatComposer";
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

/** 履歴を読む。**失敗（ネットワーク・非2xx）は null** で返し、空配列と区別する——
 *  失敗を [] と同一視すると、その後の保存で過去の会話が空で上書きされる
 *  （2026-08-07「Wrangler AI の記憶が無くなる」の一因） */
async function loadHistory(): Promise<UIMessage[] | null> {
  try {
    const res = await fetch(`/api/chats/${CHAT_KEY}`);
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.messages) ? (data.messages as UIMessage[]) : [];
  } catch {
    return null;
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

  // モデル/エフォートの切り替え（2026-08-07 本人要望）。この端末の選択として記憶し、
  // 送信のたびに body で渡す（null = ⚙の既定に従う）。入力欄・添付・音声入力の実体は
  // ChatComposer（Thread と共通。2026-08-07「UI を分けずに同じコンポーネントに」）
  const [chatModel, setChatModel] = useState<string | null>(() => localStorage.getItem("gw.chatModel"));
  const [chatEffort, setChatEffort] = useState<string | null>(() => localStorage.getItem("gw.chatEffort"));
  useEffect(() => {
    if (chatModel) localStorage.setItem("gw.chatModel", chatModel);
    else localStorage.removeItem("gw.chatModel");
  }, [chatModel]);
  useEffect(() => {
    if (chatEffort) localStorage.setItem("gw.chatEffort", chatEffort);
    else localStorage.removeItem("gw.chatEffort");
  }, [chatEffort]);

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

  // 「この画面で会話が進んだか」。**進んでいないなら保存しない**——複数タブ・複数端末で
  // 開いているとき、古い履歴しか持たない画面の閉じ際保存が最新の会話を巻き戻していた
  // （last-write-wins。2026-08-07「記憶が無くなる」のもう一つの経路）
  const dirtyRef = useRef(false);

  // 「最後に見た messages」の控え。ストリーミング中は下の保存 effect がスキップするため、
  // 応答中にドロワーを閉じる（アンマウント）と会話が未保存のまま消えることがある
  // （2026-08-01 の会話消失バグの同型）。アンマウントのクリーンアップで必ず保存する。
  // 応答ストリーミング中なら途中までの内容が保存される（何も残らないより途中まで
  // 残るほうがよい。ストリームの残りはサーバ側で完走するが本文は拾えない既知の制限）
  const lastMessagesRef = useRef<UIMessage[]>([]);
  useEffect(() => {
    lastMessagesRef.current = messages;
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";
  // ロード再試行の setTimeout コールバック（下の effect）から最新の busy を読むための控え
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // マウント時にサーバから履歴を読み込む（保存は下の messages 変更 effect が担う。
  // 読み込み完了までの間に保存しないよう、ロード済みフラグを追跡する）。
  // 読み込みに失敗したら**成功するまで保存を解禁しない**まま5秒おきに再試行する
  // （失敗を空履歴と同一視して会話がまっさらに見え、そのまま話し始めると過去の履歴が
  // 上書きで消えていた——2026-08-07「記憶が無くなる」対策）。
  // 再試行の成功時、ロード完了前にこの画面で会話が始まっていることがある（送信は
  // ロード完了を待たない）。そのまま setMessages(history) すると進行中の会話が
  // 巻き戻るため、応答の生成中なら差し替えずに読み直しへ回し、会話が進んでいる
  // （dirty）ならサーバ履歴を前置して合流させる——どちらの会話も失わない
  const loadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    loadedRef.current = false;
    const attempt = (first: boolean) => {
      void loadHistory().then((history) => {
        if (cancelled) return;
        if (history === null) {
          if (first) pushToast("チャット履歴の読み込みに失敗しました。再試行します", "error");
          timer = window.setTimeout(() => attempt(false), 5000);
          return;
        }
        if (busyRef.current) {
          // ストリーミング中の差し替えは応答本文ごと消してしまう。落ち着いてから読み直す
          timer = window.setTimeout(() => attempt(false), 5000);
          return;
        }
        if (dirtyRef.current) {
          setMessages([...history, ...lastMessagesRef.current]);
        } else {
          setMessages(history);
        }
        loadedRef.current = true;
      });
    };
    attempt(true);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // setMessages は useChat の安定参照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (!loadedRef.current || !dirtyRef.current) return; // ロード前/会話が進んでいない（上書き事故を防ぐ）
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

  // 追従スクロールは「最下部付近にいる間だけ」（2026-08-07 本人要望「スクロールを改善」。
  // 旧: 新着のたび無条件で最下部へ——上に遡って読んでいても引き戻されていた）。
  // 自分が送信したときは位置に関わらず最下部へ戻す（submit が stick を立てる）
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, busy]);

  // メッセージが変わるたびにグローバル履歴としてサーバへ保存する（ロード完了前は保存しない）。
  // 応答ストリーミング中も2秒間隔で間引き保存する——ブラウザのリロード/タブ閉じでは React の
  // アンマウントクリーンアップが走らないため、完了時だけの保存だと応答中のリロードで
  // 送信ごと会話が消えていた（2026-08-02 本人指摘「リロード耐性についてチェック」で発覚）
  const lastSaveAtRef = useRef(0);
  const pendingSaveRef = useRef<number | null>(null);
  useEffect(() => {
    if (!loadedRef.current || !dirtyRef.current) return;
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
      if (!loadedRef.current || !dirtyRef.current || lastMessagesRef.current.length === 0) return;
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
      dirtyRef.current = false; // 空を明示保存済み。以後は次の送信まで保存不要
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
    dirtyRef.current = true; // 読み込んだセッションを現行スナップショットとして保存する（従来挙動）
    stickToBottomRef.current = true;
    setTab("talk");
  };

  // 送信予約（2026-08-05 本人要望「送信予約で話しかける機能」）: 応答中でも書いて送れる。
  // 送った分は**予約**として溜め、応答が終わり次第まとめて1通で送る（途中で割り込むと
  // 今の応答が無駄になるため）。すぐ割り込みたいときは「止めて送る」（Ctrl/⌘+Enter）
  const [queued, setQueued] = useState<string | null>(null);
  const queuedRef = useRef<string | null>(null);
  useEffect(() => {
    queuedRef.current = queued;
  }, [queued]);

  const submit = (text: string) => {
    dirtyRef.current = true; // この画面で会話が進んだ＝以後の保存を解禁
    stickToBottomRef.current = true; // 自分の送信では最下部へ戻す
    void sendMessage(
      { text },
      // model/effort はこの会話での上書き（null = ⚙の既定。2026-08-07）
      { body: { pageId, selectedNodeId, model: chatModel, effort: chatEffort } },
    );
  };

  // 応答が終わったら、溜まっていた送信予約を送る
  useEffect(() => {
    if (busy) return;
    const text = queuedRef.current;
    if (!text) return;
    setQueued(null);
    submit(text);
    // submit / busy 以外に依存しない（queued は ref で読む＝送信のたびの再実行を避ける）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  /** ChatComposer から組み立て済み本文（添付行込み）を受けて送る。応答中は予約に足し、
   *  応答が終わり次第まとめて1通で送る */
  const send = (full: string) => {
    if (busy) {
      setQueued((prev) => (prev ? `${prev}\n${full}` : full));
      return;
    }
    submit(full);
  };

  /** 今の応答を打ち切って、書いた内容をすぐ送る（Ctrl/⌘+Enter） */
  const stopAndSend = (full: string) => {
    stop();
    const merged = queuedRef.current ? `${queuedRef.current}\n${full}` : full;
    setQueued(null);
    // stop() の反映（status が ready に落ちる）を待ってから送る
    setTimeout(() => submit(merged), 50);
  };

  return (
    <div
      // data-shortcuts-block: グラフのキーボードショートカット(GraphView)を無効化する目印
      // （このドロワーは role="dialog" を持たない素の常設パネルのため、入力欄以外にも及ぶよう明示する）
      data-shortcuts-block
      data-mobile-panel="right"
      // overflow-hidden はルートに付けない（リサイズハンドルの外側半分が切られる。2026-08-07）
      className="relative flex flex-shrink-0 flex-col border-l bg-background"
      style={{ width }}
    >
      <div className="resize-handle resize-handle-left" onPointerDown={(e) => startResize(e, -1)} />
      {/* ヘッダー行に下線は付けない（2026-08-03 本人指定「この線は不要」） */}
      <div className="flex flex-shrink-0 items-center gap-2 px-4 py-3">
        <span className="inline-flex items-center gap-2 font-semibold">
          <Icon name="chat" size={15} /> GraphWrangler AI
        </span>
        {pageTitle && (
          <span className="min-w-0 flex-1 truncate text-right text-sm text-muted-foreground">{pageTitle}</span>
        )}
        {/* 「新しい会話」はアイコン化（2026-08-07 文字削減。説明は title） */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="flex-shrink-0 text-muted-foreground"
          title="新しい会話（今の会話は履歴へ移す）"
          disabled={busy || startingNewChat}
          onClick={() => void startNewChat()}
        >
          <SquarePen className="size-5" />
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
          <div
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 pt-3"
            ref={bodyRef}
            onScroll={() => {
              const el = bodyRef.current;
              if (!el) return;
              // 48px の遊び: ストリーミング中の行送りでわずかに離れても追従を切らない
              stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
          >
            {messages.length === 0 && !error && (
              <div className="py-2 text-sm text-text-lo">グラフの整理を話しかけてみてください</div>
            )}
            {messages.map((m) => (
              <ChatMessageView key={m.id} message={m} />
            ))}
            {busy && <ThinkingIndicator label={workingLabel} />}
            {error && (
              <div className="self-stretch whitespace-pre-wrap rounded-md border border-destructive/35 bg-destructive/[0.08] px-3 py-2 text-sm text-destructive">
                {formatChatError(error)}
              </div>
            )}
          </div>
          {/* 入力欄は ChatComposer（Thread=Task AI と共通。2026-08-07 本人要望
              「UI を分けずに同じコンポーネントに」）。見た目・添付・音声入力の変更は
              ChatComposer 側で行うこと */}
          <div className="mx-4 mb-4 flex-shrink-0">
            <ChatComposer
              value={input}
              onChange={setInput}
              busy={busy}
              onSend={send}
              onStop={() => stop()}
              onStopAndSend={stopAndSend}
              queued={queued}
              onCancelQueued={() => setQueued(null)}
              placeholderIdle="メッセージを入力…"
              placeholderBusy="続けて入力…（応答後に送信）"
              model={chatModel}
              onModelChange={setChatModel}
              effort={chatEffort}
              onEffortChange={setChatEffort}
            />
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
