// executor 起動の組み立て（script/ai 共通部）。
// プロジェクト層（executeNode / tickDecision）とラン層（executeRunItem /
// executeRunDecisionItem）で同じ組み立てを共用する。文脈ごとの差分（run.context の解決・
// プロンプトへ渡すゴール/親文脈・失敗の記録先・ログ文言）は引数で受ける。
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getFile, patchRunItem, postMessage } from "./api.js";
import { ENGINE_ACTOR, VIA } from "./actor.js";
import { buildDecisionPrompt, parseBranchChoice } from "./decision.js";
import { buildContextEnv } from "./context.js";
import { truncate, withSubSteps } from "./format.js";
import { log } from "./log.js";
import { substituteParams } from "./params.js";
import { configFor, engineMode, workspaceRoot } from "./settings.js";
import { parentSayContext, parentSayContextForRun, threadContextFor } from "./threadContext.js";
import { runScript } from "./executors/script.js";
import { buildAiPrompt, runClaude, type ExecResult } from "./executors/claude.js";
import { runApi } from "./executors/api.js";
import type { Actor, Node, Run } from "./types.js";

/** autonomy=high の自動リトライ回数（プロジェクトはノードid、ランは gateKey で数える。
 *  エンジンのメモリ管理: プロセス再起動でリセットされるのは aiTriggerLastCheckedAt と
 *  同じく許容する。成功・質問・人間へ渡した時点で消す */
export const autoRetryCounts = new Map<string, number>();

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

/** ai 実行の actor 名（engine.mode で決まる） */
export function aiExecutorName(): string {
  return engineMode === "api" ? "executor:api" : "executor:claude";
}

/** ai 実行の起動。engine.mode で API / claude CLI を切り替える（cwd は workspace root） */
export function runAiExecutor(prompt: string, node: Pick<Node, "aiModel" | "aiEffort">): Promise<ExecResult> {
  return engineMode === "api"
    ? runApi(prompt)
    : runClaude(prompt, configFor(node), { cwd: workspaceRoot ?? undefined });
}

/** task ノードの script/ai executor 起動を組み立てて実行する。run の有無が層の違い:
 *  - script: ラン層は run.context を渡して解決し（解決順: context → デフォルト値 →
 *    未入力エラー。3.15）、実行直前に解決済みの値を RunItem.resolvedParams へ焼き、
 *    GW_* 環境変数と作業ディレクトリを付ける。プロジェクト層はランが無いので context を
 *    渡さない（従来どおりデフォルト値のみ）
 *  - ai: ゴール文脈はラン層=ページノード(run.pageId) / プロジェクト層=group のゴール。
 *    親の成果はラン層=同一ランの say のみ（parentSayContextForRun）。runContext は
 *    ラン層でのみプロンプトへ渡す（undefined = プロジェクト層。claude.ts 参照）
 *  結果の後処理（成功/失敗/QUESTION の記録先）は呼び出し側が層ごとに行う */
export async function launchExecutor(
  nodes: Node[],
  node: Node,
  run: Run | null,
): Promise<{ result: ExecResult; executorName: string; aiSources: string[] }> {
  let result: ExecResult;
  let executorName: string;
  let aiSources: string[] = [];

  if (node.executor === "script") {
    executorName = "executor:script";
    if (!node.impl || node.impl.type !== "script") {
      result = { success: false, output: "", error: "実装がない（impl が script 形式ではない）" };
    } else {
      const sub = run
        ? substituteParams(node.impl.command, node.impl.params, run.context)
        : substituteParams(node.impl.command, node.impl.params);
      if (!sub.ok) {
        result = { success: false, output: "", error: sub.reason };
      } else if (run) {
        // 実行直前に、実際に使った解決済みの値（context 由来+デフォルト値由来の両方）を
        // ランへ焼く（RunItem.resolvedParams。ランページの引数欄が読み取り専用で表示し、
        // 現在の run.context とずれたら「古い値で実行済み」バッジを出す。3.15）
        await patchRunItem(run.id, node.id, { resolvedParams: sub.resolved }, ENGINE_ACTOR, VIA);
        const runDir = await ensureRunDir(run.id);
        result = await runScript(sub.command, {
          cwd: workspaceRoot ?? undefined,
          env: buildContextEnv(run.id, run.context, node.impl.params, runDir),
        });
      } else {
        result = await runScript(sub.command, { cwd: workspaceRoot ?? undefined });
      }
    }
  } else {
    const goal = run
      ? (nodes.find((n) => n.id === run.pageId) ?? null)
      : node.group
        ? (nodes.find((n) => n.id === node.group) ?? null)
        : null;
    const parentSayMessages = run
      ? await parentSayContextForRun(node, nodes, run.id)
      : await parentSayContext(node, nodes);
    // ラン実行の経緯は**そのラン**の会話だけ（別ランのQ&Aを新しい世界線へ漏らさない）
    const threadContext = await threadContextFor(node.id, run?.id ?? null);
    const resolved = await resolveDocForPrompt(node);
    if (resolved.error) {
      executorName = aiExecutorName();
      result = { success: false, output: "", error: resolved.error };
    } else {
      const built = buildAiPrompt({
        node: resolved.node,
        goal,
        parentSayMessages,
        autonomy: node.autonomy,
        threadContext,
        ...(run ? { runContext: run.context } : {}),
      });
      aiSources = built.sources;
      executorName = aiExecutorName();
      result = await runAiExecutor(built.prompt, node);
    }
  }

  return { result, executorName, aiSources };
}

/** 分岐ノード（kind=decision）の script/ai 実行の文脈差分。失敗の記録先
 *  （プロジェクト層=失敗リカバリカード / ラン層=アイテムを waiting へ）と決着先
 *  （decideNode / decideRunItem）、ログ文言を層ごとに渡す */
interface DecisionExecContext {
  /** 帰属ラン（ラン層のみ。プロジェクト層は undefined＝テンプレート側の記録） */
  runId?: string;
  /** スレッド投稿に載せる payload（ラン層は {runId}。プロジェクト層は undefined）。
   *  帰属は ctx.runId が正で、payload.runId は server の GET /api/runs/:id/trace 用の併記 */
  payload?: Record<string, unknown>;
  /** ログの主語（"分岐" / "ラン分岐"） */
  logLabel: string;
  /** ログの位置表記（"id=..." / "run=... node=..."） */
  logWhere: string;
  /** 実行失敗・出力不正時の後処理（status 投稿は共通側が済ませてから呼ぶ） */
  onFailure: (reason: string) => Promise<void>;
  /** 枝の決着 */
  decide: (choice: string, actor: Actor) => Promise<void>;
}

/** 分岐ノードの script/ai 実行を組み立てて枝の決着まで行う（プロジェクト層・ラン層共通）。
 *  実行 → 出力を枝 id として解釈（parseBranchChoice）→ decide。失敗はどの段階でも
 *  status をスレッドへ積んでから ctx.onFailure に渡す */
export async function executeDecisionCore(node: Node, ctx: DecisionExecContext): Promise<void> {
  const { payload, logLabel, logWhere } = ctx;
  const withRun = ctx.runId ? { runId: ctx.runId } : {};
  const withPayload = payload ? { payload, ...withRun } : withRun;

  if (node.executor === "script") {
    const actor: Actor = { kind: "agent", name: "executor:script" };
    if (!node.impl || node.impl.type !== "script") {
      await postMessage(
        node.id,
        { kind: "status", body: "実行失敗: 実装がない（impl が script 形式ではない）", ...withPayload },
        actor,
        VIA,
      );
      await ctx.onFailure("impl が script 形式ではない");
      return;
    }
    const sub = substituteParams(node.impl.command, node.impl.params);
    if (!sub.ok) {
      const reason = sub.reason;
      await postMessage(node.id, { kind: "status", body: `実行失敗: ${reason}`, ...withPayload }, actor, VIA);
      await ctx.onFailure(reason);
      log(`${logLabel}: パラメータ解決失敗 ${logWhere} reason=${reason}`);
      return;
    }
    const result = await runScript(sub.command, { cwd: workspaceRoot ?? undefined });
    if (!result.success) {
      const reason = result.error || "不明なエラー";
      await postMessage(
        node.id,
        { kind: "status", body: truncate(`実行失敗: ${reason}`, 500), ...withPayload },
        actor,
        VIA,
      );
      await ctx.onFailure(reason);
      log(`${logLabel}の script 実行失敗: ${logWhere} reason=${reason}`);
      return;
    }
    const choice = parseBranchChoice(node, result.output);
    if (!choice) {
      const reason = `script出力が枝idと一致しません(出力="${truncate(result.output, 200)}")`;
      await postMessage(node.id, { kind: "status", body: `実行失敗: ${reason}`, ...withPayload }, actor, VIA);
      await ctx.onFailure(reason);
      log(`${logLabel}の script 出力が不正: ${logWhere}`);
      return;
    }
    await postMessage(
      node.id,
      { kind: "status", body: `分岐: ${choice} を選択（script出力）`, ...withPayload },
      actor,
      VIA,
    );
    await ctx.decide(choice, actor);
    log(`${logLabel}確定(script): ${logWhere} choice=${choice}`);
    return;
  }

  // executor=ai
  const actor: Actor = { kind: "agent", name: aiExecutorName() };
  const prompt = buildDecisionPrompt(node);
  const result = await runAiExecutor(prompt, node);
  if (!result.success) {
    const reason = result.error || "不明なエラー";
    await postMessage(
      node.id,
      {
        kind: "status",
        body: truncate(`実行失敗: ${reason}`, 500),
        payload: withSubSteps(payload, result),
        ...withRun,
      },
      actor,
      VIA,
    );
    await ctx.onFailure(reason);
    log(`${logLabel}の ai 実行失敗: ${logWhere} reason=${reason}`);
    return;
  }
  const choice = parseBranchChoice(node, result.output);
  if (!choice) {
    const reason = `AI出力が枝idと一致しません(出力="${truncate(result.output, 200)}")`;
    await postMessage(
      node.id,
      { kind: "status", body: `実行失敗: ${reason}`, payload: withSubSteps(payload, result), ...withRun },
      actor,
      VIA,
    );
    await ctx.onFailure(reason);
    log(`${logLabel}の ai 出力が不正: ${logWhere}`);
    return;
  }
  await postMessage(
    node.id,
    { kind: "say", body: result.output.trim(), payload: withSubSteps(payload, result), ...withRun },
    actor,
    VIA,
  );
  await ctx.decide(choice, actor);
  log(`${logLabel}確定(ai): ${logWhere} choice=${choice}`);
}
