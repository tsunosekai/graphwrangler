import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore, RunStore, GraphError, type Node } from "../src/index.js";

let dir: string;
let graph: GraphStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-runs-"));
  graph = new GraphStore(dir);
});

/** procedure ノード + メンバー3個（committed/pending・committed/unplanned・draft）を用意 */
function setupProcedure(): { procedureId: string; committedPending: Node; committedUnplanned: Node; draft: Node } {
  const procedure = graph.addNode({ title: "月次経理", kind: "procedure" });
  const committedPending = graph.patchNode(
    graph.addNode({ title: "買い出し", group: procedure.id }).id,
    { lifecycle: "committed" },
  );
  const committedUnplanned = graph.patchNode(
    graph.addNode({ title: "やり方未定の工程", group: procedure.id }).id,
    { lifecycle: "committed", status: "unplanned" },
  );
  const draft = graph.addNode({ title: "まだdraftの工程", group: procedure.id });
  return { procedureId: procedure.id, committedPending, committedUnplanned, draft };
}

describe("RunStore", () => {
  it("create: committed のテンプレートだけが item になり、unplanned は skipped", () => {
    const runs = new RunStore(dir);
    const { procedureId, committedPending, committedUnplanned, draft } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const run = runs.create(procedureId, members);

    expect(run.id).toMatch(/^r-\d{8}-0001$/);
    expect(run.status).toBe("running");
    expect(Object.keys(run.items).sort()).toEqual(
      [committedPending.id, committedUnplanned.id].sort(),
    );
    expect(run.items[committedPending.id].status).toBe("pending");
    expect(run.items[committedUnplanned.id].status).toBe("skipped");
    expect(run.items[draft.id]).toBeUndefined();
  });

  it("create: title/trigger の既定値と明示指定", () => {
    const runs = new RunStore(dir);
    const { procedureId } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const withDefaults = runs.create(procedureId, members);
    expect(withDefaults.trigger).toBe("manual");

    const withOpts = runs.create(procedureId, members, {
      title: "臨時実行",
      trigger: "schedule:daily 09:00",
    });
    expect(withOpts.title).toBe("臨時実行");
    expect(withOpts.trigger).toBe("schedule:daily 09:00");
  });

  it("patchItem: status と note を更新できる", () => {
    const runs = new RunStore(dir);
    const { procedureId, committedPending } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const run = runs.create(procedureId, members);

    const patched = runs.patchItem(run.id, committedPending.id, {
      status: "running",
      note: "着手した",
    });
    expect(patched.items[committedPending.id].status).toBe("running");
    expect(patched.items[committedPending.id].note).toBe("着手した");
    // status を省略すれば既存値を維持
    const notePatched = runs.patchItem(run.id, committedPending.id, { note: "続けている" });
    expect(notePatched.items[committedPending.id].status).toBe("running");
    expect(notePatched.items[committedPending.id].note).toBe("続けている");
  });

  it("patchItem: 全アイテムが done/dropped/skipped になったらランが自動的に done になる", () => {
    const runs = new RunStore(dir);
    const { procedureId, committedPending, committedUnplanned } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const run = runs.create(procedureId, members);

    // unplanned は既に skipped 済み。残り1件を done にすれば全体が done になるはず
    expect(run.items[committedUnplanned.id].status).toBe("skipped");
    const stillRunning = runs.patchItem(run.id, committedPending.id, { status: "running" });
    expect(stillRunning.status).toBe("running");
    const done = runs.patchItem(run.id, committedPending.id, { status: "done" });
    expect(done.status).toBe("done");
  });

  it("patchItem: 存在しないノードの item は404相当のGraphError", () => {
    const runs = new RunStore(dir);
    const { procedureId } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const run = runs.create(procedureId, members);
    expect(() => runs.patchItem(run.id, "n-99999999-0001", { status: "done" })).toThrow(
      GraphError,
    );
  });

  it("cancel: status が cancelled になり、以後の patchItem で done に戻らない", () => {
    const runs = new RunStore(dir);
    const { procedureId, committedPending } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const run = runs.create(procedureId, members);

    const cancelled = runs.cancel(run.id);
    expect(cancelled.status).toBe("cancelled");
    // 全アイテムを done にしても cancelled のまま（done に覆されない）
    const afterPatch = runs.patchItem(run.id, committedPending.id, { status: "done" });
    expect(afterPatch.status).toBe("cancelled");
  });

  it("list: procedure ごとにフィルタし、created 降順で返す", () => {
    const runs = new RunStore(dir);
    const { procedureId } = setupProcedure();
    const otherProcedure = graph.addNode({ title: "別の手順", kind: "procedure" });
    const members = graph.state().nodes.filter((n) => n.group === procedureId);

    const first = runs.create(procedureId, members, { title: "1回目" });
    const second = runs.create(procedureId, members, { title: "2回目" });
    runs.create(otherProcedure.id, [], { title: "別手順のラン" });

    const list = runs.list(procedureId);
    expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(list.every((r) => r.procedure === procedureId)).toBe(true);
  });

  it("永続化ラウンドトリップ: 新しい RunStore インスタンスからも get/list できる", () => {
    const runs1 = new RunStore(dir);
    const { procedureId } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const run = runs1.create(procedureId, members);
    runs1.patchItem(run.id, Object.keys(run.items)[0], { status: "done" });

    const runs2 = new RunStore(dir);
    const reloaded = runs2.get(run.id);
    expect(reloaded).toEqual(runs1.get(run.id));
    expect(runs2.list(procedureId).map((r) => r.id)).toEqual([run.id]);
  });

  it("get: 存在しないランは404相当のGraphError", () => {
    const runs = new RunStore(dir);
    expect(() => runs.get("r-99999999-0001")).toThrow(GraphError);
  });
});

// createFromTrigger（トリガー起点のラン生成。docs/design.md 3.4/3.8 新モデル）。
// 「ルーティーンであること」はページ種別ではなく先頭のトリガーノードから導出する。
function setupTriggerPage(graph: GraphStore) {
  const page = graph.addNode({ title: "ページ", kind: "goal" });
  const trigger = graph.addNode({
    title: "起点",
    kind: "trigger",
    group: page.id,
    executor: "script",
    schedule: "every 1m",
  });
  const childA = graph.patchNode(
    graph.addNode({ title: "A", group: page.id, parents: [trigger.id] }).id,
    { lifecycle: "committed" },
  );
  // 分岐: childA から2つに分かれる
  const childB = graph.patchNode(
    graph.addNode({ title: "B(分岐1)", group: page.id, parents: [childA.id] }).id,
    { lifecycle: "committed" },
  );
  const childC = graph.patchNode(
    graph.addNode({ title: "C(分岐2)", group: page.id, parents: [childA.id] }).id,
    { lifecycle: "committed" },
  );
  // 合流: B・Cの両方を親に持つ
  const merge = graph.patchNode(
    graph.addNode({ title: "合流", group: page.id, parents: [childB.id, childC.id] }).id,
    { lifecycle: "committed" },
  );
  const draftChild = graph.addNode({ title: "draftのまま", group: page.id, parents: [trigger.id] });
  const unplannedChild = graph.patchNode(
    graph.addNode({ title: "やり方未定", group: page.id, parents: [trigger.id] }).id,
    { lifecycle: "committed", status: "unplanned" },
  );
  // トリガーの子孫ではない（parentsを持たない）ページ内の無関係ノード
  const outsider = graph.addNode({ title: "無関係な兄弟", group: page.id });
  return { page, trigger, childA, childB, childC, merge, draftChild, unplannedChild, outsider };
}

describe("RunStore.createFromTrigger", () => {
  it("子孫算出: 分岐・合流を含めてトリガーの子孫だけを拾う", () => {
    const runs = new RunStore(dir);
    const { page, trigger, childA, childB, childC, merge, draftChild, unplannedChild } =
      setupTriggerPage(graph);
    const allMembers = graph.state().nodes.filter((n) => n.group === page.id);
    const run = runs.createFromTrigger(page.id, trigger.id, allMembers);

    expect(Object.keys(run.items).sort()).toEqual(
      [childA.id, childB.id, childC.id, merge.id, draftChild.id, unplannedChild.id].sort(),
    );
  });

  it("トリガー自身は items に入らない", () => {
    const runs = new RunStore(dir);
    const { page, trigger } = setupTriggerPage(graph);
    const allMembers = graph.state().nodes.filter((n) => n.group === page.id);
    const run = runs.createFromTrigger(page.id, trigger.id, allMembers);
    expect(run.items[trigger.id]).toBeUndefined();
  });

  it("トリガーの子孫ではないページ内ノードは items に入らない", () => {
    const runs = new RunStore(dir);
    const { page, trigger, outsider } = setupTriggerPage(graph);
    const allMembers = graph.state().nodes.filter((n) => n.group === page.id);
    const run = runs.createFromTrigger(page.id, trigger.id, allMembers);
    expect(run.items[outsider.id]).toBeUndefined();
  });

  it("draft のテンプレートも items に入る（status=pending）。Fix/committed は参加条件ではない", () => {
    const runs = new RunStore(dir);
    const { page, trigger, draftChild } = setupTriggerPage(graph);
    expect(draftChild.lifecycle).toBe("draft");
    const allMembers = graph.state().nodes.filter((n) => n.group === page.id);
    const run = runs.createFromTrigger(page.id, trigger.id, allMembers);
    expect(run.items[draftChild.id].status).toBe("pending");
  });

  it("status=unplanned のテンプレートは create() と同じく skipped になる（維持）", () => {
    const runs = new RunStore(dir);
    const { page, trigger, unplannedChild } = setupTriggerPage(graph);
    const allMembers = graph.state().nodes.filter((n) => n.group === page.id);
    const run = runs.createFromTrigger(page.id, trigger.id, allMembers);
    expect(run.items[unplannedChild.id].status).toBe("skipped");
  });

  it("run.trigger に発火元(trigger:<id>:<via>)が記録される。via省略時はmanual", () => {
    const runs = new RunStore(dir);
    const { page, trigger } = setupTriggerPage(graph);
    const allMembers = graph.state().nodes.filter((n) => n.group === page.id);
    const withDefault = runs.createFromTrigger(page.id, trigger.id, allMembers);
    expect(withDefault.trigger).toBe(`trigger:${trigger.id}:manual`);

    const withVia = runs.createFromTrigger(page.id, trigger.id, allMembers, {
      via: "schedule:every 1m",
    });
    expect(withVia.trigger).toBe(`trigger:${trigger.id}:schedule:every 1m`);
  });

  it("procedure フィールドには pageId が入る（トリガー起点なので kind=procedure とは限らない）", () => {
    const runs = new RunStore(dir);
    const { page, trigger } = setupTriggerPage(graph);
    expect(graph.get(page.id).kind).toBe("goal");
    const allMembers = graph.state().nodes.filter((n) => n.group === page.id);
    const run = runs.createFromTrigger(page.id, trigger.id, allMembers);
    expect(run.procedure).toBe(page.id);
    expect(runs.list(page.id).map((r) => r.id)).toEqual([run.id]);
  });
});

// applyItemDecision の実行フェーズゲート（2026-07-31追加。「前のノードが終わっていない
// ノードで実行系の操作ができてしまうのはおかしい」への対応。GraphStore.applyDecision の
// validateDecisionGate と同種で、ラン内では「テンプレートのラン内親が全てdone|skipped」を見る）
describe("RunStore.applyItemDecision: 実行フェーズゲート", () => {
  function setupRunDecision() {
    const procedure = graph.addNode({ title: "手順", kind: "procedure" });
    const pre = graph.patchNode(graph.addNode({ title: "前段", group: procedure.id }).id, {
      lifecycle: "committed",
    });
    const decision = graph.patchNode(
      graph.addNode({
        title: "分岐",
        kind: "decision",
        group: procedure.id,
        parents: [pre.id],
        branches: [
          { id: "a", label: "Aへ" },
          { id: "b", label: "Bへ" },
        ],
      }).id,
      { lifecycle: "committed" },
    );
    return { procedure, pre, decision };
  }

  it("ラン内の親アイテムが未決着なら選べない(409)", () => {
    const runs = new RunStore(dir);
    const { procedure, decision } = setupRunDecision();
    const members = graph.state().nodes.filter((n) => n.group === procedure.id);
    const run = runs.create(procedure.id, members);
    expect(() => runs.applyItemDecision(run.id, decision.id, "a", members)).toThrow(
      /前のノードが終わっていない/,
    );
  });

  it("ラン内の親アイテムが決着していれば選べる", () => {
    const runs = new RunStore(dir);
    const { procedure, pre, decision } = setupRunDecision();
    const members = graph.state().nodes.filter((n) => n.group === procedure.id);
    const run = runs.create(procedure.id, members);
    runs.patchItem(run.id, pre.id, { status: "done" });
    const updated = runs.applyItemDecision(run.id, decision.id, "a", members);
    expect(updated.items[decision.id].status).toBe("done");
    expect(updated.items[decision.id].choice).toBe("a");
  });
});
