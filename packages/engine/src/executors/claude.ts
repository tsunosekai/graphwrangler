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

export interface AiPromptInput {
  node: Pick<Node, "title" | "detail" | "impl">;
  /** group が指すゴールノード（無ければ null） */
  goal: Pick<Node, "title" | "detail"> | null;
  /** 親ノードのスレッド末尾の say メッセージ（文脈）。"タイトル: 本文" の形で渡す */
  parentSayMessages: string[];
}

/**
 * claude -p に渡すプロンプトを組み立てる（純粋関数）。
 * ゴールの title/detail → 親ノードの文脈 → 自ノードの title/detail →
 * impl が doc ならその全文を「手順書。これに従え」として付与 → 出力形式の指定、の順。
 */
export function buildAiPrompt(input: AiPromptInput): string {
  const { node, goal, parentSayMessages } = input;
  const lines: string[] = [];
  lines.push(
    "あなたは GraphWrangler（タスクグラフをAIと人間で分担するツール）の実行ワーカーです。",
    "次の作業を行ってください。",
    "",
  );
  if (goal) {
    lines.push(`ゴール: ${goal.title}`);
    if (goal.detail) lines.push(`ゴールの補足: ${goal.detail}`);
    lines.push("");
  }
  if (parentSayMessages.length > 0) {
    lines.push("先行ノードから引き継ぐ文脈:");
    for (const s of parentSayMessages) lines.push(`- ${s}`);
    lines.push("");
  }
  lines.push(`作業内容: ${node.title}`);
  if (node.detail) lines.push(`補足: ${node.detail}`);
  if (node.impl && node.impl.type === "doc") {
    lines.push("", "手順書。これに従え:", node.impl.text);
  }
  lines.push(
    "",
    "作業結果の要約テキストのみを返してください"
      + "（ツールでの自己報告は不要です。あなたの標準出力がそのまま記録されます）。",
  );
  return lines.join("\n");
}

/**
 * claude -p を起動する。PATH の claude を使う。
 * --dangerously-skip-permissions は使わない（#inbox 経由のプロンプトインジェクション対策と
 * 同じ理由。docs/agent-contracts.md・zinsei CLAUDE.md 参照）。
 */
export function runClaude(
  prompt: string,
  model: string,
  timeoutMs: number = CLAUDE_TIMEOUT_MS,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--model", model, "--allowedTools", ...ALLOWED_TOOLS];
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Windows では claude が .cmd シム（cmd.exe 経由でないと直接起動できない）のため、
    // その場合だけ shell:true にする。POSIX 側は argv をそのまま execve するので
    // シェルクォート事故が起きない（zinsei desk/engine.py の subprocess.run(list) と同型）
    const isWindows = process.platform === "win32";
    let child;
    try {
      child = spawn("claude", args, isWindows ? { shell: true } : undefined);
    } catch (err) {
      resolve({ success: false, output: "", error: `claude -p 起動失敗: ${String(err)}` });
      return;
    }

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
      resolve({ success: false, output: stdout, error: `claude -p 起動失敗: ${String(err)}` });
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
