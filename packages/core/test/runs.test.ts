import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore, RunStore, GraphError } from "../src/index.js";

let dir: string;
let graph: GraphStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-runs-"));
  graph = new GraphStore(dir);
});

// トリガー起点のラン生成（docs/design.md 3.4/3.8）。
// 「ルーティーンであること」はページ種別ではなく先頭のトリガーノードから導出する。
function setupTriggerPage() {
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

/** setupTriggerPage したページのメンバー一覧 */
function membersOf(pageId: string) {
  return graph.state().nodes.filter((n) => n.group === pageId);
}

describe("RunStore.createFromTrigger", () => {
  it("子孫算出: 分岐・合流を含めてトリガーの子孫だけを拾う", () => {
    const runs = new RunStore(dir);
    const { page, trigger, childA, childB, childC, merge, draftChild, unplannedChild } =
      setupTriggerPage();
    const run = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id));

    expect(run.id).toMatch(/^r-\d{8}-0001$/);
    expect(run.status).toBe("running");
    expect(Object.keys(run.items).sort()).toEqual(
      [childA.id, childB.id, childC.id, merge.id, draftChild.id, unplannedChild.id].sort(),
    );
  });

  it("トリガー自身は items に入らない", () => {
    const runs = new RunStore(dir);
    const { page, trigger } = setupTriggerPage();
    const run = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id));
    expect(run.items[trigger.id]).toBeUndefined();
  });

  it("トリガーの子孫ではないページ内ノードは items に入らない", () => {
    const runs = new RunStore(dir);
    const { page, trigger, outsider } = setupTriggerPage();
    const run = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id));
    expect(run.items[outsider.id]).toBeUndefined();
  });

  it("draft のテンプレートも items に入る（status=pending）。Fix/committed は参加条件ではない", () => {
    const runs = new RunStore(dir);
    const { page, trigger, draftChild } = setupTriggerPage();
    expect(draftChild.lifecycle).toBe("draft");
    const run = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id));
    expect(run.items[draftChild.id].status).toBe("pending");
  });

  it("status=unplanned のテンプレートは skipped になる", () => {
    const runs = new RunStore(dir);
    const { page, trigger, unplannedChild } = setupTriggerPage();
    const run = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id));
    expect(run.items[unplannedChild.id].status).toBe("skipped");
  });

  it("run.trigger に発火元(trigger:<id>:<via>)が記録される。via省略時はmanual", () => {
    const runs = new RunStore(dir);
    const { page, trigger } = setupTriggerPage();
    const withDefault = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id));
    expect(withDefault.trigger).toBe(`trigger:${trigger.id}:manual`);

    const withVia = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id), {
      via: "schedule:every 1m",
    });
    expect(withVia.trigger).toBe(`trigger:${trigger.id}:schedule:every 1m`);
  });

  it("procedure フィールドには pageId が入る", () => {
    const runs = new RunStore(dir);
    const { page, trigger } = setupTriggerPage();
    expect(graph.get(page.id).kind).toBe("goal");
    const run = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id));
    expect(run.procedure).toBe(page.id);
    expect(runs.list(page.id).map((r) => r.id)).toEqual([run.id]);
  });
});

describe("RunStore: ワークアイテム更新・一覧・永続化", () => {
  it("patchItem: status と note を更新できる", () => {
    const runs = new RunStore(dir);
    const { page, trigger, childA } = setupTriggerPage();
    const run = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id));

    const patched = runs.patchItem(run.id, childA.id, {
      status: "running",
      note: "着手した",
    });
    expect(patched.items[childA.id].status).toBe("running");
    expect(patched.items[childA.id].note).toBe("着手した");
    // status を省略すれば既存値を維持
    const notePatched = runs.patchItem(run.id, childA.id, { note: "続けている" });
    expect(notePatched.items[childA.id].status).toBe("running");
    expect(notePatched.items[childA.id].note).toBe("続けている");
  });

  it("patchItem: 全アイテムが done/dropped/skipped になったらランが自動的に done になる", () => {
    const runs = new RunStore(dir);
    const { page, trigger, unplannedChild } = setupTriggerPage();
    const run = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id));

    // unplanned は既に skipped 済み。残りを done にすれば全体が done になるはず
    expect(run.items[unplannedChild.id].status).toBe("skipped");
    const pendingIds = Object.entries(run.items)
      .filter(([, item]) => item.status === "pending")
      .map(([id]) => id);
    let latest = run;
    for (const id of pendingIds.slice(0, -1)) {
      latest = runs.patchItem(run.id, id, { status: "done" });
      expect(latest.status).toBe("running");
    }
    latest = runs.patchItem(run.id, pendingIds[pendingIds.length - 1], { status: "done" });
    expect(latest.status).toBe("done");
  });

  it("patchItem: 存在しないノードの item は404相当のGraphError", () => {
    const runs = new RunStore(dir);
    const { page, trigger } = setupTriggerPage();
    const run = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id));
    expect(() => runs.patchItem(run.id, "n-99999999-0001", { status: "done" })).toThrow(
      GraphError,
    );
  });

  it("cancel: status が cancelled になり、以後の patchItem で done に戻らない", () => {
    const runs = new RunStore(dir);
    const { page, trigger, childA } = setupTriggerPage();
    const run = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id));

    const cancelled = runs.cancel(run.id);
    expect(cancelled.status).toBe("cancelled");
    const afterPatch = runs.patchItem(run.id, childA.id, { status: "done" });
    expect(afterPatch.status).toBe("cancelled");
  });

  it("list: ページごとにフィルタし、created 降順で返す", () => {
    const runs = new RunStore(dir);
    const { page, trigger } = setupTriggerPage();
    const otherPage = graph.addNode({ title: "別のページ", kind: "goal" });
    const otherTrigger = graph.addNode({
      title: "別の起点",
      kind: "trigger",
      group: otherPage.id,
    });

    const first = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id), { title: "1回目" });
    const second = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id), { title: "2回目" });
    runs.createFromTrigger(otherPage.id, otherTrigger.id, membersOf(otherPage.id), {
      title: "別ページのラン",
    });

    const list = runs.list(page.id);
    expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(list.every((r) => r.procedure === page.id)).toBe(true);
  });

  it("永続化ラウンドトリップ: 新しい RunStore インスタンスからも get/list できる", () => {
    const runs1 = new RunStore(dir);
    const { page, trigger } = setupTriggerPage();
    const run = runs1.createFromTrigger(page.id, trigger.id, membersOf(page.id));
    runs1.patchItem(run.id, Object.keys(run.items)[0], { status: "done" });

    const runs2 = new RunStore(dir);
    const reloaded = runs2.get(run.id);
    expect(reloaded).toEqual(runs1.get(run.id));
    expect(runs2.list(page.id).map((r) => r.id)).toEqual([run.id]);
  });

  it("get: 存在しないランは404相当のGraphError", () => {
    const runs = new RunStore(dir);
    expect(() => runs.get("r-99999999-0001")).toThrow(GraphError);
  });
});

// applyItemDecision の実行フェーズゲート（GraphStore.applyDecision の validateDecisionGate と
// 同種で、ラン内では「テンプレートのラン内親が全てdone|skipped」を見る）
describe("RunStore.applyItemDecision: 実行フェーズゲート", () => {
  function setupRunDecision() {
    const page = graph.addNode({ title: "ページ", kind: "goal" });
    const trigger = graph.addNode({ title: "起点", kind: "trigger", group: page.id });
    const pre = graph.patchNode(
      graph.addNode({ title: "前段", group: page.id, parents: [trigger.id] }).id,
      { lifecycle: "committed" },
    );
    const decision = graph.patchNode(
      graph.addNode({
        title: "分岐",
        kind: "decision",
        group: page.id,
        parents: [pre.id],
        branches: [
          { id: "a", label: "Aへ" },
          { id: "b", label: "Bへ" },
        ],
      }).id,
      { lifecycle: "committed" },
    );
    return { page, trigger, pre, decision };
  }

  it("ラン内の親アイテムが未決着なら選べない(409)", () => {
    const runs = new RunStore(dir);
    const { page, trigger, decision } = setupRunDecision();
    const members = membersOf(page.id);
    const run = runs.createFromTrigger(page.id, trigger.id, members);
    expect(() => runs.applyItemDecision(run.id, decision.id, "a", members)).toThrow(
      /前のノードが終わっていない/,
    );
  });

  it("ラン内の親アイテムが決着していれば選べる", () => {
    const runs = new RunStore(dir);
    const { page, trigger, pre, decision } = setupRunDecision();
    const members = membersOf(page.id);
    const run = runs.createFromTrigger(page.id, trigger.id, members);
    runs.patchItem(run.id, pre.id, { status: "done" });
    const updated = runs.applyItemDecision(run.id, decision.id, "a", members);
    expect(updated.items[decision.id].status).toBe("done");
    expect(updated.items[decision.id].choice).toBe("a");
  });
});

describe("RunStore.rename", () => {
  it("ランの名前を後から変更できる（他フィールドは不変）", () => {
    const runs = new RunStore(dir);
    const { page, trigger } = setupTriggerPage();
    const run = runs.createFromTrigger(page.id, trigger.id, membersOf(page.id), { title: "作品A" });
    const renamed = runs.rename(run.id, "作品A（改）");
    expect(renamed.title).toBe("作品A（改）");
    expect(renamed.items).toEqual(run.items);
    expect(renamed.status).toBe(run.status);
    expect(runs.get(run.id).title).toBe("作品A（改）");
  });
});
