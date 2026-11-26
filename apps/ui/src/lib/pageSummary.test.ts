import { describe, expect, it } from "vitest";
import type { Node } from "../types";
import { isPageNode, pageProgress, pageTriggerLines } from "./pageSummary";

const mk = (id: string, over: Partial<Node>): Node =>
  ({
    id,
    title: id,
    detail: null,
    impl: null,
    parents: [],
    group: null,
    kind: "task",
    executor: "human",
    approval: false,
    lifecycle: "committed",
    status: "pending",
    fixed: false,
    schedule: null,
    ...over,
  }) as Node;

describe("isPageNode", () => {
  it("ページ本体と棚だけが対象", () => {
    expect(isPageNode(mk("p", { kind: "goal" }))).toBe(true);
    expect(isPageNode(mk("f", { kind: "folder" }))).toBe(true);
    expect(isPageNode(mk("t", { kind: "task" }))).toBe(false);
    expect(isPageNode(mk("g", { kind: "trigger" }))).toBe(false);
  });
});

describe("pageProgress", () => {
  it("直下の作業ノードだけを数え、完了・飛ばした・中止を片づいた扱いにする", () => {
    const nodes = [
      mk("p", { kind: "goal" }),
      mk("a", { group: "p", status: "done" }),
      mk("b", { group: "p", status: "skipped" }),
      mk("c", { group: "p", status: "running" }),
      mk("d", { group: "p", kind: "decision", status: "dropped" }),
      mk("w", { group: "p", kind: "wait" }),
      mk("sub", { group: "a", status: "done" }),
      mk("other", { group: "q", status: "done" }),
    ];
    expect(pageProgress({ id: "p" }, nodes)).toEqual({ settled: 3, total: 5 });
  });
});

describe("pageTriggerLines", () => {
  it("トリガーごとに、いつ動くかを1行にする", () => {
    const nodes = [
      mk("p", { kind: "goal" }),
      mk("t1", { group: "p", kind: "trigger", executor: "script", schedule: "weekly fri 13:00" }),
      mk("t2", { group: "p", kind: "trigger", executor: "human" }),
      mk("t3", { group: "p", kind: "trigger", executor: "script", schedule: null }),
      mk("t4", { group: "p", kind: "trigger", executor: "script", schedule: "weekly fri 13:00", lifecycle: "draft" }),
      mk("x", { group: "q", kind: "trigger", executor: "human" }),
    ];
    const lines = pageTriggerLines({ id: "p" }, nodes);
    expect(lines.map((l) => l.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(lines[0].warn).toBe(false);
    expect(lines[1]).toEqual({ id: "t2", text: "手動で開始", warn: false });
    expect(lines[2].warn).toBe(true);
    expect(lines[3].warn).toBe(true);
    expect(lines[3].text).toContain("未計画");
  });
});
