// 展開（「ノード内ノード」→ 実ノード連鎖）のテスト。docs/design.md 3.12 参照。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore, GraphError, ThreadStore, type SubStep } from "@graphwrangler/core";
import { expandNode } from "../src/expand.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-expand-"));
}

const META = { actor: { kind: "human" as const }, via: "ui" };

const SUB_STEPS: SubStep[] = [
  {
    id: "tu_1",
    index: 0,
    tool: "Bash",
    title: "依存関係をインストール",
    command: "npm install",
    input: null,
    output: "added 3 packages",
    status: "ok",
  },
  {
    id: "tu_2",
    index: 1,
    tool: "Read",
    title: "設定ファイルを読む",
    command: null,
    input: '{"path":"config.json"}',
    output: "{...}",
    status: "ok",
  },
  {
    id: "tu_3",
    index: 2,
    tool: "Edit",
    title: "設定を書き換える",
    command: null,
    input: '{"path":"config.json","old":"a","new":"b"}',
    output: null,
    status: "ok",
  },
];

// ---- 幸せパス ----

test("展開: 3件のsubStepsから連鎖ノードを作り、元ノードを置き換える", () => {
  const dir = tmpDir();
  const g = new GraphStore(dir);
  const t = new ThreadStore(dir);

  const page = g.addNode({ title: "ページ", kind: "goal" });
  const grandparent = g.addNode({ title: "前段" });
  const original = g.addNode({
    title: "AIタスク",
    kind: "task",
    executor: "ai",
    group: page.id,
    parents: [grandparent.id],
  });
  const child = g.addNode({ title: "後段", parents: [original.id] });

  const msg = t.post(original.id, {
    kind: "status",
    body: "実行成功",
    payload: { subSteps: SUB_STEPS },
    author: { kind: "system" },
    via: "engine",
  });

  const result = expandNode(g, t, original.id, msg.id, META);

  assert.equal(result.created.length, 3);
  const [n1, n2, n3] = result.created.map((id) => g.get(id));

  // 1件目: Bash+command → script executor・impl.script、親は元ノードの parents を継承
  assert.equal(n1.executor, "script");
  assert.deepEqual(n1.impl, { type: "script", command: "npm install" });
  assert.deepEqual(n1.parents, [grandparent.id]);
  assert.equal(n1.group, page.id);
  assert.equal(n1.kind, "task");
  assert.equal(n1.lifecycle, "draft");
  assert.match(n1.detail ?? "", /ツール: Bash/);

  // 2・3件目: Bash以外 → ai executor・impl null、直列に連鎖
  assert.equal(n2.executor, "ai");
  assert.equal(n2.impl, null);
  assert.deepEqual(n2.parents, [n1.id]);
  assert.match(n2.detail ?? "", /ツール: Read/);
  assert.match(n2.detail ?? "", /入力/);

  assert.equal(n3.executor, "ai");
  assert.deepEqual(n3.parents, [n2.id]);

  // 子の付け替え: 元ノードへの参照が連鎖の最後のノードへ変わる
  const updatedChild = g.get(child.id);
  assert.deepEqual(updatedChild.parents, [n3.id]);

  // 元ノードは消えている
  assert.throws(() => g.get(original.id), GraphError);
});

// ---- undo可能性: 逆操作を1つずつ辿ると元の状態に戻る ----

test("展開: undoLast を必要回数呼ぶと元のノードが復活し、作られたノードは消える", () => {
  const dir = tmpDir();
  const g = new GraphStore(dir);
  const t = new ThreadStore(dir);

  const original = g.addNode({ title: "AIタスク", kind: "task", executor: "ai" });
  const child = g.addNode({ title: "後段", parents: [original.id] });
  const msg = t.post(original.id, {
    kind: "status",
    body: "実行成功",
    payload: { subSteps: SUB_STEPS },
  });

  const result = expandNode(g, t, original.id, msg.id, META);
  // op数 = addNode(3) + patchNode(子の付け替え1) + removeNode(1) = 5
  const opsToUndo = result.created.length + 1 + 1;
  for (let i = 0; i < opsToUndo; i++) {
    const undone = g.undoLast(META);
    assert.ok(undone, `undoLast #${i + 1} は何かを打ち消すはず`);
  }

  assert.equal(g.get(original.id).title, "AIタスク");
  assert.deepEqual(g.get(child.id).parents, [original.id]);
  for (const id of result.created) {
    assert.throws(() => g.get(id), GraphError);
  }
});

// ---- 404 ----

test("展開: ノードが存在しなければ404", () => {
  const dir = tmpDir();
  const g = new GraphStore(dir);
  const t = new ThreadStore(dir);
  assert.throws(
    () => expandNode(g, t, "n-99999999-0001", "m-1", META),
    (err: unknown) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.status, 404);
      return true;
    },
  );
});

test("展開: メッセージが見つからなければ404", () => {
  const dir = tmpDir();
  const g = new GraphStore(dir);
  const t = new ThreadStore(dir);
  const original = g.addNode({ title: "AIタスク", kind: "task" });
  assert.throws(
    () => expandNode(g, t, original.id, "m-nope", META),
    (err: unknown) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.status, 404);
      return true;
    },
  );
});

// ---- 409ガード ----

test("展開: subStepsが空なら409", () => {
  const dir = tmpDir();
  const g = new GraphStore(dir);
  const t = new ThreadStore(dir);
  const original = g.addNode({ title: "AIタスク", kind: "task" });
  const msg = t.post(original.id, { kind: "status", body: "実行成功", payload: { subSteps: [] } });
  assert.throws(
    () => expandNode(g, t, original.id, msg.id, META),
    (err: unknown) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.status, 409);
      assert.match((err as GraphError).message, /内訳がありません/);
      return true;
    },
  );
});

test("展開: kind!==taskなら409", () => {
  const dir = tmpDir();
  const g = new GraphStore(dir);
  const t = new ThreadStore(dir);
  const original = g.addNode({ title: "ページ", kind: "goal" });
  const msg = t.post(original.id, {
    kind: "status",
    body: "実行成功",
    payload: { subSteps: SUB_STEPS },
  });
  assert.throws(
    () => expandNode(g, t, original.id, msg.id, META),
    (err: unknown) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.status, 409);
      return true;
    },
  );
});

test("展開: fixedなノードは409", () => {
  const dir = tmpDir();
  const g = new GraphStore(dir);
  const t = new ThreadStore(dir);
  const original = g.addNode({ title: "AIタスク", kind: "task" });
  g.patchNode(original.id, { fixed: true });
  const msg = t.post(original.id, {
    kind: "status",
    body: "実行成功",
    payload: { subSteps: SUB_STEPS },
  });
  assert.throws(
    () => expandNode(g, t, original.id, msg.id, META),
    (err: unknown) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.status, 409);
      return true;
    },
  );
});

test("展開: ページ化している（メンバーを持つ）ノードは409", () => {
  const dir = tmpDir();
  const g = new GraphStore(dir);
  const t = new ThreadStore(dir);
  const original = g.addNode({ title: "AIタスク", kind: "task" });
  g.addNode({ title: "メンバー", group: original.id });
  const msg = t.post(original.id, {
    kind: "status",
    body: "実行成功",
    payload: { subSteps: SUB_STEPS },
  });
  assert.throws(
    () => expandNode(g, t, original.id, msg.id, META),
    (err: unknown) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.status, 409);
      assert.match((err as GraphError).message, /ページ化/);
      return true;
    },
  );
});

test("展開: 分岐の配線対象（parentOptions非空）は409", () => {
  const dir = tmpDir();
  const g = new GraphStore(dir);
  const t = new ThreadStore(dir);
  const decision = g.addNode({
    title: "分岐",
    kind: "decision",
    branches: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  });
  const original = g.addNode({
    title: "AIタスク",
    kind: "task",
    parents: [decision.id],
    parentOptions: { [decision.id]: "a" },
  });
  const msg = t.post(original.id, {
    kind: "status",
    body: "実行成功",
    payload: { subSteps: SUB_STEPS },
  });
  assert.throws(
    () => expandNode(g, t, original.id, msg.id, META),
    (err: unknown) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.status, 409);
      assert.match((err as GraphError).message, /分岐の配線対象/);
      return true;
    },
  );
});

// ---- ラン記録からの展開も許可される ----

test("展開: runId付き（ランの記録）のメッセージからも展開できる", () => {
  const dir = tmpDir();
  const g = new GraphStore(dir);
  const t = new ThreadStore(dir);
  const original = g.addNode({ title: "AIタスク", kind: "task" });
  const msg = t.post(original.id, {
    kind: "status",
    body: "実行成功",
    payload: { subSteps: SUB_STEPS },
    runId: "r-1",
  });
  const result = expandNode(g, t, original.id, msg.id, META);
  assert.equal(result.created.length, 3);
});
