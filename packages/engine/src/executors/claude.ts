// executor=ai: claude -p を子プロセスで起動する。zinsei desk/engine.py の _run_claude と
// 同型（shell 経由ではなく argv 配列で渡す。プロンプトはコマンドライン引数として渡すので
// シェルクォート事故が起きない）。--dangerously-skip-permissions は絶対に使わない。
//
// 2026-08-09: --output-format stream-json --verbose を追加し、stdout を「実行結果の
// テキスト」だけでなく「AIが実際に呼んだツール（Bash/Edit/Task…）の列」としても読めるように
// した（AI実行の内部で実際に何が行われたかをノード内ノードとして記録するため。
// packages/core/src/schema.ts の SubStep がその契約型、パースは stream_trace.ts）。
// 素の -p（テキスト出力）に比べて stdout は増えるが、成功時の output は従来どおり
// 最終テキストのみ（stream_trace.parseStreamJsonOutput が result 行から取り出す）。
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { autonomyPromptLines } from "../ask.js";
import type { Autonomy, Node, SubStep } from "../types.js";
import { killTree, STDIO_GRACE_MS } from "./script.js";
import { parseStreamJsonOutput } from "./stream_trace.js";

// packages/engine/src/executors → repoRoot
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const mcpEntry = path.join(repoRoot, "packages", "mcp", "src", "index.ts");

/** 実行AIに許可する GraphWrangler MCP ツール（2026-08-11）。
 *  **discord_post ただ1つ**に絞る——手順書に「#運営一般 に報告」と書かれたノードで、
 *  AI がその実行として連絡を投げられるようにするため（本人要望「AIが人間とコミュニケーション
 *  する必要のあるタスクは積極的に Discord を使ってほしい」）。
 *  グラフ操作（node_add / node_remove / undo …）は渡さない: 実行AIの仕事は「ノードを実行する」
 *  ことで、グラフを組み替えることではない。人間へ判断を仰ぐ経路は MCP ではなく
 *  QUESTION プロトコル（ask.ts）が既に担っているので、request_open も要らない */
const ALLOWED_MCP_TOOLS = ["mcp__graphwrangler__discord_post"];

/** claude -p に渡す一時 mcp-config を書く（server 側 chat_cli.ts の writeMcpConfig と同型）。
 *  GraphWrangler の HTTP API の場所は api.ts と同じ env の見方で MCP サーバへ渡す */
function writeMcpConfig(): string {
  const config = {
    mcpServers: {
      graphwrangler: {
        command: "npx",
        args: ["tsx", mcpEntry],
        env: {
          GRAPHWRANGLER_URL: (process.env.GRAPHWRANGLER_URL ?? "http://localhost:8770").replace(
            /\/+$/,
            "",
          ),
        },
      },
    },
  };
  const file = path.join(os.tmpdir(), `graphwrangler-engine-mcp-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
  return file;
}

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
  /** 実行中に呼ばれたツールの内訳（stream-json から復元）。空なら付けない */
  subSteps?: SubStep[];
}

// Bash 許可で実作業（ビルド・テスト・データ処理）が10分を超えうるため、権限拡張と同時に
// 10分→30分へ（2026-08-03）
export const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000; // 30分

/** 実行を許可するツールのフルセット。
 *  2026-08-03 本人指示「権限が無さ過ぎて何もできない。Claw（OpenClaw）と同じぐらい色々
 *  できるように」で Bash / Task / TodoWrite / NotebookEdit を追加し、「読み取り+書き込みのみ」
 *  の縛りを撤廃した。危険な操作の歯止めはツールの出し渋りではなく、ノード側の
 *  実行前承認（approval）・自律度（autonomy の QUESTION プロトコル）・試走（--dry-run）で
 *  担保する。--dangerously-skip-permissions を使わない方針は不変（許可は常にこのリストで明示）。
 *  MCP 等をさらに足すときは設定 engine.cliExtraTools（settings.ts）。
 *  server 側 chat_cli.ts の DEFAULT_CLI_TOOLS と同じ内容（変えたら両方直す） */
export const ALLOWED_TOOLS = [
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

/** 設定(GET /api/settings)経由の extraArgs で安全装置を上書きされないためのブロックリスト。
 *  --dangerously-skip-permissions と --allowedTools 系は設定に含まれていても常に無視する */
const BLOCKED_EXTRA_ARGS = new Set([
  "--dangerously-skip-permissions",
  "--allowedtools",
  "--allowed-tools",
]);

/** extraArgs から安全装置に関わるフラグを取り除く（設定はサーバ管理者が触れるものだが、
 *  「サーバ設定をポーリングして反映する」経路を安全側に倒すための最終防御） */
export function sanitizeExtraArgs(extraArgs: string[]): string[] {
  return extraArgs.filter((a) => !BLOCKED_EXTRA_ARGS.has(a.toLowerCase()));
}

/** 設定 engine.cliExtraTools のサニタイズ。"-" 始まりはツール名でなくフラグとして解釈されて
 *  しまう（--dangerously-skip-permissions の混入経路になる）ので落とす（chat_cli.ts と同じ規則） */
export function sanitizeExtraTools(tools: string[]): string[] {
  return tools.filter((t) => !t.startsWith("-"));
}

/** 設定 ai.addDirs のサニタイズ。"-" 始まり（フラグ混入経路）を落とす */
export function sanitizeAddDirs(dirs: string[]): string[] {
  return dirs.filter((d) => !d.startsWith("-"));
}

/** claude executor の実行時設定（cliPath/model は GET /api/settings + env で上書き可能） */
export interface ClaudeExecutorConfig {
  cliPath: string;
  model: string;
  /** --effort（思考の深さ）。null = CLI 既定。ノード側の aiEffort が優先（2026-08-07） */
  effort: string | null;
  extraArgs: string[];
  /** ALLOWED_TOOLS に追加で許可するツール（設定 engine.cliExtraTools。例: "mcp__foo__*"） */
  extraTools: string[];
  /** claude -p の --add-dir に渡す追加作業ディレクトリ（設定 ai.addDirs。三役共通）。
   *  ファイルツールは cwd=workspace root に閉じるため、外のパスはここで開放する
   *  （2026-08-04 本人指示「AI が stremix-document 外も触れるように」） */
  addDirs: string[];
}

export interface AiPromptInput {
  node: Pick<Node, "title" | "detail" | "impl" | "outputs">;
  /** group が指すゴールノード（無ければ null） */
  goal: Pick<Node, "title" | "detail"> | null;
  /** 親ノードのスレッド末尾の say メッセージ（文脈）。"タイトル: 本文" の形で渡す */
  parentSayMessages: string[];
  /** 自律度（ask.ts）。省略時 normal（QUESTION プロトコルあり・最終手段） */
  autonomy?: Autonomy;
  /** 自ノードのスレッドから拾った経緯（人間へのQ&A・直前の失敗。ask.ts の
   *  buildThreadContextLines）。質問への回答を踏まえた再実行で使う */
  threadContext?: string[];
  /** ランのコンテキスト（docs/design.md 3.15）。**ラン層の実行でのみ渡す**（空 {} でも渡す。
   *  undefined = プロジェクト層 = outputs 宣言があっても ##gw 出力指示は付けない）。
   *  値があればプロンプトへ「ランのコンテキスト」ブロックとして注入する。
   *  欠けていてもエラーにしない——AI は QUESTION プロトコルで人間に聞ける（3.15） */
  runContext?: Record<string, string>;
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
  const { node, goal, parentSayMessages, autonomy = "normal", threadContext = [], runContext } = input;
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
  if (threadContext.length > 0) {
    sources.push("スレッドの経緯");
    lines.push("この作業のこれまでの経緯:");
    for (const s of threadContext) lines.push(`- ${s}`);
    lines.push("");
  }
  if (runContext && Object.keys(runContext).length > 0) {
    sources.push("ランのコンテキスト");
    lines.push("ランのコンテキスト（このランで引き継がれている値。docs/design.md 3.15）:");
    for (const [k, v] of Object.entries(runContext)) lines.push(`- ${k}: ${v}`);
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
    "作業が完了したら、作業結果の要約テキストのみを返してください"
      + "（ツールでの自己報告は不要です。あなたの標準出力がそのまま記録されます）。",
    ...autonomyPromptLines(autonomy),
  );
  // ランのコンテキストへの出力宣言（3.15「実行時の書き」）。ラン層（runContext が渡された
  // 実行）でのみ指示する——プロジェクト層では ##gw マーカーは無視される（ランでのみ有効）
  if (runContext !== undefined && node.outputs && node.outputs.length > 0) {
    lines.push(
      "",
      "このノードには、次のキーをランのコンテキストへ出力する宣言があります。"
        + '結果の末尾に、キーごとに ##gw {"set":{"キー":"値"}} 形式の行（1行1個。行全体がこの形）を'
        + "出力してください。この行は記録から自動で取り除かれ、ランのコンテキストへ書き込まれます:",
      ...node.outputs.map(
        (o) =>
          `- ${o.name}${o.label ? `（${o.label}）` : ""}${o.example ? ` 例: ${o.example}` : ""}`,
      ),
    );
  }
  return { prompt: lines.join("\n"), sources };
}

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
    // MCP 設定（2026-08-11）。これが無いと --allowedTools に mcp__* を並べても接続自体が
    // 無いので呼べない（実測: 手順書に投稿先を書いても discord_post に手が届かなかった）。
    // 書き出しに失敗しても実行そのものは続ける——MCP は「連絡できる」ぶんの追加機能で、
    // ノードの実行を止める理由にはならない
    let mcpConfigFile: string | null = null;
    try {
      mcpConfigFile = writeMcpConfig();
    } catch (err) {
      console.error(`[claude] MCP設定の書き出しに失敗（MCPなしで続行）: ${String(err)}`);
    }
    const isWindowsShell = process.platform === "win32";
    const q = (s: string) => (isWindowsShell ? `"${s.replace(/"/g, '\\"')}"` : s);

    // プロンプトは argv ではなく **stdin** で渡す。Windows の shell:true は cmd.exe を経由し、
    // cmd.exe は改行を含む引数を黙って切り捨てる（2026-07-29 に chat_cli 側で実測）。
    // buildAiPrompt は常に複数行なので、argv 渡しだと Windows で先頭行しか届かない。
    const args = [
      "-p",
      "--model",
      config.model,
      ...(config.effort ? ["--effort", config.effort] : []),
      ...sanitizeExtraArgs(config.extraArgs),
      ...(mcpConfigFile ? ["--mcp-config", q(mcpConfigFile)] : []),
      "--allowedTools",
      ...(mcpConfigFile ? ALLOWED_MCP_TOOLS : []),
      ...ALLOWED_TOOLS,
      ...sanitizeExtraTools(config.extraTools),
      ...sanitizeAddDirs(config.addDirs).flatMap((d) => ["--add-dir", d]),
      // 内訳（サブステップ）を復元するため、1行1JSONの詳細ログで出させる（stream_trace.ts）
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    let stdout = "";
    let stderr = "";
    // close はタイムアウト resolve 後にも遅れて発火しうるため、二重 resolve を防ぐ
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const settle = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      // 一時 MCP 設定の後始末。ノード実行のたびに1つ作るので、消さないと tmp に溜まり続ける
      if (mcpConfigFile) {
        try {
          fs.unlinkSync(mcpConfigFile);
        } catch {
          // 掃除に失敗しても致命的ではない（chat_cli.ts と同じ扱い）
        }
      }
      resolve(result);
    };

    // Windows では claude が .cmd シム（cmd.exe 経由でないと直接起動できない）のため、
    // その場合だけ shell:true にする。POSIX 側は argv をそのまま execve する
    // （detached はプロセスグループを分け、killTree でグループごと止めるため）
    const isWindows = process.platform === "win32";
    let child: ChildProcess;
    try {
      child = spawn(config.cliPath, args, {
        ...(isWindows ? { shell: true } : { detached: true }),
        ...(cwd ? { cwd } : {}),
        env: sanitizedClaudeEnv(),
      });
    } catch (err) {
      resolve({ success: false, output: "", error: `${config.cliPath} -p 起動失敗: ${String(err)}` });
      return;
    }
    child.stdin?.write(prompt);
    child.stdin?.end();

    // close は「プロセス終了 + stdio が全部閉じる」まで発火しない。claude が起動した
    // 孫プロセスにパイプを握られると kill 後も close が来ないため、タイムアウトでは
    // ツリーごと殺し、こちら側のストリームを打ち切って、その場で必ず resolve する
    // （エンジンは1並列なので、ここで待ち続けるとエンジン全体が止まる）
    timer = setTimeout(() => {
      killTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const parsed = parseStreamJsonOutput(stdout);
      settle({
        success: false,
        output: stdout,
        error: `タイムアウト（${Math.round(timeoutMs / 60000)}分）`,
        subSteps: parsed.subSteps.length > 0 ? parsed.subSteps : undefined,
      });
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      settle({ success: false, output: stdout, error: `${config.cliPath} -p 起動失敗: ${String(err)}` });
    });

    // 終了コードから結果を確定する（close / exit+猶予 の両経路で共用）
    const finish = (code: number | null) => {
      // stream-json を通した以上 stdout は常にパースを試す。異常終了でもここまでに出た
      // tool_use/tool_result は「どこまで進んだか」を示す貴重な情報なので、
      // 途中で切れていても拾えるだけ拾う（parseStreamJsonOutput は壊れた最終行を読み飛ばす）
      const parsed = parseStreamJsonOutput(stdout);
      const subSteps = parsed.subSteps.length > 0 ? parsed.subSteps : undefined;
      if (code !== 0) {
        // claude CLI はエラーの種類によって stdout/stderr どちらに理由を出すか一定しない
        // （実機確認で判明: 認証エラーは stdout、stdin待ちの警告は stderr に出た）。
        // stream-json が最後まで通っていれば result.result（人間向けの理由文）を優先し、
        // 通っていなければ従来どおり stderr/stdout の生テキストを繋げる
        const reason = parsed.output ?? [stderr.trim(), stdout.trim()].filter(Boolean).join(" / ");
        settle({
          success: false,
          output: stdout,
          error: reason.slice(0, 500) || `終了コード ${code}`,
          subSteps,
        });
        return;
      }
      if (parsed.isError) {
        // 終了コード0でも result.is_error=true は「AIが処理を終えたが失敗として報告した」
        // ケース（権限拒否で何もできなかった等）。exit code だけ見ると成功扱いになってしまう
        settle({
          success: false,
          output: stdout,
          error: (parsed.output ?? "AIがエラーを報告しました（詳細不明）").slice(0, 500),
          subSteps,
        });
        return;
      }
      settle({ success: true, output: parsed.output ?? stdout.trim(), subSteps });
    };

    // exit はプロセス本体の終了時に必ず発火する（close と違い stdio の状態に依存しない）。
    // 通常は直後に close が来て確定するが、claude が起動した孫プロセスにパイプを握られた
    // まま本体だけ終了した場合は close が来ないため、猶予後にストリームを打ち切って
    // 終了コードで確定する
    child.on("exit", (code) => {
      if (settled) return;
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, STDIO_GRACE_MS);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}
