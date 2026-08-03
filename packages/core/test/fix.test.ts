// Fix（= ロック。やり方の確定）の実効化まわりのテスト。docs/design.md 3.5 が仕様の正。
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore, GraphError, implEqualIgnoringParamValues } from "../src/index.js";

let dir: string;
let g: GraphStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-fix-"));
  g = new GraphStore(dir);
});

describe("implEqualIgnoringParamValues", () => {
  it("null同士・両方nullは等しい", () => {
    expect(implEqualIgnoringParamValues(null, null)).toBe(true);
  });

  it("片方だけnullなら異なる", () => {
    expect(implEqualIgnoringParamValues(null, { type: "doc", text: "x" })).toBe(false);
    expect(implEqualIgnoringParamValues({ type: "doc", text: "x" }, null)).toBe(false);
  });

  it("type が違えば異なる", () => {
    expect(
      implEqualIgnoringParamValues({ type: "doc", text: "x" }, { type: "script", command: "x" }),
    ).toBe(false);
  });

  it("doc: text/path が同じなら等しい", () => {
    expect(
      implEqualIgnoringParamValues(
        { type: "doc", text: "手順", path: "docs/a.md" },
        { type: "doc", text: "手順", path: "docs/a.md" },
      ),
    ).toBe(true);
  });

  it("doc: text が違えば異なる", () => {
    expect(
      implEqualIgnoringParamValues(
        { type: "doc", text: "手順A" },
        { type: "doc", text: "手順B" },
      ),
    ).toBe(false);
  });

  it("script: command が違えば異なる", () => {
    expect(
      implEqualIgnoringParamValues(
        { type: "script", command: "node a.mjs" },
        { type: "script", command: "node b.mjs" },
      ),
    ).toBe(false);
  });

  it("script: params の value だけ違うなら等しい", () => {
    expect(
      implEqualIgnoringParamValues(
        {
          type: "script",
          command: "node a.mjs {target}",
          params: [{ name: "target", example: "foo", value: null }],
        },
        {
          type: "script",
          command: "node a.mjs {target}",
          params: [{ name: "target", example: "foo", value: "bar" }],
        },
      ),
    ).toBe(true);
  });

  it("script: params の宣言（name等）が違えば異なる", () => {
    expect(
      implEqualIgnoringParamValues(
        {
          type: "script",
          command: "node a.mjs {target}",
          params: [{ name: "target", example: "foo" }],
        },
        {
          type: "script",
          command: "node a.mjs {target}",
          params: [{ name: "target", example: "変わった" }],
        },
      ),
    ).toBe(false);
  });

  it("script: params が未指定/null/空配列は同値扱い", () => {
    expect(
      implEqualIgnoringParamValues(
        { type: "script", command: "node a.mjs" },
        { type: "script", command: "node a.mjs", params: null },
      ),
    ).toBe(true);
    expect(
      implEqualIgnoringParamValues(
        { type: "script", command: "node a.mjs", params: [] },
        { type: "script", command: "node a.mjs" },
      ),
    ).toBe(true);
  });
});

describe("GraphStore: fixed ノードの patch 拒否", () => {
  it("保護フィールド（title/detail/kind/executor/approval/group/schedule）の実質変更は409", () => {
    const a = g.addNode({ title: "a" });
    g.patchNode(a.id, { fixed: true });

    expect(() => g.patchNode(a.id, { title: "変更後" })).toThrow(GraphError);
    expect(() => g.patchNode(a.id, { detail: "追記" })).toThrow(GraphError);
    expect(() => g.patchNode(a.id, { kind: "decision", branches: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] })).toThrow(
      GraphError,
    );
    expect(() => g.patchNode(a.id, { executor: "ai" })).toThrow(GraphError);
    expect(() => g.patchNode(a.id, { approval: true })).toThrow(GraphError);
    expect(() => g.patchNode(a.id, { schedule: "daily 09:00" })).toThrow(GraphError);

    try {
      g.patchNode(a.id, { title: "変更後" });
    } catch (e) {
      expect(e).toBeInstanceOf(GraphError);
      expect((e as GraphError).status).toBe(409);
      expect((e as GraphError).message).toMatch(/Fix済みのノードのやり方は変更できません/);
    }
  });

  it("parents/group/branches/parentOptions の実質変更は409", () => {
    const p = g.addNode({ title: "親" });
    const other = g.addNode({ title: "別の親" });
    const goal = g.addNode({ title: "ゴール", kind: "goal" });
    const other2 = g.addNode({ title: "別グループ", kind: "goal" });
    const child = g.addNode({ title: "子", parents: [p.id], group: goal.id });
    g.patchNode(child.id, { fixed: true });

    expect(() => g.patchNode(child.id, { parents: [other.id] })).toThrow(GraphError);
    expect(() => g.patchNode(child.id, { group: other2.id })).toThrow(GraphError);
  });

  it("同値のpatch（no-op）は許可される", () => {
    const a = g.addNode({ title: "a", detail: "メモ", schedule: null });
    g.patchNode(a.id, { fixed: true });
    const updated = g.patchNode(a.id, { title: "a", detail: "メモ" });
    expect(updated.title).toBe("a");
    expect(updated.detail).toBe("メモ");
  });

  it("status/lifecycle/fixed/pendingRequest/choice の変更は許可される", () => {
    const a = g.addNode({ title: "a", lifecycle: "committed" });
    g.patchNode(a.id, { fixed: true });
    const updated = g.patchNode(a.id, { status: "done" });
    expect(updated.status).toBe("done");
    // fixed 自体を落とすことができる（解除できる必要がある）
    const unlocked = g.patchNode(a.id, { fixed: false });
    expect(unlocked.fixed).toBe(false);
  });

  it("impl: params の value だけの変更は許可、それ以外(command)の変更は拒否", () => {
    const s = g.addNode({
      title: "スクリプト",
      executor: "script",
      impl: {
        type: "script",
        command: "node run.mjs {target}",
        params: [{ name: "target", example: "foo", value: null }],
      },
    });
    g.patchNode(s.id, { fixed: true });

    const updated = g.patchNode(s.id, {
      impl: {
        type: "script",
        command: "node run.mjs {target}",
        params: [{ name: "target", example: "foo", value: "bar" }],
      },
    });
    expect(updated.impl).toEqual({
      type: "script",
      command: "node run.mjs {target}",
      params: [{ name: "target", example: "foo", value: "bar" }],
    });

    expect(() =>
      g.patchNode(s.id, {
        impl: { type: "script", command: "node run.mjs --changed {target}" },
      }),
    ).toThrow(GraphError);
  });
});

describe("GraphStore: fixed ノードの removeNode 拒否", () => {
  it("fixed なノードは削除できない（先に解除が必要）", () => {
    const a = g.addNode({ title: "a" });
    g.patchNode(a.id, { fixed: true });
    expect(() => g.removeNode(a.id)).toThrow(GraphError);
    try {
      g.removeNode(a.id);
    } catch (e) {
      expect((e as GraphError).status).toBe(409);
      expect((e as GraphError).message).toMatch(/Fix済みのノードは削除できません/);
    }
    // 解除すれば削除できる
    g.patchNode(a.id, { fixed: false });
    g.removeNode(a.id);
    expect(g.has(a.id)).toBe(false);
  });
});

describe("GraphStore: fixed ノードの undo/redo 拒否", () => {
  it("fixed済みノードの保護フィールドを戻す補償(redo)は拒否。解除後は成功する", () => {
    // 現実的な手順で再現する: ①タイトル変更 ②その undo（未ロックなので許可）
    // ③ロック ④ここで redo（=タイトル変更をやり直す）しようとすると、fixed中の
    // 保護フィールド変更にあたるため拒否される
    const a = g.addNode({ title: "元のタイトル" });
    g.patchNode(a.id, { title: "変更後のタイトル" });
    g.undoLast();
    expect(g.get(a.id).title).toBe("元のタイトル");

    g.patchNode(a.id, { fixed: true });
    expect(() => g.redoLast()).toThrow(GraphError);
    try {
      g.redoLast();
    } catch (e) {
      expect((e as GraphError).status).toBe(409);
      expect((e as GraphError).message).toMatch(/元に戻せません/);
    }
    expect(g.get(a.id).title).toBe("元のタイトル");

    // ロックを解除すれば redo できる
    g.patchNode(a.id, { fixed: false });
    g.redoLast();
    expect(g.get(a.id).title).toBe("変更後のタイトル");
  });

  it("fixed の付け外しを戻す undo はロック中でも許可される", () => {
    const a = g.addNode({ title: "a" });
    g.patchNode(a.id, { fixed: true });
    // fixed のみを戻す undo は許可（ロックの付け外し自体）
    const undone = g.undoLast();
    expect(undone).not.toBeNull();
    expect(g.get(a.id).fixed).toBe(false);
  });

  it("fixedなノードをundoで削除することはできない（addのundo）", () => {
    // fixed:true を作成時点の入力として渡す＝ノードに付随する唯一のopがaddそのもの
    // （このノードが直近の非補償opとしてundoLastの対象になる）
    const a = g.addNode({ title: "a", fixed: true });
    expect(() => g.undoLast()).toThrow(GraphError);
    expect(g.has(a.id)).toBe(true);
  });

  it("リプレイ整合は拒否されたパスでは崩れない", () => {
    const a = g.addNode({ title: "a" });
    // 1回のpatchでtitle変更+ロックを同時に行う（patch時点ではまだ未ロックなので許可される）。
    // このopのundoはtitleとfixedの両方を戻そうとするため、ロック中は拒否される
    g.patchNode(a.id, { title: "b", fixed: true });
    expect(() => g.undoLast()).toThrow(GraphError);
    // 拒否された（=コミットされなかった）ので、ops.jsonlのリプレイと現在状態は一致し続ける
    expect(GraphStore.replay(dir)).toEqual(new Map(g.state().nodes.map((n) => [n.id, n])));
  });
});
