// claude -p --output-format stream-json --verbose の stdout（1行1 JSON）から、
// 実際に呼ばれたツール（Bash/Edit/Read/Task…）を SubStep として復元する純粋関数群。
// 2026-08-09 追加: 「AI実行の内部で実際に何が行われたか」をノード内ノードとして記録するため
// （packages/core/src/schema.ts の SubStepSchema/subStepsOf がその契約型）。
// server/src/chat_cli.ts も同じ stream-json 行を SSE 中継用にパースしているが、
// 目的（ここは実行後の集計、あちらはリアルタイム中継）と出力形が違うため import で共有せず、
// tool_result の content 取り出し（toolResultText）は同じ実装を意図的に複製する
// （「変えたら両方直す」。engine が server に依存しない方針とも一致）。
import type { SubStep } from "@graphwrangler/core";

export interface StreamTraceResult {
  /** claude が最後に返した result.result（最終テキスト）。result 行が無ければ null */
  output: string | null;
  /** result 行の is_error。result 行が無ければ false */
  isError: boolean;
  subSteps: SubStep[];
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

const TRUNCATE_LIMIT = 2000;
const TITLE_LIMIT = 80;

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

/** tool_result の content（文字列 or ブロック配列）からテキストを取り出す。
 *  server/src/chat_cli.ts の toolResultText と同じ規則（変えたら両方直す） */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** tool_use.input から表示タイトルを作る。主要引数が拾えなければツール名にフォールバックする */
function deriveTitle(tool: string, input: unknown): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  let title: string | undefined;
  switch (tool) {
    case "Bash": {
      const description = asString(obj.description);
      title = description && description.trim() ? description : undefined;
      if (!title) {
        const command = asString(obj.command);
        if (command) title = firstLine(command);
      }
      break;
    }
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      title = asString(obj.file_path);
      break;
    case "Task": {
      const description = asString(obj.description);
      title = description && description.trim() ? description : undefined;
      if (!title) {
        const prompt = asString(obj.prompt);
        if (prompt) title = firstLine(prompt);
      }
      break;
    }
    case "WebSearch":
      title = asString(obj.query);
      break;
    case "WebFetch":
      title = asString(obj.url);
      break;
    case "Grep":
    case "Glob":
      title = asString(obj.pattern);
      break;
    default:
      title = undefined;
  }
  if (!title || !title.trim()) title = tool;
  return truncate(title, TITLE_LIMIT);
}

interface PendingStep {
  id: string;
  index: number;
  tool: string;
  input: unknown;
  matched: boolean;
  isError: boolean;
  resultContent: unknown;
}

/**
 * stream-json（1行1 JSON）を解析し、最終出力と tool_use/tool_result のペアから
 * SubStep 列を作る。壊れた行・空行は黙って読み飛ばす（claude -p はまれに
 * stderr/stdout の混線でJSONでない行を吐くことがある実測あり）。
 */
export function parseStreamJsonOutput(stdout: string): StreamTraceResult {
  const steps: PendingStep[] = [];
  const byId = new Map<string, PendingStep>();
  let output: string | null = null;
  let isError = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const obj = event as { type?: unknown; message?: unknown; result?: unknown; is_error?: unknown };

    if (obj.type === "assistant" || obj.type === "user") {
      const message = obj.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(message?.content) ? (message!.content as ContentBlock[]) : [];
      for (const block of blocks) {
        if (block.type === "tool_use" && block.id) {
          const step: PendingStep = {
            id: block.id,
            index: steps.length,
            tool: block.name ?? "?",
            input: block.input,
            matched: false,
            isError: false,
            resultContent: undefined,
          };
          steps.push(step);
          byId.set(block.id, step);
        } else if (block.type === "tool_result" && block.tool_use_id) {
          const step = byId.get(block.tool_use_id);
          if (step) {
            step.matched = true;
            step.isError = !!block.is_error;
            step.resultContent = block.content;
          }
        }
      }
      continue;
    }

    if (obj.type === "result") {
      output = typeof obj.result === "string" ? obj.result : null;
      isError = !!obj.is_error;
    }
  }

  const subSteps: SubStep[] = steps.map((step) => {
    const inputStr = step.input == null ? null : truncate(JSON.stringify(step.input), TRUNCATE_LIMIT);
    const inputObj = step.input && typeof step.input === "object" ? (step.input as Record<string, unknown>) : {};
    const command =
      step.tool === "Bash" && typeof inputObj.command === "string"
        ? truncate(inputObj.command, TRUNCATE_LIMIT)
        : null;
    return {
      id: step.id,
      index: step.index,
      tool: step.tool,
      title: deriveTitle(step.tool, step.input),
      command,
      input: inputStr,
      // 未マッチ（tool_use はあるが tool_result が来ていない = 中断・タイムアウト）は
      // 結果不明ではなく「失敗」扱いにする（呼び出しが完了しなかった事実を隠さない）
      output: step.matched ? truncate(toolResultText(step.resultContent), TRUNCATE_LIMIT) : null,
      status: step.matched ? (step.isError ? "error" : "ok") : "error",
    };
  });

  return { output, isError, subSteps };
}
