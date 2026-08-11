import { describe, expect, it } from "vitest";
import {
  DECISION_WAITING_NOTE,
  buildRunDecisionRequest,
  collectPendingRunDecisions,
  selectRunDecisionAction,
  selectRunDecisionApprovalAction,
} from "../src/decisionRun.js";
import { runGateMarker } from "../src/approval.js";
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
    // 左レールの整理棚と並び順（2026-08-05）。エンジンは見ないが型のため埋める
    folder: partial.folder ?? null,
    folderSection: partial.folderSection ?? null,
    order: partial.order ?? null,
    kind: partial.kind ?? "decision",
    executor: partial.executor ?? "script",
    approval: partial.approval ?? false,
    autonomy: partial.autonomy ?? "normal",
    aiModel: partial.aiModel ?? null,
    aiEffort: partial.aiEffort ?? null,
    lifecycle: partial.lifecycle ?? "committed",
    status: partial.status ?? "pending", // テンプレート自身のstatusはランには関係しない
    fixed: partial.fixed ?? false,
    pendingRequest: partial.pendingRequest ?? null,
    implTrial: partial.implTrial ?? null,
    schedule: partial.schedule ?? null,
    branches: partial.branches ?? [
      { id: "a", label: "Aへ" },
      { id: "b", label: "Bへ" },
    ],
    choice: partial.choice ?? null,
    parentOptions: partial.parentOptions ?? {},
    createdBy: partial.createdBy ?? null,
    assignee: partial.assignee ?? null,
    members: partial.members ?? [],
    outputs: partial.outputs ?? null,
    created: partial.created ?? `2026-01-01T00:00:${String(nodeSeq).padStart(2, "0")}Z`,
  };
}

function item(partial: Partial<RunItem> = {}): RunItem {
  return {
    status: partial.status ?? "pending",
    note: partial.note ?? null,
    choice: partial.choice ?? null,
    resolvedParams: partial.resolvedParams ?? null,
  };
}

let runSeq = 0;
function run(items: Record<string, RunItem>, partial: Partial<Run> = {}): Run {
  runSeq += 1;
  return {
    id: partial.id ?? `r-${runSeq}`,
    pageId: partial.pageId ?? "proc-1",
    title: partial.title ?? `ラン ${runSeq}`,
    trigger: partial.trigger ?? "manual",
    status: partial.status ?? "running",
    items,
    context: partial.context ?? {},
    snapshot: partial.snapshot ?? { capturedAt: "2026-01-01T00:00:00Z", nodes: [] },
    created: partial.created ?? `2026-01-01T01:00:${String(runSeq).padStart(2, "0")}Z`,
  };
}

describe("selectRunDecisionAction: executor別の分岐処理", () => {
  it("executor=script は execute-script を返す", () => {
    const n = node({ id: "d1", executor: "script" });
    const r = run({ d1: item() });
    expect(selectRunDecisionAction([n], [r])).toEqual({ type: "execute-script", run: r, node: n });
  });

  it("executor=ai は execute-ai を返す", () => {
    const n = node({ id: "d1", executor: "ai" });
    const r = run({ d1: item() });
    expect(selectRunDecisionAction([n], [r])).toEqual({ type: "execute-ai", run: r, node: n });
  });

  it("executor=human はまず waiting-human を返す（承認連携と同じ2段構え）", () => {
    const n = node({ id: "d1", executor: "human" });
    const r = run({ d1: item() });
    expect(selectRunDecisionAction([n], [r])).toEqual({ type: "waiting-human", run: r, node: n });
  });
});

describe("selectRunDecisionAction: lifecycle除外(3.8新モデル: draftもitemsには入るが自動判定はしない)", () => {
  it("lifecycle=draft のテンプレートは items にあっても候補にならない", () => {
    const n = node({ id: "d1", lifecycle: "draft" });
    const r = run({ d1: item() });
    expect(selectRunDecisionAction([n], [r])).toEqual({ type: "none" });
  });
});

describe("selectRunDecisionAction: ラン内伝搬（依存充足）", () => {
  it("ラン内の親アイテムが未完了(pending)なら候補から除外される", () => {
    const parent = node({ id: "p1", kind: "task" });
    const child = node({ id: "d1", parents: ["p1"] });
    const r = run({ p1: item({ status: "pending" }), d1: item() });
    expect(selectRunDecisionAction([parent, child], [r])).toEqual({ type: "none" });
  });

  it("ラン内の親アイテムがskipped(選ばれなかった枝)でも充足扱いで候補になる", () => {
    const parent = node({ id: "p1", kind: "task" });
    const child = node({ id: "d1", parents: ["p1"] });
    const r = run({ p1: item({ status: "skipped" }), d1: item() });
    expect(selectRunDecisionAction([parent, child], [r])).toEqual({
      type: "execute-script",
      run: r,
      node: child,
    });
  });

  it("手順の外のノードを親に持っていても、そのアイテムがランに無いなら依存判定に影響しない", () => {
    const outside = node({ id: "outside", group: null, kind: "task" });
    const child = node({ id: "d1", parents: ["outside"] });
    const r = run({ d1: item() }); // outside はこのランのitemに無い
    expect(selectRunDecisionAction([outside, child], [r])).toEqual({
      type: "execute-script",
      run: r,
      node: child,
    });
  });

  it("item.statusがpending以外(running/done/waiting/skipped)は対象外", () => {
    const n = node({ id: "d1" });
    for (const status of ["running", "done", "waiting", "skipped"] as const) {
      const r = run({ d1: item({ status }) });
      expect(selectRunDecisionAction([n], [r])).toEqual({ type: "none" });
    }
  });
});

describe("collectPendingRunDecisions", () => {
  it("waiting+DECISION_WAITING_NOTEのhuman分岐だけを集める", () => {
    const human = node({ id: "h1", executor: "human" });
    const script = node({ id: "s1", executor: "script" });
    const r = run({
      h1: item({ status: "waiting", note: DECISION_WAITING_NOTE }),
      s1: item({ status: "waiting", note: DECISION_WAITING_NOTE }),
    });
    expect(collectPendingRunDecisions([human, script], [r])).toEqual([{ run: r, node: human }]);
  });

  it("noteが違う/statusが違うものは除外", () => {
    const human = node({ id: "h1", executor: "human" });
    const r = run({ h1: item({ status: "waiting", note: "他のメモ" }) });
    expect(collectPendingRunDecisions([human], [r])).toEqual([]);
  });
});

describe("selectRunDecisionApprovalAction", () => {
  it("ゲート未発行(none)ならopen-requestを返す", () => {
    const n = node({ id: "h1", executor: "human" });
    const r = run({ h1: item({ status: "waiting", note: DECISION_WAITING_NOTE }) });
    const action = selectRunDecisionApprovalAction([n], [r], {});
    expect(action).toEqual({ type: "open-request", run: r, node: n });
  });

  it("ゲート発行済み・未回答(open)なら何もしない(二重に開かない)", () => {
    const n = node({ id: "h1", executor: "human" });
    const r = run({ h1: item({ status: "waiting", note: DECISION_WAITING_NOTE }) });
    const gateStates = { [`${r.id}:h1`]: { status: "open" as const } };
    expect(selectRunDecisionApprovalAction([n], [r], gateStates)).toEqual({ type: "none" });
  });

  it("回答が有効な枝idならdecideを返す", () => {
    const n = node({ id: "h1", executor: "human" });
    const r = run({ h1: item({ status: "waiting", note: DECISION_WAITING_NOTE }) });
    const gateStates = { [`${r.id}:h1`]: { status: "answered" as const, option: "b" } };
    expect(selectRunDecisionApprovalAction([n], [r], gateStates)).toEqual({
      type: "decide",
      run: r,
      node: n,
      choice: "b",
    });
  });

  it("回答がbranchesに無い値なら次候補へ(none)", () => {
    const n = node({ id: "h1", executor: "human" });
    const r = run({ h1: item({ status: "waiting", note: DECISION_WAITING_NOTE }) });
    const gateStates = { [`${r.id}:h1`]: { status: "answered" as const, option: "z" } };
    expect(selectRunDecisionApprovalAction([n], [r], gateStates)).toEqual({ type: "none" });
  });
});

describe("buildRunDecisionRequest", () => {
  it("options=branches・questionにランIDのマーカーを含む", () => {
    const n = node({ id: "h1", title: "本番構成を選ぶ" });
    const r = run({}, { id: "r-99", title: "夜間バッチ" });
    const req = buildRunDecisionRequest(n, r);
    expect(req.options.map((o) => o.id)).toEqual(["a", "b"]);
    expect(req.question).toContain(runGateMarker("r-99"));
    expect(req.context).toContain("本番構成を選ぶ");
    expect(req.context).toContain("夜間バッチ");
  });
});
