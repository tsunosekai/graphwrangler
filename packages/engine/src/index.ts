// graphwrangler 実行エンジン（M5）。常駐プロセスとして HTTP API をポーリングし、
// 実行可能なノード（実行者=ai|script）を1並列で処理する。zinsei desk/engine.py の一般化。
// docs/design.md 3.4/3.5/3.7、docs/agent-contracts.md が設計の正。
import { getState, getThread, openRequest, patchNode, postMessage } from "./api.js";
import { buildFailureRecoveryRequest, buildIrreversibleGateRequest, selectAction } from "./pick.js";
import { runScript } from "./executors/script.js";
import { buildAiPrompt, runClaude } from "./executors/claude.js";
import type { Actor, Message, Node } from "./types.js";

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

async function tick(): Promise<void> {
  const { nodes } = await getState();
  const ids = candidateIdsNeedingThread(nodes);
  const lastMessages = await lastMessagesFor(ids);
  const action = selectAction(nodes, lastMessages);

  switch (action.type) {
    case "none":
      return;
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
  }
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
