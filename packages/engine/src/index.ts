// graphwrangler 実行エンジン（M5）。常駐プロセスとして HTTP API をポーリングし、
// 実行可能なノード（実行者=ai|script）を1並列で処理する。zinsei desk/engine.py の一般化。
// docs/design.md 3.4/3.5/3.7、docs/agent-contracts.md が設計の正。
import {
  createRun,
  getState,
  getThread,
  listProcedureRuns,
  openRequest,
  patchNode,
  patchRunItem,
  postMessage,
} from "./api.js";
import { buildFailureRecoveryRequest, buildIrreversibleGateRequest, selectAction } from "./pick.js";
import { selectRunAction } from "./pickRun.js";
import { parseSchedule, shouldCreateScheduledRun } from "./schedule.js";
import { runScript } from "./executors/script.js";
import { buildAiPrompt, runClaude } from "./executors/claude.js";
import type { Actor, Message, Node, Run } from "./types.js";

const INTERVAL_MS = Number(process.env.GW_ENGINE_INTERVAL_MS ?? 5000);
const MODEL = process.env.GW_ENGINE_CLAUDE_MODEL ?? "sonnet";
const VIA = "engine";
const ENGINE_ACTOR: Actor = { kind: "agent", name: "engine" };

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
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

  if (node.executor === "script") {
    executorName = "executor:script";
    if (!node.impl || node.impl.type !== "script") {
      result = { success: false, output: "", error: "実装がない（impl が script 形式ではない）" };
    } else {
      result = await runScript(node.impl.command);
    }
  } else {
    executorName = "executor:claude";
    const goal = node.group ? (nodes.find((n) => n.id === node.group) ?? null) : null;
    const parentSayMessages = await parentSayContext(node, nodes);
    const prompt = buildAiPrompt({ node, goal, parentSayMessages });
    result = await runClaude(prompt, MODEL);
  }

  const actor: Actor = { kind: "agent", name: executorName };

  if (result.success) {
    const summary = truncate(result.output || "(出力なし)", 500);
    await postMessage(node.id, { kind: "status", body: `実行成功: ${summary}` }, actor, VIA);
    await postMessage(node.id, { kind: "say", body: result.output.trim() || "(結果なし)" }, actor, VIA);
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

  if (node.executor === "script") {
    executorName = "executor:script";
    if (!node.impl || node.impl.type !== "script") {
      result = { success: false, output: "", error: "実装がない（impl が script 形式ではない）" };
    } else {
      result = await runScript(node.impl.command);
    }
  } else {
    executorName = "executor:claude";
    const procedureNode = nodes.find((n) => n.id === run.procedure) ?? null;
    const prompt = buildAiPrompt({ node, goal: procedureNode, parentSayMessages: [] });
    result = await runClaude(prompt, MODEL);
  }

  const actor: Actor = { kind: "agent", name: executorName };
  const payload = { runId: run.id };

  if (result.success) {
    const summary = truncate(result.output || "(出力なし)", 500);
    await postMessage(node.id, { kind: "status", body: `実行成功: ${summary}`, payload }, actor, VIA);
    await postMessage(
      node.id,
      { kind: "say", body: result.output.trim() || "(結果なし)", payload },
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

/** プロジェクト側に実行候補が無かったとき、ランのワークアイテムを1件処理する */
async function tickRunItem(nodes: Node[]): Promise<void> {
  const runningRuns = await fetchRunningRuns(nodes);
  if (runningRuns.length === 0) return;

  const action = selectRunAction(nodes, runningRuns);
  switch (action.type) {
    case "none":
      return;
    case "waiting-irreversible":
      await patchRunItem(
        action.run.id,
        action.node.id,
        { status: "waiting", note: "不可逆のため人間の実行待ち" },
        ENGINE_ACTOR,
        VIA,
      );
      log(
        `不可逆のためラン待ち: run=${action.run.id} node=${action.node.id} title=${action.node.title}`,
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
  log(`graphwrangler engine 起動: url=${url} interval=${INTERVAL_MS}ms model=${MODEL}`);
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
