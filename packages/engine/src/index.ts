// graphwrangler 実行エンジン。常駐プロセスとして HTTP API をポーリングし、
// 実行可能なノード（実行者=ai|script）を1並列で処理する。
// docs/design.md 3.4/3.5/3.8/3.9 が設計の正。
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  decideNode,
  decideRunItem,
  runTriggerNode,
  getFile,
  getSettings,
  getState,
  getThread,
  getWorkspace,
  heartbeat,
  listPageRuns,
  openRequest,
  patchNode,
  patchRunContext,
  patchRunItem,
  postMessage,
} from "./api.js";
import {
  buildFailureRecoveryRequest,
  buildIrreversibleGateRequest,
  isRunManagedMember,
  selectAction,
  triggerPageIds,
} from "./pick.js";
import { selectRunAction } from "./pickRun.js";
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
  buildThreadContextLines,
  parseAiQuestion,
  shouldAutoRetry,
  type AiQuestion,
} from "./ask.js";
import {
  buildDecisionPrompt,
  buildDecisionRequest,
  parseBranchChoice,
  selectDecisionAction,
} from "./decision.js";
import {
  DECISION_WAITING_NOTE,
  buildRunDecisionRequest,
  collectPendingRunDecisions,
  selectRunDecisionAction,
  selectRunDecisionApprovalAction,
} from "./decisionRun.js";
import {
  // approval.ts（ランアイテムの実行前承認）と同名だが別物なので、ラン開始承認系として別名で受ける
  buildRunApprovalRequest as buildRunStartApprovalRequest,
  buildTriggerPrompt,
  describeRunEvent,
  findRunGate as findRunStartGate,
  findLatestRunEvent,
  runBaseline,
  hasUnconsumedGo,
  isDetectScriptTrigger,
  isClosedPage,
  isRunnableTrigger,
  parseAiRunDecision,
  parseDetectEmitLines,
  resolveAiCheckIntervalMs,
  shouldEvaluateAiTrigger,
  shouldRunScriptTrigger,
  shouldRunDetectScript,
  type DetectEmitEvent,
  type RunGateState as RunStartGateState,
} from "./trigger.js";
import { buildContextEnv, extractGwMarkers } from "./context.js";
import { runScript } from "./executors/script.js";
import { substituteParams } from "./params.js";
import { buildAiPrompt, runClaude, type ClaudeExecutorConfig } from "./executors/claude.js";
import { runApi } from "./executors/api.js";
import type { Actor, Message, Node, Run, SubStep } from "./types.js";

const INTERVAL_MS = Number(process.env.GW_ENGINE_INTERVAL_MS ?? 5000);
const VIA = "engine";
const ENGINE_ACTOR: Actor = { kind: "agent", name: "engine" };

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---- エンジンAI設定（サーバ設定を起動時+10分ごとに読む） ----
// env GW_ENGINE_CLAUDE_MODEL があれば model はそれを優先する（取得失敗時は既定値で継続）。
const SETTINGS_REFRESH_MS = 10 * 60 * 1000; // 10分

const DEFAULT_ENGINE_CONFIG: ClaudeExecutorConfig = {
  cliPath: "claude",
  model: process.env.GW_ENGINE_CLAUDE_MODEL ?? "opus",
  effort: null,
  extraArgs: [],
  extraTools: [],
  addDirs: [],
};

/** ノード側の aiModel/aiEffort（2026-08-07 切替機能）を設定の既定へ重ねた実行時設定。
 *  null（未指定）のフィールドだけ engineConfig に従う */
function configFor(node: Pick<Node, "aiModel" | "aiEffort">): ClaudeExecutorConfig {
  return {
    ...engineConfig,
    model: node.aiModel ?? engineConfig.model,
    effort: node.aiEffort ?? engineConfig.effort,
  };
}

let engineConfig: ClaudeExecutorConfig = DEFAULT_ENGINE_CONFIG;
// engine.mode（"cli"=claude -p 等のヘッドレスCLI起動 / "api"=サーバの /api/ai/complete を呼ぶ）。
// 取得失敗時は前回値のまま継続する（既定は安全側の "cli"）
let engineMode: "cli" | "api" = "cli";
let lastSettingsFetchAt = 0;

/** GET /api/settings から engine executor の設定を反映する。10分未満は何もしない
 *  （force=true なら起動時など強制的に取得する）。取得失敗時は前回値のまま継続し、
 *  次 tick で再試行する（起動直後にサーバがまだ立っていないレースで10分間
 *  既定値のまま走らないため。refreshWorkspaceInfo と同じ方式） */
async function refreshEngineConfig(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSettingsFetchAt < SETTINGS_REFRESH_MS) return;
  try {
    const settings = await getSettings();
    lastSettingsFetchAt = now;
    const modelFromEnv = process.env.GW_ENGINE_CLAUDE_MODEL;
    engineMode = settings.engine.mode === "api" ? "api" : "cli";
    engineConfig = {
      cliPath: settings.engine.cliPath || DEFAULT_ENGINE_CONFIG.cliPath,
      model: modelFromEnv ?? settings.engine.model ?? DEFAULT_ENGINE_CONFIG.model,
      effort: settings.engine.effort ?? null,
      extraArgs: Array.isArray(settings.engine.extraArgs) ? settings.engine.extraArgs : [],
      extraTools: Array.isArray(settings.engine.cliExtraTools) ? settings.engine.cliExtraTools : [],
      addDirs: Array.isArray(settings.ai?.addDirs) ? settings.ai.addDirs : [],
    };
    log(
      `エンジン設定を反映: mode=${engineMode} cliPath=${engineConfig.cliPath} model=${engineConfig.model} extraArgs=${JSON.stringify(engineConfig.extraArgs)} extraTools=${JSON.stringify(engineConfig.extraTools)} addDirs=${JSON.stringify(engineConfig.addDirs)}`,
    );
  } catch (err) {
    log(`設定取得に失敗（前回値のまま継続、次tickで再試行）: ${String(err)}`);
  }
}

// ---- ワークスペースモード: サーバの動作モード ----
// script/AI executor の cwd 決定（workspace root を渡す）と impl={type:"doc",path} の解決に使う。
// 取得失敗時は null のまま（従来の data-dir モードと同じ挙動で継続する）。
// 起動時1回きりだとエンジンがサーバより先に起動したとき恒久的に null 固定になるため
// （2026-07-31 整合レビューで検出）、未取得の間は毎 tick 再試行し、成功後は
// refreshEngineConfig と同じ 10 分間隔で追随する（サーバのモード切替再起動にも追従）

let workspaceRoot: string | null = null;
let workspaceFetchedOk = false;
let lastWorkspaceFetchAt = 0;

async function refreshWorkspaceInfo(): Promise<void> {
  const now = Date.now();
  if (workspaceFetchedOk && now - lastWorkspaceFetchAt < SETTINGS_REFRESH_MS) return;
  try {
    const info = await getWorkspace();
    workspaceFetchedOk = true;
    lastWorkspaceFetchAt = now;
    const prev = workspaceRoot;
    workspaceRoot = info.mode === "workspace" ? info.root : null;
    if (workspaceRoot && workspaceRoot !== prev) log(`ワークスペースモードで接続: root=${workspaceRoot}`);
  } catch (err) {
    log(`ワークスペース情報の取得に失敗（data-dirモード相当で継続）: ${String(err)}`);
  }
}

/** impl={type:"doc"} の本文を解決する。text があればそのまま（インライン済み扱い）、
 *  無くて path があれば GET /api/files で取得して text に埋め込む（ワークスペースモード。
 *  仕様書「ワークスペース=1ファイル化」参照）。取得に失敗したら error を返す
 *  （呼び出し側はこれを実行失敗として既存の failure recovery（承認/回答リクエスト）に乗せる） */
async function resolveDocForPrompt(node: Node): Promise<{ node: Node; error?: string }> {
  if (!node.impl || node.impl.type !== "doc" || node.impl.text || !node.impl.path) {
    return { node };
  }
  try {
    const text = await getFile(node.impl.path);
    return { node: { ...node, impl: { ...node.impl, text } } };
  } catch (err) {
    return {
      node,
      error: `手順書ファイル(path=${node.impl.path})の取得に失敗しました: ${String(err)}`,
    };
  }
}

function truncate(text: string, limit: number): string {
  const t = text.trim();
  return t.length <= limit ? t : t.slice(0, limit) + "…";
}

/** 実行結果の subSteps（実行の内訳）を postMessage 用 payload にする。空/無ければ
 *  base をそのまま返す（status メッセージに subSteps が無いケースを既存互換で保つ） */
function withSubSteps(
  base: Record<string, unknown> | undefined,
  result: { subSteps?: SubStep[] },
): Record<string, unknown> | undefined {
  if (!result.subSteps || result.subSteps.length === 0) return base;
  return { ...base, subSteps: result.subSteps };
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
        n.parents.every((pid) => {
          const s = byId.get(pid)?.status;
          return s === "done" || s === "skipped"; // 3.9: skipped も充足扱い（合流ノード対応）
        }),
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

/** autonomy=high の自動リトライ回数（プロジェクトはノードid、ランは gateKey で数える。
 *  エンジンのメモリ管理: プロセス再起動でリセットされるのは aiTriggerLastCheckedAt と
 *  同じく許容する。成功・質問・人間へ渡した時点で消す */
const autoRetryCounts = new Map<string, number>();

/** 自ノードのスレッドから再実行プロンプト用の経緯（人間へのQ&A・直前の失敗）を拾う。
 *  取得失敗時は経緯なしで実行を続ける（経緯は補助文脈であり必須ではない） */
async function threadContextFor(nodeId: string): Promise<string[]> {
  try {
    const { messages } = await getThread(nodeId);
    return buildThreadContextLines(messages);
  } catch (err) {
    log(`スレッド経緯の取得に失敗（経緯なしで実行継続）: node=${nodeId} ${String(err)}`);
    return [];
  }
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

/** メッセージの帰属ラン id。既存データ互換のためフィールド → payload の順に見る
 *  （core の runIdOf と同じ規則。engine は HTTP API のみを統合点にするためここに再実装） */
function runIdOf(m: Message): string | null {
  if (m.runId) return m.runId;
  const payload = m.payload as { runId?: unknown } | null;
  return payload && typeof payload.runId === "string" ? payload.runId : null;
}

/** parentSayContext のラン層版: 同じランに属する say（runIdOf === runId）だけを拾う。
 *  テンプレートのスレッドには複数の並列ランの記録が混ざるため、フィルタ無しで末尾を
 *  拾うと別ランの成果を文脈として渡してしまう（従来はラン層で [] 固定＝親の成果が
 *  全く渡っていなかった穴の修復。2026-08-09） */
async function parentSayContextForRun(node: Node, nodes: Node[], runId: string): Promise<string[]> {
  const out: string[] = [];
  for (const pid of node.parents) {
    try {
      const { messages } = await getThread(pid);
      const say = [...messages].reverse().find((m) => m.kind === "say" && runIdOf(m) === runId);
      if (say) {
        const title = nodes.find((n) => n.id === pid)?.title ?? pid;
        out.push(`${title}: ${say.body}`);
      }
    } catch (err) {
      log(`親ノードの文脈取得に失敗（実行は継続）: run=${runId} node=${pid} ${String(err)}`);
    }
  }
  return out;
}

/** ラン毎の作業ディレクトリ（3.15「成果物はファイル、context にはパス」）。ワークスペース
 *  モードでのみ <workspaceRoot>/.graphwrangler/runfiles/<runId> を実行前に mkdir して返す。
 *  data-dir モードでは null（GW_RUN_DIR を渡さない）。作成失敗も null で実行は続ける
 *  （作業ディレクトリは補助であり、無いことはスクリプト側が GW_RUN_DIR の有無で判る） */
async function ensureRunDir(runId: string): Promise<string | null> {
  if (!workspaceRoot) return null;
  const dir = path.join(workspaceRoot, ".graphwrangler", "runfiles", runId);
  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch (err) {
    log(`ラン作業ディレクトリの作成に失敗（GW_RUN_DIRなしで続行）: dir=${dir} ${String(err)}`);
    return null;
  }
}

/** 失敗リカバリの「内容を変える(modify)」回答を受けて、下書きに戻して人間の編集を待つ。
 *  回答直後に同じ内容で即再実行してしまわないための待避（編集後「プラン済みにする」で
 *  再び実行対象になる）。status メッセージを積むことでスレッド末尾の modify 回答を消費し、
 *  再コミット後に再度 demote されるループを防ぐ */
async function demoteToDraft(node: Node): Promise<void> {
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

  let result: { success: boolean; output: string; error?: string; subSteps?: SubStep[] };
  let executorName: string;
  let aiSources: string[] = [];

  if (node.executor === "script") {
    executorName = "executor:script";
    if (!node.impl || node.impl.type !== "script") {
      result = { success: false, output: "", error: "実装がない（impl が script 形式ではない）" };
    } else {
      // プロジェクト層はランが無いので context を渡さない（従来どおりデフォルト値のみ。3.15）
      const sub = substituteParams(node.impl.command, node.impl.params);
      if (!sub.ok) {
        result = { success: false, output: "", error: sub.reason };
      } else {
        result = await runScript(sub.command, { cwd: workspaceRoot ?? undefined });
      }
    }
  } else {
    const goal = node.group ? (nodes.find((n) => n.id === node.group) ?? null) : null;
    const parentSayMessages = await parentSayContext(node, nodes);
    const threadContext = await threadContextFor(node.id);
    const resolved = await resolveDocForPrompt(node);
    if (resolved.error) {
      executorName = engineMode === "api" ? "executor:api" : "executor:claude";
      result = { success: false, output: "", error: resolved.error };
    } else {
      const built = buildAiPrompt({
        node: resolved.node,
        goal,
        parentSayMessages,
        autonomy: node.autonomy,
        threadContext,
      });
      aiSources = built.sources;
      if (engineMode === "api") {
        executorName = "executor:api";
        result = await runApi(built.prompt);
      } else {
        executorName = "executor:claude";
        result = await runClaude(built.prompt, configFor(node), { cwd: workspaceRoot ?? undefined });
      }
    }
  }

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

// ---- 分岐ノード（kind=decision、プロジェクト層。docs/design.md 3.9） ----

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
async function tickDecision(nodes: Node[]): Promise<boolean> {
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
    case "execute-script": {
      const node = action.node;
      const actor: Actor = { kind: "agent", name: "executor:script" };
      if (!node.impl || node.impl.type !== "script") {
        await postMessage(
          node.id,
          { kind: "status", body: "実行失敗: 実装がない（impl が script 形式ではない）" },
          actor,
          VIA,
        );
              await openRequest(
          node.id,
          buildFailureRecoveryRequest(node, "impl が script 形式ではない"),
          ENGINE_ACTOR,
          VIA,
        );
        return true;
      }
      const sub = substituteParams(node.impl.command, node.impl.params);
      if (!sub.ok) {
        const reason = sub.reason;
        await postMessage(node.id, { kind: "status", body: `実行失敗: ${reason}` }, actor, VIA);
              await openRequest(node.id, buildFailureRecoveryRequest(node, reason), ENGINE_ACTOR, VIA);
        log(`分岐: パラメータ解決失敗 id=${node.id} reason=${reason}`);
        return true;
      }
      const result = await runScript(sub.command, { cwd: workspaceRoot ?? undefined });
      if (!result.success) {
        const reason = result.error || "不明なエラー";
        await postMessage(node.id, { kind: "status", body: truncate(`実行失敗: ${reason}`, 500) }, actor, VIA);
              await openRequest(node.id, buildFailureRecoveryRequest(node, reason), ENGINE_ACTOR, VIA);
        log(`分岐の script 実行失敗: id=${node.id} reason=${reason}`);
        return true;
      }
      const choice = parseBranchChoice(node, result.output);
      if (!choice) {
        const reason = `script出力が枝idと一致しません(出力="${truncate(result.output, 200)}")`;
        await postMessage(node.id, { kind: "status", body: `実行失敗: ${reason}` }, actor, VIA);
              await openRequest(node.id, buildFailureRecoveryRequest(node, reason), ENGINE_ACTOR, VIA);
        log(`分岐の script 出力が不正: id=${node.id}`);
        return true;
      }
      await postMessage(node.id, { kind: "status", body: `分岐: ${choice} を選択（script出力）` }, actor, VIA);
      await decideNode(node.id, choice, actor, VIA);
      log(`分岐確定(script): id=${node.id} choice=${choice}`);
      return true;
    }
    case "execute-ai": {
      const node = action.node;
      const actor: Actor = { kind: "agent", name: engineMode === "api" ? "executor:api" : "executor:claude" };
      const prompt = buildDecisionPrompt(node);
      const result = engineMode === "api" ? await runApi(prompt) : await runClaude(prompt, configFor(node), { cwd: workspaceRoot ?? undefined });
      if (!result.success) {
        const reason = result.error || "不明なエラー";
        await postMessage(
          node.id,
          { kind: "status", body: truncate(`実行失敗: ${reason}`, 500), payload: withSubSteps(undefined, result) },
          actor,
          VIA,
        );
              await openRequest(node.id, buildFailureRecoveryRequest(node, reason), ENGINE_ACTOR, VIA);
        log(`分岐の ai 実行失敗: id=${node.id} reason=${reason}`);
        return true;
      }
      const choice = parseBranchChoice(node, result.output);
      if (!choice) {
        const reason = `AI出力が枝idと一致しません(出力="${truncate(result.output, 200)}")`;
        await postMessage(
          node.id,
          { kind: "status", body: `実行失敗: ${reason}`, payload: withSubSteps(undefined, result) },
          actor,
          VIA,
        );
              await openRequest(node.id, buildFailureRecoveryRequest(node, reason), ENGINE_ACTOR, VIA);
        log(`分岐の ai 出力が不正: id=${node.id}`);
        return true;
      }
      await postMessage(
        node.id,
        { kind: "say", body: result.output.trim(), payload: withSubSteps(undefined, result) },
        actor,
        VIA,
      );
      await decideNode(node.id, choice, actor, VIA);
      log(`分岐確定(ai): id=${node.id} choice=${choice}`);
      return true;
    }
  }
}

// ---- ルーティーンページ: ランのワークアイテム実行 ----

/** ランのワークアイテムを実行する。プロンプト文脈はページノードの title/detail +
 *  テンプレートの title/detail/impl（claude.ts の buildAiPrompt を "goal=ページノード" として再利用）。
 *  実行ログ・成果はテンプレートノードのスレッドへ payload {runId} 付きで投稿する */
async function executeRunItem(nodes: Node[], run: Run, node: Node): Promise<void> {
  await patchRunItem(run.id, node.id, { status: "running" }, ENGINE_ACTOR, VIA);
  log(`ラン実行開始: run=${run.id} node=${node.id} title=${node.title} executor=${node.executor}`);

  let result: { success: boolean; output: string; error?: string; subSteps?: SubStep[] };
  let executorName: string;
  let aiSources: string[] = [];

  if (node.executor === "script") {
    executorName = "executor:script";
    if (!node.impl || node.impl.type !== "script") {
      result = { success: false, output: "", error: "実装がない（impl が script 形式ではない）" };
    } else {
      // ラン層は run.context を渡して解決する（解決順: context → デフォルト値 → 未入力エラー。3.15）
      const sub = substituteParams(node.impl.command, node.impl.params, run.context);
      if (!sub.ok) {
        result = { success: false, output: "", error: sub.reason };
      } else {
        // 実行直前に、実際に使った解決済みの値（context 由来+デフォルト値由来の両方）を
        // ランへ焼く（RunItem.resolvedParams。ランページの引数欄が読み取り専用で表示し、
        // 現在の run.context とずれたら「古い値で実行済み」バッジを出す。3.15）
        await patchRunItem(run.id, node.id, { resolvedParams: sub.resolved }, ENGINE_ACTOR, VIA);
        const runDir = await ensureRunDir(run.id);
        result = await runScript(sub.command, {
          cwd: workspaceRoot ?? undefined,
          env: buildContextEnv(run.id, run.context, node.impl.params, runDir),
        });
      }
    }
  } else {
    const pageNode = nodes.find((n) => n.id === run.procedure) ?? null;
    const parentSayMessages = await parentSayContextForRun(node, nodes, run.id);
    const threadContext = await threadContextFor(node.id);
    const resolved = await resolveDocForPrompt(node);
    if (resolved.error) {
      executorName = engineMode === "api" ? "executor:api" : "executor:claude";
      result = { success: false, output: "", error: resolved.error };
    } else {
      const built = buildAiPrompt({
        node: resolved.node,
        goal: pageNode,
        parentSayMessages,
        autonomy: node.autonomy,
        threadContext,
        runContext: run.context,
      });
      aiSources = built.sources;
      if (engineMode === "api") {
        executorName = "executor:api";
        result = await runApi(built.prompt);
      } else {
        executorName = "executor:claude";
        result = await runClaude(built.prompt, configFor(node), { cwd: workspaceRoot ?? undefined });
      }
    }
  }

  const actor: Actor = { kind: "agent", name: executorName };
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
        await openRequest(node.id, buildAiQuestionRequest(node, question, run.id), ENGINE_ACTOR, VIA);
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
        },
        actor,
        VIA,
      );
    }
    const summary = truncate(extraction.body || "(出力なし)", 500);
    await postMessage(
      node.id,
      { kind: "status", body: `実行成功: ${summary}`, payload: withSubSteps(payload, result) },
      actor,
      VIA,
    );
    // AI発言の出典バッジ用データ（docs/design.md 3.8）。script executor には該当する文脈が無いので付けない
    const sayPayload = node.executor === "ai" ? { ...payload, sources: aiSources } : payload;
    await postMessage(
      node.id,
      { kind: "say", body: extraction.body.trim() || "(結果なし)", payload: sayPayload },
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
    { kind: "status", body: truncate(`実行失敗: ${reason}`, 500), payload: withSubSteps(payload, result) },
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
    let messages;
    try {
      ({ messages } = await getThread(node.id));
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
            (m.payload as { runId?: string; aiQuestion?: AiQuestion } | null)?.runId === run.id &&
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
        await openRequest(node.id, buildAiQuestionRequest(node, question, run.id), ENGINE_ACTOR, VIA);
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

// ---- ルーティーンページ: ランの分岐アイテム（kind=decision。docs/design.md 3.8/3.9） ----

/** ラン内の human 分岐アイテムについて、テンプレートノードのスレッドから
 *  承認連携(approval.ts)と同じ方式でゲート状態を集める */
async function fetchRunDecisionGateStates(
  pending: Array<{ run: Run; node: Node }>,
): Promise<Record<string, RunGateState>> {
  const gateStates: Record<string, RunGateState> = {};
  for (const { run, node } of pending) {
    try {
      const { messages } = await getThread(node.id);
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

  const payload = { runId: run.id };

  if (node.executor === "script") {
    const actor: Actor = { kind: "agent", name: "executor:script" };
    if (!node.impl || node.impl.type !== "script") {
      await postMessage(
        node.id,
        { kind: "status", body: "実行失敗: 実装がない（impl が script 形式ではない）", payload },
        actor,
        VIA,
      );
      await patchRunItem(
        run.id,
        node.id,
        { status: "waiting", note: "失敗: impl が script 形式ではない" },
        ENGINE_ACTOR,
        VIA,
      );
      return;
    }
    const sub = substituteParams(node.impl.command, node.impl.params);
    if (!sub.ok) {
      const reason = sub.reason;
      await postMessage(node.id, { kind: "status", body: `実行失敗: ${reason}`, payload }, actor, VIA);
      await patchRunItem(
        run.id,
        node.id,
        { status: "waiting", note: `失敗: ${truncate(reason, 200)}` },
        ENGINE_ACTOR,
        VIA,
      );
      log(`ラン分岐: パラメータ解決失敗 run=${run.id} node=${node.id} reason=${reason}`);
      return;
    }
    const result = await runScript(sub.command, { cwd: workspaceRoot ?? undefined });
    if (!result.success) {
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
      log(`ラン分岐の script 実行失敗: run=${run.id} node=${node.id} reason=${reason}`);
      return;
    }
    const choice = parseBranchChoice(node, result.output);
    if (!choice) {
      const reason = `script出力が枝idと一致しません(出力="${truncate(result.output, 200)}")`;
      await postMessage(node.id, { kind: "status", body: `実行失敗: ${reason}`, payload }, actor, VIA);
      await patchRunItem(
        run.id,
        node.id,
        { status: "waiting", note: `失敗: ${truncate(reason, 200)}` },
        ENGINE_ACTOR,
        VIA,
      );
      log(`ラン分岐の script 出力が不正: run=${run.id} node=${node.id}`);
      return;
    }
    await postMessage(
      node.id,
      { kind: "status", body: `分岐: ${choice} を選択（script出力）`, payload },
      actor,
      VIA,
    );
    await decideRunItem(run.id, node.id, choice, actor, VIA);
    log(`ラン分岐確定(script): run=${run.id} node=${node.id} choice=${choice}`);
    return;
  }

  // executor=ai
  const actor: Actor = { kind: "agent", name: engineMode === "api" ? "executor:api" : "executor:claude" };
  const prompt = buildDecisionPrompt(node);
  const result = engineMode === "api" ? await runApi(prompt) : await runClaude(prompt, configFor(node), { cwd: workspaceRoot ?? undefined });
  if (!result.success) {
    const reason = result.error || "不明なエラー";
    await postMessage(
      node.id,
      { kind: "status", body: truncate(`実行失敗: ${reason}`, 500), payload: withSubSteps(payload, result) },
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
    log(`ラン分岐の ai 実行失敗: run=${run.id} node=${node.id} reason=${reason}`);
    return;
  }
  const choice = parseBranchChoice(node, result.output);
  if (!choice) {
    const reason = `AI出力が枝idと一致しません(出力="${truncate(result.output, 200)}")`;
    await postMessage(
      node.id,
      { kind: "status", body: `実行失敗: ${reason}`, payload: withSubSteps(payload, result) },
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
    log(`ラン分岐の ai 出力が不正: run=${run.id} node=${node.id}`);
    return;
  }
  await postMessage(
    node.id,
    { kind: "say", body: result.output.trim(), payload: withSubSteps(payload, result) },
    actor,
    VIA,
  );
  await decideRunItem(run.id, node.id, choice, actor, VIA);
  log(`ラン分岐確定(ai): run=${run.id} node=${node.id} choice=${choice}`);
}

/** プロジェクト側・通常のランタスクに実行候補が無かったとき、ランの分岐アイテムを1件処理する。
 *  処理したら true を返す */
async function tickRunDecision(nodes: Node[], runningRuns: Run[]): Promise<boolean> {
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

/** プロジェクト側に実行候補が無かったとき、ランのワークアイテムを1件処理する。
 *  承認待ちアイテムの回答チェックをランの通常実行候補選択より先に行う。通常タスクの実行候補が
 *  無ければ分岐アイテム(kind=decision)を見る */
async function tickRunItem(nodes: Node[]): Promise<void> {
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

// ---- トリガーノード（kind=trigger）: script/ai によるラン作成・自動生成 ----
// docs/design.md 3.4/3.8/3.9。
// 「ルーティーンであること」はページ種別ではなく、フロー先頭のトリガーノードから導出する。

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
async function tickDetectScriptTrigger(trigger: Node, runsForPage: Run[]): Promise<void> {
  const latestRun = runsForPage[0] ?? null; // list は created 降順
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

/** script トリガーを1件処理する（判定は schedule.ts）。impl.command があれば検知スクリプト
 *  （tickDetectScriptTrigger。3.15）、無ければ従来どおりの無条件 cron ラン作成。
 *  approval=true（ラン前承認）ならラン作成の代わりにラン前承認カードを開き、
 *  go 回答の1回だけランを作る（trigger.ts 参照） */
async function tickScriptTrigger(trigger: Node, runsForPage: Run[]): Promise<void> {
  if (isDetectScriptTrigger(trigger)) {
    await tickDetectScriptTrigger(trigger, runsForPage);
    return;
  }
  const latestRun = runsForPage[0] ?? null; // list は created 降順
  if (trigger.pendingRequest) return; // ラン前承認カード等の回答待ち

  let gate: RunStartGateState = { status: "none" };
  if (trigger.approval) {
    try {
      const { messages } = await getThread(trigger.id);
      gate = findRunStartGate(messages);
    } catch (err) {
      log(`ラン前承認のスレッド取得に失敗（この周は保留）: trigger=${trigger.id} ${String(err)}`);
      return;
    }
  }

  // skip 回答はその回のラン作成とみなす（runBaseline）。承認なしのトリガーでは gate=none で従来どおり
  const should = shouldRunScriptTrigger(trigger.schedule, runBaseline(latestRun, gate), new Date());
  if (should === null) {
    if (trigger.schedule) {
      log(`未対応のschedule書式のため無視: trigger=${trigger.id} schedule="${trigger.schedule}"`);
    } else {
      log(`scheduleが無いためscriptトリガーはラン作成しません: trigger=${trigger.id} title=${trigger.title}`);
    }
    return;
  }
  if (!should) return;

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
async function tickAiTrigger(trigger: Node, runsForPage: Run[]): Promise<void> {
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
    if (hasUnconsumedGo(gate, runsForPage[0] ?? null)) {
      // 承認済みの go はその場で消費する（2026-08-08: 以前は実行中ランがあると待たせていたが、
      // 人間が「開始して」と答えたのに動かないのは事故に見える）。
      // ラン作成判定の ##gw マーカー由来の context（payload.runEvent。旧 fireEvent も読む）があれば載せる
      const event = findLatestRunEvent(messages, runsForPage[0] ?? null);
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
  const actor: Actor = { kind: "agent", name: engineMode === "api" ? "executor:api" : "executor:claude" };
  const result = engineMode === "api" ? await runApi(prompt) : await runClaude(prompt, configFor(trigger), { cwd: workspaceRoot ?? undefined });

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
async function triggerTick(nodes: Node[]): Promise<void> {
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

    if (trigger.executor === "script") {
      await tickScriptTrigger(trigger, runsForPage);
    } else if (trigger.executor === "ai") {
      await tickAiTrigger(trigger, runsForPage);
    }
    // executor=human はエンジンは何もしない（手動 /run のみ）
  }
}

async function tick(): Promise<void> {
  await refreshEngineConfig(); // 成功後は10分ごと、失敗中は毎tick再試行（内部で throttle）
  await refreshWorkspaceInfo(); // 未取得なら毎tick再試行、取得後は10分ごと（内部で throttle）

  // UIの稼働インジケータ用ハートビート（失敗しても実行は続ける）。
  // ついでにサーバ側アプリの版（HEAD sha）を見て、自動アップデートで入れ替わっていたら
  // 自分も降りる——エンジンは別プロセスなので、放っておくと古いコードのまま回り続ける
  // （プロセス管理が無い環境では降りない。selfupdate.ts と同じ原則。2026-08-05）
  void heartbeat()
    .then(({ version }) => noteServerVersion(version))
    .catch(() => {});

  const { nodes } = await getState();

  await triggerTick(nodes);

  const ids = candidateIdsNeedingThread(nodes);
  const lastMessages = await lastMessagesFor(ids);
  const action = selectAction(nodes, lastMessages);

  switch (action.type) {
    case "drop":
      await patchNode(action.node.id, { status: "dropped" }, ENGINE_ACTOR, VIA);
      log(`人間の回答により中止(dropped): id=${action.node.id} title=${action.node.title}`);
      return;
    case "demote":
      await demoteToDraft(action.node);
      return;
    case "open-gate":
      await openRequest(action.node.id, buildIrreversibleGateRequest(action.node), ENGINE_ACTOR, VIA);
      log(`不可逆ノードの承認カードを開いた: id=${action.node.id} title=${action.node.title}`);
      return;
    case "execute":
      await executeNode(nodes, action.node);
      return;
    case "none":
      break; // プロジェクト側のタスクに候補が無ければ分岐ノードを見る（タスク優先→分岐→ラン）
  }

  if (await tickDecision(nodes)) return;

  await tickRunItem(nodes);
}

// ---- 自動アップデート追随（2026-08-05。selfupdate.ts の相方） ----
// サーバが再起動して別の版になったら、エンジンも降りて新しいコードで上がり直す。
// 自分から再起動はしない（それはプロセス管理の仕事）ので、監視されていない環境では
// 降りずにそのまま回り続ける——落ちたきり戻らないほうが困るため
let seenServerVersion: string | null = null;

function supervised(): boolean {
  return Boolean(process.env.INVOCATION_ID) || process.env.pm_id !== undefined;
}

function noteServerVersion(version: string | null): void {
  if (!version) return;
  if (seenServerVersion === null) {
    seenServerVersion = version;
    return;
  }
  if (seenServerVersion === version) return;
  log(`サーバのアプリ版が ${seenServerVersion} → ${version} に変わりました`);
  seenServerVersion = version;
  if (!supervised()) {
    log("プロセス管理下ではないため自動終了しません（手動で再起動してください）");
    return;
  }
  // 非0で終える理由はサーバ側と同じ（unit が Restart=on-failure なので 0 だと
  // 上げ直してもらえない）。75 = EX_TEMPFAIL。selfupdate.ts の RESTART_EXIT_CODE と同値
  log("新しいコードで上がり直すため終了します");
  process.exit(75);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const url = process.env.GRAPHWRANGLER_URL ?? "http://localhost:8770";
  await refreshEngineConfig(true); // 起動時は必ず一度取得する
  await refreshWorkspaceInfo(); // 起動時に1回、サーバの動作モード（workspace/datadir）を読む
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
