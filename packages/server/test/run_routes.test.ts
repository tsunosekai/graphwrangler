// ラン層のルート（src/routes/runs.ts）のテスト。
// 主眼は「テンプレートノードを削除したあともランが進む」こと——ランは作成時点の
// スナップショットで動く（docs/design.md 5.5）ので、テンプレートの現存を前提にして
// 404 で止めてはいけない。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { GraphError, GraphStore, RunStore, ThreadStore, type Node, type Run } from "@graphwrangler/core";
import { ReadsStore } from "../src/reads.js";
import { SettingsStore } from "../src/settings.js";
import { UserSettingsStore } from "../src/user_settings.js";
import { runRoutes, resolveItemNode } from "../src/routes/runs.js";
import { clearDuplicateGuard } from "../src/discord.js";
import type { AppContext } from "../src/app_context.js";

interface Harness {
  graph: GraphStore;
  threads: ThreadStore;
  runs: RunStore;
  settings: SettingsStore;
  app: Hono;
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-run-routes-"));
  const graph = new GraphStore(dir);
  const threads = new ThreadStore(dir);
  const runs = new RunStore(dir);
  // ラン層のルートが実際に読むのは graph/threads/runs/settings/userSettings/usersFile だけ。
  // 残りは AppContext の形を満たすためのダミー（selfUpdate は触られない）
  const settings = new SettingsStore(dir);
  const ctx = {
    graph,
    threads,
    runs,
    settings,
    userSettings: new UserSettingsStore(dir),
    reads: new ReadsStore(path.join(dir, "reads.json")),
    usersFile: path.join(dir, "users.json"),
    sessionSecret: "test-secret",
    chatsDir: path.join(dir, "chats"),
    attachmentsDir: path.join(dir, "attachments"),
    brandingPath: path.join(dir, "branding"),
    gitSync: null,
    selfUpdate: null as unknown as AppContext["selfUpdate"],
    port: 0,
  } satisfies AppContext;
  // index.ts と同じ形で載せる（"/" 前置きの app.route + GraphError を status へ写す onError）。
  // これが無いと GraphError が全部 500 になり、404 との区別が付かない
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof GraphError) return c.json({ error: err.message }, err.status as 400);
    throw err;
  });
  app.route("/", runRoutes(ctx));
  return { graph, threads, runs, settings, app };
}

function postJson(app: Hono, url: string, body: unknown): Promise<Response> {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** ページ + トリガー + 直下メンバー1件（committed）を作る */
function simplePage(graph: GraphStore): { page: Node; trigger: Node; task: Node } {
  const page = graph.addNode({ title: "ページ", kind: "goal" });
  const trigger = graph.addNode({
    title: "起点",
    kind: "trigger",
    group: page.id,
    executor: "script",
    schedule: "every 1m",
  });
  const task = graph.patchNode(
    graph.addNode({ title: "作業", group: page.id, parents: [trigger.id], executor: "human" }).id,
    { lifecycle: "committed" },
  );
  return { page, trigger, task };
}

/** ページ + トリガー + 分岐 + 枝2本（committed）を作る */
function decisionPage(graph: GraphStore): {
  trigger: Node;
  decision: Node;
  childA: Node;
  childB: Node;
} {
  const page = graph.addNode({ title: "分岐ページ", kind: "goal" });
  const trigger = graph.addNode({
    title: "起点",
    kind: "trigger",
    group: page.id,
    executor: "script",
    schedule: "every 1m",
  });
  const decision = graph.patchNode(
    graph.addNode({
      title: "どっち",
      kind: "decision",
      group: page.id,
      parents: [trigger.id],
      branches: [
        { id: "a", label: "Aへ" },
        { id: "b", label: "Bへ" },
      ],
    }).id,
    { lifecycle: "committed" },
  );
  const mk = (title: string, branch: string) =>
    graph.patchNode(
      graph.addNode({
        title,
        group: page.id,
        parents: [decision.id],
        parentOptions: { [decision.id]: branch },
      }).id,
      { lifecycle: "committed" },
    );
  return { trigger, decision, childA: mk("A側", "a"), childB: mk("B側", "b") };
}

async function createRun(app: Hono, triggerId: string): Promise<Run> {
  const res = await postJson(app, `/api/nodes/${triggerId}/run`, {});
  assert.equal(res.status, 200);
  return (await res.json()) as Run;
}

// ---- ワークアイテム更新（POST /api/runs/:id/items/:nodeId） ----

test("ワークアイテム更新: テンプレートノードが削除済みでもランは進む（404 で止めない）", async () => {
  const { graph, app } = harness();
  const { trigger, task } = simplePage(graph);
  const run = await createRun(app, trigger.id);

  graph.removeNode(task.id, {}, { force: true });
  assert.equal(graph.has(task.id), false);

  const res = await postJson(app, `/api/runs/${run.id}/items/${task.id}`, { status: "done" });
  assert.equal(res.status, 200);
  const updated = (await res.json()) as Run;
  assert.equal(updated.items[task.id].status, "done");
  assert.equal(updated.status, "done"); // 全アイテム決着でラン完了
});

test("ワークアイテム更新: 削除済みテンプレートの記録にはスナップショットのタイトルが残る", async () => {
  const { graph, threads, app } = harness();
  const { trigger, task } = simplePage(graph);
  const run = await createRun(app, trigger.id);
  graph.removeNode(task.id, {}, { force: true });

  await postJson(app, `/api/runs/${run.id}/items/${task.id}`, { status: "running" });
  const messages = threads.listScoped(task.id, run.id);
  assert.equal(messages.at(-1)?.body, "作業: pending → running");
});

test("ワークアイテム更新: ランに存在しないノードは従来どおり 404", async () => {
  const { graph, app } = harness();
  const { trigger } = simplePage(graph);
  const run = await createRun(app, trigger.id);

  const res = await postJson(app, `/api/runs/${run.id}/items/n-nope-0001`, { status: "done" });
  assert.equal(res.status, 404);
});

// ---- 分岐確定（POST /api/runs/:id/items/:nodeId/decide） ----

test("分岐確定: 分岐テンプレートが削除済みでもスナップショットから確定できる", async () => {
  const { graph, app } = harness();
  const { trigger, decision, childA } = decisionPage(graph);
  const run = await createRun(app, trigger.id);

  graph.removeNode(decision.id, {}, { force: true });
  assert.equal(graph.has(decision.id), false);

  const res = await postJson(app, `/api/runs/${run.id}/items/${decision.id}/decide`, {
    choice: "a",
  });
  assert.equal(res.status, 200);
  const updated = (await res.json()) as Run;
  assert.equal(updated.items[decision.id].status, "done");
  assert.equal(updated.items[decision.id].choice, "a");
  assert.equal(updated.items[childA.id].status, "pending");
});

test("分岐確定: 削除済みの枝ノードもスナップショットの parentOptions で skipped になる", async () => {
  const { graph, app } = harness();
  const { trigger, decision, childA, childB } = decisionPage(graph);
  const run = await createRun(app, trigger.id);

  // 分岐と B 側の両方を消す（force 削除は生き残る子の parentOptions も切り離すため、
  // 現在のグラフだけでは選ばれなかった枝を判定できない状態にする）
  graph.removeNode(decision.id, {}, { force: true });
  graph.removeNode(childB.id, {}, { force: true });

  const res = await postJson(app, `/api/runs/${run.id}/items/${decision.id}/decide`, {
    choice: "a",
  });
  assert.equal(res.status, 200);
  const updated = (await res.json()) as Run;
  assert.equal(updated.items[childB.id].status, "skipped");
  assert.equal(updated.items[childA.id].status, "pending");
});

test("分岐確定: ランに存在しないノードは従来どおり 404", async () => {
  const { graph, app } = harness();
  const { trigger } = decisionPage(graph);
  const run = await createRun(app, trigger.id);

  const res = await postJson(app, `/api/runs/${run.id}/items/n-nope-0001/decide`, { choice: "a" });
  assert.equal(res.status, 404);
});

test("分岐確定: 存在しない枝idは従来どおりエラー", async () => {
  const { graph, app } = harness();
  const { trigger, decision } = decisionPage(graph);
  const run = await createRun(app, trigger.id);
  graph.removeNode(decision.id, {}, { force: true });

  const res = await postJson(app, `/api/runs/${run.id}/items/${decision.id}/decide`, {
    choice: "zzz",
  });
  assert.notEqual(res.status, 200);
});

// ---- resolveItemNode（テンプレート解決の順序） ----

test("resolveItemNode: 現存するテンプレートを最優先で返す", () => {
  const { graph, runs } = harness();
  const { page, trigger, task } = simplePage(graph);
  const run = runs.createFromTrigger(
    page.id,
    trigger.id,
    graph.state().nodes.filter((n) => n.group === page.id),
    { pageNode: page },
  );
  graph.patchNode(task.id, { title: "改題後" });
  assert.equal(resolveItemNode(graph, run, task.id).title, "改題後");
});

test("resolveItemNode: snapshot も無い旧ランでは 404 を投げず中立値で代用する", () => {
  const { graph } = harness();
  const legacyRun = {
    id: "r-legacy",
    pageId: "n-page",
    title: "旧ラン",
    trigger: "trigger:n-t:manual",
    status: "running",
    items: {},
    context: {},
    snapshot: null,
    created: "2026-01-01T00:00:00.000Z",
  } as unknown as Run;
  assert.deepEqual(resolveItemNode(graph, legacyRun, "n-gone"), {
    id: "n-gone",
    title: "（削除済み n-gone）",
    group: null,
    assignee: null,
    branches: null,
    // 通知判定（連続する人間作業の消音）は「形が分からないなら鳴らす」に倒す中立値
    kind: "task",
    executor: "human",
    parents: [],
  });
});

// ---- 「あなたの番」通知（発生源②: ワークアイテムの waiting 遷移）----
// 連続する人間作業をまとめる規則（2026-08-20。設定 notify.quietConsecutiveHumanTurns）が
// ルート越しに効いていることを、Webhook への POST を捕まえて確かめる。
// 判定そのものの仕様は core の turn.test.ts / open_request.test.ts が持つ。

/** ページ + トリガー + 人間タスク2連（t1 → t2）。executor は引数で差し替えられる */
function humanChain(graph: GraphStore, firstExecutor: "human" | "ai" = "human") {
  const page = graph.addNode({ title: "連続ページ", kind: "goal" });
  const trigger = graph.addNode({
    title: "起点",
    kind: "trigger",
    group: page.id,
    executor: "script",
    schedule: "every 1m",
  });
  const t1 = graph.patchNode(
    graph.addNode({ title: "1本目", group: page.id, parents: [trigger.id], executor: firstExecutor })
      .id,
    { lifecycle: "committed" },
  );
  const t2 = graph.patchNode(
    graph.addNode({ title: "2本目", group: page.id, parents: [t1.id], executor: "human" }).id,
    { lifecycle: "committed" },
  );
  return { page, trigger, t1, t2 };
}

/** Webhook への POST 本文を集めながら fn を走らせる（通知は投げっぱなしなので少し待つ） */
async function captureNotifications(fn: () => Promise<void>): Promise<string[]> {
  clearDuplicateGuard();
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body).content);
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = realFetch;
    clearDuplicateGuard();
  }
  return sent;
}

/** Discord 通知を有効にする（Webhook URL と公開URLが揃って初めて鳴る） */
function enableNotify(settings: SettingsStore): void {
  settings.update({
    notify: {
      discordEnabled: true,
      discordWebhookUrl: "https://hook.test/webhook",
      publicUrl: "http://gw.test",
    },
  });
}

test("同じ担当者の人間作業が連続する2本目は鳴らない（1本目だけ通知）", async () => {
  const { graph, runs, settings, app } = harness();
  enableNotify(settings);
  const { page, trigger, t1, t2 } = humanChain(graph);
  const run = runs.createFromTrigger(
    page.id,
    trigger.id,
    graph.state().nodes.filter((n) => n.group === page.id),
    { pageNode: page },
  );
  const sent = await captureNotifications(async () => {
    await postJson(app, `/api/runs/${run.id}/items/${t1.id}`, { status: "waiting" });
    await postJson(app, `/api/runs/${run.id}/items/${t1.id}`, { status: "done" });
    await postJson(app, `/api/runs/${run.id}/items/${t2.id}`, { status: "waiting" });
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("1本目"));
});

test("直前がAIなら2本目も鳴る（機械の仕事の完了は人間にとって新しい知らせ）", async () => {
  const { graph, runs, settings, app } = harness();
  enableNotify(settings);
  const { page, trigger, t1, t2 } = humanChain(graph, "ai");
  const run = runs.createFromTrigger(
    page.id,
    trigger.id,
    graph.state().nodes.filter((n) => n.group === page.id),
    { pageNode: page },
  );
  const sent = await captureNotifications(async () => {
    await postJson(app, `/api/runs/${run.id}/items/${t1.id}`, { status: "done" });
    await postJson(app, `/api/runs/${run.id}/items/${t2.id}`, { status: "waiting" });
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("2本目"));
});

test("設定を切れば連続でも従来どおり2本とも鳴る", async () => {
  const { graph, runs, settings, app } = harness();
  enableNotify(settings);
  settings.update({ notify: { quietConsecutiveHumanTurns: false } });
  const { page, trigger, t1, t2 } = humanChain(graph);
  const run = runs.createFromTrigger(
    page.id,
    trigger.id,
    graph.state().nodes.filter((n) => n.group === page.id),
    { pageNode: page },
  );
  const sent = await captureNotifications(async () => {
    await postJson(app, `/api/runs/${run.id}/items/${t1.id}`, { status: "waiting" });
    await postJson(app, `/api/runs/${run.id}/items/${t1.id}`, { status: "done" });
    await postJson(app, `/api/runs/${run.id}/items/${t2.id}`, { status: "waiting" });
  });
  assert.equal(sent.length, 2);
});
