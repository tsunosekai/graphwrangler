// 飛ばす（skipNode）・ここで打ち切る（abortFrom）と、分岐の連鎖skipの範囲限定。
// docs/design.md 3.9b が仕様の正。
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore, GraphError, RunStore } from "../src/index.js";

let dir: string;
let g: GraphStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-skipabort-"));
  g = new GraphStore(dir);
});

function makeDecision(extra: Record<string, unknown> = {}) {
  return g.addNode({
    title: "分岐",
    kind: "decision",
    lifecycle: "committed",
    branches: [
      { id: "a", label: "Aへ" },
      { id: "b", label: "Bへ" },
    ],
    ...extra,
  });
}

describe("skipNode: 飛ばして先へ進む", () => {
  it("skipped になり、下流は frontier に乗る（下流へ伝搬しない）", () => {
    const a = g.addNode({ title: "A", lifecycle: "committed", status: "done" });
    const b = g.addNode({ title: "B", lifecycle: "committed", parents: [a.id] });
    const c = g.addNode({ title: "C", lifecycle: "committed", parents: [b.id] });
    g.skipNode(b.id);
    expect(g.get(b.id).status).toBe("skipped");
    expect(g.get(c.id).status).toBe("pending");
    expect(g.frontier().map((n) => n.id)).toContain(c.id);
  });

  it("frontier でなくても飛ばせる（先に「やらない」と決めるのは計画の操作）", () => {
    const a = g.addNode({ title: "A", lifecycle: "committed" });
    const b = g.addNode({ title: "B", lifecycle: "committed", parents: [a.id] });
    g.skipNode(b.id);
    expect(g.get(b.id).status).toBe("skipped");
  });

  it("open な判断リクエストがあれば閉じる（pendingRequest=null）", () => {
    const a = g.addNode({ title: "A", lifecycle: "committed" });
    g.patchNode(a.id, { pendingRequest: "m-1" });
    g.skipNode(a.id);
    expect(g.get(a.id).pendingRequest).toBeNull();
    expect(g.get(a.id).status).toBe("skipped");
  });

  it("決着済み・進行中・トリガー・分岐は飛ばせない(409)", () => {
    const done = g.addNode({ title: "done", status: "done" });
    const running = g.addNode({ title: "running", status: "running" });
    const trig = g.addNode({ title: "t", kind: "trigger" });
    expect(() => g.skipNode(done.id)).toThrow(GraphError);
    expect(() => g.skipNode(running.id)).toThrow(/進行中/);
    expect(() => g.skipNode(trig.id)).toThrow(/トリガー/);
    expect(() => g.skipNode(makeDecision().id)).toThrow(/分岐/);
  });

  it("手動スキップは undo で戻る（patch 1手）", () => {
    const a = g.addNode({ title: "A", lifecycle: "committed" });
    g.skipNode(a.id);
    g.undoLast();
    expect(g.get(a.id).status).toBe("pending");
  });
});

describe("連鎖skipの範囲限定: 手動スキップの下流を分岐の決着が巻き込まない", () => {
  it("A→B→C で B を飛ばしたあと、無関係な分岐を決めても C は pending のまま", () => {
    const a = g.addNode({ title: "A", lifecycle: "committed", status: "done" });
    const b = g.addNode({ title: "B", lifecycle: "committed", parents: [a.id] });
    const c = g.addNode({ title: "C", lifecycle: "committed", parents: [b.id] });
    g.skipNode(b.id);
    const d = makeDecision();
    g.addNode({ title: "a枝", lifecycle: "committed", parents: [d.id], parentOptions: { [d.id]: "a" } });
    const b1 = g.addNode({
      title: "b枝",
      lifecycle: "committed",
      parents: [d.id],
      parentOptions: { [d.id]: "b" },
    });
    const b2 = g.addNode({ title: "b枝の後続", lifecycle: "committed", parents: [b1.id] });
    g.applyDecision(d.id, "a");
    expect(g.get(b1.id).status).toBe("skipped"); // 負けた枝は従来どおり
    expect(g.get(b2.id).status).toBe("skipped"); // 負けた枝からの連鎖も従来どおり
    expect(g.get(c.id).status).toBe("pending"); // 手動スキップの下流は巻き込まれない
  });

  it("負けた枝の子孫と手動スキップの子孫が合流するノードは、負けた枝由来として連鎖する", () => {
    const x = g.addNode({ title: "X", lifecycle: "committed" });
    g.skipNode(x.id);
    const d = makeDecision();
    const b1 = g.addNode({
      title: "b枝",
      lifecycle: "committed",
      parents: [d.id],
      parentOptions: { [d.id]: "b" },
    });
    const join = g.addNode({ title: "合流", lifecycle: "committed", parents: [x.id, b1.id] });
    g.applyDecision(d.id, "a");
    // 全親 skipped かつ親の1つ（b1）が決着由来 → 連鎖の対象
    expect(g.get(join.id).status).toBe("skipped");
  });
});

describe("abortFrom: ここで打ち切る", () => {
  function setupProject() {
    const page = g.addNode({ title: "プロジェクト", kind: "goal" });
    const a = g.addNode({ title: "A", group: page.id, lifecycle: "committed", status: "done" });
    const b = g.addNode({ title: "B", group: page.id, lifecycle: "committed", parents: [a.id] });
    const c = g.addNode({ title: "C", group: page.id, lifecycle: "committed", parents: [b.id] });
    const c2 = g.addNode({
      title: "C2(済)",
      group: page.id,
      lifecycle: "committed",
      parents: [b.id],
      status: "done",
    });
    const side = g.addNode({ title: "無関係", group: page.id, lifecycle: "committed" });
    return { page, a, b, c, c2, side };
  }

  it("起点は dropped、下流の未決着は skipped、done は触らず、ページは dropped", () => {
    const { page, a, b, c, c2, side } = setupProject();
    const res = g.abortFrom(b.id);
    expect(g.get(b.id).status).toBe("dropped");
    expect(g.get(c.id).status).toBe("skipped");
    expect(g.get(c2.id).status).toBe("done");
    expect(g.get(a.id).status).toBe("done");
    expect(g.get(side.id).status).toBe("pending"); // 子孫でないものは触らない（ページが閉じるだけ）
    expect(g.get(page.id).status).toBe("dropped");
    expect(res.skipped).toEqual([c.id]);
    expect(res.page?.id).toBe(page.id);
  });

  it("起点が done なら done のまま（ここまでやって打ち切る）", () => {
    const { page, a, b } = setupProject();
    g.abortFrom(a.id);
    expect(g.get(a.id).status).toBe("done");
    expect(g.get(b.id).status).toBe("skipped");
    expect(g.get(page.id).status).toBe("dropped");
  });

  it("open な判断リクエストは起点・下流とも閉じる", () => {
    const { b, c } = setupProject();
    g.patchNode(b.id, { pendingRequest: "m-1" });
    g.patchNode(c.id, { pendingRequest: "m-2" });
    g.abortFrom(b.id);
    expect(g.get(b.id).pendingRequest).toBeNull();
    expect(g.get(c.id).pendingRequest).toBeNull();
  });

  it("dropped/skipped 済みの起点・トリガーは打ち切れない(409)", () => {
    const { b } = setupProject();
    g.patchNode(b.id, { status: "dropped" });
    expect(() => g.abortFrom(b.id)).toThrow(GraphError);
    const trig = g.addNode({ title: "t", kind: "trigger" });
    expect(() => g.abortFrom(trig.id)).toThrow(/トリガー/);
  });

  it("group の無いノードは自分と子孫だけ閉じる（page=null）", () => {
    const a = g.addNode({ title: "A", lifecycle: "committed" });
    const b = g.addNode({ title: "B", lifecycle: "committed", parents: [a.id] });
    const res = g.abortFrom(a.id);
    expect(res.page).toBeNull();
    expect(g.get(a.id).status).toBe("dropped");
    expect(g.get(b.id).status).toBe("skipped");
  });

  it("undo は1手ずつ戻る（起点→下流→ページの順に積まれる）", () => {
    const { page, b, c } = setupProject();
    g.abortFrom(b.id);
    g.undoLast(); // ページ
    expect(g.get(page.id).status).toBe("pending");
    g.undoLast(); // c
    expect(g.get(c.id).status).toBe("pending");
    g.undoLast(); // b
    expect(g.get(b.id).status).toBe("pending");
  });
});

describe("RunStore.abortFrom / cancel（ラン版の打ち切り）", () => {
  function setupRoutine() {
    const page = g.addNode({ title: "ルーティーン", kind: "goal" });
    const trigger = g.addNode({ title: "起点", kind: "trigger", group: page.id });
    const a = g.addNode({ title: "A", group: page.id, lifecycle: "committed", parents: [trigger.id] });
    const b = g.addNode({ title: "B", group: page.id, lifecycle: "committed", parents: [a.id] });
    const c = g.addNode({ title: "C", group: page.id, lifecycle: "committed", parents: [b.id] });
    const side = g.addNode({
      title: "並行",
      group: page.id,
      lifecycle: "committed",
      parents: [trigger.id],
    });
    const members = g.state().nodes.filter((n) => n.group === page.id);
    return { page, trigger, a, b, c, side, members };
  }

  it("abortFrom: 起点 dropped・下流 skipped・並行はそのまま・ラン cancelled。テンプレートは不変", () => {
    const runs = new RunStore(dir);
    const { page, trigger, a, b, c, side, members } = setupRoutine();
    const run = runs.createFromTrigger(page.id, trigger.id, members);
    runs.patchItem(run.id, a.id, { status: "done" });
    const { run: updated, skipped } = runs.abortFrom(run.id, b.id, members);
    expect(updated.status).toBe("cancelled");
    expect(updated.items[a.id].status).toBe("done");
    expect(updated.items[b.id].status).toBe("dropped");
    expect(updated.items[c.id].status).toBe("skipped");
    expect(updated.items[side.id].status).toBe("pending"); // 子孫でないものは触らない
    expect(skipped).toEqual([c.id]);
    // テンプレート（ページ側）は変わらない＝次のランは普通に作られる
    expect(g.get(b.id).status).toBe("pending");
    expect(g.get(page.id).status).toBe("pending");
  });

  it("abortFrom: 起点が done なら done のまま。cancelled 済みのランは 409", () => {
    const runs = new RunStore(dir);
    const { page, trigger, a, b, members } = setupRoutine();
    const run = runs.createFromTrigger(page.id, trigger.id, members);
    runs.patchItem(run.id, a.id, { status: "done" });
    const { run: updated } = runs.abortFrom(run.id, a.id, members);
    expect(updated.items[a.id].status).toBe("done");
    expect(updated.items[b.id].status).toBe("skipped");
    expect(() => runs.abortFrom(run.id, b.id, members)).toThrow(GraphError);
  });

  it("cancel: 未決着（pending/waiting/running）は全部 skipped、done/dropped は触らない", () => {
    const runs = new RunStore(dir);
    const { page, trigger, a, b, c, side, members } = setupRoutine();
    const run = runs.createFromTrigger(page.id, trigger.id, members);
    runs.patchItem(run.id, a.id, { status: "done" });
    runs.patchItem(run.id, b.id, { status: "running" });
    runs.patchItem(run.id, c.id, { status: "waiting" });
    runs.patchItem(run.id, side.id, { status: "dropped" });
    const { run: updated, skipped } = runs.cancel(run.id);
    expect(updated.status).toBe("cancelled");
    expect(updated.items[a.id].status).toBe("done");
    expect(updated.items[b.id].status).toBe("skipped");
    expect(updated.items[c.id].status).toBe("skipped");
    expect(updated.items[side.id].status).toBe("dropped");
    expect(skipped.sort()).toEqual([b.id, c.id].sort());
  });

  it("ラン内の分岐決着も、「このランでは飛ばす」の下流を巻き込まない", () => {
    const runs = new RunStore(dir);
    const page = g.addNode({ title: "R", kind: "goal" });
    const trigger = g.addNode({ title: "起点", kind: "trigger", group: page.id });
    const x = g.addNode({ title: "X", group: page.id, lifecycle: "committed", parents: [trigger.id] });
    const y = g.addNode({ title: "Y", group: page.id, lifecycle: "committed", parents: [x.id] });
    const d = g.addNode({
      title: "分岐",
      kind: "decision",
      group: page.id,
      lifecycle: "committed",
      parents: [trigger.id],
      branches: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
    const b1 = g.addNode({
      title: "b枝",
      group: page.id,
      lifecycle: "committed",
      parents: [d.id],
      parentOptions: { [d.id]: "b" },
    });
    const members = g.state().nodes.filter((n) => n.group === page.id);
    const run = runs.createFromTrigger(page.id, trigger.id, members);
    runs.patchItem(run.id, x.id, { status: "skipped" }); // このランでは飛ばす
    const updated = runs.applyItemDecision(run.id, d.id, "a", members);
    expect(updated.items[b1.id].status).toBe("skipped");
    expect(updated.items[y.id].status).toBe("pending"); // 巻き込まれない
  });
});
