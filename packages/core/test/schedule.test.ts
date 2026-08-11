import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  formatSchedule,
  parseCron,
  parseSchedule,
} from "../src/schedule.js";

// パース自体の網羅（every/daily/weekly/cron の受理・拒否、cron のフィールド解釈）は
// engine 側の test/schedule.test.ts が持っている（移動前からの資産。engine は core から
// 再エクスポートしているのでそのまま効く）。ここでは core へ移動した際に足した
// 整形（formatSchedule / describeSchedule）と、UI が頼る「parse→format の往復が原文へ戻る」
// 性質だけを見る。

describe("formatSchedule", () => {
  it("every/daily/weekly を組み立てる（HH:MM はゼロ埋め）", () => {
    expect(formatSchedule({ type: "every", amount: 15, unit: "m" })).toBe("every 15m");
    expect(formatSchedule({ type: "daily", hour: 9, minute: 0 })).toBe("daily 09:00");
    expect(formatSchedule({ type: "weekly", weekday: "mon", hour: 9, minute: 5 })).toBe(
      "weekly mon 09:05",
    );
  });

  it("parse→format の往復が正規形へ戻る（UI の構造化入力が保存する形）", () => {
    for (const raw of ["every 15m", "every 2h", "every 3d", "daily 09:00", "weekly mon 09:00"]) {
      const parsed = parseSchedule(raw);
      expect(parsed).not.toBeNull();
      if (!parsed || parsed.type === "cron") throw new Error("unreachable");
      expect(formatSchedule(parsed)).toBe(raw);
    }
  });

  it("parseSchedule は every の amount/unit を構造として返す（UI のフォーム初期値）", () => {
    expect(parseSchedule("every 90m")).toMatchObject({ type: "every", amount: 90, unit: "m" });
  });
});

describe("describeSchedule", () => {
  it("対応書式を日本語の読み下しにする", () => {
    expect(describeSchedule("every 15m")).toBe("15分ごと");
    expect(describeSchedule("every 2h")).toBe("2時間ごと");
    expect(describeSchedule("every 3d")).toBe("3日ごと");
    expect(describeSchedule("daily 9:00")).toBe("毎日 09:00");
    expect(describeSchedule("weekly mon 09:00")).toBe("毎週月曜 09:00");
    expect(describeSchedule("*/15 9-23 * * *")).toBe("cron式（*/15 9-23 * * *）");
  });

  it("未設定・解釈できない書式は null（UI は警告表示へ切り替える）", () => {
    expect(describeSchedule(null)).toBeNull();
    expect(describeSchedule("")).toBeNull();
    expect(describeSchedule("every day")).toBeNull();
    expect(describeSchedule("mainte 09:00")).toBeNull();
  });
});

describe("parseCron（coreへの移動でエクスポート面が変わっていないことの確認）", () => {
  it("5フィールドを解釈し、式でなければ null", () => {
    expect(parseCron("*/15 9-23 * * *")).not.toBeNull();
    expect(parseCron("every 15m")).toBeNull();
  });
});
