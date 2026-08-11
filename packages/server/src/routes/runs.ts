// トリガー発火とラン（実行インスタンス。docs/design.md 3.8）のルート（旧 index.ts から移設）
import { Hono } from "hono";
import { z } from "zod";
import {
  GraphError,
  RunItemStatusSchema,
  checkWiring,
  type GraphStore,
  type Node,
  type NodeSnapshot,
  type Run,
} from "@graphwrangler/core";
import { loadUsers } from "../auth.js";
import { notifyTurn } from "../discord.js";
import { notifyTargetOf } from "../notify_target.js";
import { meta } from "../request_meta.js";
import type { AppContext } from "../app_context.js";

/** ラン既定タイトル「MM/DD HH:mm のラン」（docs/design.md 3.8） */
function defaultRunTitle(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi} のラン`;
}

/** ランのワークアイテムが指すテンプレートノードを解決する。テンプレートが今のグラフから
 *  消えていても、ランは作成時点のスナップショットで動く（docs/design.md 5.5）ので
 *  run.snapshot から引いて処理を通す。snapshot も無い旧ラン（かつ削除済み）は
 *  最低限の情報で代用する——ワークアイテムの更新自体を 404 で止めない */
export function resolveItemNode(
  graph: GraphStore,
  run: Run,
  nodeId: string,
): Pick<Node, "id" | "title" | "group" | "assignee" | "branches"> {
  if (graph.has(nodeId)) return graph.get(nodeId);
  const snap = run.snapshot?.nodes.find((n) => n.id === nodeId);
  if (snap) return snap;
  // タイトルは表示（スレッド本文・通知の見出し）にしか使わない。空にすると
  // 「: pending → done」のような読めない記録が残るので、辿れる形にしておく
  return { id: nodeId, title: `（削除済み ${nodeId}）`, group: null, assignee: null, branches: null };
}

/** snapshot ノードを RunStore.applyItemDecision が受けるテンプレート（Node）の形へ補完する。
 *  分岐確定の判定に効くのは kind / parents / branches / parentOptions のみで、
 *  補完フィールドは判定に使われない（Node 型を満たすための中立値） */
function snapshotTemplate(snap: NodeSnapshot, capturedAt: string): Node {
  return {
    ...snap,
    implTrial: null,
    folder: null,
    folderSection: null,
    order: null,
    pendingRequest: null,
    choice: null,
    createdBy: null,
    members: [],
    created: capturedAt,
  };
}

export function runRoutes(ctx: AppContext): Hono {
  const { graph, threads, runs, settings, userSettings, usersFile } = ctx;
  const app = new Hono();

  // ---- トリガーノード（kind=trigger。docs/design.md 3.4/3.8/3.9） ----
  // 「ルーティーンであること」はページ種別ではなく先頭のトリガーノードから導出する。
  // トリガーを回すと、その group ページで createFromTrigger によりランが1本生成される。

  const FireSchema = z.object({
    via: z.string().min(1).optional(),
    /** ランの名前（作品名など）。同じルーティーンを並列で回すとき（並行ラン）に
     *  どのランか区別するためのラベル。省略時は「MM/DD HH:mm のラン」 */
    title: z.string().min(1).optional(),
    /** ランのコンテキストの初期値（3.15）。手動▶のラン作成フォーム・MCP trigger_run・
     *  外部システムの curl が同じ口で渡す。省略 = 空（値なしでもラン作成は止めない） */
    context: z.record(z.string(), z.string()).optional(),
  });

  /** トリガーノードからランを1本作り、その group ページへ置く。トリガーのスレッドへ
   *  「ラン: <run.title>」を payload {runId} 付きで記録する */
  app.post("/api/nodes/:id/run", async (c) => {
    const id = c.req.param("id");
    const trigger = graph.get(id);
    const body = await c.req.json().catch(() => ({}));
    const { via, title, context } = FireSchema.parse(body);
    const m = meta(body);
    if (trigger.kind !== "trigger") {
      throw new GraphError(`node ${trigger.id} is not a trigger (kind=${trigger.kind})`, 400);
    }
    const pageId = trigger.group;
    if (!pageId) {
      throw new GraphError(`trigger node ${trigger.id} has no group (page) to create a run in`, 400);
    }
    const members = graph.state().nodes.filter((n) => n.group === pageId);
    const run = runs.createFromTrigger(pageId, trigger.id, members, {
      title: title ?? defaultRunTitle(),
      via: via ?? "manual",
      // ページ自身もラン作成時点のスナップショットに含める（当時のページ名まで残す。2026-08-08）
      pageNode: graph.has(pageId) ? graph.get(pageId) : null,
      // ランのコンテキストの初期値（3.15）。以降の書き足しは POST /api/runs/:id/context
      context,
    });
    threads.post(trigger.id, {
      kind: "status",
      body: `ラン: ${run.title}`,
      payload: { runId: run.id },
      runId: run.id, // このランのスレッドへ（テンプレートの会話には混ぜない。2026-08-08）
      author: m.actor,
      via: m.via,
    });
    return c.json(run);
  });

  // ---- ラン（実行インスタンス。docs/design.md 3.8） ----

  /** 一覧レスポンスからラン作成時のスナップショット（run.snapshot）を落とす。一覧の用途
   *  （進捗の点・台帳の表）には要らないうえ、ページ構成まるごと入っていて重い——
   *  左レールは全ページぶんを5秒ごとに引くので、載せると毎回その全部が流れる（2026-08-08）。
   *  当時の中身が要るときは GET /api/runs/:id/graph が返す */
  function withoutSnapshot(r: Run): Omit<Run, "snapshot"> {
    const { snapshot: _snapshot, ...rest } = r;
    return rest;
  }

  /** 全ページのラン一覧をまとめて返す（ページ id → ラン配列。各配列は新しい順）。
   *  左レールのラン子行がこれ1本で済むようにする（旧: ページ数ぶんのリクエスト）。
   *  ルート順の都合で /api/runs/:id より前に置く（:id に "summary" を食わせない） */
  app.get("/api/runs/summary", (c) => {
    const byPage = runs.listByPage();
    return c.json({
      runs: Object.fromEntries(
        Object.entries(byPage).map(([pageId, list]) => [pageId, list.map(withoutSnapshot)]),
      ),
    });
  });

  /** ページ(:id)に属するラン一覧（どのページ種別でも同じ形で返る） */
  app.get("/api/pages/:id/runs", (c) => {
    const id = c.req.param("id");
    graph.get(id);
    return c.json({ runs: runs.list(id).map(withoutSnapshot) });
  });

  /** 配線チェック（ランのコンテキストの静的検査。docs/design.md 3.15。実装は core の
   *  checkWiring）。ページの script ノードの {name} 参照と outputs 宣言を照合し、
   *  参照矢印（破線描画用）と警告バッジ（missing / not-ancestor / branch-dependent /
   *  duplicate）を返す。警告のみでラン作成は止めない */
  app.get("/api/pages/:id/wiring", (c) => {
    const id = c.req.param("id");
    graph.get(id); // 404: ページが存在しない
    return c.json(checkWiring(graph.state().nodes, id));
  });

  app.get("/api/runs/:id", (c) => {
    return c.json(runs.get(c.req.param("id")));
  });

  const PatchRunItemSchema = z.object({
    status: RunItemStatusSchema.optional(),
    note: z.string().nullable().optional(),
    /** script 実行時に実際に解決された {name: 値}（3.15）。エンジンが実行直前に焼く。
     *  ランページの引数欄が値入り（読み取り専用）表示に使い、現在の run.context と
     *  ずれていたら「古い値で実行済み」を出す */
    resolvedParams: z.record(z.string(), z.string()).nullable().optional(),
  });

  /** ワークアイテム更新。テンプレートノードのスレッドへ状態遷移を記録し、
   *  ラン全体が done に転じたらページノードのスレッドにも記録する */
  app.post("/api/runs/:id/items/:nodeId", async (c) => {
    const runId = c.req.param("id");
    const nodeId = c.req.param("nodeId");
    const before = runs.get(runId);
    const beforeItem = before.items[nodeId];
    if (!beforeItem) {
      throw new GraphError(`run ${runId} has no work item for node ${nodeId}`, 404);
    }
    const body = await c.req.json();
    const input = PatchRunItemSchema.parse(body);
    const run = runs.patchItem(runId, nodeId, {
      status: input.status,
      note: input.note,
      resolvedParams: input.resolvedParams,
    });
    const m = meta(body);
    const node = resolveItemNode(graph, before, nodeId);
    const fromStatus = beforeItem.status;
    const toStatus = run.items[nodeId].status;
    threads.post(nodeId, {
      kind: "status",
      body: `${node.title}: ${fromStatus} → ${toStatus}`,
      payload: { runId },
      runId,
      author: m.actor,
      via: m.via,
    });
    if (before.status !== "done" && run.status === "done") {
      threads.post(run.pageId, {
        kind: "status",
        body: `ラン完了: ${run.title}`,
        payload: { runId },
        runId,
        author: { kind: "system" },
        via: m.via,
      });
    }
    // Discord 通知（あなたの番の発生源②: ワークアイテムが waiting へ遷移した瞬間。
    // エンジンが人間タスクの順番到達で waiting を付ける経路もここを通る）。
    // 担当者ありならその人の個人設定を尊重（2026-08-07 ユーザー別設定）。
    // ラン名は target.runTitle として渡す（簡略フォーマット化 2026-08-08 本人指示）
    if (
      fromStatus !== "waiting" &&
      toStatus === "waiting" &&
      (!node.assignee || userSettings.get(node.assignee).discordTurnNotify)
    ) {
      notifyTurn(settings.get().notify, loadUsers(usersFile), {
        assignee: node.assignee,
        target: notifyTargetOf(graph, node, run),
      });
    }
    return c.json(run);
  });

  const DecideRunItemSchema = z.object({ choice: z.string().min(1) });

  /** ラン内の分岐アイテム(kind=decision)の choice を確定する（docs/design.md 3.9のラン内版）。
   *  templates はページの全メンバー（RunStore.applyItemDecision が parentOptions/branches の
   *  定義を引くのに必要。ラン作成時と同じ group=ページ フィルタ）。テンプレートが削除済みの
   *  分は run.snapshot から補う（ランは作成時点のスナップショットで動く。docs/design.md 5.5） */
  app.post("/api/runs/:id/items/:nodeId/decide", async (c) => {
    const runId = c.req.param("id");
    const nodeId = c.req.param("nodeId");
    const run = runs.get(runId);
    const node = resolveItemNode(graph, run, nodeId);
    const body = await c.req.json();
    const { choice } = DecideRunItemSchema.parse(body);
    const m = meta(body);
    const current = graph.state().nodes.filter((n) => n.group === run.pageId);
    const currentIds = new Set(current.map((n) => n.id));
    const fromSnapshot = (run.snapshot?.nodes ?? [])
      .filter((n) => n.group === run.pageId && !currentIds.has(n.id))
      .map((n) => snapshotTemplate(n, run.snapshot?.capturedAt ?? run.created));
    const templates = [...current, ...fromSnapshot];
    const updated = runs.applyItemDecision(runId, nodeId, choice, templates);
    const label = node.branches?.find((b) => b.id === choice)?.label ?? choice;
    threads.post(nodeId, {
      kind: "status",
      body: `分岐: ${label} を選択`,
      payload: { runId, choice },
      runId,
      author: m.actor,
      via: m.via,
    });
    if (run.status !== "done" && updated.status === "done") {
      threads.post(run.pageId, {
        kind: "status",
        body: `ラン完了: ${run.title}`,
        payload: { runId },
        runId,
        author: { kind: "system" },
        via: m.via,
      });
    }
    return c.json(updated);
  });

  const RenameRunSchema = z.object({ title: z.string().min(1) });

  /** ラン名の変更（並列ラン=ランの区別用ラベル） */
  app.post("/api/runs/:id/rename", async (c) => {
    const { title } = RenameRunSchema.parse(await c.req.json());
    return c.json(runs.rename(c.req.param("id"), title));
  });

  app.post("/api/runs/:id/cancel", (c) => {
    return c.json(runs.cancel(c.req.param("id")));
  });

  // ---- ランのコンテキスト（3.15 の書き。エンジンの ##gw マーカー抽出・人間の完了フォーム・
  //      MCP・外部システムが全員この口から merge する） ----

  const PatchRunContextSchema = z.object({
    /** merge する {キー: 値}（last-write-wins） */
    set: z.record(z.string(), z.string()),
    /** どのノードの実行がこの更新を書いたか（監査記録の宛先）。省略時は run.trigger から
     *  トリガーノードを割り出してそちらへ積む */
    nodeId: z.string().optional(),
  });

  /** ランのコンテキストへ値を merge し、更新後の Run を返す。run ファイル自身は現在値だけを
   *  持つので、「誰がいつ何を書いたか」の監査はノードスレッドへの status メッセージで残す
   *  （nodeId がワークアイテムのノードならラントレース GET /api/runs/:id/trace にも
   *  同じ経路で乗る。トリガーノード宛はトレース対象外＝ラン作成の記録と同じ扱い） */
  app.post("/api/runs/:id/context", async (c) => {
    const runId = c.req.param("id");
    const body = await c.req.json();
    const { set, nodeId } = PatchRunContextSchema.parse(body);
    const m = meta(body);
    const run = runs.patchContext(runId, set); // run が無ければ 404、空キーは 400
    // 監査の宛先: 書き手のノード（nodeId）が指定されていればそのスレッド、無ければ
    // run.trigger（"trigger:<id>:<via>" 形式）からトリガーノードのスレッドへ。
    // ノードが後から消されていてもスレッドファイルには追記できる（ランの記録は
    // テンプレート削除後も読める既存規則に合わせる）
    const targetId = nodeId ?? /^trigger:([^:]+):/.exec(run.trigger)?.[1] ?? null;
    if (targetId && Object.keys(set).length > 0) {
      const summary = Object.entries(set)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      threads.post(targetId, {
        kind: "status",
        body: `コンテキスト更新: ${summary}`,
        payload: { runId, set },
        runId,
        author: m.actor,
        via: m.via,
      });
    }
    return c.json(run);
  });

  /**
   * そのランの時点のノード（2026-08-08 本人要望「その時のノードの状態を見れるように」）。
   *
   * テンプレートは共有なので、後から書き換えると過去のランを開いても今の文面しか出ない。
   * 出どころを3段で解決し、ノードごとにどれを使ったかを source に載せて返す:
   *   snapshot = ラン作成時にランへ焼いた中身（この機能以降のランで最も確か）
   *   replay   = 操作ログをラン作成時刻まで再生して復元した中身
   *   current  = どちらも無く、現在の中身で代用（当時と違う可能性がある）
   * replay のうち「作られた記録がログに無く、辻褄合わせで後から足された」ノードも
   * 当時の中身は分からないので current と同じ扱い（正直に出す）にする。
   */
  app.get("/api/runs/:id/graph", (c) => {
    const runId = c.req.param("id");
    const run = runs.get(runId);
    const at = run.snapshot?.capturedAt ?? run.created;
    const snapshots = new Map((run.snapshot?.nodes ?? []).map((n) => [n.id, n]));
    const replayed = graph.nodesAt(at);
    const replayedById = new Map(replayed.nodes.map((n) => [n.id, n]));
    // 出す対象: 当時のページ構成（スナップショット）∪ 再生結果のうち同じページのもの
    // ∪ ワークアイテムのノード（テンプレートが消えていても行としては見せる）
    const ids = new Set<string>([
      run.pageId,
      ...snapshots.keys(),
      ...Object.keys(run.items),
      ...replayed.nodes.filter((n) => n.group === run.pageId).map((n) => n.id),
    ]);
    const nodes: Array<Record<string, unknown> & { id: string; source: string }> = [];
    for (const id of ids) {
      const snap = snapshots.get(id);
      if (snap) {
        nodes.push({ ...snap, source: "snapshot" });
        continue;
      }
      const old = replayedById.get(id);
      if (old && !replayed.baseline.has(id)) {
        nodes.push({ ...old, source: "replay" });
        continue;
      }
      if (graph.has(id)) {
        nodes.push({ ...graph.get(id), source: "current" });
      } else if (old) {
        // 現在は消えているが、当時の記録（辻褄合わせ由来）はある
        nodes.push({ ...old, source: "current" });
      }
    }
    return c.json({ runId, at, nodes });
  });

  /** トレース再生: ページノード+全ワークアイテムのスレッドから payload.runId が一致する
   *  メッセージを集め、ts 昇順で返す（docs/design.md 3.8「トレース」） */
  app.get("/api/runs/:id/trace", (c) => {
    const runId = c.req.param("id");
    const run = runs.get(runId);
    const nodeIds = [run.pageId, ...Object.keys(run.items)];
    const events: Array<ReturnType<typeof threads.list>[number] & { nodeTitle: string }> = [];
    for (const nodeId of nodeIds) {
      // テンプレートが消えていてもランの記録は辿れる（GET /runs/:id/graph が
      // 削除済みメンバーを行として出すのと揃える）
      const node = resolveItemNode(graph, run, nodeId);
      for (const msg of threads.list(nodeId)) {
        const payload = msg.payload as { runId?: string } | null;
        if (payload && payload.runId === runId) {
          events.push({ ...msg, nodeTitle: node.title });
        }
      }
    }
    events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return c.json({ events });
  });

  return app;
}
