// 内蔵チャットの CLI 方式（chat.mode="cli"）。APIキーを使わず、ログイン済みのヘッドレス
// エージェントCLI（claude -p 等）を起動して応答を作る。グラフ操作はチャット側の
// tool-calling（chat.ts の add_node 等）ではなく、自前の MCP サーバ（packages/mcp）を
// CLI に接続して行わせる。そのため via は "mcp"（actor:{kind:"agent",name:"mcp"}）になる。「チャットAI＝via:chat」という慣例からは外れるが、
// CLI 経由の唯一の操作口が MCP である以上この帰属が実態を正しく表しているので許容する。
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import type { GraphStore, ThreadStore } from "@graphwrangler/core";
import type { SettingsStore } from "./settings.js";
import { systemPrompt, type ChatRequestBody } from "./chat.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/server/src → repoRoot
const repoRoot = path.resolve(here, "..", "..", "..");
const mcpEntry = path.join(repoRoot, "packages", "mcp", "src", "index.ts");

// thread_ai.ts（スレッド相談AI＝バックグラウンドで停止ボタンが無い）だけが使う上限。
// チャット本体は 2026-08-02 本人要望「タイムアウトをなくして」でタイムアウト無しにした
// （サブエージェント並列などの長い作業が5分で切られていた。中断したいときは UI の停止ボタン。
// ドロワーを閉じてもサーバ側の子プロセスは完走する）
export const CLI_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 20; // 「最大10往復」= user+assistant で20件

/** GraphWrangler AI / Task AI に既定で許可するツールのフルセット。
 *  2026-08-03 本人指示「権限が無さ過ぎて何もできない。Claw（OpenClaw）と同じぐらい色々
 *  できるように」で、それまでの「読み取り+Write/Edit のみ・Bash はあえて許可しない」の
 *  縛りを撤廃した。危険な操作の歯止めはツールの出し渋りではなく、グラフ側の
 *  実行前承認（approval）・試走（--dry-run）・人間との会話で担保する。
 *  --dangerously-skip-permissions を使わない方針は不変（許可は常にこのリストで明示）。
 *  engine/src/executors/claude.ts の ALLOWED_TOOLS と同じ内容（変えたら両方直す） */
/** --effort に渡せる値（claude CLI の思考の深さ。2026-08-07 モデル/エフォート切替） */
export const CLI_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** リクエスト由来のモデル名のサニタイズ（"-" 始まり等のフラグ混入・空白を拒否）。
 *  不正・空なら null（= 設定の既定を使う） */
export function sanitizeModelOverride(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v) ? v : null;
}

/** リクエスト由来のエフォートのサニタイズ。既知の値以外は null（= 設定の既定） */
export function sanitizeEffortOverride(v: unknown): string | null {
  return typeof v === "string" && (CLI_EFFORT_LEVELS as readonly string[]).includes(v) ? v : null;
}

export const DEFAULT_CLI_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "Task",
  "TodoWrite",
  "WebSearch",
  "WebFetch",
];

/**
 * 子の claude に渡す環境変数の掃除。CLI方式はログイン済み資格情報（サブスクリプション）
 * 経路に固定する（APIキーで使いたい場合は接続方式 "api" を選ぶ）。継承された
 * ANTHROPIC_API_KEY や、Claude Code セッション内から起動された場合の CLAUDE_CODE_* /
 * ANTHROPIC_BASE_URL は子の claude を誤経路・認証失敗に落とすため除去する（2026-07-31 実測）。
 * ただし CLAUDE_CODE_OAUTH_TOKEN だけは残す（2026-08-18）。ブラウザでログインした
 * セッションは期限が来ると自動更新に失敗して資格情報が空になり（stremix VPS で 8/12 に
 * 発生。以後 6 日間 AI が全滅した）、画面の無いサーバでは復旧に人間の再ログインが要る。
 * `claude setup-token` の長期トークンを unit の環境に置く運用が唯一の恒久策なのに、
 * ここで落としていると設定しても効かない（＝サブスクリプション経路のまま。APIキー課金には
 * 流れないので上の方針とも矛盾しない）。
 * packages/engine/src/executors/claude.ts の sanitizedClaudeEnv と同じ規則（変えたら両方直す）。
 * thread_ai.ts（スレッド相談AI、機能1）もこの関数をそのまま import して使う。
 */
export function sanitizedClaudeEnv(): NodeJS.ProcessEnv {
  const keep = /^CLAUDE_CODE_OAUTH_TOKEN$/;
  const drop =
    /^(CLAUDE_CODE_|CLAUDE_PREVIEW_|CLAUDE_AGENT_SDK)|^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|AI_AGENT|BAGGAGE)$/;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (keep.test(k) || !drop.test(k)) env[k] = v;
  }
  return env;
}

/** claude CLI のログイン切れを、人間が次にやることまで含む一行に言い換える。
 *  生の英語（"Failed to authenticate: OAuth session expired and could not be refreshed"）
 *  だけだと、画面を見た人は何をすればいいか分からず、AI 側の一時的な不調と区別もつかない
 *  （2026-08-18 stremix VPS。8/12 にセッションが切れてから、Task AI が毎回この一行だけを
 *  スレッドへ書き続けていた）。マッチしなければ元の文字列をそのまま返す。
 *  packages/engine/src/executors/claude.ts の同名関数と同じ規則（変えたら両方直す）。 */
const CLAUDE_AUTH_FAILURE_RE =
  /OAuth session expired|Failed to authenticate|OAuth (access )?token (is )?(invalid|expired)|Invalid API key|Please run \/login/i;

export function explainClaudeCliFailure(raw: string): string {
  if (!CLAUDE_AUTH_FAILURE_RE.test(raw)) return raw;
  return `${raw}\n→ AI（claude CLI）のログインが切れています。サーバ側で \`claude setup-token\` を実行し、発行された長期トークンを環境変数 CLAUDE_CODE_OAUTH_TOKEN に設定して GraphWrangler を再起動してください（ブラウザログインのセッションは期限切れ後に自動更新できません）。`;
}

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** 進行中の CLI チャット応答の数。自動アップデート（selfupdate.ts）が「会話の途中で
 *  再起動して応答を殺す」のを避けるための busy 判定に使う（2026-08-07
 *  「チャットのネットワークエラー頻発」調査——エラーの一因が更新再起動だった） */
let activeCliChats = 0;
export function activeChatCliCount(): number {
  return activeCliChats;
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

interface StreamEventContentBlock {
  type: string;
  text?: string;
}

interface StreamEventDelta {
  type: string;
  text?: string;
  thinking?: string;
}

interface StreamEventPayload {
  type: string;
  index?: number;
  content_block?: StreamEventContentBlock;
  delta?: StreamEventDelta;
  message?: { id?: string };
}

/** stream_event（--include-partial-messages）の content_block_start〜stop を跨いで
 *  ブロックID・種別を追いかけるための状態。runCli の呼び出し1回（=1往復）につき1つ持つ */
interface StreamJsonState {
  messageId: string | null;
  /** content_block の index → 発行済みのUIMessageStreamブロックID・種別 */
  activeBlocks: Map<number, { id: string; kind: "text" | "reasoning" }>;
}

export function createStreamJsonState(): StreamJsonState {
  return { messageId: null, activeBlocks: new Map() };
}

/** stream_event（トークン単位の部分メッセージ）を UIMessageStream チャンクへ変換する。
 *  text/thinking(reasoning) 以外の content_block（tool_use等）は追跡対象に含めないため、
 *  対応する content_block_delta（input_json_delta）は activeBlocks に見つからず自然に無視される */
function emitStreamEvent(
  event: StreamEventPayload,
  state: StreamJsonState,
  push: (chunk: Record<string, unknown>) => void,
): void {
  switch (event.type) {
    case "message_start": {
      state.messageId = event.message?.id ?? null;
      state.activeBlocks.clear();
      break;
    }
    case "content_block_start": {
      const index = event.index;
      const block = event.content_block;
      if (index === undefined || !block) break;
      const base = state.messageId ?? "msg";
      if (block.type === "text") {
        const id = `${base}-${index}`;
        state.activeBlocks.set(index, { id, kind: "text" });
        push({ type: "text-start", id });
      } else if (block.type === "thinking") {
        const id = `${base}-${index}`;
        state.activeBlocks.set(index, { id, kind: "reasoning" });
        push({ type: "reasoning-start", id });
      }
      // tool_use 等は追跡しない（ツールはフルメッセージ行=assistant/userイベント側で確定表示する）
      break;
    }
    case "content_block_delta": {
      const index = event.index;
      if (index === undefined) break;
      const active = state.activeBlocks.get(index);
      if (!active) break; // tool_use の input_json_delta 等はここで無視される
      const delta = event.delta;
      if (active.kind === "text" && delta?.type === "text_delta" && typeof delta.text === "string") {
        push({ type: "text-delta", id: active.id, delta: delta.text });
      } else if (
        active.kind === "reasoning" &&
        delta?.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      ) {
        push({ type: "reasoning-delta", id: active.id, delta: delta.thinking });
      }
      break;
    }
    case "content_block_stop": {
      const index = event.index;
      if (index === undefined) break;
      const active = state.activeBlocks.get(index);
      if (!active) break;
      push({ type: active.kind === "text" ? "text-end" : "reasoning-end", id: active.id });
      state.activeBlocks.delete(index);
      break;
    }
    default:
      // message_delta / message_stop / ping 等は表示に不要なので無視する
      break;
  }
}

/** stream-json の1行を UIMessageStream(SSE) チャンクへ変換し、controller に enqueue する。
 *  --include-partial-messages 有効時は stream_event でトークン単位のテキスト/独り言(reasoning)
 *  を先行して流し、確定済みの assistant/user フルメッセージ行からはツール呼び出しだけを
 *  拾う（テキストブロックは stream_event 側で流し済みのため二重表示になるので出さない） */
export function emitStreamJsonLine(
  line: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: StreamJsonState,
): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return; // 壊れた行・空行は無視
  }

  // クライアントが切断済み（リロード/タブ閉じ）だと controller は closed で enqueue が投げる。
  // ここは CLI 子プロセスの stdout ハンドラから呼ばれるため、投げると uncaught でサーバ
  // プロセスごと落ちる（2026-08-02 リロード耐性チェックで実際にクラッシュを確認）。
  // 黙って捨てる——CLI は完走させ、グラフ操作（MCP経由）は最後まで反映させる
  const push = (chunk: Record<string, unknown>) => {
    try {
      controller.enqueue(encoder.encode(sseChunk(chunk)));
    } catch {
      // closed: 表示先が居ないだけなので無視
    }
  };

  if (event.type === "stream_event") {
    const inner = event.event as StreamEventPayload | undefined;
    if (inner) emitStreamEvent(inner, state, push);
    return;
  }

  if (event.type === "assistant" || event.type === "user") {
    const message = event.message as { content?: ContentBlock[] } | undefined;
    const blocks = message?.content ?? [];
    for (const block of blocks) {
      // block.type === "text" は stream_event（content_block_start/delta/stop）で流し済みなので
      // ここでは出さない（二重表示防止）。ツール呼び出し・結果はここでしか来ないので従来どおり処理する
      if (block.type === "tool_use" && block.id) {
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

/** 子プロセスを**木ごと**確実に殺す（2026-08-05「AIの会話を止められるように」）。
 *  Windows では shell:true で起動している＝直接の子は cmd.exe なので、`child.kill()` だと
 *  シムだけ死んで claude 本体が残る。taskkill /T で木ごと落とす。
 *  POSIX は spawn した本人を SIGTERM（それでも残る場合に備えて5秒後に SIGKILL） */
export function killTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      try {
        child.kill();
      } catch {
        // 既に終了している
      }
    }
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    return; // 既に終了している
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // 既に終了している
    }
  }, 5000).unref?.();
}

/** claude -p を起動し、stream-json の出力を UIMessageStream(SSE) へ変換しながら
 *  controller に流す。呼び出し完了・失敗にかかわらず必ず [DONE] を送って close する。
 *  signal が中断されたら claude を木ごと殺す——UI の「停止」で fetch を切っても、
 *  以前は CLI が裏で走り続けて MCP 経由でグラフを書き換えていた（2026-08-05 修正） */
function runCli(
  cliPath: string,
  cliModel: string,
  prompt: string,
  system: string,
  cwd: string,
  mcpConfigFile: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  extraTools: string[] = [],
  addDirs: string[] = [],
  signal?: AbortSignal,
  /** --effort（思考の深さ）。null = 指定しない（CLI 既定。2026-08-07） */
  effort: string | null = null,
): Promise<void> {
  return new Promise((resolve) => {
    // 切断済み controller への enqueue はサーバを落とすので必ず握りつぶす（emitStreamJsonLine と同じ理由）
    const push = (chunk: Record<string, unknown>) => {
      try {
        controller.enqueue(encoder.encode(sseChunk(chunk)));
      } catch {
        // closed: 無視
      }
    };
    // stream_event（トークン単位の部分メッセージ）のブロック追跡状態。この呼び出し=1往復で使い切り
    const streamState = createStreamJsonState();
    activeCliChats += 1;
    let finished = false; // error と close の両方が来ても1回だけ畳む（カウンタの二重減算防止）
    const finish = () => {
      if (finished) return;
      finished = true;
      activeCliChats = Math.max(0, activeCliChats - 1);
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

    // プロンプトは argv でなく **stdin** で渡す（複数行をそのまま渡せる。旧 cliSafeArg で
    // 改行を潰す妥協を撤廃）。Windows の shell:true は引数を自前でクォートしないと
    // **空白で分解される**ため、空白を含みうる引数（system）は winQuote で囲む
    // （2026-07-31 実測: システムプロンプトが最初の空白でちぎれて文脈が届いていなかった）
    const isWindows = process.platform === "win32";
    const q = (s: string) => (isWindows ? `"${s.replace(/"/g, '\\"')}"` : s);
    const args = [
      "-p",
      "--model",
      cliModel,
      // エフォート（思考の深さ）。null なら CLI の既定に任せる（2026-08-07 切替機能）
      ...(effort ? ["--effort", effort] : []),
      "--mcp-config",
      q(mcpConfigFile),
      "--allowedTools",
      "mcp__graphwrangler__*",
      // 既定でフルセットを許可する（DEFAULT_CLI_TOOLS。2026-08-03 本人指示「権限が無さ過ぎて
      // 何もできない。Claw と同じぐらい色々できるように」で Bash 等を追加）。
      // 取り返しのつかない操作の歯止めはグラフ側の実行前承認・試走と人間との会話で担保する
      ...DEFAULT_CLI_TOOLS,
      // 設定 chat.cliExtraTools（例: "mcp__foo__*"）。"-" 始まりはツール名でなく
      // フラグとして解釈されてしまう（--dangerously-skip-permissions の混入経路になる）ので落とす
      ...extraTools.filter((t) => !t.startsWith("-")),
      // 設定 ai.addDirs: ワークスペースルート外もファイルツールで触れるようにする
      // （2026-08-04 本人指示。"-" 始まりの除外は extraTools と同じフラグ混入対策）
      ...addDirs.filter((d) => !d.startsWith("-")).flatMap((d) => ["--add-dir", q(d)]),
      "--append-system-prompt",
      q(cliSafeArg(system)),
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      // --dangerously-skip-permissions は使わない（MCPツールは --allowedTools で許可済み）
    ];

    // Windows では claude が .cmd シム（cmd.exe 経由でないと直接起動できない）のため、
    // その場合だけ shell:true にする（packages/engine/src/executors/claude.ts と同型）
    let child: ChildProcess;
    try {
      // cwd を明示する: サーバの cwd（graphwrangler リポジトリ）のまま起動すると、
      // claude がそのリポジトリを自分のプロジェクトだと思い込み、画面のグラフでなく
      // ソースコードの話を始める（2026-07-31 実測）。ワークスペースモードなら
      // workspace root、それ以外は中立な tmp
      child = spawn(cliPath, args, { ...(isWindows ? { shell: true } : {}), env: sanitizedClaudeEnv(), cwd });
    } catch (err) {
      push({ type: "error", errorText: `${cliPath} の起動に失敗しました: ${String(err)}` });
      finish();
      return;
    }
    child.stdin?.write(prompt);
    child.stdin?.end();

    // 「停止」（クライアントの中断・ストリームの cancel）で claude を木ごと落とす。
    // 途中まで流したテキストは UI 側に残る（打ち切りであって取り消しではない）
    let stopped = false;
    const onAbort = () => {
      if (stopped) return;
      stopped = true;
      killTree(child);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let sawAnyOutput = false;

    child.stdout?.on("data", (d: Buffer) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        sawAnyOutput = true;
        emitStreamJsonLine(line, controller, encoder, streamState);
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderrBuf += d.toString();
    });

    child.on("error", (err) => {
      push({ type: "error", errorText: `${cliPath} の起動に失敗しました: ${String(err)}` });
      finish();
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (stopped) {
        // 人間が止めたので、失敗として騒がずに畳む（[DONE] は finish が送る）
        finish();
        return;
      }
      if (stdoutBuf.trim()) emitStreamJsonLine(stdoutBuf, controller, encoder, streamState);
      if (code !== 0 && !sawAnyOutput) {
        // CLI 実装都合でエラー理由が stdout/stderr どちらに出るか一定しないため両方拾う
        // （packages/engine/src/executors/claude.ts と同じ事情）
        const combined = [stderrBuf.trim(), stdoutBuf.trim()].filter(Boolean).join(" / ");
        push({
          type: "error",
          errorText: `ヘッドレスCLIの起動に失敗しました（終了コード ${code}）: ${explainClaudeCliFailure(combined.slice(0, 500)) || "不明なエラー"}`,
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
  threads: ThreadStore,
  settings: SettingsStore,
  body: ChatRequestBody,
  serverPort: number,
  /** リクエストの中断シグナル（UI の「停止」＝ fetch の abort）。claude を木ごと落とすのに使う */
  signal?: AbortSignal,
  /** 添付ファイル置き場（2026-08-07）。--add-dir に足して Read で読めるようにする */
  attachmentsDir?: string,
): Response {
  const pageId = body.pageId ?? null;
  const { cliPath, cliModel, cliEffort, cliExtraTools } = settings.get().chat;
  const { addDirs: settingsAddDirs } = settings.get().ai;
  const addDirs = attachmentsDir ? [...settingsAddDirs, attachmentsDir] : settingsAddDirs;
  // この会話でのモデル/エフォート上書き（ChatDrawer のセレクタ → body。2026-08-07）。
  // 不正値はサニタイズで落ちて設定の既定に戻る
  const model = sanitizeModelOverride(body.model) ?? cliModel;
  const effort = sanitizeEffortOverride(body.effort) ?? cliEffort;
  const system = [
    systemPrompt(graph, threads, pageId, body.selectedNodeId ?? null),
    "グラフの操作（ノード作成・更新・削除・スレッド投稿等）は graphwrangler の MCP ツールで行うこと。",
  ].join("\n");
  const prompt = buildPrompt(body.messages ?? []);

  const encoder = new TextEncoder();
  // 中断は2経路ある: リクエスト側の signal（fetch の abort が届く）と、レスポンス
  // ストリームの cancel（クライアントが読むのをやめた）。どちらでも同じ停止に畳む
  const stopper = new AbortController();
  if (signal) {
    if (signal.aborted) stopper.abort();
    else signal.addEventListener("abort", () => stopper.abort(), { once: true });
  }
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
      runCli(
        cliPath,
        model,
        prompt,
        system,
        graph.workspaceInfo().root ?? os.tmpdir(),
        mcpConfigFile,
        controller,
        encoder,
        cliExtraTools,
        addDirs,
        stopper.signal,
        effort,
      ).catch((err) => {
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
    cancel() {
      // クライアントが読むのをやめた（タブを閉じた・停止した）。CLI を放置しない
      stopper.abort();
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
