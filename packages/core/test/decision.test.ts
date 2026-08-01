// 分岐ノード(kind=decision)まわりのテスト。docs/design.md 3.9 が仕様の正。
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore, GraphError } from "../src/index.js";

let dir: string;
let g: GraphStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-decision-"));
  g = new GraphStore(dir);
});

describe("branches検証", () => {
  it("decisionノードはbranchesが最低2個必要（0個/1個はGraphError）", () => {
    expect(() => g.addNode({ title: "分岐", kind: "decision" })).toThrow(GraphError);
    expect(() =>
      g.addNode({ title: "分岐", kind: "decision", branches: [{ id: "a", label: "Aへ" }] }),
    ).toThrow(GraphError);
  });

  it("decisionノードにbranchesが2個以上あれば作成できる", () => {
    const d = g.addNode({
      title: "分岐",
      kind: "decision",
      branches: [
        { id: "a", label: "Aへ" },
        { id: "b", label: "Bへ" },
      ],
    });
    expect(d.branches).toHaveLength(2);
  });

  it("kind=task ではbranchesの中身は検証されない（null/1個でもよい）", () => {
    const t = g.addNode({ title: "普通の作業", branches: [{ id: "a", label: "Aへ" }] });
    expect(t.branches).toEqual([{ id: "a", label: "Aへ" }]);
  });

  it("patchでkindをdecisionに変えるときもbranchesが検証される", () => {
    const t = g.addNode({ title: "普通の作業" });
    expect(() => g.patchNode(t.id, { kind: "decision" })).toThrow(GraphError);
    const withBranches = g.patchNode(t.id, {
      kind: "decision",
      branches: [
        { id: "a", label: "Aへ" },
        { id: "b", label: "Bへ" },
      ],
    });
    expect(withBranches.kind).toBe("decision");
  });
});

function makeDecision() {
  return g.addNode({
    title: "分岐",
    kind: "decision",
    lifecycle: "committed",
    branches: [
      { id: "a", label: "Aへ" },
      { id: "b", label: "Bへ" },
    ],
  });
}

describe("parentOptions検証", () => {
  it("親がdecisionでない場合は400相当のGraphError", () => {
    const notDecision = g.addNode({ title: "普通のタスク" });
    expect(() =>
      g.addNode({
        title: "子",
        parents: [notDecision.id],
        parentOptions: { [notDecision.id]: "a" },
      }),
    ).toThrow(GraphError);
  });

  it("枝idがそのdecisionのbranchesに存在しない場合は400相当のGraphError", () => {
    const d = makeDecision();
    expect(() =>
      g.addNode({
        title: "子",
        parents: [d.id],
        parentOptions: { [d.id]: "c" }, // c という枝は無い
      }),
    ).toThrow(GraphError);
  });

  it("キーがparentsに含まれていなければGraphError", () => {
    const d = makeDecision();
    expect(() =>
      g.addNode({
        title: "子",
        parents: [], // d.id を parents に入れていない
        parentOptions: { [d.id]: "a" },
      }),
    ).toThrow(GraphError);
  });

  it("正しい parentOptions（親がdecision・値がbranches内）なら作成できる", () => {
    const d = makeDecision();
    const child = g.addNode({ title: "子", parents: [d.id], parentOptions: { [d.id]: "a" } });
    expect(child.parentOptions).toEqual({ [d.id]: "a" });
  });
});

/** 分岐→2枝→片方はさらに1段下流(連鎖skip検証用)→合流、という形を組み立てる */
function setupBranchGraph() {
  const d = makeDecision();
  const a1 = g.addNode({
    title: "A枝の作業",
    lifecycle: "committed",
    parents: [d.id],
    parentOptions: { [d.id]: "a" },
  });
  const b1 = g.addNode({
    title: "B枝の作業",
    lifecycle: "committed",
    parents: [d.id],
    parentOptions: { [d.id]: "b" },
  });
  const b2 = g.addNode({ title: "B枝の後続", lifecycle: "committed", parents: [b1.id] });
  const merge = g.addNode({ title: "合流", lifecycle: "committed", parents: [a1.id, b2.id] });
  return { d, a1, b1, b2, merge };
}

describe("applyDecision: 直接skip", () => {
  it("選ばれなかった枝の直下の子だけがskippedになる", () => {
    const { d, a1, b1 } = setupBranchGraph();
    g.applyDecision(d.id, "a");
    expect(g.get(d.id).status).toBe("done");
    expect(g.get(d.id).choice).toBe("a");
    expect(g.get(a1.id).status).toBe("pending"); // 選ばれた枝はそのまま
    expect(g.get(b1.id).status).toBe("skipped"); // 選ばれなかった枝
  });
});

describe("applyDecision: 連鎖skip", () => {
  it("skippedノードの子で全ての親がskippedなものも連鎖的にskippedになる", () => {
    const { d, b2 } = setupBranchGraph();
    g.applyDecision(d.id, "a");
    expect(g.get(b2.id).status).toBe("skipped");
  });

  it("done/droppedになっているノードは連鎖規則で上書きされない", () => {
    const { d, a1, b1, b2 } = setupBranchGraph();
    // b2 を先に dropped にしておく（人間が既に中止済み、という状況を模す）
    g.patchNode(b2.id, { status: "dropped" });
    g.applyDecision(d.id, "a");
    expect(g.get(b1.id).status).toBe("skipped");
    expect(g.get(b2.id).status).toBe("dropped"); // skippedで上書きされない
    expect(g.get(a1.id).status).toBe("pending");
  });
});

describe("applyDecision: 合流", () => {
  it("片方の枝がskippedでも、もう片方が完了すれば合流ノードがfrontierに乗る", () => {
    const built = setupBranchGraph();
    g.applyDecision(built.d.id, "a");
    // この時点では a1 がまだ pending なので合流はまだ frontier に乗らない
    expect(g.frontier().map((n) => n.id)).not.toContain(built.merge.id);
    g.patchNode(built.a1.id, { status: "done" });
    // a1 が done、b2 は skipped → 「skippedでない親が全てdone」なので合流が着火する
    expect(g.frontier().map((n) => n.id)).toContain(built.merge.id);
  });
});

describe("applyDecision: 入力検証", () => {
  it("choiceがbranchesに無ければGraphError", () => {
    const d = makeDecision();
    expect(() => g.applyDecision(d.id, "c")).toThrow(GraphError);
  });

  it("kind!=decisionのノードに対してはGraphError", () => {
    const t = g.addNode({ title: "普通の作業", lifecycle: "committed" });
    expect(() => g.applyDecision(t.id, "a")).toThrow(GraphError);
  });
});

describe("applyDecision: 実行フェーズゲート(2026-07-31追加)", () => {
  it("lifecycle=draftの分岐は選べない(409)", () => {
    const d = g.addNode({
      title: "分岐",
      kind: "decision",
      branches: [
        { id: "a", label: "Aへ" },
        { id: "b", label: "Bへ" },
      ],
    }); // lifecycle省略=draft
    expect(() => g.applyDecision(d.id, "a")).toThrow(/確定\(committed\)/);
  });

  it("前の親ノードが終わっていない分岐は選べない(409)。終われば選べる", () => {
    const pre = g.addNode({ title: "前段", lifecycle: "committed" });
    const d = g.addNode({
      title: "分岐",
      kind: "decision",
      lifecycle: "committed",
      parents: [pre.id],
      branches: [
        { id: "a", label: "Aへ" },
        { id: "b", label: "Bへ" },
      ],
    });
    expect(() => g.applyDecision(d.id, "a")).toThrow(/前のノードが終わっていない/);
    g.patchNode(pre.id, { status: "done" });
    expect(() => g.applyDecision(d.id, "a")).not.toThrow();
  });

  it("既に決着済み(done)の分岐は選び直せない(409)", () => {
    const d = makeDecision();
    g.applyDecision(d.id, "a");
    expect(() => g.applyDecision(d.id, "b")).toThrow(/既に決着/);
  });

  it("committed かつ frontier に到達した分岐は選べる", () => {
    const d = makeDecision();
    const updated = g.applyDecision(d.id, "a");
    expect(updated.status).toBe("done");
    expect(updated.choice).toBe("a");
  });
});

describe("applyDecision: undoとの整合", () => {
  it("一連の変更は複数opの連続であり、undoは1opずつ戻る", () => {
    const { d, b1, b2 } = setupBranchGraph();
    g.applyDecision(d.id, "a");
    expect(g.get(b1.id).status).toBe("skipped");
    expect(g.get(b2.id).status).toBe("skipped");

    // 最後のop（連鎖skipによるb2）だけが戻る
    g.undoLast();
    expect(g.get(b2.id).status).toBe("pending");
    expect(g.get(b1.id).status).toBe("skipped"); // まだ戻っていない
    expect(g.get(d.id).status).toBe("done"); // まだ戻っていない

    // その前のop（直接skipのb1）が戻る
    g.undoLast();
    expect(g.get(b1.id).status).toBe("pending");
    expect(g.get(d.id).status).toBe("done"); // まだ戻っていない

    // 最初のop（choice確定）が戻る
    g.undoLast();
    expect(g.get(d.id).status).toBe("pending");
    expect(g.get(d.id).choice).toBeNull();
  });
});

// ---- 選び直し（revertDecision。手戻り）と、決着後の後付けノードの自動skip ----

describe("revertDecision: 分岐の選び直し", () => {
  function setupDecided() {
    const d = makeDecision();
    const childA = g.patchNode(
      g.addNode({ title: "A側", parents: [d.id], parentOptions: { [d.id]: "a" } }).id,
      { lifecycle: "committed" },
    );
    const childB = g.patchNode(
      g.addNode({ title: "B側", parents: [d.id], parentOptions: { [d.id]: "b" } }).id,
      { lifecycle: "committed" },
    );
    const grandB = g.patchNode(
      g.addNode({ title: "B側の続き", parents: [childB.id] }).id,
      { lifecycle: "committed" },
    );
    g.applyDecision(d.id, "a");
    return { d, childA, childB, grandB };
  }

  it("choice が取り消され、直接skip + 連鎖skip が pending に復元される", () => {
    const { d, childA, childB, grandB } = setupDecided();
    expect(g.get(childB.id).status).toBe("skipped");
    expect(g.get(grandB.id).status).toBe("skipped");

    const reverted = g.revertDecision(d.id);
    expect(reverted.choice).toBeNull();
    expect(reverted.status).toBe("pending");
    expect(g.get(childB.id).status).toBe("pending");
    expect(g.get(grandB.id).status).toBe("pending");
    expect(g.get(childA.id).status).toBe("pending"); // 勝った枝はそのまま
  });

  it("別の決着済み分岐によるskipは復元しない", () => {
    const { d } = setupDecided();
    const d2 = makeDecision();
    const other = g.patchNode(
      g.addNode({ title: "別分岐のB側", parents: [d2.id], parentOptions: { [d2.id]: "b" } }).id,
      { lifecycle: "committed" },
    );
    g.applyDecision(d2.id, "a");
    expect(g.get(other.id).status).toBe("skipped");

    g.revertDecision(d.id);
    expect(g.get(other.id).status).toBe("skipped"); // d2 の決着は生きている
  });

  it("未決着の分岐は409相当のGraphError", () => {
    const d = makeDecision();
    expect(() => g.revertDecision(d.id)).toThrow(/決着していません/);
  });

  it("done になった下流は戻さない", () => {
    const { d, childB } = setupDecided();
    g.revertDecision(d.id);
    g.applyDecision(d.id, "b");
    g.patchNode(childB.id, { status: "done" });
    g.revertDecision(d.id);
    expect(g.get(childB.id).status).toBe("done");
  });
});

describe("決着済み分岐の負けた枝への後付けノードは自動skip", () => {
  it("addNode: 負けた枝に後付けしたノードは skipped で生まれる", () => {
    const d = makeDecision();
    g.applyDecision(d.id, "a");
    const late = g.addNode({
      title: "後付けB側",
      parents: [d.id],
      parentOptions: { [d.id]: "b" },
      lifecycle: "committed",
    });
    expect(late.status).toBe("skipped");
    // 勝った枝への後付けは普通に pending
    const winner = g.addNode({
      title: "後付けA側",
      parents: [d.id],
      parentOptions: { [d.id]: "a" },
    });
    expect(winner.status).toBe("pending");
  });

  it("patchNode: 負けた枝へ繋ぎ変えたノードは skipped になる", () => {
    const d = makeDecision();
    g.applyDecision(d.id, "a");
    const n = g.addNode({ title: "あとで繋ぐ" });
    const patched = g.patchNode(n.id, {
      parents: [d.id],
      parentOptions: { [d.id]: "b" },
    });
    expect(patched.status).toBe("skipped");
  });

  it("自動skipされた後付けノードも revertDecision で復元される", () => {
    const d = makeDecision();
    g.applyDecision(d.id, "a");
    const late = g.addNode({
      title: "後付けB側",
      parents: [d.id],
      parentOptions: { [d.id]: "b" },
    });
    g.revertDecision(d.id);
    expect(g.get(late.id).status).toBe("pending");
  });
});
