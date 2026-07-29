// 内蔵チャット（M4: グラフ整理の相棒AI）。TopBar の 💬 から開く右ドロワー。
// AI SDK の useChat は使わず、fetch + ReadableStream で UIMessageStream(SSE) を素朴にパースする
// （ai パッケージは apps/ui の依存に無い。pnpm add 禁止のため自前実装、docs/agent-contracts.md）。
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { ChatMessageView, type ChatMessage, type ChatPart, type ChatToolPart } from "./ChatMessage";
import { Icon } from "./Icon";

interface Props {
  pageId: string | null;
  pageTitle: string | null;
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

export function ChatDrawer({ pageId, pageTitle, onMutated, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, banner]);

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
      const body = await api.chatStream(history, pageId);
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
    <div className="chat-drawer">
      <div className="chat-drawer-head">
        <span className="chat-drawer-title">
          <Icon name="chat" size={13} /> 相棒AI
        </span>
        {pageTitle && <span className="chat-drawer-page">{pageTitle}</span>}
        <button type="button" className="chat-drawer-close" onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="chat-drawer-body" ref={bodyRef}>
        {messages.length === 0 && !banner && (
          <div className="chat-drawer-empty">グラフの整理を話しかけてみてください</div>
        )}
        {messages.map((m) => (
          <ChatMessageView key={m.id} message={m} />
        ))}
        {banner && <div className="chat-drawer-banner">{banner}</div>}
      </div>
      <div className="chat-drawer-input">
        <textarea
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
        <button type="button" disabled={sending || !input.trim()} onClick={send}>
          <Icon name="send" size={13} />
        </button>
      </div>
    </div>
  );
}
