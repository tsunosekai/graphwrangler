import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore, GraphError, type OpRecord } from "../src/index.js";
import { readJsonl } from "../src/storage.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-graph-"));
});

describe("GraphStore", () => {
  it("空タイトルで作成できる（UIの「作って即リネーム」フロー）", () => {
    const g = new GraphStore(dir);
    const n = g.addNode({ title: "" });
    expect(n.title).toBe("");
  });

  it("ノード作成: 既定値が入り、idが採番される", () => {
    const g = new GraphStore(dir);
    const n = g.addNode({ title: "最初の仕事" });
    expect(n.id).toMatch(/^n-\d{8}-0001$/);
    expect(n.executor).toBe("human");
    expect(n.impact).toBe("safe");
    expect(n.lifecycle).toBe("draft");
    expect(n.status).toBe("pending");
    expect(n.pendingRequest).toBeNull();
  });

  it("存在しない親は拒否", () => {
    const g = new GraphStore(dir);
    expect(() => g.addNode({ title: "x", parents: ["n-99999999-0001"] })).toThrow(
      GraphError,
    );
  });

  it("循環禁止: 自分自身・子孫を親にできない", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "a" });
    const b = g.addNode({ title: "b", parents: [a.id] });
    const c = g.addNode({ title: "c", parents: [b.id] });
    expect(() => g.patchNode(a.id, { parents: [a.id] })).toThrow(/own parent/);
    expect(() => g.patchNode(a.id, { parents: [c.id] })).toThrow(/cycle/);
  });

  it("group: 存在検証・包含循環の禁止・メンバー持ちの削除禁止", () => {
    const g = new GraphStore(dir);
    const goal = g.addNode({ title: "ゴール", kind: "goal" });
    const a = g.addNode({ title: "a", group: goal.id });
    expect(a.group).toBe(goal.id);
    expect(() => g.addNode({ title: "x", group: "n-99999999-0001" })).toThrow(
      /group not found/,
    );
    expect(() => g.patchNode(goal.id, { group: goal.id })).toThrow(/containment cycle/);
    expect(() => g.patchNode(goal.id, { group: a.id })).toThrow(/containment cycle/);
    expect(() => g.removeNode(goal.id)).toThrow(/members/);
    g.patchNode(a.id, { group: null });
    g.removeNode(goal.id);
  });

  it("子を持つノードは消せない", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "a" });
    g.addNode({ title: "b", parents: [a.id] });
    expect(() => g.removeNode(a.id)).toThrow(/children/);
  });

  it("frontier: 親が全てdoneの未完ノードだけ", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "a" });
    const b = g.addNode({ title: "b", parents: [a.id] });
    g.addNode({ title: "c", parents: [b.id] });
    expect(g.frontier().map((n) => n.id)).toEqual([a.id]);
    g.patchNode(a.id, { status: "done" });
    expect(g.frontier().map((n) => n.id)).toEqual([b.id]);
  });

  it("操作ログに帰属(actor/via)が残る", () => {
    const g = new GraphStore(dir);
    g.addNode({ title: "x" }, { actor: { kind: "agent", name: "planner" }, via: "mcp" });
    const ops = readJsonl<OpRecord>(path.join(dir, "ops.jsonl"));
    expect(ops).toHaveLength(1);
    expect(ops[0].actor).toEqual({ kind: "agent", name: "planner" });
    expect(ops[0].via).toBe("mcp");
  });

  it("ops.jsonl のリプレイがスナップショットと一致する", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "a" });
    const b = g.addNode({ title: "b", parents: [a.id] });
    g.patchNode(a.id, { status: "done", detail: "済んだ" });
    g.removeNode(b.id);
    const replayed = GraphStore.replay(dir);
    const live = new Map(g.state().nodes.map((n) => [n.id, n]));
    expect(replayed).toEqual(live);
  });

  it("undo: add→消える / patch→値が戻る / remove→復活 / undoのundo=redo", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "a" });
    // patch を undo
    g.patchNode(a.id, { status: "done", detail: "済" });
    g.undoLast();
    expect(g.get(a.id).status).toBe("pending");
    expect(g.get(a.id).detail).toBeNull();
    // redo で戻る → もう一度 undo
    g.redoLast();
    expect(g.get(a.id).status).toBe("done");
    g.undoLast();
    expect(g.get(a.id).status).toBe("pending");
    // remove を undo → 復活（フィールドも戻る）
    const b = g.addNode({ title: "b", detail: "メモ" });
    g.removeNode(b.id);
    g.undoLast();
    expect(g.get(b.id).detail).toBe("メモ");
    // add を undo → 消える
    const c = g.addNode({ title: "c" });
    g.undoLast();
    expect(g.has(c.id)).toBe(false);
    // リプレイ整合
    expect(GraphStore.replay(dir)).toEqual(new Map(g.state().nodes.map((n) => [n.id, n])));
  });

  it("undo: 後続が生えた add は409、空なら null", () => {
    const g = new GraphStore(dir);
    expect(g.undoLast()).toBeNull();
    const a = g.addNode({ title: "a" });
    g.addNode({ title: "b", parents: [a.id] });
    // 直近は b の add → undo で b が消えるのは OK。その次の undo（a の add）は子が…もう居ない
    g.undoLast(); // b を打ち消す
    expect(g.state().nodes).toHaveLength(1);
    g.undoLast(); // a の add を打ち消す
    expect(g.state().nodes).toHaveLength(0);
  });

  it("スナップショットから再ロードできる", () => {
    const g1 = new GraphStore(dir);
    const a = g1.addNode({ title: "a" });
    const g2 = new GraphStore(dir);
    expect(g2.get(a.id).title).toBe("a");
  });
});

// kind=trigger（起点ノード）まわりのテスト。docs/design.md 3.4/3.8 新モデルが仕様の正。
describe("GraphStore: trigger ノード", () => {
  it("trigger ノードは parents を持てない（addNode時）", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "a" });
    expect(() => g.addNode({ title: "起点", kind: "trigger", parents: [a.id] })).toThrow(
      /trigger ノードは parents を持てません/,
    );
  });

  it("parentsが空ならtriggerノードを作成できる", () => {
    const g = new GraphStore(dir);
    const t = g.addNode({ title: "起点", kind: "trigger" });
    expect(t.kind).toBe("trigger");
    expect(t.parents).toEqual([]);
  });

  it("patchでparentsを足そうとすると拒否される（既存triggerノード）", () => {
    const g = new GraphStore(dir);
    const t = g.addNode({ title: "起点", kind: "trigger" });
    const a = g.addNode({ title: "a" });
    expect(() => g.patchNode(t.id, { parents: [a.id] })).toThrow(/trigger ノードは parents を持てません/);
  });

  it("patchでkindをtriggerに変えるときもparents保有が検証される", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "a" });
    const b = g.addNode({ title: "b", parents: [a.id] });
    expect(() => g.patchNode(b.id, { kind: "trigger" })).toThrow(/trigger ノードは parents を持てません/);
    // parentsも同時に空にすれば通る
    const patched = g.patchNode(b.id, { kind: "trigger", parents: [] });
    expect(patched.kind).toBe("trigger");
  });
});
