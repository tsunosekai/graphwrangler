// トリガーノード（kind=trigger）: script/ai によるラン作成・自動生成。
// docs/design.md 3.4/3.8/3.9。
// 「ルーティーンであること」はページ種別ではなく、フロー先頭のトリガーノードから導出する。
// 判定は trigger.ts / schedule.ts（純粋関数）、ここはその結果を API へ書く配線。
import { getThread, listPageRuns, openRequest, postMessage, runTriggerNode } from "./api.js";
import { ENGINE_ACTOR, VIA } from "./actor.js";
import { extractGwMarkers } from "./context.js";
import { aiExecutorName, runAiExecutor } from "./executor.js";
import { truncate, withSubSteps } from "./format.js";
import { log } from "./log.js";
import { substituteParams } from "./params.js";
import { workspaceRoot } from "./settings.js";
import {
  // approval.ts（ランアイテムの実行前承認）と同名だが別物なので、ラン開始承認系として別名で受ける
  buildRunApprovalRequest as buildRunStartApprovalRequest,
  buildScheduleWarningBody,
  buildTriggerPrompt,
  describeRunEvent,
  findRunGate as findRunStartGate,
  findLatestRunEvent,
  runBaseline,
  hasScheduleWarning,
  hasUnconsumedGo,
  isDetectScriptTrigger,
  isClosedPage,
  isRunnableTrigger,
  latestScheduleSetAt,
  mergeScheduleSetBaseline,
  parseAiRunDecision,
  parseDetectEmitLines,
  resolveAiCheckIntervalMs,
  runsOfTrigger,
  shouldEvaluateAiTrigger,
  shouldRunScriptTrigger,
  shouldRunDetectScript,
  type DetectEmitEvent,
  type RunGateState as RunStartGateState,
} from "./trigger.js";
import { runScript } from "./executors/script.js";
import type { Actor, Message, Node, Run } from "./types.js";

/** ai トリガーの直近チェック時刻（エンジンのメモリ管理。プロセス再起動で即再チェックされるのは
 *  許容する。docs/design.md「チェック時刻はエンジンのメモリ管理」） */
const aiTriggerLastCheckedAt = new Map<string, number>();

/** 検知スクリプト（impl.command のある script トリガー）の直近チェック時刻。
 *  aiTriggerLastCheckedAt と同じ in-memory 方式（3.15） */
const detectTriggerLastCheckedAt = new Map<string, number>();

/** 検知スクリプトのラン作成 via（"schedule:<schedule原文>"。3.8 の emit プロトコル） */
function detectVia(trigger: Node): string {
  return `schedule:${trigger.schedule ?? ""}`;
}

/**
 * 検知スクリプトトリガーを1件処理する（docs/design.md 3.8/3.15）。schedule をチェック間隔とし、
 * 間隔ごとに impl.command を実行して stdout の '{' 始まりの各行を emit イベントとしてランを作る
 * （1行=1ラン。空 emit = 今回はラン作成なし。同じ対象で二重にランを作らない責務は検知スクリプト側）。
 * approval=true なら emit イベントを1件ずつラン前承認カードに載せる:
 * イベント本体は payload.runEvent 付き status としてスレッドへ積み、go 回答時に
 * findLatestRunEvent で復元してその値でランを作る。**複数イベントは1tickに1件だけ**カードに
 * 載せる——検知スクリプトは「まだランになっていない対象」を次回も再 emit する前提なので、
 * 残りは次回の検知で改めて拾われる（カードの多重発行で人間を溺れさせない）。
 */
async function tickDetectScriptTrigger(trigger: Node, runsForTrigger: Run[]): Promise<void> {
  const latestRun = runsForTrigger[0] ?? null; // list は created 降順
  if (trigger.pendingRequest) return; // ラン前承認カード等の回答待ち
  const actor: Actor = { kind: "agent", name: "executor:script" };

  if (trigger.approval) {
    let messages: Message[];
    try {
      ({ messages } = await getThread(trigger.id));
    } catch (err) {
      log(`ラン前承認のスレッド取得に失敗（この周は保留）: trigger=${trigger.id} ${String(err)}`);
      return;
    }
    const gate = findRunStartGate(messages);
    if (hasUnconsumedGo(gate, latestRun)) {
      // go 回答を消費して、カードに対応する検知イベントの値でランを作る
      const event = findLatestRunEvent(messages, latestRun);
      try {
        await runTriggerNode(
          trigger.id,
          {
            via: detectVia(trigger),
            ...(event?.title ? { title: event.title } : {}),
            ...(event ? { context: event.context } : {}),
          },
          ENGINE_ACTOR,
        );
        log(`承認により検知イベントのラン作成: trigger=${trigger.id} title=${trigger.title}`);
      } catch (err) {
        log(`ラン作成に失敗（次周に持ち越し）: trigger=${trigger.id} ${String(err)}`);
      }
      return;
    }
    // skip/未発行は下のチェック間隔フローへ（再確認の抑制はチェック間隔のメモリ管理が担う）
  }

  const now = Date.now();
  if (
    !shouldRunDetectScript(
      trigger.schedule,
      detectTriggerLastCheckedAt.get(trigger.id) ?? null,
      new Date(now),
    )
  ) {
    return;
  }
  detectTriggerLastCheckedAt.set(trigger.id, now);

  if (!trigger.impl || trigger.impl.type !== "script") return; // isDetectScriptTrigger 済み（型のため）
  const sub = substituteParams(trigger.impl.command, trigger.impl.params);
  if (!sub.ok) {
    await postMessage(
      trigger.id,
      { kind: "status", body: `検知スクリプトを実行できません: ${sub.reason}` },
      actor,
      VIA,
    );
    log(`検知スクリプトのパラメータ解決失敗: trigger=${trigger.id} reason=${sub.reason}`);
    return;
  }
  const result = await runScript(sub.command, { cwd: workspaceRoot ?? undefined });
  if (!result.success) {
    // 非0終了はトリガーのスレッドへ失敗として記録する（3.8）
    await postMessage(
      trigger.id,
      {
        kind: "status",
        body: truncate(`検知スクリプトが失敗: ${result.error ?? "不明なエラー"}`, 500),
      },
      actor,
      VIA,
    );
    log(`検知スクリプト失敗: trigger=${trigger.id} reason=${result.error}`);
    return;
  }

  const parsed = parseDetectEmitLines(result.output);
  if (parsed.invalidLines.length > 0) {
    await postMessage(
      trigger.id,
      {
        kind: "status",
        body: truncate(
          `検知スクリプトの emit 行を解釈できません: ${parsed.invalidLines.join(" / ")}`,
          500,
        ),
      },
      actor,
      VIA,
    );
  }
  if (parsed.events.length === 0) return; // 空 emit = 今回はラン作成なし

  if (trigger.approval) {
    // 1tickに1件だけ承認カードへ（残りは次回の検知で再 emit される前提。関数コメント参照）
    const event = parsed.events[0];
    try {
      await postMessage(
        trigger.id,
        {
          kind: "status",
          body: `検知イベント: ${describeRunEvent(event)}`,
          payload: { runEvent: event },
        },
        ENGINE_ACTOR,
        VIA,
      );
      await openRequest(trigger.id, buildRunStartApprovalRequest(trigger, event), ENGINE_ACTOR, VIA);
      log(`検知イベント→ラン前承認カードを開いた: trigger=${trigger.id} event=${describeRunEvent(event)}`);
    } catch (err) {
      log(`ラン前承認カードを開けなかった（次回の検知で再emit想定）: trigger=${trigger.id} ${String(err)}`);
    }
    return;
  }

  for (const event of parsed.events) {
    try {
      await runTriggerNode(
        trigger.id,
        {
          via: detectVia(trigger),
          ...(event.title ? { title: event.title } : {}),
          context: event.context,
        },
        ENGINE_ACTOR,
      );
      log(`検知イベントによりラン作成: trigger=${trigger.id} event=${describeRunEvent(event)}`);
    } catch (err) {
      log(`ラン作成に失敗（次回の検知で再emit想定）: trigger=${trigger.id} ${String(err)}`);
    }
  }
}

/** schedule を解釈できず「このトリガーは永久にランを作らない」ことを、エンジンログだけでなく
 *  人の目に入る形にする（2026-08-11。trigger.ts の SCHEDULE_WARNING_MARKER）。
 *  トリガーのスレッドへ status を1回だけ積む——同じ警告が既に積まれていれば黙る
 *  （毎tick積むとスレッドが警告で埋まる）。記録に失敗しても実行は続ける */
async function noteUnresolvedSchedule(trigger: Node): Promise<void> {
  const body = buildScheduleWarningBody(trigger.schedule);
  try {
    const { messages } = await getThread(trigger.id);
    if (hasScheduleWarning(messages, body)) return;
    await postMessage(trigger.id, { kind: "status", body }, ENGINE_ACTOR, VIA);
    log(`scheduleを解釈できないことをトリガーのスレッドへ記録: trigger=${trigger.id} title=${trigger.title}`);
  } catch (err) {
    log(`schedule警告の記録に失敗（次周に持ち越し）: trigger=${trigger.id} ${String(err)}`);
  }
}

/** script トリガーを1件処理する（判定は schedule.ts）。impl.command があれば検知スクリプト
 *  （tickDetectScriptTrigger。3.15）、無ければ従来どおりの無条件 cron ラン作成。
 *  approval=true（ラン前承認）ならラン作成の代わりにラン前承認カードを開き、
 *  go 回答の1回だけランを作る（trigger.ts 参照） */
async function tickScriptTrigger(trigger: Node, runsForTrigger: Run[]): Promise<void> {
  if (isDetectScriptTrigger(trigger)) {
    await tickDetectScriptTrigger(trigger, runsForTrigger);
    return;
  }
  const latestRun = runsForTrigger[0] ?? null; // list は created 降順
  if (trigger.pendingRequest) return; // ラン前承認カード等の回答待ち

  let gate: RunStartGateState = { status: "none" };
  let threadMessages: Message[] | null = null; // 取得済みなら使い回す（下の抑止判定と共用）
  if (trigger.approval) {
    try {
      ({ messages: threadMessages } = await getThread(trigger.id));
      gate = findRunStartGate(threadMessages);
    } catch (err) {
      log(`ラン前承認のスレッド取得に失敗（この周は保留）: trigger=${trigger.id} ${String(err)}`);
      return;
    }
  }

  // skip 回答はその回のラン作成とみなす（runBaseline）。承認なしのトリガーでは gate=none で従来どおり
  const baseline = runBaseline(latestRun, gate);
  const should = shouldRunScriptTrigger(trigger.schedule, baseline, new Date());
  if (should === null) {
    if (trigger.schedule) {
      log(`未対応のschedule書式のため無視: trigger=${trigger.id} schedule="${trigger.schedule}"`);
    } else {
      log(`scheduleが無いためscriptトリガーはラン作成しません: trigger=${trigger.id} title=${trigger.title}`);
    }
    await noteUnresolvedSchedule(trigger);
    return;
  }
  if (!should) return;

  // 起動方式の設定・変更直後の追い付き実行の抑止（2026-08-12 本人報告）: 設定・変更の時刻を
  // 「その回は済んだ」扱いで基準に混ぜ、次の定刻から動かす。判定は基準が新しいほど false に
  // 倒れる（単調）ので、上の粗い判定が true のときだけスレッドを見る＝定常では追加取得なし
  if (!threadMessages) {
    try {
      ({ messages: threadMessages } = await getThread(trigger.id));
    } catch (err) {
      log(`スレッド取得に失敗（この周は保留）: trigger=${trigger.id} ${String(err)}`);
      return;
    }
  }
  const merged = mergeScheduleSetBaseline(baseline, latestScheduleSetAt(threadMessages));
  if (merged !== baseline && shouldRunScriptTrigger(trigger.schedule, merged, new Date()) !== true) {
    return; // 設定・変更した回ぶんは済んだ扱い。次の定刻を待つ
  }

  if (trigger.approval && !hasUnconsumedGo(gate, latestRun)) {
    try {
      await openRequest(trigger.id, buildRunStartApprovalRequest(trigger), ENGINE_ACTOR, VIA);
      log(`ラン前承認カードを開いた: trigger=${trigger.id} title=${trigger.title}`);
    } catch (err) {
      log(`ラン前承認カードを開けなかった（次周に持ち越し）: trigger=${trigger.id} ${String(err)}`);
    }
    return;
  }

  try {
    await runTriggerNode(trigger.id, { via: `schedule:${trigger.schedule}` }, ENGINE_ACTOR);
    log(`スケジュールによりラン作成: trigger=${trigger.id} schedule="${trigger.schedule}"`);
  } catch (err) {
    log(`ラン作成に失敗（次周に持ち越し）: trigger=${trigger.id} ${String(err)}`);
  }
}

/** ai トリガーを1件処理する。schedule をチェック間隔として使い、間隔経過かつ実行中ランなしの
 *  ときだけ AI に「今ランを作るべきか」を判定させる。run ならスレッドへ理由を残してランを作り、
 *  skip はエンジンログのみ（スレッドは汚さない。docs/design.md「skipはエンジンログのみ」）。
 *  approval=true（ラン前承認）なら AI の run 判定後にラン前承認カードを開き、go 回答の1回だけランを作る */
async function tickAiTrigger(trigger: Node, runsForTrigger: Run[]): Promise<void> {
  if (trigger.pendingRequest) return; // ラン前承認カード等の回答待ち

  if (trigger.approval) {
    let gate: RunStartGateState;
    let messages: Message[];
    try {
      ({ messages } = await getThread(trigger.id));
      gate = findRunStartGate(messages);
    } catch (err) {
      log(`ラン前承認のスレッド取得に失敗（この周は保留）: trigger=${trigger.id} ${String(err)}`);
      return;
    }
    if (hasUnconsumedGo(gate, runsForTrigger[0] ?? null)) {
      // 承認済みの go はその場で消費する（2026-08-08: 以前は実行中ランがあると待たせていたが、
      // 人間が「開始して」と答えたのに動かないのは事故に見える）。
      // ラン作成判定の ##gw マーカー由来の context（payload.runEvent）があれば載せる
      const event = findLatestRunEvent(messages, runsForTrigger[0] ?? null);
      try {
        await runTriggerNode(
          trigger.id,
          { via: "ai", ...(event ? { context: event.context } : {}) },
          ENGINE_ACTOR,
        );
        log(`承認によりAIトリガーラン作成: trigger=${trigger.id} title=${trigger.title}`);
      } catch (err) {
        log(`AIラン作成に失敗（次周に持ち越し）: trigger=${trigger.id} ${String(err)}`);
      }
      return;
    }
    // skip/未発行は下の通常評価フローへ（再評価の抑制はチェック間隔のメモリ管理が担う）
  }

  const intervalMs = resolveAiCheckIntervalMs(trigger.schedule);
  const lastCheckedAt = aiTriggerLastCheckedAt.get(trigger.id) ?? null;
  const now = Date.now();
  if (!shouldEvaluateAiTrigger(intervalMs, lastCheckedAt, now)) return;
  aiTriggerLastCheckedAt.set(trigger.id, now);

  const prompt = buildTriggerPrompt(trigger, new Date(now));
  const actor: Actor = { kind: "agent", name: aiExecutorName() };
  const result = await runAiExecutor(prompt, trigger);

  if (!result.success) {
    log(`AIトリガー判定に失敗（次周に持ち越し）: trigger=${trigger.id} title=${trigger.title} reason=${result.error}`);
    return;
  }

  // ラン作成判定の出力に ##gw マーカーがあれば context としてラン作成に渡す（3.15。
  // 「run 行 + マーカー行」の形。判定の解釈はマーカーを除いた本文に対して行う）
  const extraction = extractGwMarkers(result.output);
  const decision = parseAiRunDecision(extraction.body);
  if (extraction.invalidLines.length > 0) {
    log(
      `AI判定の ##gw マーカーを解釈できません（無視して続行）: trigger=${trigger.id} lines=${extraction.invalidLines.join(" / ")}`,
    );
  }
  const event: DetectEmitEvent | null =
    Object.keys(extraction.set).length > 0 ? { context: extraction.set, title: null } : null;
  if (decision === "run") {
    try {
      // ラン作成の判定でAIがツールを使った場合（ログ確認など）、その内訳もラン作成理由の記録として残す
      await postMessage(
        trigger.id,
        { kind: "say", body: extraction.body.trim() || "(理由なし)", payload: withSubSteps(undefined, result) },
        actor,
        VIA,
      );
      if (trigger.approval) {
        if (event) {
          // go 回答時に findLatestRunEvent で復元できるよう、context 本体を payload として積む
          await postMessage(
            trigger.id,
            {
              kind: "status",
              body: `検知イベント: ${describeRunEvent(event)}`,
              payload: { runEvent: event },
            },
            ENGINE_ACTOR,
            VIA,
          );
        }
        await openRequest(trigger.id, buildRunStartApprovalRequest(trigger, event), ENGINE_ACTOR, VIA);
        log(`AI判定run→ラン前承認カードを開いた: trigger=${trigger.id} title=${trigger.title}`);
      } else {
        await runTriggerNode(
          trigger.id,
          { via: "ai", ...(event ? { context: event.context } : {}) },
          actor,
        );
        log(`AI判定によりラン作成: trigger=${trigger.id} title=${trigger.title}`);
      }
    } catch (err) {
      log(`AIラン作成に失敗（次周に持ち越し）: trigger=${trigger.id} ${String(err)}`);
    }
    return;
  }
  if (decision === "skip") {
    log(`AI判定で見送り(skip): trigger=${trigger.id} title=${trigger.title}`);
    return;
  }
  log(
    `AI判定の出力がrun/skipと一致しません: trigger=${trigger.id} 出力="${truncate(result.output, 200)}"`,
  );
}

/** kind=trigger(lifecycle=committed) のノードを毎tickチェックする。executor軸で分岐:
 *  script=cron的、ai=間隔チェック、human=エンジンは何もしない（手動 /run のみ） */
export async function triggerTick(nodes: Node[]): Promise<void> {
  // 所属ページが完了/中止（＝アーカイブ節）のトリガーは対象から外す。人が終いにした
  // ルーティーンが裏で回り続けないように（2026-08-09。trigger.ts の isClosedPage）
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const triggers = nodes.filter(
    (n) => isRunnableTrigger(n) && !isClosedPage(n.group ? byId.get(n.group) : null),
  );
  if (triggers.length === 0) return;

  // ページ横断の一覧APIは無いため、対象トリガーの所属ページ(group)ごとに束ねて取得する
  // （同じページを指す複数トリガーがあっても1回だけ取得する）
  const runsByPage = new Map<string, Run[]>();
  for (const trigger of triggers) {
    if (!trigger.group) {
      log(`groupが無いためトリガーは無視: id=${trigger.id} title=${trigger.title}`);
      continue;
    }
    if (runsByPage.has(trigger.group)) continue;
    try {
      runsByPage.set(trigger.group, await listPageRuns(trigger.group));
    } catch (err) {
      log(`ラン一覧取得に失敗（次周に持ち越し）: page=${trigger.group} ${String(err)}`);
    }
  }

  for (const trigger of triggers) {
    if (!trigger.group) continue;
    const runsForPage = runsByPage.get(trigger.group);
    if (!runsForPage) continue; // 一覧取得に失敗したページはこの周スキップ
    // 判定はそのトリガーが作ったランだけで行う（2026-08-14 修正。同じページの別トリガーの
    // ランを「自分の回は済んだ」と誤認して黙るのを防ぐ。trigger.ts の runsOfTrigger）
    const runsForTrigger = runsOfTrigger(runsForPage, trigger.id);

    if (trigger.executor === "script") {
      await tickScriptTrigger(trigger, runsForTrigger);
    } else if (trigger.executor === "ai") {
      await tickAiTrigger(trigger, runsForTrigger);
    }
    // executor=human はエンジンは何もしない（手動 /run のみ）
  }
}
