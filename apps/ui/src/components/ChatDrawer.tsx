// 内蔵チャット（M4: グラフ整理の Workflow AI）。TopBar の 💬 から開く右ドロワー。
// @ai-sdk/react の useChat + ai の DefaultChatTransport で UIMessageStream(SSE) を処理する
// （B-x: Claude Code 風UX化に伴い、自前の fetch+ReadableStream パース(readSse/applyChunk)から
// 移行。ai / @ai-sdk/react は apps/ui の依存としてこのタスクで追加した。
// docs/agent-contracts.md の「pnpm add 禁止」は既定の規律で、依頼元プロンプトで明示許可された例外）。
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { Button } from "./ui/button";
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

// B-7: チャット履歴の永続化。ページ（or グローバル）ごとに localStorage へ保存する
function storageKey(pageId: string | null): string {
  return `gw.chat.${pageId ?? "global"}`;
}

function loadHistory(pageId: string | null): UIMessage[] {
  try {
    const raw = localStorage.getItem(storageKey(pageId));
    return raw ? (JSON.parse(raw) as UIMessage[]) : [];
  } catch {
    return [];
  }
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

  // transportはstatic（apiパスのみ）。pageId/selectedNodeIdは送信のたびにsendMessageのoptions
  // で渡す（最新値を確実に反映するため。transport生成時のクロージャに古い値を焼き込まない）
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat", fetch: chatFetch }), []);

  // id を pageId に紐づけることで、ページ切替時に useChat 内部が Chat インスタンスを
  // 作り直す（=履歴を loadHistory(pageId) で読み込み直す）。旧実装の「pageId変更→useEffectで
  // 読み込み直す」に相当する
  const { messages, setMessages, sendMessage, status, error, stop } = useChat({
    id: pageId ?? "global",
    messages: loadHistory(pageId),
    transport,
    onFinish: () => onMutated(),
  });

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

  // メッセージが変わるたびに該当ページの履歴として保存する
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(pageId), JSON.stringify(messages));
    } catch {
      // 容量超過等は無視（履歴の永続化は補助機能）
    }
  }, [messages, pageId]);

  const clearHistory = () => {
    setMessages([]);
    try {
      localStorage.removeItem(storageKey(pageId));
    } catch {
      // 無視
    }
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
          disabled={messages.length === 0}
          onClick={clearHistory}
        >
          履歴をクリア
        </Button>
        <Button type="button" variant="ghost" size="icon" onClick={onClose}>
          <Icon name="x" size={15} />
        </Button>
      </div>
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
              <span className="size-1 animate-bounce rounded-full bg-text-lo" style={{ animationDelay: "0ms" }} />
              <span className="size-1 animate-bounce rounded-full bg-text-lo" style={{ animationDelay: "150ms" }} />
              <span className="size-1 animate-bounce rounded-full bg-text-lo" style={{ animationDelay: "300ms" }} />
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
    </div>
  );
}
