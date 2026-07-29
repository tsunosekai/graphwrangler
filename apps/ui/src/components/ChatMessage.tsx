// 内蔵チャット（M4）のメッセージ型 + 1メッセージ分の表示。
// UIMessage(AI SDK v5系)の最小形（id/role/parts）を手で再現している。
// ai パッケージは apps/ui の依存に無い（pnpm add 禁止）ため、SSE パースも含め自前実装。
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

export type ChatTextPart = { type: "text"; text: string; state?: "streaming" | "done" };

export type ChatToolPart = {
  type: "dynamic-tool";
  toolCallId: string;
  toolName: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export type ChatPart = ChatTextPart | ChatToolPart;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: ChatPart[];
}

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
    default:
      label = part.toolName;
  }
  if (part.state === "output-error") return `${label}（失敗: ${part.errorText ?? "不明なエラー"}）`;
  if (part.state !== "output-available") return `${label} …`;
  return label;
}

export function ChatMessageView({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex max-w-[90%] flex-col gap-1.5", isUser ? "self-end" : "self-start")}>
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          if (!part.text) return null;
          return (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-words rounded-md border bg-card px-3 py-2 text-sm",
                isUser ? "border-human/40" : "border-ai/40",
              )}
            >
              {part.text}
            </div>
          );
        }
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
      })}
    </div>
  );
}
