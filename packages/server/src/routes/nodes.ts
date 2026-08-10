// ノードの CRUD・展開・試走・手順書のファイル化・分岐（テンプレート層）のルート
// （旧 index.ts から移設）
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  GraphError,
  NodeInputSchema,
  NodePatchSchema,
  nowIso,
} from "@graphwrangler/core";
import { expandNode } from "../expand.js";
import { resolveWorkspacePath } from "../files.js";
import { assertTrialAllowed, runTrial, sha256Hex, substituteParams, trialCwd } from "../trial.js";
import { meta } from "../request_meta.js";
import type { AppContext } from "../app_context.js";

export function nodeRoutes(ctx: AppContext): Hono {
  const { graph, threads } = ctx;
  const app = new Hono();

  app.post("/api/nodes", async (c) => {
    const body = await c.req.json();
    const node = graph.addNode(NodeInputSchema.parse(body), meta(body));
    return c.json(node);
  });

  app.post("/api/nodes/:id", async (c) => {
    const body = await c.req.json();
    const node = graph.patchNode(c.req.param("id"), NodePatchSchema.parse(body), meta(body));
    return c.json(node);
  });

  app.post("/api/nodes/:id/remove", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // force=true: Fix済み・メンバー持ち・子持ちでも消す（確認モーダルは UI の責務。
    // メンバーは巻き添え削除、外の子は参照を切り離す。core の removeNode 参照）
    graph.removeNode(c.req.param("id"), meta(body), { force: body?.force === true });
    return c.json({ removed: true });
  });

  // ---- 展開（「ノード内ノード」→ 実ノード連鎖。docs/design.md 3.14。実装は expand.ts） ----
  // AI実行ノードの実行記録（スレッドの status メッセージ）が持つ内訳（payload.subSteps）から、
  // ノードを実ノードの連鎖へ展開する。ノードidは history が下がる正データ（3.1 参照）なので、
  // これは「意図的な削除+追加」——各手順が addNode/patchNode/removeNode の独立した op として
  // ops.jsonl に乗るため、undo は逆操作N件で戻る。展開元のメッセージはテンプレート記録・
  // ラン記録のどちらでもよい（どちらから展開しても、編集対象は常にテンプレート側のグラフ）
  const ExpandBodySchema = z.object({ messageId: z.string().min(1) });

  app.post("/api/nodes/:id/expand", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const { messageId } = ExpandBodySchema.parse(body);
    const result = expandNode(graph, threads, id, messageId, meta(body));
    return c.json(result);
  });

  // ---- スクリプト試走（試走ゲート。docs/design.md 3.5 近く。実装は trial.ts） ----
  // impl.type==="script" の command を実際に1回動かし、implTrial（hash/success/ts）を
  // ノードに記録する。「実装をscriptにするのは宣言であって証明ではない」を埋めるための
  // ソフトゲート（ハードブロックはしない。人間が主導権を持つ思想）。
  // 2026-07-31: 試走は常に --dry-run 付きで実行する「予告編」に固定（AIが書くスクリプトは
  // --dry-run 実装が規約。docs/design.md 3.5.1）。パラメータ宣言（同節）があれば
  // substituteParams で {name} を値へ置換してから実行する。未入力があれば実行せず400。

  app.post("/api/nodes/:id/trial", async (c) => {
    const id = c.req.param("id");
    const node = graph.get(id);
    assertTrialAllowed(node); // 400: impl.type!=="script"
    // 試走はテンプレート層（ランが無い）なので context は渡さない＝解決はデフォルト値のみ
    // （3.15 の解決順②だけが効く従来動作）。unsafe は context 由来の値にしか付かないため
    // ここでの失敗は常に kind:"missing"（分岐は型を閉じるための保険）
    const sub = substituteParams(node.impl.command, node.impl.params);
    if (!sub.ok) {
      const names = sub.kind === "missing" ? sub.missing : sub.unsafe;
      throw new GraphError(`パラメータが未入力です: ${names.join(", ")}`, 400);
    }
    const resolvedCommand = `${sub.command} --dry-run`;
    const cwd = trialCwd(graph.workspaceInfo().root);
    const result = await runTrial(resolvedCommand, cwd);
    // hash は command テンプレートのまま（値の変更だけでは stale にしない。既存挙動を維持）
    const implTrial = { hash: sha256Hex(node.impl.command), success: result.success, ts: nowIso() };
    const updated = graph.patchNode(id, { implTrial }, { actor: { kind: "system" }, via: "ui" });
    const resultLabel = result.success ? "試走成功" : `試走失敗（exit ${result.exitCode}）`;
    threads.post(id, {
      kind: "status",
      // resolvedCommand（パラメータ置換後 + --dry-run の実コマンド）を本文に含めて、
      // 追加UI無しでスレッド経由で見えるようにする（docs/design.md 3.5.1）
      body: `${resultLabel}（--dry-run）\n実行: ${resolvedCommand}\n${result.output.slice(0, 500)}`.trim(),
      payload: { implTrial, resolvedCommand },
      author: { kind: "system" },
      via: "ui",
    });
    return c.json({
      success: result.success,
      exitCode: result.exitCode,
      output: result.output.slice(0, 2000),
      implTrial: updated.implTrial,
      resolvedCommand,
    });
  });

  // ---- 手順書のファイル化（2026-08-02 本人要望「実装の手順をドキュメント化（ファイル化）する
  // 機能が欲しい」） ----
  // impl.type==="doc" のインライン本文（text）を、ワークスペース内のファイルへ書き出して
  // impl を path 参照に切り替える。手順書がリポジトリの普通のファイルになるので、
  // エディタで開ける・git で版管理される・スクリプトと同じ場所で育てられる。
  // パスは resolveWorkspacePath でルート外への脱出を拒否。fixed ノードは impl 変更が
  // patchNode の Fix ガードで 409 になる（＝ロック中はファイル化できない。先に解除）。

  const ImplToFileSchema = z.object({
    /** 書き出し先（ワークスペースルートからの相対パス。例: docs/手順.md） */
    path: z.string().min(1),
    /** 既存ファイルがあるとき上書きするか（省略時は 409 で拒否） */
    overwrite: z.boolean().optional(),
  });

  app.post("/api/nodes/:id/impl/to-file", async (c) => {
    const id = c.req.param("id");
    const node = graph.get(id);
    if (node.impl?.type !== "doc" || !node.impl.text || !node.impl.text.trim()) {
      throw new GraphError("インライン本文を持つ手順書がありません（impl.type=doc で text が必要）", 400);
    }
    const info = graph.workspaceInfo();
    if (info.mode !== "workspace" || !info.root) {
      throw new GraphError("ファイル化はワークスペースモードでのみ使えます", 400);
    }
    const body = await c.req.json();
    const { path: relPathRaw, overwrite } = ImplToFileSchema.parse(body);
    const relPath = relPathRaw.replace(/\\/g, "/");
    const abs = resolveWorkspacePath(info.root, relPath);
    if (!abs) throw new GraphError(`ワークスペース外のパスは指定できません: ${relPath}`, 400);
    if (fs.existsSync(abs) && !overwrite) {
      throw new GraphError(`既にファイルがあります: ${relPath}`, 409);
    }
    const m = meta(body);
    const text = node.impl.text.endsWith("\n") ? node.impl.text : `${node.impl.text}\n`;
    // 先に impl の patch を通す（fixed の 409 をファイル書き込み前に踏むため。
    // patch が通ってから書き込みに失敗した場合は impl を書き戻す）
    graph.patchNode(id, { impl: { type: "doc", path: relPath, text: null } }, m);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, "utf8");
    } catch (err) {
      graph.patchNode(id, { impl: node.impl }, m); // 書き込み失敗: インライン本文へ戻す
      throw new GraphError(`ファイルの書き込みに失敗しました: ${String(err)}`, 500);
    }
    threads.post(id, {
      kind: "status",
      body: `手順書をファイル化: ${relPath}`,
      payload: { implToFile: relPath },
      author: m.actor,
      via: m.via,
    });
    return c.json({ ok: true, path: relPath });
  });

  // ---- 分岐ノード（kind=decision。docs/design.md 3.9） ----
  // choice 確定 + skip伝搬は GraphStore.applyDecision に一任する（1トランザクション=複数patch opsの連続）。
  // UI が直接叩く経路とエンジン(executor=script/ai の結果、または human回答後)が叩く経路の両方が正。

  const DecideSchema = z.object({ choice: z.string().min(1) });

  app.post("/api/nodes/:id/decide", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const { choice } = DecideSchema.parse(body);
    const m = meta(body);
    const updated = graph.applyDecision(id, choice, { actor: m.actor, via: m.via });
    const label = updated.branches?.find((b) => b.id === choice)?.label ?? choice;
    threads.post(id, {
      kind: "status",
      body: `分岐: ${label} を選択`,
      payload: { choice },
      author: m.actor,
      via: m.via,
    });
    return c.json(updated);
  });

  /** 分岐の選び直し（手戻り）。choice を取り消して pending に戻し、この決着に由来する
   *  skip を復元する（GraphStore.revertDecision）。下流の done は戻さない */
  app.post("/api/nodes/:id/decide/revert", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const m = meta(body);
    const updated = graph.revertDecision(id, { actor: m.actor, via: m.via });
    threads.post(id, {
      kind: "status",
      body: "分岐の選択を取り消し（選び直し）",
      author: m.actor,
      via: m.via,
    });
    return c.json(updated);
  });

  return app;
}
