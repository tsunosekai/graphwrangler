// ラン内の分岐アイテム（kind=decision のテンプレート。docs/design.md 3.8/3.9）。
// 判定は decisionRun.ts（純粋関数）、ここはその結果を API へ書く配線。
import { decideRunItem, getThread, openRequest, patchRunItem } from "./api.js";
import { ENGINE_ACTOR, VIA } from "./actor.js";
import { findRunGate, gateKey, type RunGateState } from "./approval.js";
import {
  DECISION_WAITING_NOTE,
  buildRunDecisionRequest,
  collectPendingRunDecisions,
  selectRunDecisionAction,
  selectRunDecisionApprovalAction,
} from "./decisionRun.js";
import { executeDecisionCore } from "./executor.js";
import { truncate } from "./format.js";
import { log } from "./log.js";
import type { Node, Run } from "./types.js";

/** ラン内の human 分岐アイテムについて、テンプレートノードのスレッドから
 *  承認連携(approval.ts)と同じ方式でゲート状態を集める */
async function fetchRunDecisionGateStates(
  pending: Array<{ run: Run; node: Node }>,
): Promise<Record<string, RunGateState>> {
  const gateStates: Record<string, RunGateState> = {};
  for (const { run, node } of pending) {
    try {
      // ゲート照合はラン横断（"all"）: runId 付きの分岐カード・回答を見失わない
      const { messages } = await getThread(node.id, "all");
      gateStates[gateKey(run.id, node.id)] = findRunGate(messages, run.id);
    } catch (err) {
      log(`分岐ゲートのスレッド取得に失敗（この周は保留）: run=${run.id} node=${node.id} ${String(err)}`);
    }
  }
  return gateStates;
}

/** waiting中(note=DECISION_WAITING_NOTE)の human 分岐アイテムを1件処理する。処理したら true */
async function tickRunDecisionApprovals(nodes: Node[], runs: Run[]): Promise<boolean> {
  const pending = collectPendingRunDecisions(nodes, runs);
  if (pending.length === 0) return false;

  const gateStates = await fetchRunDecisionGateStates(pending);
  const action = selectRunDecisionApprovalAction(nodes, runs, gateStates);

  switch (action.type) {
    case "none":
      return false;
    case "open-request":
      try {
        await openRequest(
          action.node.id,
          buildRunDecisionRequest(action.node, action.run),
          ENGINE_ACTOR,
          VIA,
          action.run.id,
        );
      } catch (err) {
        // 開けなかった（別リクエストが開いている等）。処理済み扱いにすると以降のラン処理を
        // 塞いでしまうため、この周は未処理として譲り、次周に再試行する
        log(
          `分岐の判断リクエストを開けなかった（次周に持ち越し）: run=${action.run.id} node=${action.node.id} ${String(err)}`,
        );
        return false;
      }
      log(
        `分岐: 判断リクエストを開いた run=${action.run.id} node=${action.node.id} title=${action.node.title}`,
      );
      return true;
    case "decide":
      await decideRunItem(action.run.id, action.node.id, action.choice, ENGINE_ACTOR, VIA);
      log(
        `分岐確定(human回答, ラン内): run=${action.run.id} node=${action.node.id} choice=${action.choice}`,
      );
      return true;
  }
}

/** ラン内の分岐アイテム(kind=decision)を1件実行する（script/ai executor。human は
 *  tickRunItem 側で waiting へ倒し、tickRunDecisionApprovals が往復を担当する） */
async function executeRunDecisionItem(run: Run, node: Node): Promise<void> {
  await patchRunItem(run.id, node.id, { status: "running" }, ENGINE_ACTOR, VIA);
  log(`ラン分岐実行開始: run=${run.id} node=${node.id} title=${node.title} executor=${node.executor}`);

  await executeDecisionCore(node, {
    runId: run.id,
    payload: { runId: run.id },
    logLabel: "ラン分岐",
    logWhere: `run=${run.id} node=${node.id}`,
    onFailure: async (reason) => {
      await patchRunItem(
        run.id,
        node.id,
        { status: "waiting", note: `失敗: ${truncate(reason, 200)}` },
        ENGINE_ACTOR,
        VIA,
      );
    },
    decide: async (choice, actor) => {
      await decideRunItem(run.id, node.id, choice, actor, VIA);
    },
  });
}

/** プロジェクト側・通常のランタスクに実行候補が無かったとき、ランの分岐アイテムを1件処理する。
 *  処理したら true を返す */
export async function tickRunDecision(nodes: Node[], runningRuns: Run[]): Promise<boolean> {
  if (await tickRunDecisionApprovals(nodes, runningRuns)) return true;

  const action = selectRunDecisionAction(nodes, runningRuns);
  switch (action.type) {
    case "none":
      return false;
    case "waiting-human":
      // ここではカードを開かず waiting へ倒すだけ。判断リクエストの発行/再試行は
      // tickRunDecisionApprovals（次周）が一元的に担当する（承認連携と同じ2段構え）
      await patchRunItem(
        action.run.id,
        action.node.id,
        { status: "waiting", note: DECISION_WAITING_NOTE },
        ENGINE_ACTOR,
        VIA,
      );
      log(
        `分岐(human)のため回答待ちへ: run=${action.run.id} node=${action.node.id} title=${action.node.title}`,
      );
      return true;
    case "execute-script":
    case "execute-ai":
      await executeRunDecisionItem(action.run, action.node);
      return true;
  }
}
