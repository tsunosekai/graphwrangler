// 右クリックメニューの共通ヘルパ（lib/actions.ts）のうち純関数部分のテスト。
// 「まとめ削除の順」「既読キーの集め方」といった地味な決まりごとを固める
// （api / dialogs / clipboard に触る関数はここでは扱わない）。
import { describe, expect, it } from "vitest";
import {
  collectDescendants,
  deletionOrder,
  hasUnread,
  readKeysForNode,
  readKeysForPage,
} from "./actions";
import { makeNode } from "./testutil";

describe("collectDescendants", () => {
  it("parents を辿って到達できる子孫を集める（root 自身は含めない）", () => {
    const nodes = [
      makeNode({ id: "root" }),
      makeNode({ id: "child", parents: ["root"] }),
      makeNode({ id: "grandchild", parents: ["child"] }),
      makeNode({ id: "unrelated" }),
    ];
    expect(collectDescendants(nodes, "root")).toEqual(new Set(["child", "grandchild"]));
  });

  it("ダイヤモンド型（複数経路）でも重複なく1回だけ集める", () => {
    const nodes = [
      makeNode({ id: "root" }),
      makeNode({ id: "left", parents: ["root"] }),
      makeNode({ id: "right", parents: ["root"] }),
      makeNode({ id: "merge", parents: ["left", "right"] }),
    ];
    expect(collectDescendants(nodes, "root")).toEqual(new Set(["left", "right", "merge"]));
  });

  it("循環があっても止まる（本来 DAG だが visited で保護）", () => {
    const nodes = [
      makeNode({ id: "a", parents: ["b"] }),
      makeNode({ id: "b", parents: ["a"] }),
    ];
    expect(collectDescendants(nodes, "a")).toEqual(new Set(["b"]));
  });
});

describe("deletionOrder", () => {
  it("依存(parents)は子が先・親が後（葉から順）", () => {
    const nodes = [
      makeNode({ id: "parent" }),
      makeNode({ id: "child", parents: ["parent"] }),
      makeNode({ id: "grandchild", parents: ["child"] }),
    ];
    const order = deletionOrder(nodes, new Set(["parent", "child", "grandchild"]));
    expect(order).toEqual(["grandchild", "child", "parent"]);
  });

  it("包含(group)もメンバーが先・入れ物が後", () => {
    const nodes = [
      makeNode({ id: "page", kind: "goal" }),
      makeNode({ id: "member", group: "page" }),
    ];
    expect(deletionOrder(nodes, new Set(["page", "member"]))).toEqual(["member", "page"]);
  });

  it("削除集合の外のノードは順序計算に関与しない", () => {
    const nodes = [
      makeNode({ id: "parent" }),
      makeNode({ id: "child", parents: ["parent"] }),
      makeNode({ id: "outsideChild", parents: ["parent"] }),
    ];
    // outsideChild は集合外なので、parent は集合内では葉扱いになる
    expect(deletionOrder(nodes, new Set(["parent", "child"]))).toEqual(["child", "parent"]);
  });

  it("循環（本来起きない）でも全ノードを出して止まらない", () => {
    const nodes = [
      makeNode({ id: "a", parents: ["b"] }),
      makeNode({ id: "b", parents: ["a"] }),
    ];
    const order = deletionOrder(nodes, new Set(["a", "b"]));
    expect(new Set(order)).toEqual(new Set(["a", "b"]));
    expect(order).toHaveLength(2);
  });
});

describe("readKeysForNode", () => {
  it("テンプレート側 + 全ランぶんのキーを threadMeta から集める", () => {
    const meta = {
      n1: "2026-08-01T00:00:00Z",
      "n1@r1": "2026-08-01T00:00:00Z",
      "n1@r2": "2026-08-01T00:00:00Z",
      n2: "2026-08-01T00:00:00Z",
    };
    expect(readKeysForNode("n1", meta).sort()).toEqual(["n1", "n1@r1", "n1@r2"]);
  });

  it("会話が存在しないキーは含めない（既読にしても意味が無い）", () => {
    expect(readKeysForNode("n1", {})).toEqual([]);
  });

  it("id が前方一致する他ノードのキーは拾わない", () => {
    const meta = { n10: "2026-08-01T00:00:00Z", "n10@r1": "2026-08-01T00:00:00Z" };
    expect(readKeysForNode("n1", meta)).toEqual([]);
  });
});

describe("readKeysForPage", () => {
  it("ページ自身 + 配下の全メンバー（入れ子も辿る）のキーを集める", () => {
    const nodes = [
      makeNode({ id: "page", kind: "goal" }),
      makeNode({ id: "member", group: "page" }),
      makeNode({ id: "nested", group: "member" }),
      makeNode({ id: "outside" }),
    ];
    const meta = {
      page: "2026-08-01T00:00:00Z",
      member: "2026-08-01T00:00:00Z",
      "nested@r1": "2026-08-01T00:00:00Z",
      outside: "2026-08-01T00:00:00Z",
    };
    expect(readKeysForPage("page", nodes, meta).sort()).toEqual([
      "member",
      "nested@r1",
      "page",
    ]);
  });
});

describe("hasUnread", () => {
  it("指定キーのどれかが未読なら true", () => {
    const meta = { n1: "2026-08-02T00:00:00Z", n2: "2026-08-02T00:00:00Z" };
    const reads = { n1: "2026-08-03T00:00:00Z" };
    expect(hasUnread(["n1", "n2"], meta, reads)).toBe(true);
    expect(hasUnread(["n1"], meta, reads)).toBe(false);
    expect(hasUnread([], meta, reads)).toBe(false);
  });
});
