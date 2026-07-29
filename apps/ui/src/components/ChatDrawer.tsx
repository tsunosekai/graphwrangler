// 内蔵チャット（M4: グラフ整理の相棒AI）。TopBar の 💬 から開く右ドロワー。
// AI SDK の useChat は使わず、fetch + ReadableStream で UIMessageStream(SSE) を素朴にパースする
// （ai パッケージは apps/ui の依存に無い。pnpm add 禁止のため自前実装、docs/agent-contracts.md）。
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { ChatMessageView, type ChatMessage, type ChatPart, type ChatToolPart } from "./ChatMessage";
import { Icon } from "./Icon";

interface Props {
  pageId: string | null;
  pageTitle: string | null;
  /** 選択中ノード（あれば）。チャットへ渡し「これ」で通じるようにする */
  selectedNodeId: string | null;
  onMutated: () => void;
  onClose: () => void;
}

/** サーバは "data: {...}\n\n" 区切りの SSE (末尾 "data: [DONE]") を返す（ai の toUIMessageStreamResponse） */
async function readSse(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Record<string, unknown>) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const block of blocks) {
      const line = block.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        onChunk(JSON.parse(payload));
      } catch {
        // 壊れた行は無視
      }
    }
  }
}

// B-7: チャット履歴の永続化。ページ（or グローバル）ごとに localStorage へ保存する
function storageKey(pageId: string | null): string {
  return `gw.chat.${pageId ?? "global"}`;
}

export function ChatDrawer({ pageId, pageTitle, selectedNodeId, onMutated, onClose }: Props) {
  const [width, startResize] = useResizableWidth("chatW", 360, 300, 640);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // pageId が変わった直後の1回だけ、永続化effectが読み込み直後の内容を再書き込みするのを許す
  // （読み込みそのものを無効化するわけではない。二重書き込みは無害）
  const loadingRef = useRef(false);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, banner]);

  // ページ切替時に該当ページの履歴を読み込む
  useEffect(() => {
    loadingRef.current = true;
    try {
      const raw = localStorage.getItem(storageKey(pageId));
      setMessages(raw ? (JSON.parse(raw) as ChatMessage[]) : []);
    } catch {
      setMessages([]);
    }
  }, [pageId]);

  // メッセージが変わるたびに保存する
  useEffect(() => {
    if (loadingRef.current) {
      loadingRef.current = false;
      return;
    }
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

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setBanner(null);
    setInput("");
    setSending(true);

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text }] };
    const history = [...messages, userMsg];
    let assistant: ChatMessage = { id: `a-${Date.now()}`, role: "assistant", parts: [] };
    setMessages([...history, assistant]);

    const textIds = new Map<string, number>();
    const toolIds = new Map<string, number>();

    const flush = () => setMessages([...history, assistant]);

    const patchPart = (idx: number, patch: Partial<ChatPart>) => {
      const parts = [...assistant.parts];
      parts[idx] = { ...parts[idx], ...patch } as ChatPart;
      assistant = { ...assistant, parts };
    };

    const ensureTool = (toolCallId: string, toolName: string): number => {
      let idx = toolIds.get(toolCallId);
      if (idx === undefined) {
        const part: ChatToolPart = { type: "dynamic-tool", toolCallId, toolName, state: "input-streaming" };
        assistant = { ...assistant, parts: [...assistant.parts, part] };
        idx = assistant.parts.length - 1;
        toolIds.set(toolCallId, idx);
      }
      return idx;
    };

    const applyChunk = (chunk: Record<string, unknown>) => {
      switch (chunk.type) {
        case "text-start": {
          assistant = { ...assistant, parts: [...assistant.parts, { type: "text", text: "", state: "streaming" }] };
          textIds.set(chunk.id as string, assistant.parts.length - 1);
          break;
        }
        case "text-delta": {
          const idx = textIds.get(chunk.id as string);
          if (idx === undefined) break;
          const cur = assistant.parts[idx] as { type: "text"; text: string };
          patchPart(idx, { text: cur.text + (chunk.delta as string) });
          break;
        }
        case "text-end": {
          const idx = textIds.get(chunk.id as string);
          if (idx !== undefined) patchPart(idx, { state: "done" });
          break;
        }
        case "tool-input-start": {
          ensureTool(chunk.toolCallId as string, chunk.toolName as string);
          break;
        }
        case "tool-input-available": {
          const idx = ensureTool(chunk.toolCallId as string, chunk.toolName as string);
          patchPart(idx, { state: "input-available", input: chunk.input });
          break;
        }
        case "tool-input-error": {
          const idx = ensureTool(chunk.toolCallId as string, chunk.toolName as string);
          patchPart(idx, { state: "output-error", input: chunk.input, errorText: chunk.errorText as string });
          break;
        }
        case "tool-output-available": {
          const idx = toolIds.get(chunk.toolCallId as string);
          if (idx !== undefined) patchPart(idx, { state: "output-available", output: chunk.output });
          break;
        }
        case "tool-output-error": {
          const idx = toolIds.get(chunk.toolCallId as string);
          if (idx !== undefined) patchPart(idx, { state: "output-error", errorText: chunk.errorText as string });
          break;
        }
        case "error": {
          setBanner((chunk.errorText as string) ?? "チャットでエラーが発生しました");
          break;
        }
        default:
          break;
      }
    };

    try {
      const body = await api.chatStream(history, pageId, selectedNodeId);
      await readSse(body, (chunk) => {
        applyChunk(chunk);
        flush();
      });
    } catch (err) {
      setBanner(err instanceof ApiError ? err.message : "通信エラーが発生しました");
    } finally {
      setSending(false);
      onMutated();
    }
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
          <Icon name="chat" size={15} /> 相棒AI
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
        {messages.length === 0 && !banner && (
          <div className="py-2 text-sm text-muted-foreground">グラフの整理を話しかけてみてください</div>
        )}
        {messages.map((m) => (
          <ChatMessageView key={m.id} message={m} />
        ))}
        {banner && (
          <div className="self-stretch whitespace-pre-wrap rounded-md border border-destructive/35 bg-destructive/[0.08] px-3 py-2 text-sm text-destructive">
            {banner}
          </div>
        )}
      </div>
      <div className="flex flex-shrink-0 items-end gap-2 border-t p-4">
        <Textarea
          className="flex-1 resize-y"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="メッセージを入力... (Ctrl/Cmd+Enter で送信)"
          rows={2}
          disabled={sending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button type="button" variant="secondary" size="icon" disabled={sending || !input.trim()} onClick={send}>
          <Icon name="send" size={15} />
        </Button>
      </div>
    </div>
  );
}
