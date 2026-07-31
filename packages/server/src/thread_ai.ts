// スレッド相談AI（M4「会話はいつでも可」の実装漏れ。docs/design.md 3.9）。
// ノードのスレッドに人間が say を書いたら、非同期でAIが応答する。判断リクエストの
// ラリー（POST /api/nodes/:id/answer, option:null）はエンジン側が拾うので、ここでは
// 「open な判断リクエストが無いノードへの普通の相談」だけを相手にする。
// 呼び出し元は index.ts の POST /api/nodes/:id/messages（メッセージ保存レスポンスを
// 返した直後、await せずに maybeTriggerThreadAi を呼ぶ）。
import type { Actor, GraphStore, Node, ThreadStore } from "@graphwrangler/core";
import { spawn } from "node:child_process";
import os from "node:os";
import { chatKeyMissing, completeText } from "./chat.js";
import { CLI_TIMEOUT_MS, sanitizedClaudeEnv } from "./chat_cli.js";
import type { SettingsStore } from "./settings.js";

const MAX_THREAD_AI_HISTORY = 20;

// ---- 純関数（トリガー判定・プロンプト組み立て。ユニットテスト対象） ----

/** このメッセージ投稿でスレッド相談AIを起動すべきか。人間の say かつ open な判断
 *  リクエストが無いときのみ true（エンジン等の投稿・判断リクエストのラリーには反応しない） */
export function shouldTriggerThreadAi(input: {
  kind: string;
  actor: Pick<Actor, "kind">;
  pendingRequest: string | null;
}): boolean {
  return input.kind === "say" && input.actor.kind === "human" && input.pendingRequest === null;
}

export interface ThreadAiNodeContext {
  title: string;
  detail: string | null;
  kind: string;
  executor: string;
  status: string;
  /** impl の「有無と種類」だけ渡す（doc の全文などは含めない。相談AIは概況が分かれば十分） */
  impl: { type: "doc" | "script" } | null;
}

export interface ThreadAiHistoryEntry {
  kind: string;
  body: string;
}

export interface BuildThreadReplyPromptInput {
  node: ThreadAiNodeContext;
  /** 親ノードのタイトル（id ではなく人間可読な形で渡す） */
  parentTitles: string[];
  /** 所属ページ（group）のタイトル。無ければ null */
  pageTitle: string | null;
  /** スレッド直近の履歴（今回の新しい発言を除く。呼び出し側で最大20件に絞って渡すこと） */
  history: ThreadAiHistoryEntry[];
  /** 今回人間が書いた新しい発言 */
  newMessage: string;
}

/** スレッド相談AIへ渡すプロンプトを組み立てる（純粋関数）。CLI方式(stdin渡し)・API方式
 *  (completeText への単発プロンプト)の両方で同じ文字列をそのまま使う */
export function buildThreadReplyPrompt(input: BuildThreadReplyPromptInput): string {
  const { node, parentTitles, pageTitle, history, newMessage } = input;
  const lines: string[] = [
    "あなたは Wrangler AI。タスクノードのスレッドで相談に乗る相棒として、簡潔に日本語で答えてください。",
    "話題は以下のタスクノードそのもの。作業ディレクトリのソースコードやリポジトリの話はしない。",
    "",
    `ノード: ${node.title || "（無題）"}`,
  ];
  if (node.detail) lines.push(`詳細: ${node.detail}`);
  lines.push(
    `種別(kind): ${node.kind}`,
    `実行者(executor): ${node.executor}`,
    `状態(status): ${node.status}`,
    `実装(impl): ${node.impl ? `あり（${node.impl.type}）` : "未設定"}`,
  );
  if (parentTitles.length > 0) lines.push(`親ノード: ${parentTitles.join(", ")}`);
  if (pageTitle) lines.push(`ページ: ${pageTitle}`);

  const trimmedHistory = history.slice(-MAX_THREAD_AI_HISTORY);
  if (trimmedHistory.length > 0) {
    lines.push("", "これまでの会話:");
    for (const h of trimmedHistory) lines.push(`${h.kind}: ${h.body}`);
  }

  lines.push("", `人間: ${newMessage}`);
  return lines.join("\n");
}

// ---- CLI起動（chat_cli.ts と同じ spawn の流儀。MCPは繋がずツールも持たせない素のテキスト出力） ----

export interface PlainCliResult {
  success: boolean;
  output: string;
  error?: string;
}

/** claude -p をプレーンに起動する（--output-format 指定なし＝素のテキスト出力、MCP接続なし）。
 *  プロンプトは stdin 渡し（Windows の cmd.exe が改行入り argv を切り捨てる問題を避けるため。
 *  packages/engine/src/executors/claude.ts runClaude と同型）。sanitizedClaudeEnv・
 *  Windows の shell:true 判定・タイムアウト値は chat_cli.ts と共通化している */
export function runPlainClaude(
  cliPath: string,
  cliModel: string,
  prompt: string,
  cwd: string,
): Promise<PlainCliResult> {
  return new Promise((resolve) => {
    const args = ["-p", "--model", cliModel];
    const isWindows = process.platform === "win32";
    let child;
    try {
      // cwd 明示: サーバの cwd のまま起動すると claude が graphwrangler リポジトリを
      // 自分のプロジェクトと誤認する（chat_cli.ts と同じ対策。2026-07-31 実測）
      child = spawn(cliPath, args, { ...(isWindows ? { shell: true } : {}), env: sanitizedClaudeEnv(), cwd });
    } catch (err) {
      resolve({ success: false, output: "", error: `${cliPath} -p 起動失敗: ${String(err)}` });
      return;
    }
    child.stdin?.write(prompt);
    child.stdin?.end();

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CLI_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: stdout, error: `${cliPath} -p 起動失敗: ${String(err)}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ success: false, output: stdout, error: "ヘッドレスCLIの応答がタイムアウトしました（5分）" });
        return;
      }
      if (code !== 0) {
        const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join(" / ");
        resolve({ success: false, output: stdout, error: combined.slice(0, 500) || `終了コード ${code}` });
        return;
      }
      resolve({ success: true, output: stdout.trim() });
    });
  });
}

// ---- オーケストレーション（副作用あり。ノードごとの簡潔な排他つき） ----

/** 実行中のノードid集合。多重投稿されても「実行中なら今回はスキップ」という簡潔な排他で
 *  十分（docs/agent-contracts.md の担当外にある詳細なキューイングは持たない） */
const runningThreadAiNodes = new Set<string>();

async function respondInThread(
  graph: GraphStore,
  threads: ThreadStore,
  settings: SettingsStore,
  node: Node,
): Promise<void> {
  const messages = threads.list(node.id);
  const last = messages[messages.length - 1];
  if (!last) return; // 起動条件は post 直後なので理論上は必ずある

  const history: ThreadAiHistoryEntry[] = messages
    .slice(0, -1)
    .filter((m) => m.kind === "say" || m.kind === "decision_request" || m.kind === "decision_answer")
    .slice(-MAX_THREAD_AI_HISTORY)
    .map((m) => ({ kind: m.kind, body: m.body }));

  const parentTitles = node.parents.map((pid) => (graph.has(pid) ? graph.get(pid).title : pid));
  const pageTitle = node.group && graph.has(node.group) ? graph.get(node.group).title : null;

  const prompt = buildThreadReplyPrompt({
    node: {
      title: node.title,
      detail: node.detail,
      kind: node.kind,
      executor: node.executor,
      status: node.status,
      impl: node.impl ? { type: node.impl.type } : null,
    },
    parentTitles,
    pageTitle,
    history,
    newMessage: last.body,
  });

  const chat = settings.get().chat;
  let replyText: string;
  let modelLabel: string;

  if (chat.mode === "cli") {
    modelLabel = chat.cliModel;
    const result = await runPlainClaude(
      chat.cliPath,
      chat.cliModel,
      prompt,
      graph.workspaceInfo().root ?? os.tmpdir(),
    );
    if (!result.success) {
      console.error(`[thread-ai] node ${node.id}: ヘッドレスCLIの起動に失敗しました: ${result.error}`);
      return;
    }
    replyText = result.output.trim();
  } else {
    const missing = chatKeyMissing(settings);
    if (missing) {
      console.error(`[thread-ai] node ${node.id}: ${missing}`);
      return;
    }
    modelLabel = chat.model ?? "default";
    try {
      replyText = (await completeText(settings, prompt)).trim();
    } catch (err) {
      console.error(`[thread-ai] node ${node.id}: API呼び出しに失敗しました: ${String(err)}`);
      return;
    }
  }

  if (!replyText) return;

  threads.post(node.id, {
    kind: "say",
    body: replyText,
    author: { kind: "agent", name: `thread:${modelLabel}` },
    via: "chat",
  });
}

/**
 * POST /api/nodes/:id/messages のハンドラから、レスポンスを返した後（await しない）に
 * 呼ぶ。トリガー条件を満たさなければ何もしない。同じノードで既に応答ジョブが実行中なら
 * 今回の起動はスキップする（最後の1件だけに応答すればよいという要件を、簡潔な排他で満たす）。
 * 失敗（CLI起動失敗・タイムアウト・APIエラー）はログに出すだけでスレッドには書き込まない。
 */
export function maybeTriggerThreadAi(params: {
  graph: GraphStore;
  threads: ThreadStore;
  settings: SettingsStore;
  nodeId: string;
  kind: string;
  actor: Actor;
}): void {
  const { graph, threads, settings, nodeId, kind, actor } = params;
  if (!graph.has(nodeId)) return;
  const node = graph.get(nodeId);
  if (!shouldTriggerThreadAi({ kind, actor, pendingRequest: node.pendingRequest })) return;
  if (runningThreadAiNodes.has(nodeId)) return;

  runningThreadAiNodes.add(nodeId);
  respondInThread(graph, threads, settings, node)
    .catch((err) => {
      console.error(`[thread-ai] node ${nodeId}: 予期しないエラー: ${String(err)}`);
    })
    .finally(() => {
      runningThreadAiNodes.delete(nodeId);
    });
}
