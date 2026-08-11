// 行のドット（ちょぼ）の導出。色・席の規則そのものは lib/railDots.test.ts が持つので、
// ここは「行の材料から作った並び・色・薄さ」が規則どおりかだけを見る。
// 色ルールの正文（2026-08-08 本人指定）: 色は常に担当(executor)の色、唯一の例外が
// 「あなたの番」= 橙。終わったノードは色を変えず薄くする。
import { describe, expect, it } from "vitest";
import { makeNode } from "../../lib/testutil";
import type { Node, Run } from "../../types";
import { effStatus, pageDots, runDots } from "./dots";

const me = "me@example.com";

const run = (items: Run["items"]): Run => ({
  id: "r1",
  pageId: "page",
  title: "ラン",
  trigger: "trigger:t1:manual",
  status: "running",
  items,
  context: {},
  created: "2026-08-01T00:00:00.000Z",
});
const item = (status: Run["items"][string]["status"]): Run["items"][string] => ({
  status,
  note: null,
  choice: null,
  resolvedParams: null,
});

describe("effStatus", () => {
  it("判断リクエストが開いていれば status に関わらず「あなたの番」", () => {
    const n = makeNode({ id: "n", status: "pending", pendingRequest: "m1" });
    expect(effStatus(n, me)).toBe("waiting");
  });

  it("担当者が他人なら橙へ昇格させない（素の status のまま）", () => {
    const n = makeNode({ id: "n", status: "pending", pendingRequest: "m1", assignee: "other@example.com" });
    expect(effStatus(n, me)).toBe("pending");
  });

  it("担当者なし（全員宛）は自分の番", () => {
    const n = makeNode({ id: "n", status: "pending", pendingRequest: "m1", assignee: null });
    expect(effStatus(n, me)).toBe("waiting");
  });
});

describe("pageDots", () => {
  it("あなたの番 → 人間 → AI → スクリプト → 決着済み の順に並べる", () => {
    const members: Node[] = [
      makeNode({ id: "done", executor: "human", status: "done" }),
      makeNode({ id: "script", executor: "script" }),
      makeNode({ id: "ai", executor: "ai" }),
      makeNode({ id: "human", executor: "human" }),
      makeNode({ id: "turn", executor: "script", pendingRequest: "m1" }),
    ];
    expect(pageDots(members, me).map((d) => d.key)).toEqual(["turn", "human", "ai", "script", "done"]);
  });

  it("色は担当の色、あなたの番だけ橙。終わった粒は色を変えず薄くする", () => {
    const members: Node[] = [
      makeNode({ id: "ai", executor: "ai" }),
      makeNode({ id: "turn", executor: "ai", pendingRequest: "m1" }),
      makeNode({ id: "doneScript", executor: "script", status: "done" }),
    ];
    const byKey = Object.fromEntries(pageDots(members, me).map((d) => [d.key, d]));
    expect(byKey.ai).toMatchObject({ color: "var(--ai)", dim: false });
    expect(byKey.turn).toMatchObject({ color: "var(--attention)", dim: false });
    expect(byKey.doneScript).toMatchObject({ color: "var(--script)", dim: true });
  });

  it("メンバーが空なら粒も無い（呼び出し側が列ごと出さない判定に使う）", () => {
    expect(pageDots([], me)).toEqual([]);
  });
});

describe("runDots", () => {
  it("担当色はテンプレートノードから引き、テンプレートが無ければスクリプト扱い", () => {
    const nodeById = new Map([["a", makeNode({ id: "a", executor: "ai" })]]);
    const dots = runDots(run({ a: item("pending"), 消えたノード: item("pending") }), nodeById, me);
    const byKey = Object.fromEntries(dots.map((d) => [d.key, d]));
    expect(byKey.a.color).toBe("var(--ai)");
    expect(byKey["消えたノード"].color).toBe("var(--script)");
  });

  it("他人の番のワークアイテムは橙にしない（自分の番だけ橙）", () => {
    const nodeById = new Map([
      ["mine", makeNode({ id: "mine", executor: "human", assignee: me })],
      ["theirs", makeNode({ id: "theirs", executor: "human", assignee: "other@example.com" })],
    ]);
    const dots = runDots(run({ mine: item("waiting"), theirs: item("waiting") }), nodeById, me);
    const byKey = Object.fromEntries(dots.map((d) => [d.key, d]));
    expect(byKey.mine.color).toBe("var(--attention)");
    expect(byKey.theirs.color).toBe("var(--human)");
    // ヒント文は昇格前の生の状態を見せる（どちらも「回答待ち」）
    expect(byKey.theirs.title).toContain("回答待ち");
  });

  it("skipped も決着済みとして薄く沈める", () => {
    const nodeById = new Map([["s", makeNode({ id: "s", executor: "script" })]]);
    const [dot] = runDots(run({ s: item("skipped") }), nodeById, me);
    expect(dot).toMatchObject({ color: "var(--script)", dim: true });
  });
});
