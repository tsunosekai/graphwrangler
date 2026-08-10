// 台帳ビューの列順（トポロジカル順）のテスト。関数本体は components/LedgerView.tsx に
// あるが、DOM に触らない純関数なのでここ（純関数テストの置き場）で固める。
// import は LedgerView モジュール全体を読み込むが、モジュール先頭で
// ブラウザグローバルに触らないため node 環境で動く。
import { describe, expect, it } from "vitest";
import { topoOrder } from "../components/LedgerView";
import { makeNode } from "./testutil";

const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id);

describe("topoOrder（台帳ビューの列順）", () => {
  it("parents を辿った層順（親が先・子が後）", () => {
    const members = [
      makeNode({ id: "child", parents: ["root"], created: "2026-01-01T00:00:00Z" }),
      makeNode({ id: "root", created: "2026-01-02T00:00:00Z" }),
      makeNode({ id: "grandchild", parents: ["child"], created: "2026-01-03T00:00:00Z" }),
    ];
    expect(ids(topoOrder(members))).toEqual(["root", "child", "grandchild"]);
  });

  it("同層は created 順", () => {
    const members = [
      makeNode({ id: "b", created: "2026-01-02T00:00:00Z" }),
      makeNode({ id: "a", created: "2026-01-01T00:00:00Z" }),
      makeNode({ id: "c", created: "2026-01-03T00:00:00Z" }),
    ];
    expect(ids(topoOrder(members))).toEqual(["a", "b", "c"]);
  });

  it("層はいちばん深い親経路で決まる（ダイヤモンドの合流点は最後）", () => {
    const members = [
      makeNode({ id: "merge", parents: ["left", "right"], created: "2026-01-01T00:00:00Z" }),
      makeNode({ id: "root", created: "2026-01-01T00:00:00Z" }),
      makeNode({ id: "left", parents: ["root"], created: "2026-01-01T00:00:01Z" }),
      makeNode({ id: "right", parents: ["left"], created: "2026-01-01T00:00:02Z" }),
    ];
    expect(ids(topoOrder(members))).toEqual(["root", "left", "right", "merge"]);
  });

  it("メンバー集合の外の親は層計算に関与しない", () => {
    const members = [
      makeNode({ id: "a", parents: ["outside"], created: "2026-01-01T00:00:00Z" }),
      makeNode({ id: "b", parents: ["a"], created: "2026-01-02T00:00:00Z" }),
    ];
    expect(ids(topoOrder(members))).toEqual(["a", "b"]);
  });

  it("循環（本来エンジンが禁止）があっても止まらず全員を返す", () => {
    const members = [
      makeNode({ id: "a", parents: ["b"], created: "2026-01-01T00:00:00Z" }),
      makeNode({ id: "b", parents: ["a"], created: "2026-01-02T00:00:00Z" }),
    ];
    const result = topoOrder(members);
    expect(new Set(ids(result))).toEqual(new Set(["a", "b"]));
  });

  it("入力配列を破壊しない", () => {
    const members = [
      makeNode({ id: "child", parents: ["root"], created: "2026-01-02T00:00:00Z" }),
      makeNode({ id: "root", created: "2026-01-01T00:00:00Z" }),
    ];
    topoOrder(members);
    expect(ids(members)).toEqual(["child", "root"]);
  });
});
