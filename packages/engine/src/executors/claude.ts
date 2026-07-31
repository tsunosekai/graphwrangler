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
// Write/Edit は 2026-07-31 追加（本人指示: スクリプトや手順書をAIに書かせるため。
// cwd=workspace root なので書き先はワークスペース内が既定。Bash はあえて許可しない——
// コマンド実行は試走ボタン（server の /trial）と script executor の管轄）
export const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Write", "Edit", "WebSearch", "WebFetch"];

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
  if (node.impl && node.impl.type === "doc" && node.impl.text) {
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
/**
 * 子の claude に渡す環境変数の掃除。CLI方式（claude -p）は**ログイン済み資格情報
 * （サブスクリプション）経路に固定**する（2026-07-31 本人方針「APIキー利用じゃダメ」。
 * APIキー従量課金で使いたい場合は設定の接続方式 "api" を選ぶ、という切り分けに一致）。
 * 落とすもの:
 * - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN: 継承されると claude がAPIキー課金経路に
 *   流れてしまう
 * - CLAUDE_CODE_* / CLAUDECODE / ANTHROPIC_BASE_URL 等: Claude Code セッション内から
 *   起動された場合に継承され、ホストのプロキシ/セッション認証経路を有効にして
 *   「OAuth session expired」で死ぬ（2026-07-31 実測）
 * CLAUDE_CONFIG_DIR はユーザーの意図した設定なので残す。
 * server/src/chat_cli.ts と同じ規則（変えたら両方直す）。
 */
export function sanitizedClaudeEnv(): NodeJS.ProcessEnv {
  const drop =
    /^(CLAUDE_CODE_|CLAUDE_PREVIEW_|CLAUDE_AGENT_SDK)|^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|AI_AGENT|BAGGAGE)$/;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!drop.test(k)) env[k] = v;
  }
  return env;
}

export interface RunClaudeOptions {
  timeoutMs?: number;
  /** 作業ディレクトリ。ワークスペースモードでは workspace root を渡す（AI の
   *  Read/Grep/Glob がリポジトリ内の資料を素で読めるように。2026-07-31 整合レビューで
   *  script executor だけ cwd 対応して AI 側が漏れていた穴を塞いだ）。省略時は
   *  エンジンプロセスの cwd（従来挙動） */
  cwd?: string;
}

export function runClaude(
  prompt: string,
  config: ClaudeExecutorConfig,
  opts: RunClaudeOptions = {},
): Promise<ExecResult> {
  const { timeoutMs = CLAUDE_TIMEOUT_MS, cwd } = opts;
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
      child = spawn(config.cliPath, args, {
        ...(isWindows ? { shell: true } : {}),
        ...(cwd ? { cwd } : {}),
        env: sanitizedClaudeEnv(),
      });
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
