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
import {
  isConsecutiveHumanTurn,
  type Actor,
  type DecisionRequest,
  type GraphStore,
  type Message,
  type Run,
  type RunStore,
  type ThreadStore,
  type TurnNode,
  type TurnParent,
} from "@graphwrangler/core";
import { loadUsers } from "./auth.js";
import { notifyTurn } from "./discord.js";
import { notifyTargetOf } from "./notify_target.js";
import { resolveRecipients } from "./recipients.js";
import type { SettingsStore } from "./settings.js";
import type { UserSettingsStore } from "./user_settings.js";

/**
 * このノードの「あなたの番」が既に通知済みか（純粋関数。vitest ではなく node:test 対象）。
 * ランアイテムが waiting へ遷移した瞬間に発生源②（routes/runs.ts）がラン付きリンクで
 * 鳴らしている。エンジンの2段構え（waiting に倒す → 判断カードを開く。AI質問・承認ゲート・
 * ラン内分岐が全部この形）では②→①が数秒差で連続するため、①（判断カードを開く側）は
 * これが true なら鳴らさない（2026-08-12 本人報告「同じタイミングで通知が2個来る。1つでいい」
 * ——同一の用件が run リンク版とテンプレートリンク版の2通になっていた）
 */
export function isTurnAlreadyAnnounced(
  pageRuns: Array<{ status: string; items: Record<string, { status: string }> }>,
  nodeId: string,
): boolean {
  return pageRuns.some((r) => r.status === "running" && r.items[nodeId]?.status === "waiting");
}

/**
 * このノードの「あなたの番」を鳴らすか（純粋関数）。2つの発生源
 * （①判断リクエストを開く ②ランのワークアイテムが waiting へ遷移）で規則を1つにするため
 * ここへ畳んである。判定は2段:
 *   1. 同じ人の人間作業が連続している区間の2本目以降は黙る
 *      （設定 notify.quietConsecutiveHumanTurns=true のときだけ。2026-08-20）
 *   2. 担当者が居るならその人の受け取り設定（discordTurnNotify。2026-08-07 ユーザー別設定）
 * 黙らせるのは通知だけで、waiting への遷移も橙の「あなたの番」表示も変わらない。
 */
export function shouldNotifyTurn(
  node: TurnNode,
  parentOf: (id: string) => TurnParent | undefined,
  opts: {
    /** 連続する人間作業をまとめる設定（settings.notify.quietConsecutiveHumanTurns） */
    quietConsecutive: boolean;
    /** 担当者メール → その人が「あなたの番」通知を受け取る設定か */
    turnNotifyOf: (email: string) => boolean;
  },
): boolean {
  if (opts.quietConsecutive && isConsecutiveHumanTurn(node, parentOf)) return false;
  return !node.assignee || opts.turnNotifyOf(node.assignee);
}

/**
 * 親ノードを「通知判定に必要な形」で引く。テンプレートが消えていても、ランは作成時点の
 * スナップショットで動く（docs/design.md 5.5）ので run.snapshot から補う。
 * ran（その回に実際に行われたか）は、ラン文脈ならワークアイテムの status、
 * プロジェクト層ならテンプレートの status から見る——分岐で選ばれなかった枝（skipped）や
 * 中止（dropped）は「直前の作業」ではないため。
 */
export function turnParentOf(
  graph: GraphStore,
  run: Run | undefined,
  parentId: string,
): TurnParent | undefined {
  const tmpl = graph.has(parentId)
    ? graph.get(parentId)
    : run?.snapshot?.nodes.find((n) => n.id === parentId);
  if (!tmpl) return undefined;
  const status = run ? run.items[parentId]?.status : tmpl.status;
  return {
    kind: tmpl.kind,
    executor: tmpl.executor,
    assignee: tmpl.assignee,
    // status を引けない親（ランのアイテムに居ない＝この回は無関係）は「行われていない」扱い
    ran: status !== undefined && status !== "skipped" && status !== "dropped",
  };
}

export interface OpenRequestDeps {
  graph: GraphStore;
  threads: ThreadStore;
  runs: RunStore;
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
  /** カードが属するランの会話（2026-08-12 からカードの runId としても焼き込む——ランのページで
   *  カードを見え・答えられるようにするため）。宛先解決の「直近の会話の当事者」を探す範囲
   *  （recipients.ts の段4）と通知リンクの向き先にも使う。pendingRequest はノード単位の状態の
   *  まま（ランごとに分かれない）で、エンジンのゲート照合は従来どおり question 内の
   *  `[ラン <id>]` マーカーが担う */
  recipientRunId: string | null = null,
): Message {
  const { graph, threads, runs, settings, userSettings, usersFile } = deps;
  const node = graph.get(nodeId);
  // カードはラン文脈なら runId 付きで積む——ランのページ（#/r/…）はそのランのメッセージだけを
  // 見せるため、これが無いと通知リンクから開いてもカードが出ず回答できない（2026-08-12 修正。
  // 回答（decision_answer）は core 側で質問と同じ runId を継承する）
  const message = threads.openRequest(nodeId, request, {
    author: meta.author,
    via: meta.via,
    runId: recipientRunId,
  });
  graph.patchNode(nodeId, { pendingRequest: message.id }, { actor: { kind: "system" }, via: meta.via });

  const announced = isTurnAlreadyAnnounced(node.group ? runs.list(node.group) : [], node.id);

  // ラン文脈の質問（Task AI がランの会話で QUESTION したとき等）はリンクをランのページへ
  // 向ける——回答導線はランの進捗側にある（発生源②と同じ理由。2026-08-12）。
  // 実在しない runId は黙ってテンプレートリンクに落とす（通知は補助機能）。
  // 親の「実際に行われたか」もラン文脈ならランのワークアイテムから見る（下の parentOf）
  let run: Run | undefined;
  if (recipientRunId) {
    try {
      run = runs.get(recipientRunId);
    } catch {}
  }

  // 鳴らすかの判定は shouldNotifyTurn に一本化（連続する人間作業 × 担当者の個人設定）。
  // 宛先は assignee 1本ではなく関係者まで広げて解決する（2026-08-11。recipients.ts）
  if (
    !announced &&
    shouldNotifyTurn(node, (id) => turnParentOf(graph, run, id), {
      quietConsecutive: settings.get().notify.quietConsecutiveHumanTurns,
      turnNotifyOf: (email) => userSettings.get(email).discordTurnNotify,
    })
  ) {
    notifyTurn(
      settings.get().notify,
      resolveRecipients(graph, threads, loadUsers(usersFile), node, recipientRunId),
      notifyTargetOf(graph, node, run),
    );
  }
  return message;
}
