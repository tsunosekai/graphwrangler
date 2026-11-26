import { describe, expect, it } from "vitest";
import { buildPrepPrompt, selectProjectPrep, upstreamProducers } from "../src/prep.js";
import type { Node } from "../src/types.js";

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
    kind: partial.kind ?? "task",
    executor: partial.executor ?? "script",
    approval: partial.approval ?? false,
    autonomy: partial.autonomy ?? "normal",
    aiModel: partial.aiModel ?? null,
    aiEffort: partial.aiEffort ?? null,
    lifecycle: partial.lifecycle ?? "committed",
    status: partial.status ?? "pending", // ランには関係しない（テンプレートは status を持たない扱い）
    fixed: partial.fixed ?? false,
    pendingRequest: partial.pendingRequest ?? null,
    implTrial: partial.implTrial ?? null,
    schedule: partial.schedule ?? null,
    catchUp: true,
    prep: partial.prep ?? true,
    prepRequest: partial.prepRequest ?? false,
    muted: false,
    wait: null,
    waitUntil: null,
    branches: partial.branches ?? null,
    choice: partial.choice ?? null,
    parentOptions: partial.parentOptions ?? {},
    createdBy: partial.createdBy ?? null,
    assignee: partial.assignee ?? null,
    members: partial.members ?? [],
    outputs: partial.outputs ?? null,
    created: partial.created ?? `2026-01-01T00:00:${String(nodeSeq).padStart(2, "0")}Z`,
  };
}

describe("upstreamProducers（前準備に渡す先行ノード）", () => {
  it("待ちノードを飛び越えて、その手前のノードを拾う", () => {
    const ai = node({ id: "ai", executor: "ai" });
    const wait = node({ id: "w", kind: "wait", parents: ["ai"] });
    const human = node({ id: "h", executor: "human", parents: ["w"] });
    const byId = new Map([ai, wait, human].map((n) => [n.id, n]));
    expect(upstreamProducers(human, byId).map((n) => n.id)).toEqual(["ai"]);
  });

  it("トリガーは成果を持たないので拾わない／合流は両方拾う", () => {
    const t = node({ id: "t", kind: "trigger" });
    const a = node({ id: "a", executor: "ai", parents: ["t"] });
    const b = node({ id: "b", executor: "human", parents: ["t"] });
    const h = node({ id: "h", executor: "human", parents: ["a", "b"] });
    const first = node({ id: "f", executor: "human", parents: ["t"] });
    const byId = new Map([t, a, b, h, first].map((n) => [n.id, n]));
    expect(upstreamProducers(h, byId).map((n) => n.id)).toEqual(["a", "b"]);
    expect(upstreamProducers(first, byId)).toEqual([]);
  });
});

describe("buildPrepPrompt（前準備のプロンプト）", () => {
  const human = node({
    id: "h",
    title: "請求書を DM で送る",
    executor: "human",
    impl: { type: "doc", text: "PDF を添付して送る" },
  });

  it("担当者の作業・手順書・先行ノードの成果・返し方の書式を含む", () => {
    const p = buildPrepPrompt({
      node: human,
      goal: node({ id: "g", kind: "goal", title: "報酬の支払い", detail: "月次" }),
      upstream: ["請求書を作る: 4通作りました"],
      threadContext: [],
      runContext: { month: "2026-10" },
    });
    expect(p).toContain("担当者の作業: 請求書を DM で送る");
    expect(p).toContain("PDF を添付して送る");
    expect(p).toContain("請求書を作る: 4通作りました");
    expect(p).toContain("ゴール: 報酬の支払い");
    expect(p).toContain("month: 2026-10");
    expect(p).toContain("```gw-actions");
    expect(p).toContain("- [ ] ");
  });

  it("作業そのものはさせない・窓は開かせない・質問で止まらせない", () => {
    const p = buildPrepPrompt({ node: human, goal: null, upstream: [], threadContext: [], runContext: {} });
    expect(p).toContain("送信・支払い・提出・公開・削除");
    expect(p).toContain("窓やアプリを自分で開くこと");
    expect(p).toContain("質問して止まること");
  });
});

describe("selectProjectPrep（プロジェクト層の前準備の対象）", () => {
  const NONE = new Set<string>();
  const human = (p: Partial<Node>) => node({ group: "proj", executor: "human", ...p });

  it("起動直後の1周目は覚えるだけで、溜まっているノードは準備しない", () => {
    const a = human({ id: "a" });
    const r = selectProjectPrep([a], NONE, null, []);
    expect(r.target).toBeNull();
    expect([...r.eligible]).toEqual(["a"]);
    // 2周目も、前の周から着手できたものは対象にしない
    expect(selectProjectPrep([a], NONE, r.eligible, r.queue).target).toBeNull();
  });

  it("新しく着手できるようになったノードを準備する（親が終わった・計画済みにした）", () => {
    const parent = human({ id: "p", status: "running" });
    const child = human({ id: "c", parents: ["p"] });
    const draft = human({ id: "d", lifecycle: "draft" });
    const first = selectProjectPrep([parent, child, draft], NONE, null, []);
    expect([...first.eligible]).toEqual([]);

    const parentDone = { ...parent, status: "done" as const };
    const committed = { ...draft, lifecycle: "committed" as const };
    const second = selectProjectPrep([parentDone, child, committed], NONE, first.eligible, first.queue);
    expect(second.target?.id).toBe("c");
    // 1周に1件。残りは待ち行列に残り、次の周に回る
    expect(second.queue).toEqual(["d"]);
    const third = selectProjectPrep([parentDone, child, committed], NONE, second.eligible, second.queue);
    expect(third.target?.id).toBe("d");
    expect(third.queue).toEqual([]);
  });

  it("待っている間に着手された・前準備オフにされたノードは行列から外す", () => {
    const a = human({ id: "a" });
    const started = { ...a, status: "running" as const };
    expect(selectProjectPrep([started], NONE, new Set(["a"]), ["a"]).target).toBeNull();
    const off = { ...a, prep: false };
    expect(selectProjectPrep([off], NONE, new Set<string>(), []).target).toBeNull();
  });

  it("依頼（prepRequest）は最優先で、着手できる状態でなくても準備する", () => {
    const queued = human({ id: "q" });
    const asked = human({ id: "x", lifecycle: "draft", prepRequest: true });
    const r = selectProjectPrep([queued, asked], NONE, new Set<string>(), []);
    expect(r.target?.id).toBe("x");
    expect(r.queue).toEqual(["q"]); // 自動のぶんは次の周へ
  });

  it("ルーティーンのメンバー・AI やスクリプトの担当は対象にしない", () => {
    const member = node({ id: "m", executor: "human" }); // group=proc-1（ルーティーン）
    const ai = human({ id: "ai", executor: "ai" });
    const r = selectProjectPrep([member, ai], new Set(["proc-1"]), new Set<string>(), []);
    expect(r.target).toBeNull();
    expect([...r.eligible]).toEqual([]);
  });
});
