// ルーティーンページのラン（実行インスタンス）のワークアイテム処理。
// 実行対象の選定は pickRun.ts / approval.ts（純粋関数）、ここはその結果を API へ書く配線。
// 分岐アイテム(kind=decision)は tickRunDecision.ts が担当する。
import { getThread, openRequest, patchRunContext, patchRunItem, postMessage, listPageRuns } from "./api.js";
import { ENGINE_ACTOR, VIA } from "./actor.js";
import {
  APPROVAL_WAITING_NOTE,
  HUMAN_TURN_WAITING_NOTE,
  buildRunApprovalRequest,
  collectPendingApprovalItems,
  findRunGate,
  gateKey,
  selectRunApprovalAction,
  type RunGateState,
} from "./approval.js";
import {
  AI_QUESTION_WAITING_NOTE,
  MAX_AUTO_RETRIES,
  buildAiQuestionRequest,
  parseAiQuestion,
  shouldAutoRetry,
  type AiQuestion,
} from "./ask.js";
import { extractGwMarkers } from "./context.js";
import { autoRetryCounts, launchExecutor } from "./executor.js";
import { truncate, withSubSteps } from "./format.js";
import { log } from "./log.js";
import { selectRunAction } from "./pickRun.js";
import { tickRunDecision } from "./tickRunDecision.js";
import type { Actor, Message, Node, Run } from "./types.js";

/** ランのワークアイテムを実行する。プロンプト文脈はページノードの title/detail +
 *  テンプレートの title/detail/impl（claude.ts の buildAiPrompt を "goal=ページノード" として再利用）。
 *  実行ログ・成果はテンプレートノードのスレッドへ、そのランの記録として投稿する */
export async function executeRunItem(nodes: Node[], run: Run, node: Node): Promise<void> {
  await patchRunItem(run.id, node.id, { status: "running" }, ENGINE_ACTOR, VIA);
  log(`ラン実行開始: run=${run.id} node=${node.id} title=${node.title} executor=${node.executor}`);

  // ラン層: script は run.context で解決+resolvedParams 焼き込み、ai は runContext 注入（3.15）
  const { result, executorName, aiSources } = await launchExecutor(nodes, node, run);

  const actor: Actor = { kind: "agent", name: executorName };
  // 帰属ランは Message.runId（postMessage の runId）が正。payload.runId はそれとは別に、
  // server の GET /api/runs/:id/trace が payload.runId でしか記録を拾えないため併記する
  const payload = { runId: run.id };
  const retryKey = gateKey(run.id, node.id);

  if (result.success) {
    // AIが QUESTION プロトコルで人間の判断を求めた（ask.ts）→ done にせず waiting に倒し、
    // 判断リクエストを開く。回答の往復は tickRunAiQuestions が担当する（承認連携と同じ2段構え。
    // カードを開けなくても waiting+note が残るので次周の gate=none 経路が開き直す）
    const question = node.executor === "ai" ? parseAiQuestion(result.output) : null;
    if (question) {
      autoRetryCounts.delete(retryKey);
      await postMessage(
        node.id,
        {
          kind: "say",
          body: result.output.trim(),
          payload: { ...payload, sources: aiSources, aiQuestion: question },
          runId: run.id,
        },
        actor,
        VIA,
      );
      await patchRunItem(
        run.id,
        node.id,
        { status: "waiting", note: AI_QUESTION_WAITING_NOTE },
        ENGINE_ACTOR,
        VIA,
      );
      try {
        await openRequest(node.id, buildAiQuestionRequest(node, question, run.id), ENGINE_ACTOR, VIA, run.id);
        log(`AIが人間へ質問(ラン): run=${run.id} node=${node.id} question=${truncate(question.question, 100)}`);
      } catch (err) {
        log(`AI質問カードを開けなかった（次周に持ち越し）: run=${run.id} node=${node.id} ${String(err)}`);
      }
      return;
    }

    autoRetryCounts.delete(retryKey);
    // ##gw マーカー（ランのコンテキストへの書き。3.15）を本文から取り出す。script の stdout /
    // AI の出力の両方が対象。マーカー行は say 本文から取り除く（監査はサーバが status
    // 「コンテキスト更新: …」を積むことで残る）
    const extraction = extractGwMarkers(result.output);
    if (Object.keys(extraction.set).length > 0) {
      try {
        await patchRunContext(run.id, extraction.set, node.id, VIA);
      } catch (err) {
        // 書き込み失敗は実行の成否に響かせない。値はマーカー行ごと本文から消えるので、
        // 失っては困る中身を status に残す
        await postMessage(
          node.id,
          {
            kind: "status",
            body: truncate(
              `コンテキスト書き込みに失敗（set=${JSON.stringify(extraction.set)}）: ${String(err)}`,
              500,
            ),
            payload,
            runId: run.id,
          },
          actor,
          VIA,
        );
        log(`コンテキスト書き込みに失敗: run=${run.id} node=${node.id} ${String(err)}`);
      }
    }
    if (extraction.invalidLines.length > 0) {
      // '{' で始まるのに JSON として読めない ##gw 行は失敗として記録する（実行自体は成功扱いのまま）
      await postMessage(
        node.id,
        {
          kind: "status",
          body: truncate(
            `##gw マーカーを解釈できません（実行は成功扱い）: ${extraction.invalidLines.join(" / ")}`,
            500,
          ),
          payload,
          runId: run.id,
        },
        actor,
        VIA,
      );
    }
    const summary = truncate(extraction.body || "(出力なし)", 500);
    await postMessage(
      node.id,
      {
        kind: "status",
        body: `実行成功: ${summary}`,
        payload: withSubSteps(payload, result),
        runId: run.id,
      },
      actor,
      VIA,
    );
    // AI発言の出典バッジ用データ（docs/design.md 3.8）。script executor には該当する文脈が無いので付けない
    const sayPayload = node.executor === "ai" ? { ...payload, sources: aiSources } : payload;
    await postMessage(
      node.id,
      {
        kind: "say",
        body: extraction.body.trim() || "(結果なし)",
        payload: sayPayload,
        runId: run.id,
      },
      actor,
      VIA,
    );
    // note: null で「AI質問待ち」「失敗→自律リトライ」等の古いノートを掃除する
    await patchRunItem(run.id, node.id, { status: "done", note: null }, ENGINE_ACTOR, VIA);
    log(`ラン実行成功: run=${run.id} node=${node.id}`);
    return;
  }

  const reason = result.error || "不明なエラー";

  // autonomy=high の AI アイテムは失敗を人間に渡す前に自動で試し直す（プロジェクト側と同じ）
  if (node.executor === "ai" && shouldAutoRetry(node.autonomy, autoRetryCounts.get(retryKey) ?? 0)) {
    const count = (autoRetryCounts.get(retryKey) ?? 0) + 1;
    autoRetryCounts.set(retryKey, count);
    await postMessage(
      node.id,
      {
        kind: "status",
        body: truncate(`実行失敗（自律リトライ ${count}/${MAX_AUTO_RETRIES}）: ${reason}`, 500),
        payload: withSubSteps(payload, result),
        runId: run.id,
      },
      actor,
      VIA,
    );
    await patchRunItem(
      run.id,
      node.id,
      { status: "pending", note: `失敗→自律リトライ ${count}/${MAX_AUTO_RETRIES}` },
      ENGINE_ACTOR,
      VIA,
    );
    log(`ラン実行失敗→自律リトライ ${count}/${MAX_AUTO_RETRIES}: run=${run.id} node=${node.id} reason=${reason}`);
    return;
  }

  autoRetryCounts.delete(retryKey);
  await postMessage(
    node.id,
    {
      kind: "status",
      body: truncate(`実行失敗: ${reason}`, 500),
      payload: withSubSteps(payload, result),
      runId: run.id,
    },
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

/** ランを持ちうる「ページ」の id 一覧: kind=goal のノード、または他ノードから group として
 *  参照されているノード。packages/mcp/src/index.ts の state_get の pages 算出と同じ考え方 */
function pageIds(nodes: Node[]): string[] {
  const ids = new Set<string>();
  for (const n of nodes) {
    if (n.kind === "goal") ids.add(n.id);
    if (n.group) ids.add(n.group);
  }
  return [...ids];
}

/** status=running の全ランをページごとに束ねて取得する
 *  （ページを横断する一覧APIが無いため、ページ単位で叩いて集める） */
async function fetchRunningRuns(nodes: Node[]): Promise<Run[]> {
  const pages = pageIds(nodes);
  const runsByPage = await Promise.all(
    pages.map(async (id) => {
      try {
        return await listPageRuns(id);
      } catch (err) {
        log(`ラン一覧取得に失敗（この周は除外）: page=${id} ${String(err)}`);
        return [] as Run[];
      }
    }),
  );
  return runsByPage.flat().filter((r) => r.status === "running");
}

// ---- ルーティーンページ: 不可逆ランアイテムの承認連携（approval.ts） ----

/** 承認待ち（waiting/note=APPROVAL_WAITING_NOTE）のランアイテムについて、テンプレートノードの
 *  スレッドから承認ゲートの状態を集める（対象があるものだけスレッドを取得する） */
async function fetchGateStates(
  pending: Array<{ run: Run; node: Node }>,
): Promise<Record<string, RunGateState>> {
  const gateStates: Record<string, RunGateState> = {};
  for (const { run, node } of pending) {
    try {
      // ゲート照合はラン横断（"all"）: runId 付きで積まれた承認カード・回答を見失わない
      const { messages } = await getThread(node.id, "all");
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
          action.run.id,
        );
      } catch (err) {
        // node に既に別のリクエストが開いている等。処理済み扱いにすると失敗が続く限り
        // 以降のラン処理を全て塞いでしまうため、この周は未処理として譲り、次周に再試行する
        log(
          `承認カードを開けなかった（次周に持ち越し）: run=${action.run.id} node=${action.node.id} ${String(err)}`,
        );
        return false;
      }
      log(
        `不可逆のため承認カードを開いた: run=${action.run.id} node=${action.node.id} title=${action.node.title}`,
      );
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

// ---- ルーティーンページ: AI質問（QUESTION プロトコル。ask.ts）の回答連携 ----

/** 「AI質問待ち」（waiting かつ note=AI_QUESTION_WAITING_NOTE）のランアイテムを、
 *  ラン created 昇順→テンプレート created 昇順で集める（承認連携と同じ並び） */
function collectPendingAiQuestions(nodes: Node[], runs: Run[]): Array<{ run: Run; node: Node }> {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const out: Array<{ run: Run; node: Node }> = [];
  const runningRuns = [...runs]
    .filter((r) => r.status === "running")
    .sort((a, b) => a.created.localeCompare(b.created));
  for (const run of runningRuns) {
    const entries = Object.entries(run.items)
      .map(([nodeId, item]) => ({ item, node: nodesById.get(nodeId) }))
      .filter((e): e is { item: (typeof run.items)[string]; node: Node } => e.node !== undefined)
      .sort((a, b) => a.node.created.localeCompare(b.node.created));
    for (const { item, node } of entries) {
      if (item.status !== "waiting" || item.note !== AI_QUESTION_WAITING_NOTE) continue;
      if (node.executor !== "ai") continue;
      out.push({ run, node });
    }
  }
  return out;
}

/** AI質問待ちのランアイテムを1件処理する。処理した(=何かアクションを起こした)ら true。
 *  ゲート判定は承認連携と同じ findRunGate（質問カードの question にランのマーカー入り）:
 *  - 未発行（executeRunItem 時に開けなかった）→ スレッドの say payload から質問を復元して開き直す
 *  - 発行済み・未回答 → 次の候補へ
 *  - 回答済み: abort → 中止(dropped) / それ以外（ai:* や自由文）→ 回答をスレッド経緯として
 *    読み込ませて再実行 */
async function tickRunAiQuestions(nodes: Node[], runs: Run[]): Promise<boolean> {
  const pending = collectPendingAiQuestions(nodes, runs);
  for (const { run, node } of pending) {
    let messages: Message[];
    try {
      // ゲート照合はラン横断（"all"）: runId 付きの質問カード・回答を見失わない
      ({ messages } = await getThread(node.id, "all"));
    } catch (err) {
      log(`AI質問のスレッド取得に失敗（この周は保留）: run=${run.id} node=${node.id} ${String(err)}`);
      continue;
    }
    const gate = findRunGate(messages, run.id);

    if (gate.status === "open") continue; // 回答待ち。次の候補へ

    if (gate.status === "none") {
      // カード未発行。say payload に保存した質問（executeRunItem が積む）から開き直す
      const say = [...messages]
        .reverse()
        .find(
          (m) =>
            m.kind === "say" &&
            m.runId === run.id &&
            (m.payload as { aiQuestion?: AiQuestion } | null)?.aiQuestion,
        );
      const question = (say?.payload as { aiQuestion?: AiQuestion } | null)?.aiQuestion;
      if (!question) {
        await patchRunItem(
          run.id,
          node.id,
          { status: "waiting", note: "失敗: AIの質問内容を復元できない" },
          ENGINE_ACTOR,
          VIA,
        );
        log(`AI質問の復元に失敗: run=${run.id} node=${node.id}`);
        return true;
      }
      try {
        await openRequest(node.id, buildAiQuestionRequest(node, question, run.id), ENGINE_ACTOR, VIA, run.id);
      } catch (err) {
        // 開けなかった（別リクエストが開いている等）。処理済み扱いにせず次の候補へ進む
        log(`AI質問カードを開けなかった（次候補へ）: run=${run.id} node=${node.id} ${String(err)}`);
        continue;
      }
      log(`AI質問カードを開き直した: run=${run.id} node=${node.id}`);
      return true;
    }

    // answered
    if (gate.option === "abort") {
      await patchRunItem(
        run.id,
        node.id,
        { status: "dropped", note: "質問への回答で中止" },
        ENGINE_ACTOR,
        VIA,
      );
      log(`AI質問の回答で中止(dropped): run=${run.id} node=${node.id} title=${node.title}`);
      return true;
    }
    await executeRunItem(nodes, run, node);
    return true;
  }
  return false;
}

/** プロジェクト側に実行候補が無かったとき、ランのワークアイテムを1件処理する。
 *  承認待ちアイテムの回答チェックをランの通常実行候補選択より先に行う。通常タスクの実行候補が
 *  無ければ分岐アイテム(kind=decision)を見る */
export async function tickRunItem(nodes: Node[]): Promise<void> {
  const runningRuns = await fetchRunningRuns(nodes);
  if (runningRuns.length === 0) return;

  if (await tickRunApprovals(nodes, runningRuns)) return;
  if (await tickRunAiQuestions(nodes, runningRuns)) return;

  const action = selectRunAction(nodes, runningRuns);
  switch (action.type) {
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
    case "human-turn":
      // 担当=人間のステップに順番が回ってきた。waiting へ上げるとサーバが
      // 「あなたの番」の Discord 通知を出し、UI にも橙ドットが出る（2026-08-08 追加。
      // 着手/完了は人間が押すので、ここでは状態を上げるだけ）
      await patchRunItem(
        action.run.id,
        action.node.id,
        { status: "waiting", note: HUMAN_TURN_WAITING_NOTE },
        ENGINE_ACTOR,
        VIA,
      );
      log(`あなたの番へ: run=${action.run.id} node=${action.node.id} title=${action.node.title}`);
      return;
    case "execute":
      await executeRunItem(nodes, action.run, action.node);
      return;
    case "none":
      break; // 通常タスクの候補が無ければ分岐アイテムを見る
  }

  await tickRunDecision(nodes, runningRuns);
}
