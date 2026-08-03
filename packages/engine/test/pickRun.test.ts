import { describe, expect, it } from "vitest";
import { selectRunAction } from "../src/pickRun.js";
import type { Node, Run, RunItem } from "../src/types.js";

let nodeSeq = 0;
function node(partial: Partial<Node> = {}): Node {
  nodeSeq += 1;
  return {
    id: partial.id ?? `n-${nodeSeq}`,
    title: partial.title ?? `node ${nodeSeq}`,
    detail: partial.detail ?? null,
    impl: partial.impl ?? null,
    parents: partial.parents ?? [],
    group: partial.group ?? "proc-1",
    kind: partial.kind ?? "task",
    executor: partial.executor ?? "script",
    approval: partial.approval ?? false,
    autonomy: partial.autonomy ?? "normal",
    lifecycle: partial.lifecycle ?? "committed",
    status: partial.status ?? "pending", // ランには関係しない（テンプレートは status を持たない扱い）
    fixed: partial.fixed ?? false,
    pendingRequest: partial.pendingRequest ?? null,
    implTrial: partial.implTrial ?? null,
    schedule: partial.schedule ?? null,
    branches: partial.branches ?? null,
    choice: partial.choice ?? null,
    parentOptions: partial.parentOptions ?? {},
    created: partial.created ?? `2026-01-01T00:00:${String(nodeSeq).padStart(2, "0")}Z`,
  };
}

function item(partial: Partial<RunItem> = {}): RunItem {
  return {
    status: partial.status ?? "pending",
    note: partial.note ?? null,
    choice: partial.choice ?? null,
  };
}

let runSeq = 0;
function run(items: Record<string, RunItem>, partial: Partial<Run> = {}): Run {
  runSeq += 1;
  return {
    id: partial.id ?? `r-${runSeq}`,
    procedure: partial.procedure ?? "proc-1",
    title: partial.title ?? `ラン ${runSeq}`,
    trigger: partial.trigger ?? "manual",
    status: partial.status ?? "running",
    items,
    created: partial.created ?? `2026-01-01T01:00:${String(runSeq).padStart(2, "0")}Z`,
  };
}

describe("selectRunAction: 依存充足", () => {
  it("ラン内依存(parents)が全てdoneならexecute", () => {
    const parent = node({ id: "p1" });
    const child = node({ id: "c1", parents: ["p1"] });
    const r = run({ p1: item({ status: "done" }), c1: item({ status: "pending" }) });
    const action = selectRunAction([parent, child], [r]);
    expect(action).toEqual({ type: "execute", run: r, node: child });
  });

  it("ラン内依存が未完了(pending)なら、その子は候補から除外される", () => {
    const parent = node({ id: "p1" });
    const child = node({ id: "c1", parents: ["p1"] });
    const r = run({ p1: item({ status: "pending" }), c1: item({ status: "pending" }) });
    const action = selectRunAction([parent, child], [r]);
    // parent自身は依存なし(frontier)なのでparentが選ばれ、childは選ばれない
    expect(action).toEqual({ type: "execute", run: r, node: parent });
  });

  it("手順の外のノードを親に持っていても、そのアイテムがランに無いなら依存判定に影響しない", () => {
    const outside = node({ id: "outside", group: null });
    const child = node({ id: "c1", parents: ["outside"] });
    const r = run({ c1: item({ status: "pending" }) }); // outside はこのランのitemに無い
    const action = selectRunAction([outside, child], [r]);
    expect(action).toEqual({ type: "execute", run: r, node: child });
  });
});

describe("selectRunAction: skipped扱い", () => {
  it("親アイテムがskipped(unplannedテンプレート等)でも依存は満たされたとみなす", () => {
    const parent = node({ id: "p1" });
    const child = node({ id: "c1", parents: ["p1"] });
    const r = run({ p1: item({ status: "skipped" }), c1: item({ status: "pending" }) });
    const action = selectRunAction([parent, child], [r]);
    expect(action).toEqual({ type: "execute", run: r, node: child });
  });
});

describe("selectRunAction: executor 除外", () => {
  it("executor=human のテンプレートは候補にならない", () => {
    const n = node({ id: "h1", executor: "human" });
    const r = run({ h1: item({ status: "pending" }) });
    expect(selectRunAction([n], [r])).toEqual({ type: "none" });
  });
});

describe("selectRunAction: lifecycle除外(3.8新モデル: draftもitemsには入るが自動実行はしない)", () => {
  it("lifecycle=draft のテンプレートは items にあっても実行候補にならない", () => {
    const n = node({ id: "d1", lifecycle: "draft" });
    const r = run({ d1: item({ status: "pending" }) });
    expect(selectRunAction([n], [r])).toEqual({ type: "none" });
  });

  it("lifecycle=draft をスキップして後続のcommittedを拾う", () => {
    const draftNode = node({ id: "d1", lifecycle: "draft", created: "2026-01-01T00:00:01Z" });
    const committedNode = node({ id: "c1", lifecycle: "committed", created: "2026-01-01T00:00:02Z" });
    const r = run({
      d1: item({ status: "pending" }),
      c1: item({ status: "pending" }),
    });
    expect(selectRunAction([draftNode, committedNode], [r])).toEqual({
      type: "execute",
      run: r,
      node: committedNode,
    });
  });
});

describe("selectRunAction: irreversible", () => {
  it("approval=trueは実行せずwaiting-irreversibleを返す", () => {
    const n = node({ id: "irr1", approval: true });
    const r = run({ irr1: item({ status: "pending" }) });
    const action = selectRunAction([n], [r]);
    expect(action).toEqual({ type: "waiting-irreversible", run: r, node: n });
  });
});

describe("selectRunAction: status/ラン状態のフィルタ", () => {
  it("item.status が pending 以外(running/done/waiting/dropped/skipped)は対象外", () => {
    const n = node({ id: "n1" });
    for (const status of ["running", "done", "waiting", "dropped", "skipped"] as const) {
      const r = run({ n1: item({ status }) });
      expect(selectRunAction([n], [r])).toEqual({ type: "none" });
    }
  });

  it("run.status=running 以外(done/cancelled)のランは対象外", () => {
    const n = node({ id: "n1" });
    const doneRun = run({ n1: item({ status: "pending" }) }, { status: "done" });
    const cancelledRun = run({ n1: item({ status: "pending" }) }, { status: "cancelled" });
    expect(selectRunAction([n], [doneRun])).toEqual({ type: "none" });
    expect(selectRunAction([n], [cancelledRun])).toEqual({ type: "none" });
  });
});

describe("selectRunAction: 選択順序", () => {
  it("複数の実行中ランがあれば created が古いランを優先する", () => {
    const nOld = node({ id: "old" });
    const nNew = node({ id: "new" });
    const older = run({ old: item({ status: "pending" }) }, { created: "2026-01-01T00:00:00Z" });
    const newer = run({ new: item({ status: "pending" }) }, { created: "2026-01-02T00:00:00Z" });
    const action = selectRunAction([nOld, nNew], [newer, older]);
    expect(action).toEqual({ type: "execute", run: older, node: nOld });
  });

  it("同じラン内ではテンプレートのcreatedが古い順に選ぶ", () => {
    const nOlder = node({ id: "a", created: "2026-01-01T00:00:00Z" });
    const nNewer = node({ id: "b", created: "2026-01-01T00:00:01Z" });
    const r = run({
      b: item({ status: "pending" }),
      a: item({ status: "pending" }),
    });
    const action = selectRunAction([nNewer, nOlder], [r]);
    expect(action).toEqual({ type: "execute", run: r, node: nOlder });
  });
});
