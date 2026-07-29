// graphwrangler 実行エンジン（M5）。常駐プロセスとして HTTP API をポーリングし、
// 実行可能なノード（実行者=ai|script）を1並列で処理する。zinsei desk/engine.py の一般化。
// docs/design.md 3.4/3.5/3.7、docs/agent-contracts.md が設計の正。
import {
  createRun,
  getSettings,
  getState,
  getThread,
  heartbeat,
  listProcedureRuns,
  openRequest,
  patchNode,
  patchRunItem,
  postMessage,
} from "./api.js";
import { buildFailureRecoveryRequest, buildIrreversibleGateRequest, selectAction } from "./pick.js";
import { selectRunAction } from "./pickRun.js";
import {
  APPROVAL_WAITING_NOTE,
  buildRunApprovalRequest,
  collectPendingApprovalItems,
  findRunGate,
  gateKey,
  selectRunApprovalAction,
  type RunGateState,
} from "./approval.js";
import { parseSchedule, shouldCreateScheduledRun } from "./schedule.js";
import { runScript } from "./executors/script.js";
import { buildAiPrompt, runClaude, type ClaudeExecutorConfig } from "./executors/claude.js";
import { runApi } from "./executors/api.js";
import type { Actor, Message, Node, Run } from "./types.js";

const INTERVAL_MS = Number(process.env.GW_ENGINE_INTERVAL_MS ?? 5000);
const VIA = "engine";
const ENGINE_ACTOR: Actor = { kind: "agent", name: "engine" };

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---- エンジンAI設定（M7: サーバ設定を起動時+10分ごとに読む） ----
// env GW_ENGINE_CLAUDE_MODEL があれば model はそれを優先する（取得失敗時は既定値で継続）。
const SETTINGS_REFRESH_MS = 10 * 60 * 1000; // 10分

const DEFAULT_ENGINE_CONFIG: ClaudeExecutorConfig = {
  cliPath: "claude",
  model: process.env.GW_ENGINE_CLAUDE_MODEL ?? "sonnet",
  extraArgs: [],
};

let engineConfig: ClaudeExecutorConfig = DEFAULT_ENGINE_CONFIG;
// engine.mode（"cli"=claude -p 等のヘッドレスCLI起動 / "api"=サーバの /api/ai/complete を呼ぶ）。
// 取得失敗時は前回値のまま継続する（既定は安全側の "cli"）
let engineMode: "cli" | "api" = "cli";
let lastSettingsFetchAt = 0;

/** GET /api/settings から engine executor の設定を反映する。10分未満は何もしない
 *  （force=true なら起動時など強制的に取得する）。取得失敗時は既定値のまま継続する */
async function refreshEngineConfig(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSettingsFetchAt < SETTINGS_REFRESH_MS) return;
  lastSettingsFetchAt = now;
  try {
    const settings = await getSettings();
    const modelFromEnv = process.env.GW_ENGINE_CLAUDE_MODEL;
    engineMode = settings.engine.mode === "api" ? "api" : "cli";
    engineConfig = {
      cliPath: settings.engine.cliPath || DEFAULT_ENGINE_CONFIG.cliPath,
      model: modelFromEnv ?? settings.engine.model ?? DEFAULT_ENGINE_CONFIG.model,
      extraArgs: Array.isArray(settings.engine.extraArgs) ? settings.engine.extraArgs : [],
    };
    log(
      `エンジン設定を反映: mode=${engineMode} cliPath=${engineConfig.cliPath} model=${engineConfig.model} extraArgs=${JSON.stringify(engineConfig.extraArgs)}`,
    );
  } catch (err) {
    log(`設定取得に失敗（既定値のまま継続）: ${String(err)}`);
  }
}

function truncate(text: string, limit: number): string {
  const t = text.trim();
  return t.length <= limit ? t : t.slice(0, limit) + "…";
}

/** 承認/失敗リカバリの回答判定に必要なので、frontier かつ pending な候補ノードだけ
 *  スレッドの最新メッセージを取得する（全ノード分は叩かない） */
function candidateIdsNeedingThread(nodes: Node[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes
    .filter(
      (n) =>
        n.lifecycle === "committed" &&
        n.kind === "task" &&
        (n.executor === "ai" || n.executor === "script") &&
        n.status === "pending" &&
        !n.pendingRequest &&
        n.parents.every((pid) => byId.get(pid)?.status === "done"),
    )
    .map((n) => n.id);
}

async function lastMessagesFor(nodeIds: string[]): Promise<Record<string, Message | undefined>> {
  const result: Record<string, Message | undefined> = {};
  for (const id of nodeIds) {
    try {
      const { messages } = await getThread(id);
      result[id] = messages[messages.length - 1];
    } catch (err) {
      log(`スレッド取得に失敗（この周は候補から除外扱い）: node=${id} ${String(err)}`);
    }
  }
  return result;
}

/** 親ノードのスレッド末尾の say メッセージ（文脈）を集める */
async function parentSayContext(node: Node, nodes: Node[]): Promise<string[]> {
  const out: string[] = [];
  for (const pid of node.parents) {
    try {
      const { messages } = await getThread(pid);
      const say = [...messages].reverse().find((m) => m.kind === "say");
      if (say) {
        const title = nodes.find((n) => n.id === pid)?.title ?? pid;
        out.push(`${title}: ${say.body}`);
      }
    } catch (err) {
      log(`親ノードの文脈取得に失敗（実行は継続）: node=${pid} ${String(err)}`);
    }
  }
  return out;
}

async function executeNode(nodes: Node[], node: Node): Promise<void> {
  await patchNode(node.id, { status: "running" }, ENGINE_ACTOR, VIA);
  log(`実行開始: id=${node.id} title=${node.title} executor=${node.executor}`);

  let result: { success: boolean; output: string; error?: string };
  let executorName: string;
  let aiSources: string[] = [];

  if (node.executor === "script") {
    executorName = "executor:script";
    if (!node.impl || node.impl.type !== "script") {
      result = { success: false, output: "", error: "実装がない（impl が script 形式ではない）" };
    } else {
      result = await runScript(node.impl.command);
    }
  } else {
    const goal = node.group ? (nodes.find((n) => n.id === node.group) ?? null) : null;
    const parentSayMessages = await parentSayContext(node, nodes);
    const built = buildAiPrompt({ node, goal, parentSayMessages });
    aiSources = built.sources;
    if (engineMode === "api") {
      executorName = "executor:api";
      result = await runApi(built.prompt);
    } else {
      executorName = "executor:claude";
      result = await runClaude(built.prompt, engineConfig);
    }
  }

  const actor: Actor = { kind: "agent", name: executorName };

  if (result.success) {
    const summary = truncate(result.output || "(出力なし)", 500);
    await postMessage(node.id, { kind: "status", body: `実行成功: ${summary}` }, actor, VIA);
    // AI発言の出典バッジ用データ（docs/design.md 3.8）。script executor には該当する文脈が無いので付けない
    const sayPayload = node.executor === "ai" ? { sources: aiSources } : undefined;
    await postMessage(
      node.id,
      { kind: "say", body: result.output.trim() || "(結果なし)", payload: sayPayload },
      actor,
      VIA,
    );
    await patchNode(node.id, { status: "done" }, ENGINE_ACTOR, VIA);
    log(`実行成功: id=${node.id}`);
    return;
  }

  const reason = result.error || "不明なエラー";
  await postMessage(
    node.id,
    { kind: "status", body: truncate(`実行失敗: ${reason}`, 500) },
    actor,
    VIA,
  );
  await patchNode(node.id, { status: "waiting" }, ENGINE_ACTOR, VIA);
  await openRequest(node.id, buildFailureRecoveryRequest(node, reason), ENGINE_ACTOR, VIA);
  log(`実行失敗: id=${node.id} reason=${reason}`);
}

// ---- 手順ページ: ランのワークアイテム実行（M6） ----

/** ランのワークアイテムを実行する。プロンプト文脈は手順ノード(procedure)の title/detail +
 *  テンプレートの title/detail/impl（claude.ts の buildAiPrompt を "goal=手順ノード" として再利用）。
 *  実行ログ・成果はテンプレートノードのスレッドへ payload {runId} 付きで投稿する */
async function executeRunItem(nodes: Node[], run: Run, node: Node): Promise<void> {
  await patchRunItem(run.id, node.id, { status: "running" }, ENGINE_ACTOR, VIA);
  log(`ラン実行開始: run=${run.id} node=${node.id} title=${node.title} executor=${node.executor}`);

  let result: { success: boolean; output: string; error?: string };
  let executorName: string;
  let aiSources: string[] = [];

  if (node.executor === "script") {
    executorName = "executor:script";
    if (!node.impl || node.impl.type !== "script") {
      result = { success: false, output: "", error: "実装がない（impl が script 形式ではない）" };
    } else {
      result = await runScript(node.impl.command);
    }
  } else {
    const procedureNode = nodes.find((n) => n.id === run.procedure) ?? null;
    const built = buildAiPrompt({ node, goal: procedureNode, parentSayMessages: [] });
    aiSources = built.sources;
    if (engineMode === "api") {
      executorName = "executor:api";
      result = await runApi(built.prompt);
    } else {
      executorName = "executor:claude";
      result = await runClaude(built.prompt, engineConfig);
    }
  }

  const actor: Actor = { kind: "agent", name: executorName };
  const payload = { runId: run.id };

  if (result.success) {
    const summary = truncate(result.output || "(出力なし)", 500);
    await postMessage(node.id, { kind: "status", body: `実行成功: ${summary}`, payload }, actor, VIA);
    // AI発言の出典バッジ用データ（docs/design.md 3.8）。script executor には該当する文脈が無いので付けない
    const sayPayload = node.executor === "ai" ? { ...payload, sources: aiSources } : payload;
    await postMessage(
      node.id,
      { kind: "say", body: result.output.trim() || "(結果なし)", payload: sayPayload },
      actor,
      VIA,
    );
    await patchRunItem(run.id, node.id, { status: "done" }, ENGINE_ACTOR, VIA);
    log(`ラン実行成功: run=${run.id} node=${node.id}`);
    return;
  }

  const reason = result.error || "不明なエラー";
  await postMessage(
    node.id,
    { kind: "status", body: truncate(`実行失敗: ${reason}`, 500), payload },
    actor,
    VIA,
  );
  await patchRunItem(
    run.id,
    node.id,
    { status: "waiting", note: `失敗: ${truncate(reason, 200)}` },
    ENGINE_ACTOR,
    VIA,
  );
  log(`ラン実行失敗: run=${run.id} node=${node.id} reason=${reason}`);
}

/** status=running の全ランを procedure ノードごとに束ねて取得する
 *  （procedure を横断する一覧APIが無いため、procedure ノード単位で叩いて集める） */
async function fetchRunningRuns(nodes: Node[]): Promise<Run[]> {
  const procedures = nodes.filter((n) => n.kind === "procedure");
  const runsByProcedure = await Promise.all(
    procedures.map(async (p) => {
      try {
        return await listProcedureRuns(p.id);
      } catch (err) {
        log(`ラン一覧取得に失敗（この周は除外）: procedure=${p.id} ${String(err)}`);
        return [] as Run[];
      }
    }),
  );
  return runsByProcedure.flat().filter((r) => r.status === "running");
}

// ---- 手順ページ: 不可逆ランアイテムの承認連携（docs/agent-contracts.md 1.） ----

/** 承認待ち（waiting/note=APPROVAL_WAITING_NOTE）のランアイテムについて、テンプレートノードの
 *  スレッドから承認ゲートの状態を集める（対象があるものだけスレッドを取得する） */
async function fetchGateStates(
  pending: Array<{ run: Run; node: Node }>,
): Promise<Record<string, RunGateState>> {
  const gateStates: Record<string, RunGateState> = {};
  for (const { run, node } of pending) {
    try {
      const { messages } = await getThread(node.id);
      gateStates[gateKey(run.id, node.id)] = findRunGate(messages, run.id);
    } catch (err) {
      log(`承認ゲートのスレッド取得に失敗（この周は保留）: run=${run.id} node=${node.id} ${String(err)}`);
    }
  }
  return gateStates;
}

/** 不可逆ランアイテムの承認状態を1件処理する。処理した(=何かアクションを起こした)ら true を返す */
async function tickRunApprovals(nodes: Node[], runs: Run[]): Promise<boolean> {
  const pending = collectPendingApprovalItems(nodes, runs);
  if (pending.length === 0) return false;

  const gateStates = await fetchGateStates(pending);
  const action = selectRunApprovalAction(nodes, runs, gateStates);

  switch (action.type) {
    case "none":
      return false;
    case "open-gate":
      try {
        await openRequest(
          action.node.id,
          buildRunApprovalRequest(action.node, action.run),
          ENGINE_ACTOR,
          VIA,
        );
        log(
          `不可逆のため承認カードを開いた: run=${action.run.id} node=${action.node.id} title=${action.node.title}`,
        );
      } catch (err) {
        // node に既に別のリクエストが開いている等。次周に再試行する
        log(
          `承認カードを開けなかった（次周に持ち越し）: run=${action.run.id} node=${action.node.id} ${String(err)}`,
        );
      }
      return true;
    case "execute":
      await executeRunItem(nodes, action.run, action.node);
      return true;
    case "skip":
      await patchRunItem(
        action.run.id,
        action.node.id,
        { status: "skipped", note: "承認で見送り" },
        ENGINE_ACTOR,
        VIA,
      );
      log(
        `承認により見送り(skipped): run=${action.run.id} node=${action.node.id} title=${action.node.title}`,
      );
      return true;
  }
}

/** プロジェクト側に実行候補が無かったとき、ランのワークアイテムを1件処理する。
 *  承認待ちアイテムの回答チェックをランの通常実行候補選択より先に行う */
async function tickRunItem(nodes: Node[]): Promise<void> {
  const runningRuns = await fetchRunningRuns(nodes);
  if (runningRuns.length === 0) return;

  if (await tickRunApprovals(nodes, runningRuns)) return;

  const action = selectRunAction(nodes, runningRuns);
  switch (action.type) {
    case "none":
      return;
    case "waiting-irreversible":
      // ここではカードを開かず waiting へ倒すだけ。承認カードの発行/再試行は
      // tickRunApprovals（次周）が一元的に担当する（開けなかった場合の再試行もそちら任せにできる）
      await patchRunItem(
        action.run.id,
        action.node.id,
        { status: "waiting", note: APPROVAL_WAITING_NOTE },
        ENGINE_ACTOR,
        VIA,
      );
      log(
        `不可逆のため承認待ちへ: run=${action.run.id} node=${action.node.id} title=${action.node.title}`,
      );
      return;
    case "execute":
      await executeRunItem(nodes, action.run, action.node);
      return;
  }
}

// ---- 手順ページ: スケジュールによるラン自動生成（M6） ----

/** node.schedule を持つ procedure ノードを毎tickチェックし、条件を満たせば新しいランを作る。
 *  対応書式は schedule.ts の parseSchedule のみ（それ以外は警告ログを出して無視する） */
async function scheduleTick(nodes: Node[]): Promise<void> {
  const procedures = nodes.filter((n) => n.kind === "procedure" && n.schedule);

  for (const proc of procedures) {
    const schedule = parseSchedule(proc.schedule as string);
    if (!schedule) {
      log(`未対応のschedule書式のため無視: procedure=${proc.id} schedule="${proc.schedule}"`);
      continue;
    }

    let runsForProc: Run[];
    try {
      runsForProc = await listProcedureRuns(proc.id);
    } catch (err) {
      log(`ラン一覧取得に失敗（次周に持ち越し）: procedure=${proc.id} ${String(err)}`);
      continue;
    }

    const hasRunningRun = runsForProc.some((r) => r.status === "running");
    const latestRun = runsForProc[0] ?? null; // list は created 降順
    const now = new Date();

    if (!shouldCreateScheduledRun(schedule, latestRun, now, hasRunningRun)) continue;

    try {
      await createRun(proc.id, { trigger: `schedule:${proc.schedule}` }, ENGINE_ACTOR, VIA);
      log(`スケジュールによりラン生成: procedure=${proc.id} schedule="${proc.schedule}"`);
    } catch (err) {
      log(`ラン生成に失敗（次周に持ち越し）: procedure=${proc.id} ${String(err)}`);
    }
  }
}

async function tick(): Promise<void> {
  await refreshEngineConfig(); // 起動時+10分ごと（内部で throttle。M7）

  // UIの稼働インジケータ用ハートビート（失敗しても実行は続ける）
  void heartbeat().catch(() => {});

  const { nodes } = await getState();

  await scheduleTick(nodes);

  const ids = candidateIdsNeedingThread(nodes);
  const lastMessages = await lastMessagesFor(ids);
  const action = selectAction(nodes, lastMessages);

  switch (action.type) {
    case "drop":
      await patchNode(action.node.id, { status: "dropped" }, ENGINE_ACTOR, VIA);
      log(`人間の回答により中止(dropped): id=${action.node.id} title=${action.node.title}`);
      return;
    case "open-gate":
      await openRequest(action.node.id, buildIrreversibleGateRequest(action.node), ENGINE_ACTOR, VIA);
      log(`不可逆ノードの承認カードを開いた: id=${action.node.id} title=${action.node.title}`);
      return;
    case "execute":
      await executeNode(nodes, action.node);
      return;
    case "none":
      break; // プロジェクト側に候補が無ければランのアイテムを見る（候補: プロジェクト優先→ラン）
  }

  await tickRunItem(nodes);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const url = process.env.GRAPHWRANGLER_URL ?? "http://localhost:8770";
  await refreshEngineConfig(true); // 起動時は必ず一度取得する
  log(
    `graphwrangler engine 起動: url=${url} interval=${INTERVAL_MS}ms mode=${engineMode} cliPath=${engineConfig.cliPath} model=${engineConfig.model}`,
  );
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log(`tick失敗（次周に持ち越し）: ${String(err)}`);
    }
    await sleep(INTERVAL_MS);
  }
}

main();
