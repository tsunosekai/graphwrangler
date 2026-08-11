// プロジェクト層（ルーティーンでない普通のノード。docs/design.md 3.4/3.5）のタスク処理。
// 実行対象の選定は pick.ts（純粋関数）、ここはその結果を API へ書く配線と実行の後処理。
import { openRequest, patchNode, postMessage } from "./api.js";
import { ENGINE_ACTOR, VIA } from "./actor.js";
import { MAX_AUTO_RETRIES, buildAiQuestionRequest, parseAiQuestion, shouldAutoRetry } from "./ask.js";
import { extractGwMarkers } from "./context.js";
import { autoRetryCounts, launchExecutor } from "./executor.js";
import { truncate, withSubSteps } from "./format.js";
import { log } from "./log.js";
import {
  buildFailureRecoveryRequest,
  buildIrreversibleGateRequest,
  isRunManagedMember,
  selectAction,
  triggerPageIds,
} from "./pick.js";
import { lastMessagesFor } from "./threadContext.js";
import type { Actor, Node } from "./types.js";

/** 承認/失敗リカバリの回答判定に必要なので、frontier かつ pending な候補ノードだけ
 *  スレッドの最新メッセージを取得する（全ノード分は叩かない） */
function candidateIdsNeedingThread(nodes: Node[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const triggerPages = triggerPageIds(nodes);
  return nodes
    .filter(
      (n) =>
        n.lifecycle === "committed" &&
        n.kind === "task" &&
        (n.executor === "ai" || n.executor === "script") &&
        n.status === "pending" &&
        !n.pendingRequest &&
        // ルーティーンメンバー（テンプレート）は selectAction の対象外（実行はラン側の
        // ワークアイテムが担う。pick.ts の isSchedulableKind と同じ除外）なので取得しない
        !isRunManagedMember(n, triggerPages) &&
        n.parents.every((pid) => {
          const s = byId.get(pid)?.status;
          return s === "done" || s === "skipped"; // 3.9: skipped も充足扱い（合流ノード対応）
        }),
    )
    .map((n) => n.id);
}

/** 失敗リカバリの「内容を変える(modify)」回答を受けて、下書きに戻して人間の編集を待つ。
 *  回答直後に同じ内容で即再実行してしまわないための待避（編集後「プラン済みにする」で
 *  再び実行対象になる）。status メッセージを積むことでスレッド末尾の modify 回答を消費し、
 *  再コミット後に再度 demote されるループを防ぐ */
export async function demoteToDraft(node: Node): Promise<void> {
  await patchNode(node.id, { lifecycle: "draft" }, ENGINE_ACTOR, VIA);
  await postMessage(
    node.id,
    {
      kind: "status",
      body: "「内容を変える」の回答を受けて下書きに戻しました。編集して「プラン済みにする」と再実行されます",
    },
    ENGINE_ACTOR,
    VIA,
  );
  log(`modify回答により下書きへ戻した: id=${node.id} title=${node.title}`);
}

async function executeNode(nodes: Node[], node: Node): Promise<void> {
  await patchNode(node.id, { status: "running" }, ENGINE_ACTOR, VIA);
  log(`実行開始: id=${node.id} title=${node.title} executor=${node.executor}`);

  // プロジェクト層なので run なし（script は context を渡さずデフォルト値のみ。3.15）
  const { result, executorName, aiSources } = await launchExecutor(nodes, node, null);

  const actor: Actor = { kind: "agent", name: executorName };

  if (result.success) {
    // AIが QUESTION プロトコルで人間の判断を求めた（ask.ts）→ done にせず判断リクエストを
    // 開く。status は running のまま（失敗リカバリと同じ作法: 回答が来るとサーバが
    // pending に戻し、次周の実行がスレッド経緯として回答を読み込む）
    const question = node.executor === "ai" ? parseAiQuestion(result.output) : null;
    if (question) {
      autoRetryCounts.delete(node.id);
      await postMessage(
        node.id,
        {
          kind: "say",
          body: result.output.trim(),
          payload: { sources: aiSources, aiQuestion: question },
        },
        actor,
        VIA,
      );
      try {
        await openRequest(node.id, buildAiQuestionRequest(node, question), ENGINE_ACTOR, VIA);
        log(`AIが人間へ質問: id=${node.id} question=${truncate(question.question, 100)}`);
      } catch (err) {
        // 別のリクエストが既に開いている等。running のまま放置すると再選択されず詰むので
        // pending に戻す（次周の実行でAIがもう一度質問し直せる）
        log(`AI質問カードを開けなかった（pendingへ戻す）: id=${node.id} ${String(err)}`);
        await patchNode(node.id, { status: "pending" }, ENGINE_ACTOR, VIA);
      }
      return;
    }

    autoRetryCounts.delete(node.id);
    // ##gw マーカーはランでのみ有効（3.15「適用範囲はルーティーンのみ」）。プロジェクト層では
    // context に書かず、その旨を status に残して本文から取り除くだけ
    const extraction = extractGwMarkers(result.output);
    if (extraction.validCount > 0 || extraction.invalidLines.length > 0) {
      await postMessage(
        node.id,
        {
          kind: "status",
          body: "コンテキスト書き込み（##gw マーカー）はランでのみ有効です。プロジェクトの実行では無視しました",
        },
        actor,
        VIA,
      );
    }
    const summary = truncate(extraction.body || "(出力なし)", 500);
    await postMessage(
      node.id,
      { kind: "status", body: `実行成功: ${summary}`, payload: withSubSteps(undefined, result) },
      actor,
      VIA,
    );
    // AI発言の出典バッジ用データ（docs/design.md 3.8）。script executor には該当する文脈が無いので付けない
    const sayPayload = node.executor === "ai" ? { sources: aiSources } : undefined;
    await postMessage(
      node.id,
      { kind: "say", body: extraction.body.trim() || "(結果なし)", payload: sayPayload },
      actor,
      VIA,
    );
    await patchNode(node.id, { status: "done" }, ENGINE_ACTOR, VIA);
    log(`実行成功: id=${node.id}`);
    return;
  }

  const reason = result.error || "不明なエラー";

  // autonomy=high の AI ノードは失敗を人間に渡す前に自動で試し直す（ask.ts）。
  // 失敗の status を積んでから pending に戻すと、次周の実行がスレッド経緯として
  // 失敗理由を読み込み、やり方を変えて再試行する
  if (node.executor === "ai" && shouldAutoRetry(node.autonomy, autoRetryCounts.get(node.id) ?? 0)) {
    const count = (autoRetryCounts.get(node.id) ?? 0) + 1;
    autoRetryCounts.set(node.id, count);
    await postMessage(
      node.id,
      {
        kind: "status",
        body: truncate(`実行失敗（自律リトライ ${count}/${MAX_AUTO_RETRIES}）: ${reason}`, 500),
        payload: withSubSteps(undefined, result),
      },
      actor,
      VIA,
    );
    await patchNode(node.id, { status: "pending" }, ENGINE_ACTOR, VIA);
    log(`実行失敗→自律リトライ ${count}/${MAX_AUTO_RETRIES}: id=${node.id} reason=${reason}`);
    return;
  }

  autoRetryCounts.delete(node.id);
  await postMessage(
    node.id,
    { kind: "status", body: truncate(`実行失敗: ${reason}`, 500), payload: withSubSteps(undefined, result) },
    actor,
    VIA,
  );
  await openRequest(node.id, buildFailureRecoveryRequest(node, reason), ENGINE_ACTOR, VIA);
  log(`実行失敗: id=${node.id} reason=${reason}`);
}

/** プロジェクト層のタスクを1件処理する。処理した(=何かアクションを起こした)ら true を返す
 *  （tickDecision / tickRunItem と同じ約束。false のとき呼び出し側が次の層を見る） */
export async function tickProject(nodes: Node[]): Promise<boolean> {
  const ids = candidateIdsNeedingThread(nodes);
  const lastMessages = await lastMessagesFor(ids);
  const action = selectAction(nodes, lastMessages);

  switch (action.type) {
    case "drop":
      await patchNode(action.node.id, { status: "dropped" }, ENGINE_ACTOR, VIA);
      log(`人間の回答により中止(dropped): id=${action.node.id} title=${action.node.title}`);
      return true;
    case "demote":
      await demoteToDraft(action.node);
      return true;
    case "open-gate":
      await openRequest(action.node.id, buildIrreversibleGateRequest(action.node), ENGINE_ACTOR, VIA);
      log(`不可逆ノードの承認カードを開いた: id=${action.node.id} title=${action.node.title}`);
      return true;
    case "execute":
      await executeNode(nodes, action.node);
      return true;
    case "none":
      return false;
  }
}
