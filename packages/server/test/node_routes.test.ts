// ノード層のルート（src/routes/nodes.ts）のうち、ノード1件取得（GET /api/nodes/:id）のテスト。
// MCP の node_get はグラフ全体（GET /api/state）を取って1件を探す代わりにこのルートを叩くので、
// 「見つかる / 存在しないidは404」に加えて **GET /api/state の nodes 要素と同じ形で返る**ことを
// ここで縛る（形がずれると MCP の返り値が黙って変わる）。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { GraphError, GraphStore, RunStore, ThreadStore, type Node } from "@graphwrangler/core";
import { ReadsStore } from "../src/reads.js";
import { SettingsStore } from "../src/settings.js";
import { UserSettingsStore } from "../src/user_settings.js";
import { graphRoutes } from "../src/routes/graph.js";
import { nodeRoutes } from "../src/routes/nodes.js";
import type { AppContext } from "../src/app_context.js";

interface Harness {
  graph: GraphStore;
  app: Hono;
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-node-routes-"));
  const graph = new GraphStore(dir);
  // ここで叩くルートが実際に読むのは graph/threads/reads だけ。
  // 残りは AppContext の形を満たすためのダミー（selfUpdate は触られない）
  const ctx = {
    graph,
    threads: new ThreadStore(dir),
    runs: new RunStore(dir),
    settings: new SettingsStore(dir),
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
  app.route("/", graphRoutes(ctx));
  app.route("/", nodeRoutes(ctx));
  return { graph, app };
}

test("ノード1件取得: 見つかると全フィールドが返る", async () => {
  const { graph, app } = harness();
  const created = graph.addNode({
    title: "取得されるノード",
    detail: "詳細",
    impl: { type: "doc", text: "手順の本文" },
  });

  const res = await app.request(`/api/nodes/${created.id}`);
  assert.equal(res.status, 200);
  const node = (await res.json()) as Node;
  assert.equal(node.id, created.id);
  assert.equal(node.title, "取得されるノード");
  // 一覧の要約（MCP の state_get）では落ちるフィールドまで載ること
  assert.equal(node.detail, "詳細");
  assert.deepEqual(node.impl, { type: "doc", text: "手順の本文" });
});

test("ノード1件取得: 存在しないidは404", async () => {
  const { app } = harness();
  const res = await app.request("/api/nodes/n-nope-0001");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "node not found: n-nope-0001" });
});

test("ノード1件取得: GET /api/state の nodes 要素と同じ形で返る", async () => {
  const { graph, app } = harness();
  const page = graph.addNode({ title: "ページ", kind: "goal" });
  const target = graph.addNode({
    title: "対象",
    group: page.id,
    parents: [],
    executor: "ai",
    approval: true,
    impl: { type: "script", command: "echo hi" },
  });

  const state = (await (await app.request("/api/state")).json()) as { nodes: Node[] };
  const fromState = state.nodes.find((n) => n.id === target.id);
  const fromRoute = (await (await app.request(`/api/nodes/${target.id}`)).json()) as Node;
  assert.deepEqual(fromRoute, fromState);
});
