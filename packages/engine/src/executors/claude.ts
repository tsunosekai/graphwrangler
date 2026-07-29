// executor=ai: claude -p を子プロセスで起動する。zinsei desk/engine.py の _run_claude と
// 同型（shell 経由ではなく argv 配列で渡す。プロンプトはコマンドライン引数として渡すので
// シェルクォート事故が起きない）。--dangerously-skip-permissions は絶対に使わない。
import { spawn } from "node:child_process";
import type { Node } from "../types.js";

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

export const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000; // 10分

/** 実行を許可するツール（読み取り・調査系のみ。Bash/Edit/Write は含めない） */
export const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];

/** 設定(GET /api/settings)経由の extraArgs で安全装置を上書きされないためのブロックリスト。
 *  --dangerously-skip-permissions と --allowedTools 系は設定に含まれていても常に無視する */
const BLOCKED_EXTRA_ARGS = new Set([
  "--dangerously-skip-permissions",
  "--allowedtools",
  "--allowed-tools",
]);

/** extraArgs から安全装置に関わるフラグを取り除く（設定はサーバ管理者が触れるものだが、
 *  M7の「サーバ設定をポーリングして反映する」経路を安全側に倒すための最終防御） */
export function sanitizeExtraArgs(extraArgs: string[]): string[] {
  return extraArgs.filter((a) => !BLOCKED_EXTRA_ARGS.has(a.toLowerCase()));
}

/** claude executor の実行時設定（cliPath/model は GET /api/settings + env で上書き可能。
 *  docs/design.md 3.8 M7「エンジンAI設定を server 設定から読む」） */
export interface ClaudeExecutorConfig {
  cliPath: string;
  model: string;
  extraArgs: string[];
}

export interface AiPromptInput {
  node: Pick<Node, "title" | "detail" | "impl">;
  /** group が指すゴールノード（無ければ null） */
  goal: Pick<Node, "title" | "detail"> | null;
  /** 親ノードのスレッド末尾の say メッセージ（文脈）。"タイトル: 本文" の形で渡す */
  parentSayMessages: string[];
}

export interface AiPromptResult {
  prompt: string;
  /** プロンプトに実際に含めた文脈の名前（出典バッジ用。docs/design.md 3.8）。
   *  例: ["ゴール文脈", "親ノードの成果", "手順書"] */
  sources: string[];
}

/**
 * claude -p に渡すプロンプトを組み立てる（純粋関数）。
 * ゴールの title/detail → 親ノードの文脈 → 自ノードの title/detail →
 * impl が doc ならその全文を「手順書。これに従え」として付与 → 出力形式の指定、の順。
 * 実際に組み込んだ文脈は sources として合わせて返す（AI発言の出典バッジ用）。
 */
export function buildAiPrompt(input: AiPromptInput): AiPromptResult {
  const { node, goal, parentSayMessages } = input;
  const lines: string[] = [];
  const sources: string[] = [];
  lines.push(
    "あなたは GraphWrangler（タスクグラフをAIと人間で分担するツール）の実行ワーカーです。",
    "次の作業を行ってください。",
    "",
  );
  if (goal) {
    sources.push("ゴール文脈");
    lines.push(`ゴール: ${goal.title}`);
    if (goal.detail) lines.push(`ゴールの補足: ${goal.detail}`);
    lines.push("");
  }
  if (parentSayMessages.length > 0) {
    sources.push("親ノードの成果");
    lines.push("先行ノードから引き継ぐ文脈:");
    for (const s of parentSayMessages) lines.push(`- ${s}`);
    lines.push("");
  }
  lines.push(`作業内容: ${node.title}`);
  if (node.detail) lines.push(`補足: ${node.detail}`);
  if (node.impl && node.impl.type === "doc") {
    sources.push("手順書");
    lines.push("", "手順書。これに従え:", node.impl.text);
  }
  lines.push(
    "",
    "作業結果の要約テキストのみを返してください"
      + "（ツールでの自己報告は不要です。あなたの標準出力がそのまま記録されます）。",
  );
  return { prompt: lines.join("\n"), sources };
}

/**
 * claude -p を起動する。cliPath/model/extraArgs は設定（GET /api/settings）由来（既定は
 * cliPath="claude" / model="sonnet"。env GW_ENGINE_CLAUDE_MODEL があれば呼び出し側で優先済み）。
 * --dangerously-skip-permissions は使わない（#inbox 経由のプロンプトインジェクション対策と
 * 同じ理由。docs/agent-contracts.md・zinsei CLAUDE.md 参照）。extraArgs 経由でもこの安全装置は
 * sanitizeExtraArgs で剥がすため上書きできない。
 */
export function runClaude(
  prompt: string,
  config: ClaudeExecutorConfig,
  timeoutMs: number = CLAUDE_TIMEOUT_MS,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    // プロンプトは argv ではなく **stdin** で渡す。Windows の shell:true は cmd.exe を経由し、
    // cmd.exe は改行を含む引数を黙って切り捨てる（2026-07-29 に chat_cli 側で実測）。
    // buildAiPrompt は常に複数行なので、argv 渡しだと Windows で先頭行しか届かない。
    const args = [
      "-p",
      "--model",
      config.model,
      ...sanitizeExtraArgs(config.extraArgs),
      "--allowedTools",
      ...ALLOWED_TOOLS,
    ];
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Windows では claude が .cmd シム（cmd.exe 経由でないと直接起動できない）のため、
    // その場合だけ shell:true にする。POSIX 側は argv をそのまま execve する
    const isWindows = process.platform === "win32";
    let child;
    try {
      child = spawn(config.cliPath, args, isWindows ? { shell: true } : undefined);
    } catch (err) {
      resolve({ success: false, output: "", error: `${config.cliPath} -p 起動失敗: ${String(err)}` });
      return;
    }
    child.stdin?.write(prompt);
    child.stdin?.end();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: stdout, error: `${config.cliPath} -p 起動失敗: ${String(err)}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          success: false,
          output: stdout,
          error: `タイムアウト（${Math.round(timeoutMs / 60000)}分）`,
        });
        return;
      }
      if (code !== 0) {
        // claude CLI はエラーの種類によって stdout/stderr どちらに理由を出すか一定しない
        // （実機確認で判明: 認証エラーは stdout、stdin待ちの警告は stderr に出た）。
        // 両方を拾って人間に見せる理由文にする
        const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join(" / ");
        resolve({
          success: false,
          output: stdout,
          error: combined.slice(0, 500) || `終了コード ${code}`,
        });
        return;
      }
      resolve({ success: true, output: stdout.trim() });
    });
  });
}
