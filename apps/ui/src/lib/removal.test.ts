// 削除の巻き添え計算（lib/removal.ts）のテスト。「削除は原則いつでもできる・
// 危ないケースは事前にモーダルで教える」の判定材料が正しく出ることを固める。
import { describe, expect, it } from "vitest";
import { buildRemoveMessage, computeRemoveImpact, removeImpactWarnings } from "./removal";
import { makeNode } from "./testutil";

describe("computeRemoveImpact", () => {
  it("独立ノード1つの削除は巻き添えなし", () => {
    const nodes = [makeNode({ id: "a" }), makeNode({ id: "b" })];
    const impact = computeRemoveImpact(["a"], nodes);
    expect(impact).toEqual({
      cascade: 0,
      detach: 0,
      locked: 0,
      removalSet: new Set(["a"]),
    });
  });

  it("ページを消すとメンバーが巻き添えになる（入れ子も不動点まで辿る）", () => {
    const nodes = [
      makeNode({ id: "page", kind: "goal" }),
      makeNode({ id: "sub", group: "page" }),
      makeNode({ id: "leaf", group: "sub" }),
      makeNode({ id: "outside" }),
    ];
    const impact = computeRemoveImpact(["page"], nodes);
    expect(impact.cascade).toBe(2);
    expect(impact.removalSet).toEqual(new Set(["page", "sub", "leaf"]));
  });

  it("選択に既に含まれるメンバーは巻き添えに数えない", () => {
    const nodes = [
      makeNode({ id: "page", kind: "goal" }),
      makeNode({ id: "member", group: "page" }),
    ];
    const impact = computeRemoveImpact(["page", "member"], nodes);
    expect(impact.cascade).toBe(0);
    expect(impact.removalSet).toEqual(new Set(["page", "member"]));
  });

  it("削除集合の外で親を失う子は detach に数える（parents / parentOptions の両方）", () => {
    const nodes = [
      makeNode({ id: "parent" }),
      makeNode({ id: "child", parents: ["parent"] }),
      makeNode({ id: "optChild", parentOptions: { parent: "branch1" } }),
      makeNode({ id: "unrelated" }),
    ];
    const impact = computeRemoveImpact(["parent"], nodes);
    expect(impact.detach).toBe(2);
  });

  it("削除集合の中の子は detach に数えない", () => {
    const nodes = [
      makeNode({ id: "parent" }),
      makeNode({ id: "child", parents: ["parent"] }),
    ];
    const impact = computeRemoveImpact(["parent", "child"], nodes);
    expect(impact.detach).toBe(0);
  });

  it("ロック(Fix)済みノードは巻き添え分も含めて locked に数える", () => {
    const nodes = [
      makeNode({ id: "page", kind: "goal", fixed: true }),
      makeNode({ id: "member", group: "page", fixed: true }),
      makeNode({ id: "free", group: "page" }),
    ];
    const impact = computeRemoveImpact(["page"], nodes);
    expect(impact.locked).toBe(2);
  });
});

describe("removeImpactWarnings", () => {
  it("巻き添えが無ければ空配列（普通の削除＝追加の警告不要）", () => {
    const impact = computeRemoveImpact(["a"], [makeNode({ id: "a" })]);
    expect(removeImpactWarnings(impact)).toEqual([]);
  });

  it("locked → cascade → detach の順で件数入りの警告を出す", () => {
    const warnings = removeImpactWarnings({
      cascade: 2,
      detach: 3,
      locked: 1,
      removalSet: new Set(),
    });
    expect(warnings).toEqual([
      "ロック(Fix)中のノード 1 件を含みます",
      "ページ内のノード 2 件もまとめて削除されます",
      "残る子ノード 3 件は依存から切り離されます",
    ]);
  });
});

describe("buildRemoveMessage", () => {
  it("警告が無ければ本文そのまま", () => {
    expect(buildRemoveMessage("消しますか？", [])).toBe("消しますか？");
  });

  it("警告があれば空行を挟んで ⚠ 行を続ける", () => {
    expect(buildRemoveMessage("消しますか？", ["A", "B"])).toBe("消しますか？\n\n⚠ A\n⚠ B");
  });
});
