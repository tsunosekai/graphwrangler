// 内蔵チャットの CLI 方式（chat.mode="cli"）。APIキーを使わず、ログイン済みのヘッドレス
// エージェントCLI（claude -p 等）を起動して応答を作る。グラフ操作はチャット側の
// tool-calling（chat.ts の add_node 等）ではなく、自前の MCP サーバ（packages/mcp）を
// CLI に接続して行わせる。そのため via は "mcp"（帰属は docs/agent-contracts.md のとおり
// actor:{kind:"agent",name:"mcp"}）になる。「チャットAI＝via:chat」という慣例からは外れるが、
// CLI 経由の唯一の操作口が MCP である以上この帰属が実態を正しく表しているので許容する。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import type { GraphStore } from "@graphwrangler/core";
import type { SettingsStore } from "./settings.js";
import { systemPrompt, type ChatRequestBody } from "./chat.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/server/src → repoRoot
const repoRoot = path.resolve(here, "..", "..", "..");
const mcpEntry = path.join(repoRoot, "packages", "mcp", "src", "index.ts");

const CLI_TIMEOUT_MS = 5 * 60 * 1000; // 5分
const MAX_HISTORY_MESSAGES = 20; // 「最大10往復」= user+assistant で20件

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Windows では .cmd シムの都合で spawn に shell:true が要る（下記 runCli 参照）が、
 *  shell:true 経由の呼び出しは内部で cmd.exe を介す。cmd.exe は行指向のコマンド解析をするため、
 *  引数の値に生の改行文字が入っていると そこでコマンド行が切れてしまい、以降の引数
 *  （--output-format 等）が渡らなくなる（実機確認で判明: --append-system-prompt に複数行の
 *  文字列を渡すと --output-format stream-json 以降が失われ、CLIが素のテキスト出力に
 *  フォールバックしてストリームのパースが壊れる）。POSIX側はshellを介さずargvを直接渡す
 *  ため影響を受けない。Windowsのときだけ改行を読める区切り文字に潰してから引数化する */
function cliSafeArg(text: string): string {
  if (process.platform !== "win32") return text;
  return text.replace(/\r\n|\r|\n/g, " ｜ ");
}

/** UIMessage から text パートだけを連結して取り出す（ツール呼び出し等は無視） */
function textOf(message: UIMessage): string {
  const parts = (message as { parts?: Array<{ type: string; text?: string }> }).parts ?? [];
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
}

/** 直近の会話履歴（今回のuserメッセージを除く、最大10往復）を「これまでの会話:」形式にする。
 *  ステートレスなCLI呼び出しのため、履歴はプロンプト本文に埋め込む */
function buildPrompt(messages: UIMessage[]): string {
  const current = messages[messages.length - 1];
  const currentText = current ? textOf(current) : "";
  const prior = messages.slice(0, -1).slice(-MAX_HISTORY_MESSAGES);
  const historyLines = prior
    .map((m) => `${m.role === "user" ? "user" : "assistant"}: ${textOf(m)}`)
    .filter((line) => line.trim().length > 0 && !line.endsWith(": "));

  const lines: string[] = [];
  if (historyLines.length > 0) {
    lines.push("これまでの会話:", ...historyLines, "");
  }
  lines.push(currentText);
  return lines.join("\n");
}

/** claude -p に渡す一時 mcp-config ファイルを書く。GraphWrangler の HTTP API を env
 *  GRAPHWRANGLER_URL 経由でMCPサーバ（packages/mcp、npx tsx で起動）に教える */
function writeMcpConfig(serverPort: number): string {
  const config = {
    mcpServers: {
      graphwrangler: {
        command: "npx",
        args: ["tsx", mcpEntry],
        env: { GRAPHWRANGLER_URL: `http://localhost:${serverPort}` },
      },
    },
  };
  const file = path.join(os.tmpdir(), `graphwrangler-mcp-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
  return file;
}

/** MCPツール名 "mcp__graphwrangler__node_add" → UI表示用に "node_add" へ剥がす */
function stripToolPrefix(name: string): string {
  const prefix = "mcp__graphwrangler__";
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
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

/** tool_result の content（文字列 or ブロック配列）からテキストを取り出す */
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

/** stream-json の1行を UIMessageStream(SSE) チャンクへ変換し、controller に enqueue する。
 *  claude -p はトークン単位ではなく「1メッセージ分まとまって」出力するため、テキストは
 *  text-start→text-delta(全文)→text-end を1セットとして流す（妥協点。ChatDrawer 側は
 *  差分の逐次結合なので害はない） */
function emitStreamJsonLine(
  line: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return; // 壊れた行・空行は無視
  }

  const push = (chunk: Record<string, unknown>) => controller.enqueue(encoder.encode(sseChunk(chunk)));

  if (event.type === "assistant" || event.type === "user") {
    const message = event.message as { content?: ContentBlock[] } | undefined;
    const blocks = message?.content ?? [];
    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        const id = `text-${randomUUID()}`;
        push({ type: "text-start", id });
        push({ type: "text-delta", id, delta: block.text });
        push({ type: "text-end", id });
      } else if (block.type === "tool_use" && block.id) {
        push({
          type: "tool-input-available",
          toolCallId: block.id,
          toolName: stripToolPrefix(block.name ?? "?"),
          input: block.input,
        });
      } else if (block.type === "tool_result" && block.tool_use_id) {
        if (block.is_error) {
          push({
            type: "tool-output-error",
            toolCallId: block.tool_use_id,
            errorText: toolResultText(block.content) || "ツール実行エラー",
          });
        } else {
          push({
            type: "tool-output-available",
            toolCallId: block.tool_use_id,
            output: toolResultText(block.content),
          });
        }
      }
    }
  }
  // event.type === "system" | "result" は制御イベントのみで、UI表示するテキストが無いため無視する
}

/** claude -p を起動し、stream-json の出力を UIMessageStream(SSE) へ変換しながら
 *  controller に流す。呼び出し完了・失敗にかかわらず必ず [DONE] を送って close する */
function runCli(
  cliPath: string,
  cliModel: string,
  prompt: string,
  system: string,
  mcpConfigFile: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<void> {
  return new Promise((resolve) => {
    const push = (chunk: Record<string, unknown>) => controller.enqueue(encoder.encode(sseChunk(chunk)));
    const finish = () => {
      try {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch {
        // 既にcloseされていた場合は無視
      }
      try {
        controller.close();
      } catch {
        // 既にcloseされていた場合は無視
      }
      try {
        fs.unlinkSync(mcpConfigFile);
      } catch {
        // 一時ファイルの掃除に失敗しても致命的ではない
      }
      resolve();
    };

    const args = [
      "-p",
      cliSafeArg(prompt),
      "--model",
      cliModel,
      "--mcp-config",
      mcpConfigFile,
      "--allowedTools",
      "mcp__graphwrangler__*",
      "--append-system-prompt",
      cliSafeArg(system),
      "--output-format",
      "stream-json",
      "--verbose",
      // --dangerously-skip-permissions は使わない（MCPツールは --allowedTools で許可済み）
    ];

    // Windows では claude が .cmd シム（cmd.exe 経由でないと直接起動できない）のため、
    // その場合だけ shell:true にする（packages/engine/src/executors/claude.ts と同型）
    const isWindows = process.platform === "win32";
    let child;
    try {
      child = spawn(cliPath, args, isWindows ? { shell: true } : undefined);
    } catch (err) {
      push({ type: "error", errorText: `${cliPath} の起動に失敗しました: ${String(err)}` });
      finish();
      return;
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;
    let sawAnyOutput = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CLI_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        sawAnyOutput = true;
        emitStreamJsonLine(line, controller, encoder);
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderrBuf += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      push({ type: "error", errorText: `${cliPath} の起動に失敗しました: ${String(err)}` });
      finish();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdoutBuf.trim()) emitStreamJsonLine(stdoutBuf, controller, encoder);
      if (timedOut) {
        push({ type: "error", errorText: "ヘッドレスCLIの応答がタイムアウトしました（5分）" });
        finish();
        return;
      }
      if (code !== 0 && !sawAnyOutput) {
        // CLI 実装都合でエラー理由が stdout/stderr どちらに出るか一定しないため両方拾う
        // （packages/engine/src/executors/claude.ts と同じ事情）
        const combined = [stderrBuf.trim(), stdoutBuf.trim()].filter(Boolean).join(" / ");
        push({
          type: "error",
          errorText: `ヘッドレスCLIの起動に失敗しました（終了コード ${code}）: ${combined.slice(0, 500) || "不明なエラー"}`,
        });
      }
      finish();
    });
  });
}

/**
 * POST /api/chat（chat.mode="cli"）のハンドラ本体。設定に未対応な項目（APIキー等）は無いため
 * index.ts 側での400判定は行わない。CLI起動自体の失敗は SSE の error チャンクとして
 * ストリーム内で返す（HTTPレスポンス自体は200 + text/event-stream で開始する）。
 */
export function handleChatCli(
  graph: GraphStore,
  settings: SettingsStore,
  body: ChatRequestBody,
  serverPort: number,
): Response {
  const pageId = body.pageId ?? null;
  const { cliPath, cliModel } = settings.get().chat;
  const system = [
    systemPrompt(graph, pageId, body.selectedNodeId ?? null),
    "グラフの操作（ノード作成・更新・削除・スレッド投稿等）は graphwrangler の MCP ツールで行うこと。",
  ].join("\n");
  const prompt = buildPrompt(body.messages ?? []);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let mcpConfigFile: string;
      try {
        mcpConfigFile = writeMcpConfig(serverPort);
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            sseChunk({ type: "error", errorText: `MCP設定ファイルの作成に失敗しました: ${String(err)}` }),
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      runCli(cliPath, cliModel, prompt, system, mcpConfigFile, controller, encoder).catch((err) => {
        try {
          controller.enqueue(
            encoder.encode(sseChunk({ type: "error", errorText: `予期しないエラー: ${String(err)}` })),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {
          // ストリームが既に閉じていたら何もできない
        }
        try {
          controller.close();
        } catch {
          // 既にcloseされていた場合は無視
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
