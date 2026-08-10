// 左レールのドットの色ルール（lib/railDots.ts）。2026-08-08 本人指定の
// 「色は常に担当の色、例外はあなたの番の橙だけ。終わったものは薄く」を固めるテスト。
import { describe, expect, it } from "vitest";
import { SEAT_ORDER, isSettled, seatColor, seatOf } from "./railDots";

describe("seatOf", () => {
  it("決着済み（完了・中止・スキップ）は担当に関わらず done の席", () => {
    expect(seatOf("done", "human")).toBe("done");
    expect(seatOf("dropped", "ai")).toBe("done");
    expect(seatOf("skipped", "script")).toBe("done");
  });

  it("あなたの番（waiting）は attention の席", () => {
    expect(seatOf("waiting", "human")).toBe("attention");
    expect(seatOf("waiting", "script")).toBe("attention");
  });

  it("それ以外は担当の席", () => {
    expect(seatOf("pending", "ai")).toBe("ai");
    expect(seatOf("running", "script")).toBe("script");
    expect(seatOf("unplanned", "human")).toBe("human");
  });

  it("席の並びは あなたの番 → 人間 → AI → スクリプト → 完了系", () => {
    const seats = [
      seatOf("done", "human"),
      seatOf("pending", "script"),
      seatOf("waiting", "ai"),
      seatOf("running", "human"),
      seatOf("pending", "ai"),
    ];
    const sorted = [...seats].sort((a, b) => SEAT_ORDER.indexOf(a) - SEAT_ORDER.indexOf(b));
    expect(sorted).toEqual(["attention", "human", "ai", "script", "done"]);
  });
});

describe("seatColor", () => {
  it("色は担当の色。終わっていても塗り替えない（薄くするのは isSettled 側の仕事）", () => {
    expect(seatColor("pending", "human")).toBe("var(--human)");
    expect(seatColor("done", "human")).toBe("var(--human)");
    expect(seatColor("dropped", "ai")).toBe("var(--ai)");
    expect(seatColor("skipped", "script")).toBe("var(--script)");
  });

  it("唯一の例外があなたの番（waiting）= 橙", () => {
    expect(seatColor("waiting", "human")).toBe("var(--attention)");
    expect(seatColor("waiting", "ai")).toBe("var(--attention)");
  });
});

describe("isSettled", () => {
  it("完了・中止・スキップだけが薄い点", () => {
    expect(isSettled("done")).toBe(true);
    expect(isSettled("dropped")).toBe(true);
    expect(isSettled("skipped")).toBe(true);
    expect(isSettled("pending")).toBe(false);
    expect(isSettled("running")).toBe(false);
    expect(isSettled("waiting")).toBe(false);
    expect(isSettled("unplanned")).toBe(false);
  });
});
