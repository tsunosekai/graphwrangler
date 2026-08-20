// 「同じ人の人間作業が連続しているか」の判定（src/turn.ts）。
// 2026-08-20 本人指示「人間実行ノードかつ担当者が同じタスクが連続している場合のみ
// 通知が出ないようにしてね」の仕様をここで固定する。
import { describe, expect, it } from "vitest";
import { isConsecutiveHumanTurn, sameTurnOwner, type TurnParent } from "../src/turn.js";

const human = (assignee: string | null = null, ran = true): TurnParent => ({
  kind: "task",
  executor: "human",
  assignee,
  ran,
});
const ai = (ran = true): TurnParent => ({ kind: "task", executor: "ai", assignee: null, ran });

/** id → 親、の引き当てを作る */
const from = (map: Record<string, TurnParent>) => (id: string) => map[id];

describe("sameTurnOwner", () => {
  it("未割当どうしは同じ宛先（1人運用・未割当運用でも連続を判定できる必要がある）", () => {
    expect(sameTurnOwner(null, null)).toBe(true);
  });

  it("片方だけ未割当なら別（全員宛と個人宛は同じではない）", () => {
    expect(sameTurnOwner(null, "a@example.com")).toBe(false);
    expect(sameTurnOwner("a@example.com", null)).toBe(false);
  });

  it("メールは大文字小文字・前後空白を無視して比べる", () => {
    expect(sameTurnOwner("A@Example.com", " a@example.com ")).toBe(true);
    expect(sameTurnOwner("a@example.com", "b@example.com")).toBe(false);
  });
});

describe("isConsecutiveHumanTurn", () => {
  const node = (over: Partial<Parameters<typeof isConsecutiveHumanTurn>[0]> = {}) => ({
    kind: "task",
    executor: "human",
    assignee: null,
    parents: ["p1"],
    ...over,
  });

  it("直前が同じ担当者の人間ノードなら連続（＝黙る対象）", () => {
    expect(isConsecutiveHumanTurn(node(), from({ p1: human() }))).toBe(true);
    expect(
      isConsecutiveHumanTurn(node({ assignee: "a@example.com" }), from({ p1: human("A@example.com") })),
    ).toBe(true);
  });

  it("区間の先頭（親なし）は連続ではない＝鳴らす", () => {
    expect(isConsecutiveHumanTurn(node({ parents: [] }), from({}))).toBe(false);
  });

  it("直前がAI・スクリプトなら鳴らす（人間にとって新しい知らせ）", () => {
    expect(isConsecutiveHumanTurn(node(), from({ p1: ai() }))).toBe(false);
  });

  it("担当者が違えば鳴らす（別の人の作業が終わって回ってきた番）", () => {
    expect(
      isConsecutiveHumanTurn(node({ assignee: "a@example.com" }), from({ p1: human("b@example.com") })),
    ).toBe(false);
  });

  it("合流点は「実際に行われた親が全部」同じ人の人間ノードのときだけ連続", () => {
    const parents = { p1: human(), p2: ai() };
    expect(isConsecutiveHumanTurn(node({ parents: ["p1", "p2"] }), from(parents))).toBe(false);
    expect(isConsecutiveHumanTurn(node({ parents: ["p1", "p2"] }), from({ p1: human(), p2: human() }))).toBe(
      true,
    );
  });

  it("行われなかった親（skipped/dropped の枝）は数えない", () => {
    // AI の親が skipped されているので、実際の直前は人間ノードだけ＝連続
    expect(
      isConsecutiveHumanTurn(node({ parents: ["p1", "p2"] }), from({ p1: human(), p2: ai(false) })),
    ).toBe(true);
    // 実際に行われた親が1つも無ければ連続ではない
    expect(isConsecutiveHumanTurn(node({ parents: ["p1"] }), from({ p1: human(null, false) }))).toBe(false);
  });

  it("自分がAI・スクリプトのノードなら対象外（「あなたの番」が来ない）", () => {
    expect(isConsecutiveHumanTurn(node({ executor: "ai" }), from({ p1: human() }))).toBe(false);
  });

  it("消えた親（引き当てられない）は数えない", () => {
    expect(isConsecutiveHumanTurn(node(), from({}))).toBe(false);
  });
});
