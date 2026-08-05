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
    expect(n.approval).toBe(false);
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

  it("force削除: fixed でも消える（確認は UI の責務）", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "a" });
    g.patchNode(a.id, { fixed: true });
    expect(() => g.removeNode(a.id)).toThrow(GraphError);
    g.removeNode(a.id, {}, { force: true });
    expect(() => g.get(a.id)).toThrow(GraphError);
  });

  it("force削除: ページのメンバーは入れ子ごと巻き添え削除", () => {
    const g = new GraphStore(dir);
    const goal = g.addNode({ title: "ゴール", kind: "goal" });
    const sub = g.addNode({ title: "サブページ", kind: "goal", group: goal.id });
    const a = g.addNode({ title: "a", group: goal.id });
    const b = g.addNode({ title: "b", group: sub.id });
    g.removeNode(goal.id, {}, { force: true });
    for (const id of [goal.id, sub.id, a.id, b.id]) {
      expect(() => g.get(id)).toThrow(GraphError);
    }
  });

  it("force削除: 削除集合の外の子は parents / parentOptions から切り離す（fixed の子でも）", () => {
    const g = new GraphStore(dir);
    const d = g.addNode({
      title: "分岐",
      kind: "decision",
      branches: [
        { id: "x", label: "X", then: "Xで進む" },
        { id: "y", label: "Y", then: "Yで進む" },
      ],
    });
    const a = g.addNode({ title: "a" });
    const child = g.addNode({
      title: "child",
      parents: [d.id, a.id],
      parentOptions: { [d.id]: "x" },
    });
    g.patchNode(child.id, { fixed: true });
    g.removeNode(d.id, {}, { force: true });
    const after = g.get(child.id);
    expect(after.parents).toEqual([a.id]);
    expect(after.parentOptions).toEqual({});
    expect(after.fixed).toBe(true);
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

  // ---- 左レールの整理棚（kind=folder）と手動並び順（order）。2026-08-05 ----

  it("folder: 実在検証・相手がfolderであることの検証・入れ子循環の禁止", () => {
    const g = new GraphStore(dir);
    const shelf = g.addNode({ title: "受託", kind: "folder" });
    const page = g.addNode({ title: "ゴール", kind: "goal", folder: shelf.id });
    expect(page.folder).toBe(shelf.id);
    expect(() => g.addNode({ title: "x", kind: "goal", folder: "n-99999999-0001" })).toThrow(
      /folder not found/,
    );
    // ページ（kind=goal）をフォルダ扱いにはできない
    expect(() => g.patchNode(shelf.id, { folder: page.id })).toThrow(/is not a folder/);
    const inner = g.addNode({ title: "内側", kind: "folder", folder: shelf.id });
    expect(() => g.patchNode(shelf.id, { folder: inner.id })).toThrow(/folder cycle/);
  });

  it("folder: フォルダを消しても中のページは消えず、folder が外れるだけ", () => {
    const g = new GraphStore(dir);
    const shelf = g.addNode({ title: "受託", kind: "folder" });
    const page = g.addNode({ title: "ゴール", kind: "goal", folder: shelf.id });
    g.removeNode(shelf.id);
    expect(() => g.get(shelf.id)).toThrow(GraphError);
    expect(g.get(page.id).folder).toBeNull();
  });

  it("order/folder は Fix 済みでも変更できる（並べ方は「やり方」ではない）", () => {
    const g = new GraphStore(dir);
    const shelf = g.addNode({ title: "受託", kind: "folder" });
    const page = g.addNode({ title: "ゴール", kind: "goal" });
    g.patchNode(page.id, { fixed: true });
    const moved = g.patchNode(page.id, { folder: shelf.id, order: 3 });
    expect(moved.folder).toBe(shelf.id);
    expect(moved.order).toBe(3);
    // 一方で「やり方」側（title 等）は従来どおり拒否される
    expect(() => g.patchNode(page.id, { title: "別名" })).toThrow(/Fix済み/);
  });

  it("order の既定は null（未指定＝作成順で後ろに落ちる）", () => {
    const g = new GraphStore(dir);
    expect(g.addNode({ title: "a", kind: "goal" }).order).toBeNull();
    expect(g.addNode({ title: "b", kind: "goal", order: 0 }).order).toBe(0);
  });
});
