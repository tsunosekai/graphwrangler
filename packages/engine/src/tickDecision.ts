// 分岐ノード（kind=decision、プロジェクト層。docs/design.md 3.9）。
// 判定は decision.ts（純粋関数）、ここはその結果を API へ書く配線。
import { decideNode, openRequest, patchNode } from "./api.js";
import { ENGINE_ACTOR, VIA } from "./actor.js";
import { buildDecisionRequest, selectDecisionAction } from "./decision.js";
import { executeDecisionCore } from "./executor.js";
import { log } from "./log.js";
import { buildFailureRecoveryRequest, isRunManagedMember, triggerPageIds } from "./pick.js";
import { demoteToDraft } from "./tickProject.js";
import { lastMessagesFor } from "./threadContext.js";
import type { Node } from "./types.js";

/** decision候補のうち committed/pending/frontier のものだけスレッド取得対象にする
 *  （decision.ts の isDecisionCandidateKind/isFrontierForDecision と同じ条件をここで再実装。
 *  candidateIdsNeedingThread と同じ理由で、全ノード分は叩かない。executor問わず対象にするのは
 *  script/ai executor の失敗リカバリ回答(abort)もここで拾う必要があるため） */
function decisionCandidateIdsNeedingThread(nodes: Node[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const triggerPages = triggerPageIds(nodes);
  return nodes
    .filter(
      (n) =>
        n.kind === "decision" &&
        n.lifecycle === "committed" &&
        n.status === "pending" &&
        !n.pendingRequest && // open な判断リクエスト中は人間待ち（回答が来ると server が解除する）
        !isRunManagedMember(n, triggerPages) &&
        n.parents.every((pid) => {
          const s = byId.get(pid)?.status;
          return s === "done" || s === "skipped";
        }),
    )
    .map((n) => n.id);
}

/** 分岐ノード(kind=decision, プロジェクト層)を1件処理する。処理した(=何かアクションを
 *  起こした)ら true を返す */
export async function tickDecision(nodes: Node[]): Promise<boolean> {
  const ids = decisionCandidateIdsNeedingThread(nodes);
  const lastMessages = await lastMessagesFor(ids);
  const action = selectDecisionAction(nodes, lastMessages);

  switch (action.type) {
    case "none":
      return false;
    case "drop":
      await patchNode(action.node.id, { status: "dropped" }, ENGINE_ACTOR, VIA);
      log(`分岐の失敗リカバリで中止(dropped): id=${action.node.id} title=${action.node.title}`);
      return true;
    case "demote":
      await demoteToDraft(action.node);
      return true;
    case "open-human-request":
      await openRequest(action.node.id, buildDecisionRequest(action.node), ENGINE_ACTOR, VIA);
      log(`分岐: 判断リクエストを開いた id=${action.node.id} title=${action.node.title}`);
      return true;
    case "decide":
      await decideNode(action.node.id, action.choice, ENGINE_ACTOR, VIA);
      log(`分岐確定(human回答): id=${action.node.id} choice=${action.choice}`);
      return true;
    case "execute-script":
    case "execute-ai": {
      const node = action.node;
      await executeDecisionCore(node, {
        logLabel: "分岐",
        logWhere: `id=${node.id}`,
        onFailure: async (reason) => {
          await openRequest(node.id, buildFailureRecoveryRequest(node, reason), ENGINE_ACTOR, VIA);
        },
        decide: async (choice, actor) => {
          await decideNode(node.id, choice, actor, VIA);
        },
      });
      return true;
    }
  }
}
