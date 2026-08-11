// 判断リクエストを開く（＝グラフのボールを人間へ渡す）1本道。2026-08-11 に切り出した。
//
// 「あなたの番」の Discord 通知はここでしか鳴らない（もう1つの発生源はランのワークアイテムが
// waiting へ遷移する経路）。呼び手が増えても通知の作法（関係者の解決・個人設定の尊重・
// ノードURL 必須）が枝分かれしないよう、経路を1つに畳んである。
//
// 呼び手:
//   - POST /api/nodes/:id/request … agent/engine から（AI実行中の QUESTION・承認ゲート・
//     失敗リカバリ・分岐が全部ここへ来る）
//   - スレッドの Task AI … 会話中に QUESTION プロトコルで人間の判断を求めたとき（thread_ai.ts）
import type { Actor, DecisionRequest, GraphStore, Message, ThreadStore } from "@graphwrangler/core";
import { loadUsers } from "./auth.js";
import { notifyTurn } from "./discord.js";
import { notifyTargetOf } from "./notify_target.js";
import { resolveRecipients } from "./recipients.js";
import type { SettingsStore } from "./settings.js";
import type { UserSettingsStore } from "./user_settings.js";

export interface OpenRequestDeps {
  graph: GraphStore;
  threads: ThreadStore;
  settings: SettingsStore;
  userSettings: UserSettingsStore;
  usersFile: string;
}

/**
 * 判断リクエストを開き、ノードの pendingRequest をセットし、「あなたの番」を Discord へ流す。
 * **呼び出し側が事前に pendingRequest の重複を弾くこと**（このノードに既に open なリクエストが
 * あるかどうかで、409 にするか黙って見送るかが呼び手ごとに違うため）。
 *
 * 通知は投げっぱなし＝この処理をブロックしない（通知は補助機能で、本体の操作を
 * 失敗させる理由にはならない）。
 */
export function openHumanRequest(
  deps: OpenRequestDeps,
  nodeId: string,
  request: DecisionRequest,
  meta: { author: Actor; via: string },
  /** 宛先解決で「直近の会話の当事者」を探すときに見るランの会話（recipients.ts の段4）。
   *  リクエスト自体は常にテンプレート側に開く——pendingRequest はノード単位の状態で、
   *  ランごとに分かれていないため（ランへの紐付けは question 内の `[ラン <id>]` マーカーが担う） */
  recipientRunId: string | null = null,
): Message {
  const { graph, threads, settings, userSettings, usersFile } = deps;
  const node = graph.get(nodeId);
  const message = threads.openRequest(nodeId, request, { author: meta.author, via: meta.via });
  graph.patchNode(nodeId, { pendingRequest: message.id }, { actor: { kind: "system" }, via: meta.via });

  // 担当者が居るときはその人の受け取り設定を尊重する（2026-08-07 ユーザー別設定）。
  // 宛先は assignee 1本ではなく関係者まで広げて解決する（2026-08-11。recipients.ts）
  if (!node.assignee || userSettings.get(node.assignee).discordTurnNotify) {
    notifyTurn(
      settings.get().notify,
      resolveRecipients(graph, threads, loadUsers(usersFile), node, recipientRunId),
      notifyTargetOf(graph, node),
    );
  }
  return message;
}
