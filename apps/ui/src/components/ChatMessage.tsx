// 内蔵チャット（Workflow AI）の1メッセージ分の表示。
// 型は AI SDK v5系（ai / @ai-sdk/react）の UIMessage / UIMessagePart をそのまま使う。
import type { UIMessage, UIMessagePart, UIDataTypes, UITools } from "ai";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

type ChatToolPart = Extract<UIMessagePart<UIDataTypes, UITools>, { type: "dynamic-tool" }>;

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "title" in v && typeof (v as { title?: unknown }).title === "string") {
    return (v as { title: string }).title;
  }
  return "";
}

function idOf(v: unknown): string {
  if (v && typeof v === "object" && "id" in v && typeof (v as { id?: unknown }).id === "string") {
    return (v as { id: string }).id;
  }
  return "?";
}

/** Read / read_file の入力からファイル名（末尾要素）を取り出す */
function fileLabel(input: unknown): string {
  const o = input as Record<string, unknown> | undefined;
  const p = (o?.file_path ?? o?.path) as string | undefined;
  if (typeof p !== "string" || !p) return "?";
  return p.split(/[\\/]/).pop() ?? p;
}

/** 「考え中」インジケータ用: 実行中ツールの進行形ラベル（2026-07-31 本人要望
 *  「ファイルを読んでます、とか出せない？」）。ChatDrawer が使う */
export function toolActivityLabel(toolName: string): string {
  switch (toolName) {
    case "Read":
    case "read_file":
      return "ファイルを読んでいます";
    case "Grep":
    case "Glob":
      return "ファイルを探しています";
    case "get_state":
      return "グラフを確認しています";
    case "get_thread":
      return "スレッドを確認しています";
    case "add_node":
      return "ノードを作成しています";
    case "patch_node":
      return "ノードを更新しています";
    case "remove_node":
      return "ノードを削除しています";
    case "post_message":
      return "スレッドに投稿しています";
    default:
      return `${toolName} を実行しています`;
  }
}

/** ツール呼び出しを「⚙ ノードを作成: タイトル」のような1行サマリに要約する */
function toolSummary(part: ChatToolPart): string {
  const input = part.input as Record<string, unknown> | undefined;
  let label: string;
  switch (part.toolName) {
    case "add_node":
      label = `ノードを作成: ${str(input?.title)}`;
      break;
    case "patch_node":
      label = `ノードを更新: ${idOf(input)}`;
      break;
    case "remove_node":
      label = `ノードを削除: ${idOf(input)}`;
      break;
    case "get_state":
      label = "グラフの状態を確認";
      break;
    case "get_thread":
      label = `スレッドを確認: ${input && typeof input.nodeId === "string" ? input.nodeId : "?"}`;
      break;
    case "post_message":
      label = `スレッドに投稿: ${input && typeof input.nodeId === "string" ? input.nodeId : "?"}`;
      break;
    // CLI 方式で許可している読み取り専用ツール（chat_cli.ts の --allowedTools）
    case "Read":
    case "read_file":
      label = `ファイルを読む: ${fileLabel(input)}`;
      break;
    case "Grep":
      label = `検索: ${input && typeof input.pattern === "string" ? input.pattern : "?"}`;
      break;
    case "Glob":
      label = `ファイル探索: ${input && typeof input.pattern === "string" ? input.pattern : "?"}`;
      break;
    default:
      label = part.toolName;
  }
  if (part.state === "output-error") return `${label}（失敗: ${part.errorText ?? "不明なエラー"}）`;
  if (part.state !== "output-available") return `${label} …`;
  return label;
}

export function ChatMessageView({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex max-w-[90%] flex-col gap-1.5", isUser ? "self-end" : "self-start")}>
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          if (!part.text) return null;
          // アシスタントの本文はマークダウンで描画（2026-07-31 本人要望）。
          // ユーザー発言は入力そのまま（whitespace-pre-wrap）
          return (
            <div
              key={i}
              className={cn(
                "break-words rounded-md border bg-card px-3 py-2 text-sm",
                isUser ? "whitespace-pre-wrap border-human/40" : "chat-md border-ai/40",
              )}
            >
              {isUser ? part.text : <Markdown remarkPlugins={[remarkGfm]}>{part.text}</Markdown>}
            </div>
          );
        }
        if (part.type === "reasoning") {
          // 独り言（思考の合間のテキスト）。Claude Code に寄せ、吹き出しにはせず減光イタリックで
          // 流す。中身はマークダウンとして描画する（2026-08-01 本人要望「markdown が正しく
          // レンダリングされるように」——見出しやリストが記号のまま見えていた）
          if (!part.text) return null;
          return (
            <div key={i} className="chat-md break-words px-3 py-0.5 text-sm italic text-text-lo">
              <Markdown remarkPlugins={[remarkGfm]}>{part.text}</Markdown>
            </div>
          );
        }
        if (part.type === "dynamic-tool") {
          return (
            <Badge
              key={part.toolCallId}
              variant="outline"
              className={cn(
                "self-start",
                part.state === "output-error"
                  ? "border-destructive/35 bg-destructive/[0.08] text-destructive"
                  : "border-ai/25 bg-ai/[0.08] text-muted-foreground",
              )}
            >
              ⚙ {toolSummary(part)}
            </Badge>
          );
        }
        return null;
      })}
    </div>
  );
}
