// カードの「状態 → 表示」の導出（state.ts）。同じノードでも 素のノード / テンプレート /
// ラン投影中 / ランのページ の4通りで見え方と出すボタンが変わる分岐なので、そこを固める。
import { describe, expect, it } from "vitest";
import { makeNode } from "../../lib/testutil";
import type { Node, RunItemStatus } from "../../types";
import { deriveCardState } from "./state";
import type { NodeCardData } from "./types";

/** 描画用のコールバックはこのテストでは使わないので空実装で埋める */
const cardData = (node: Node, over: Partial<NodeCardData> = {}): NodeCardData => ({
  node,
  selected: false,
  editing: false,
  onSelect: () => {},
  onDoubleClick: () => {},
  onCommitTitle: () => {},
  onCancelEdit: () => {},
  ...over,
});
const runItem = (status: RunItemStatus) => ({ runId: "r1", status, note: null });

describe("visualStatus / showStatus", () => {
  it("素のノードは自分の status をそのまま見せる", () => {
    const s = deriveCardState(cardData(makeNode({ id: "n", status: "running" })));
    expect(s).toMatchObject({ projecting: false, showStatus: true, visualStatus: "running" });
  });

  it("判断リクエストが開いていれば status より「あなたの番」を優先する（旧プロセスの取り残し対策）", () => {
    const s = deriveCardState(cardData(makeNode({ id: "n", status: "running", pendingRequest: "m1" })));
    expect(s.visualStatus).toBe("waiting");
    expect(s.showTurn).toBe(true);
  });

  it("テンプレートは status 由来の見た目を出さない（ランを持たない間）", () => {
    const s = deriveCardState(cardData(makeNode({ id: "n", status: "done" }), { isTemplate: true }));
    expect(s).toMatchObject({ projecting: false, showStatus: false, dimmed: false, showTurn: false });
  });

  it("ラン投影中はワークアイテムの status を重ねる", () => {
    const s = deriveCardState(
      cardData(makeNode({ id: "n", status: "pending" }), {
        isTemplate: true,
        runItem: runItem("waiting"),
      }),
    );
    expect(s).toMatchObject({ projecting: true, showStatus: true, visualStatus: "waiting", showTurn: true });
  });

  it("決着済み（完了・中止・スキップ）は薄くする", () => {
    for (const status of ["done", "dropped", "skipped"] as const) {
      expect(deriveCardState(cardData(makeNode({ id: "n", status }))).dimmed).toBe(true);
    }
    expect(deriveCardState(cardData(makeNode({ id: "n", status: "pending" }))).dimmed).toBe(false);
  });
});

describe("runButtons（ラン投影中の段階式アクション）", () => {
  const projected = (over: Partial<Node>, item: RunItemStatus, isRunFrontier = true) =>
    deriveCardState(
      cardData(makeNode({ id: "n", executor: "human", kind: "task", ...over }), {
        isTemplate: true,
        runItem: runItem(item),
        isRunFrontier,
      }),
    ).runButtons.map((b) => b.label);

  it("ラン内フロンティアの pending / waiting は「着手」「完了」", () => {
    expect(projected({}, "pending")).toEqual(["着手", "完了"]);
    expect(projected({}, "waiting")).toEqual(["着手", "完了"]);
  });

  it("running は「完了」「戻す」", () => {
    expect(projected({}, "running")).toEqual(["完了", "戻す"]);
  });

  it("順番が来ていない（フロンティアでない）pending には出さない", () => {
    expect(projected({}, "pending", false)).toEqual([]);
  });

  it("担当が人間でない・分岐・完了済みには出さない（決着経路は「分岐を選ぶ」のみ）", () => {
    expect(projected({ executor: "ai" }, "pending")).toEqual([]);
    expect(projected({ kind: "decision" }, "pending")).toEqual([]);
    expect(projected({}, "done")).toEqual([]);
  });

  it("投影していないテンプレート・素のノードには出さない", () => {
    const plain = deriveCardState(cardData(makeNode({ id: "n", executor: "human" })));
    expect(plain.runButtons).toEqual([]);
  });
});

describe("phaseAction / unplanPatch（計画の梯子）", () => {
  it("未計画のタスクは status と lifecycle をまとめて計画済みにする", () => {
    const s = deriveCardState(cardData(makeNode({ id: "n", status: "unplanned", lifecycle: "draft" })));
    expect(s.phaseAction).toEqual({
      label: "計画済みにする",
      patch: { status: "pending", lifecycle: "committed" },
    });
  });

  it("トリガーは lifecycle だけ（status を持たせない）", () => {
    const s = deriveCardState(cardData(makeNode({ id: "n", kind: "trigger", lifecycle: "draft" })));
    expect(s.phaseAction).toEqual({ label: "計画済みにする", patch: { lifecycle: "committed" } });
  });

  it("実行フェーズに入った計画済みタスクは「完了」", () => {
    const s = deriveCardState(
      cardData(makeNode({ id: "n", status: "pending", lifecycle: "committed" }), { isFrontier: true }),
    );
    expect(s.phaseAction).toEqual({ label: "完了", patch: { status: "done" } });
  });

  it("ランのページではテンプレートの計画操作を出さない（直すのはテンプレート側）", () => {
    const s = deriveCardState(
      cardData(makeNode({ id: "n", status: "unplanned", lifecycle: "draft" }), { inRunPage: true }),
    );
    expect(s.phaseAction).toBeNull();
    expect(s.unplanPatch).toBeNull();
    expect(s.canRun).toBe(false);
  });

  it("「未計画に戻す」は計画済みのものにだけ出る（テンプレートは lifecycle も戻す）", () => {
    expect(deriveCardState(cardData(makeNode({ id: "n", status: "pending" }))).unplanPatch).toEqual({
      status: "unplanned",
    });
    const tmpl = deriveCardState(
      cardData(makeNode({ id: "n", status: "pending", lifecycle: "committed" }), { isTemplate: true }),
    );
    expect(tmpl.unplanPatch).toEqual({ status: "unplanned", lifecycle: "draft" });
    // 投影中（実行中のラン）は進捗操作と混ざるので出さない
    const projecting = deriveCardState(
      cardData(makeNode({ id: "n", status: "pending", lifecycle: "committed" }), {
        isTemplate: true,
        runItem: runItem("running"),
      }),
    );
    expect(projecting.unplanPatch).toBeNull();
  });
});

describe("canRun（ラン作成の可否）", () => {
  it("トリガーのテンプレート表示でだけ押せる", () => {
    const trigger = makeNode({ id: "t", kind: "trigger" });
    expect(deriveCardState(cardData(trigger)).canRun).toBe(true);
    // 表示中のランは作成済み——ここから作れるのは別のランなので出さない
    expect(deriveCardState(cardData(trigger, { isTemplate: true, runItem: runItem("running") })).canRun).toBe(
      false,
    );
    expect(deriveCardState(cardData(makeNode({ id: "n" }))).canRun).toBe(false);
  });
});

describe("showFoot（「未計画」の文字）", () => {
  it("素のノードの未計画にだけ出す（テンプレートには出さない）", () => {
    const unplanned = makeNode({ id: "n", status: "unplanned" });
    expect(deriveCardState(cardData(unplanned)).showFoot).toBe(true);
    expect(deriveCardState(cardData(unplanned, { isTemplate: true })).showFoot).toBe(false);
    expect(deriveCardState(cardData(makeNode({ id: "n", status: "pending" }))).showFoot).toBe(false);
  });
});
