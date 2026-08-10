// スレッド相談AI（Task AI。「会話はいつでも可」の原則。docs/design.md 3.9）。
// ノードのスレッドに人間が say を書いたら、非同期でAIが応答する。判断リクエストの
// ラリー（POST /api/nodes/:id/answer, option:null）はエンジン側が拾うので、ここでは
// 「open な判断リクエストが無いノードへの普通の相談」だけを相手にする。
// 呼び出し元は index.ts の POST /api/nodes/:id/messages（メッセージ保存レスポンスを
// 返した直後、await せずに maybeTriggerThreadAi を呼ぶ）。
import type { Actor, GraphStore, Node, ThreadStore } from "@graphwrangler/core";
import { spawn } from "node:child_process";
import os from "node:os";
import { chatKeyMissing, completeText } from "./chat.js";
import {
  CLI_TIMEOUT_MS,
  DEFAULT_CLI_TOOLS,
  killTree,
  sanitizeModelOverride,
  sanitizedClaudeEnv,
} from "./chat_cli.js";
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
  /** impl の「有無と種類」+ doc の path だけ渡す（doc の全文は含めない。path があれば
   *  AI 自身が Read で読む。相談AIは概況が分かれば十分） */
  impl: { type: "doc" | "script"; path?: string | null } | null;
}

export interface ThreadAiHistoryEntry {
  kind: string;
  body: string;
}

/** Node → プロンプト用のノード文脈。impl は「有無と種類」+ doc の path だけ渡す
 *  （ThreadAiNodeContext の規約。script の command 等は含めない） */
export function threadAiNodeContext(
  node: Pick<Node, "title" | "detail" | "kind" | "executor" | "status" | "impl">,
): ThreadAiNodeContext {
  return {
    title: node.title,
    detail: node.detail,
    kind: node.kind,
    executor: node.executor,
    status: node.status,
    impl: node.impl
      ? { type: node.impl.type, path: node.impl.type === "doc" ? (node.impl.path ?? null) : null }
      : null,
  };
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
    "あなたは Task AI。タスクノードのスレッドで相談に乗る担当として、簡潔に答えてください。" +
      "**必ずユーザーが話しかけてきた言語で書くこと**（日本語で話しかけられたら日本語）。",
    "話題は以下のタスクノードそのもの。作業ディレクトリのソースコードやリポジトリの話はしない。",
    "実装(impl)の path やドキュメントに言及するときは、読んでいいか確認を求めず Read で先に読んでから答えること。",
    "メッセージ中の「[添付ファイル: <パス>]」はユーザーが添付したファイル。確認を求めず Read で読んで内容を踏まえること。",
    "",
    `ノード: ${node.title || "（無題）"}`,
  ];
  if (node.detail) lines.push(`詳細: ${node.detail}`);
  lines.push(
    `種別(kind): ${node.kind}`,
    `実行者(executor): ${node.executor}`,
    `状態(status): ${node.status}`,
    `実装(impl): ${
      node.impl
        ? node.impl.type === "doc" && node.impl.path
          ? `あり（doc, path: ${node.impl.path}）`
          : `あり（${node.impl.type}）`
        : "未設定"
    }`,
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
  /** 人間が「停止」した（失敗ではないので、スレッドにエラーを書かない） */
  cancelled?: boolean;
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
  extraTools: string[] = [],
  addDirs: string[] = [],
  /** 中断シグナル（UI の「停止」。2026-08-05）。落ちたら claude を木ごと殺して
   *  cancelled:true で返す */
  signal?: AbortSignal,
  /** --effort（思考の深さ）。null = CLI 既定（2026-08-07 モデル/エフォート切替） */
  effort: string | null = null,
): Promise<PlainCliResult> {
  return new Promise((resolve) => {
    // chat_cli.ts と同じフルセットを許可（2026-08-03 権限拡張。それまでは読み取り専用だった）。
    // extraTools = 設定 chat.cliExtraTools（例: "mcp__foo__*"）。"-" 始まりはフラグ解釈される
    // ので落とす（chat_cli.ts と同じサニタイズ）
    const args = [
      "-p",
      "--model",
      cliModel,
      ...(effort ? ["--effort", effort] : []),
      "--allowedTools",
      ...DEFAULT_CLI_TOOLS,
      ...extraTools.filter((t) => !t.startsWith("-")),
      // 設定 ai.addDirs: ワークスペースルート外もファイルツールで触れるようにする（chat_cli.ts と同じ）
      ...addDirs.filter((d) => !d.startsWith("-")).flatMap((d) => ["--add-dir", d]),
    ];
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
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, CLI_TIMEOUT_MS);
    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

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
      signal?.removeEventListener("abort", onAbort);
      if (cancelled) {
        resolve({ success: false, output: stdout, cancelled: true });
        return;
      }
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

/** 実行中のノード id → その応答を止めるための AbortController（2026-08-05「AIの会話を
 *  止められるように」）。以前は id の Set だけで、止める手段が無かった */
const runningThreadAi = new Map<string, AbortController>();
/** 応答中に人間がもう一度書いた（＝送信予約）ノード。今の応答が終わったら、増えた発言も
 *  含めた最新のスレッドでもう一度応答する。以前はここで黙って捨てていたので、
 *  応答中に書いた分は永遠に返事が来なかった（2026-08-05 本人要望「送信予約で話しかける機能」） */
const pendingFollowUp = new Set<string>();

/** 排他の単位は「ノード × ラン」（2026-08-08「会話もフォーク」）。同じノードでも別のランなら
 *  会話が別物なので、片方の応答中にもう片方が止まってしまわないようにする */
function aiKey(nodeId: string, runId: string | null): string {
  return runId ? `${nodeId} ${runId}` : nodeId;
}

/** UI の「考え中」表示用（GET /api/nodes/:id/thread が aiBusy として返す。
 *  2026-08-03 本人報告「ノードのAIチャット欄、考え中がでない」——GraphWrangler AI と挙動を揃える） */
export function isThreadAiRunning(nodeId: string, runId: string | null = null): boolean {
  return runningThreadAi.has(aiKey(nodeId, runId));
}

/** 応答中の Task AI の数。自動アップデートの busy 判定用（chat_cli.ts の
 *  activeChatCliCount と同じ理由。2026-08-07） */
export function threadAiActiveCount(): number {
  return runningThreadAi.size;
}

/** 送信予約を受けて再応答待ちか（UI の表示用） */
export function isThreadAiFollowUpQueued(nodeId: string, runId: string | null = null): boolean {
  return pendingFollowUp.has(aiKey(nodeId, runId));
}

/** Task AI の応答を止める（POST /api/nodes/:id/thread-ai/cancel）。
 *  予約されていた送信予約の再応答も取り消す——「止めて」と言われたら全部止まるのが素直。
 *  戻り値 false = そもそも動いていなかった */
export function cancelThreadAi(nodeId: string, runId: string | null = null): boolean {
  const key = aiKey(nodeId, runId);
  const hadFollowUp = pendingFollowUp.delete(key);
  const controller = runningThreadAi.get(key);
  if (!controller) return hadFollowUp;
  controller.abort();
  return true;
}

/** 応答失敗をスレッドに見える形で残す（GraphWrangler AI がエラーを画面に出すのと同じ扱い。
 *  以前はサーバログだけで、人間には「考え中が出ない・返事も来ない」に見えていた） */
function postThreadAiFailure(
  threads: ThreadStore,
  nodeId: string,
  reason: string,
  runId: string | null,
): void {
  try {
    threads.post(nodeId, {
      kind: "status",
      body: `Task AI 応答失敗: ${reason.slice(0, 300)}`,
      author: { kind: "system" },
      via: "chat",
      runId,
    });
  } catch (err) {
    console.error(`[thread-ai] node ${nodeId}: 失敗の記録にも失敗: ${String(err)}`);
  }
}

async function respondInThread(
  graph: GraphStore,
  threads: ThreadStore,
  settings: SettingsStore,
  node: Node,
  signal: AbortSignal,
  onReply?: (node: Node, replyText: string) => void,
  attachmentsDir?: string,
  // どのランの会話に返すか（2026-08-08「会話もフォーク」）。null = テンプレート側
  runId: string | null = null,
): Promise<void> {
  const messages = threads.listScoped(node.id, runId);
  const last = messages[messages.length - 1];
  if (!last) return; // 起動条件は post 直後なので理論上は必ずある

  // 「新しい会話」区切り（payload.chatBreak。UIの NodePanel と同じ規約）以降だけを文脈にする
  const lastBreak = messages.reduce(
    (acc, m, i) => ((m.payload as { chatBreak?: boolean } | null)?.chatBreak ? i : acc),
    -1,
  );
  const scoped = lastBreak >= 0 ? messages.slice(lastBreak + 1) : messages;

  const history: ThreadAiHistoryEntry[] = scoped
    .slice(0, -1)
    .filter((m) => m.kind === "say" || m.kind === "decision_request" || m.kind === "decision_answer")
    .slice(-MAX_THREAD_AI_HISTORY)
    .map((m) => ({ kind: m.kind, body: m.body }));

  const parentTitles = node.parents.map((pid) => (graph.has(pid) ? graph.get(pid).title : pid));
  const pageTitle = node.group && graph.has(node.group) ? graph.get(node.group).title : null;

  const prompt = buildThreadReplyPrompt({
    node: threadAiNodeContext(node),
    parentTitles,
    pageTitle,
    history,
    newMessage: last.body,
  });

  const chat = settings.get().chat;
  let replyText: string;
  let modelLabel: string;

  if (chat.mode === "cli") {
    // ノード側の aiModel/aiEffort が設定の既定より優先（2026-08-07 モデル/エフォート切替）。
    // aiModel はスキーマ上自由な文字列（MCP/HTTP の patch で入る）で、Windows は shell:true
    // 起動＝空白で argv が割れてフラグを注入できるため、chat_cli.ts のモデル上書きと同じ
    // サニタイズを通し、不正なら設定の既定へ（aiEffort はスキーマの enum で閉じている）
    const model = sanitizeModelOverride(node.aiModel) ?? chat.cliModel;
    if (node.aiModel !== null && model !== node.aiModel) {
      console.warn(
        `[thread-ai] node ${node.id}: aiModel "${node.aiModel}" は不正な形式のため既定 ${chat.cliModel} を使います`,
      );
    }
    const effort = node.aiEffort ?? chat.cliEffort;
    modelLabel = model;
    // attachmentsDir を --add-dir に足す: datadir モードでは添付置き場が cwd の外（chat_cli と同じ）
    const addDirs = attachmentsDir
      ? [...settings.get().ai.addDirs, attachmentsDir]
      : settings.get().ai.addDirs;
    const result = await runPlainClaude(
      chat.cliPath,
      model,
      prompt,
      graph.workspaceInfo().root ?? os.tmpdir(),
      chat.cliExtraTools,
      addDirs,
      signal,
      effort,
    );
    if (result.cancelled) return; // 人間が止めた（失敗ではないのでスレッドには書かない）
    if (!result.success) {
      console.error(`[thread-ai] node ${node.id}: ヘッドレスCLIの起動に失敗しました: ${result.error}`);
      postThreadAiFailure(threads, node.id, result.error ?? "ヘッドレスCLIの起動に失敗", runId);
      return;
    }
    replyText = result.output.trim();
  } else {
    const missing = chatKeyMissing(settings);
    if (missing) {
      console.error(`[thread-ai] node ${node.id}: ${missing}`);
      postThreadAiFailure(threads, node.id, missing, runId);
      return;
    }
    modelLabel = chat.model ?? "default";
    try {
      replyText = (await completeText(settings, prompt, undefined, signal)).trim();
    } catch (err) {
      if (signal.aborted) return; // 人間が止めた
      console.error(`[thread-ai] node ${node.id}: API呼び出しに失敗しました: ${String(err)}`);
      postThreadAiFailure(threads, node.id, String(err), runId);
      return;
    }
  }

  if (!replyText) return;
  if (signal.aborted) return; // 止めた後に届いた応答は書き込まない

  threads.post(node.id, {
    kind: "say",
    body: replyText,
    author: { kind: "agent", name: `task-ai:${modelLabel}` },
    via: "chat",
    runId,
  });
  // Discord 等への「返信が来た」通知（2026-08-07。設定・宛先解決は呼び出し側=index.ts が持つ）
  onReply?.(node, replyText);
}

/**
 * POST /api/nodes/:id/messages のハンドラから、レスポンスを返した後（await しない）に
 * 呼ぶ。トリガー条件を満たさなければ何もしない。
 *
 * 同じノードで応答ジョブが走っている最中の投稿（＝送信予約）は、捨てずに**予約**して
 * 今の応答が終わってから1回だけ再応答する（2026-08-05 本人要望「送信予約で話しかける機能」。
 * それまでは黙って捨てていたので、応答中に書いた分には永遠に返事が来なかった）。
 * 何度送信予約しても予約は1つ——プロンプトはそのときのスレッド全体から組み立て直すので、
 * 溜まった発言はまとめて1回の応答で拾われる。
 *
 * 失敗（CLI起動失敗・タイムアウト・APIエラー）はスレッドに status として残す。
 * 人間が「停止」した場合は何も書かない（失敗ではないため）。
 */
export function maybeTriggerThreadAi(params: {
  graph: GraphStore;
  threads: ThreadStore;
  settings: SettingsStore;
  nodeId: string;
  kind: string;
  actor: Actor;
  /** 返信を書き終えたときに呼ばれる（Discord 通知等。2026-08-07）。失敗は無視してよい */
  onReply?: (node: Node, replyText: string) => void;
  /** 添付ファイル置き場（--add-dir に足して Read で読めるようにする。2026-08-07） */
  attachmentsDir?: string;
  /** どのランの会話への投稿か（2026-08-08「会話もフォーク」）。null/未指定 = テンプレート側 */
  runId?: string | null;
}): void {
  const { graph, threads, settings, nodeId, kind, actor, onReply, attachmentsDir } = params;
  const runId = params.runId ?? null;
  if (!graph.has(nodeId)) return;
  const node = graph.get(nodeId);
  if (!shouldTriggerThreadAi({ kind, actor, pendingRequest: node.pendingRequest })) return;
  const key = aiKey(nodeId, runId);
  if (runningThreadAi.has(key)) {
    pendingFollowUp.add(key); // 送信予約: 今の応答が終わったら最新のスレッドで応答し直す
    return;
  }

  const controller = new AbortController();
  runningThreadAi.set(key, controller);
  respondInThread(graph, threads, settings, node, controller.signal, onReply, attachmentsDir, runId)
    .catch((err) => {
      if (controller.signal.aborted) return;
      console.error(`[thread-ai] node ${nodeId}: 予期しないエラー: ${String(err)}`);
    })
    .finally(() => {
      runningThreadAi.delete(key);
      // 停止させられたときは予約も取り消し済み（cancelThreadAi）。ここに残っていれば
      // 送信予約があったということなので、増えた発言込みでもう一度
      if (!pendingFollowUp.delete(key)) return;
      maybeTriggerThreadAi({ ...params, actor: { kind: "human" }, kind: "say" });
    });
}
