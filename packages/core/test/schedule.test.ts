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
    expect(formatSchedule({ type: "weekly", weekdays: ["mon"], hour: 9, minute: 5 })).toBe(
      "weekly mon 09:05",
    );
  });

  it("parse→format の往復が正規形へ戻る（UI の構造化入力が保存する形）", () => {
    for (const raw of [
      "every 15m",
      "every 2h",
      "every 3d",
      "daily 09:00",
      "weekly mon 09:00",
      "biweekly fri 18:30",
      "monthly 2 tue 09:00",
      "yearly 4 2 tue 09:00",
      // 2026-08-12 追加分（毎月◯日・最終日・最終◯曜・毎年◯月◯日・1回だけ・複数曜日・N週ごと）
      "every 2w",
      "weekly mon,wed,fri 09:00",
      "monthly day 25 09:00",
      "monthly day 1,15 09:00",
      "monthly lastday 18:00",
      "monthly last fri 17:30",
      "yearly day 4 1 09:00",
      "yearly lastday 3 18:00",
      "once 2026-09-01 09:00",
    ]) {
      const parsed = parseSchedule(raw);
      expect(parsed).not.toBeNull();
      if (!parsed || parsed.type === "cron") throw new Error("unreachable");
      expect(formatSchedule(parsed)).toBe(raw);
    }
  });

  it("biweekly/monthly/yearly の構造と不正値（2026-08-12 追加書式）", () => {
    expect(parseSchedule("biweekly mon 09:00")).toMatchObject({ type: "biweekly", weekday: "mon" });
    expect(parseSchedule("monthly 2 tue 09:00")).toMatchObject({ type: "monthly", nth: 2, weekday: "tue" });
    expect(parseSchedule("yearly 4 2 tue 09:00")).toMatchObject({
      type: "yearly",
      month: 4,
      nth: 2,
      weekday: "tue",
    });
    expect(parseSchedule("monthly 0 tue 09:00")).toBeNull(); // 第0は無い
    expect(parseSchedule("monthly 6 tue 09:00")).toBeNull(); // 第6は無い
    expect(parseSchedule("yearly 13 1 mon 09:00")).toBeNull(); // 13月は無い
    expect(parseSchedule("biweekly mon 25:00")).toBeNull(); // 範囲外時刻
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
    expect(describeSchedule("biweekly fri 18:30")).toBe("隔週金曜 18:30");
    expect(describeSchedule("monthly 2 tue 09:00")).toBe("毎月第2火曜 09:00");
    expect(describeSchedule("yearly 4 2 tue 09:00")).toBe("毎年4月の第2火曜 09:00");
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

// 2026-08-12「あらゆるタイミングが登録できるように、他のOSSと比べて足りてないものは
// 入れておいて」で足した書式。cron では書けない最終日・最終◯曜・1回だけと、
// 他のスケジューラでは当たり前に使える cron の名前・?・マクロ。
describe("2026-08-12 追加分の文法", () => {
  it("毎月◯日（複数可。無い日の月はスキップする仕様）", () => {
    expect(parseSchedule("monthly day 25 09:00")).toMatchObject({ type: "monthlyDay", days: [25] });
    expect(parseSchedule("monthly day 1,15 09:00")).toMatchObject({
      type: "monthlyDay",
      days: [1, 15],
    });
    expect(parseSchedule("monthly day 15,1 09:00")).toMatchObject({ days: [1, 15] }); // 昇順に整列
    expect(parseSchedule("monthly day 0 09:00")).toBeNull();
    expect(parseSchedule("monthly day 32 09:00")).toBeNull();
  });

  it("毎月最終日・毎月最終◯曜", () => {
    expect(parseSchedule("monthly lastday 18:00")).toMatchObject({ type: "monthlyLastDay", hour: 18 });
    expect(parseSchedule("monthly last fri 17:30")).toMatchObject({
      type: "monthlyLastDow",
      weekday: "fri",
    });
  });

  it("毎年◯月◯日・毎年◯月の最終日", () => {
    expect(parseSchedule("yearly day 4 1 09:00")).toMatchObject({ type: "yearlyDay", month: 4, day: 1 });
    expect(parseSchedule("yearly lastday 3 18:00")).toMatchObject({ type: "yearlyLastDay", month: 3 });
    expect(parseSchedule("yearly day 13 1 09:00")).toBeNull(); // 13月は無い
  });

  it("1回だけ（実在しない日付は拒否）", () => {
    expect(parseSchedule("once 2026-09-01 09:00")).toMatchObject({
      type: "once",
      year: 2026,
      month: 9,
      day: 1,
    });
    expect(parseSchedule("once 2026-02-30 09:00")).toBeNull();
    expect(parseSchedule("once 2026-13-01 09:00")).toBeNull();
  });

  it("毎週は複数曜日を持てる（平日だけ・週2回が1本で書ける）", () => {
    expect(parseSchedule("weekly mon,wed,fri 09:00")).toMatchObject({
      type: "weekly",
      weekdays: ["mon", "wed", "fri"],
    });
    // 曜日順（日曜始まり）に整列し、重複は畳む
    expect(parseSchedule("weekly fri,mon,mon 09:00")).toMatchObject({ weekdays: ["mon", "fri"] });
    expect(parseSchedule("weekly mon,xxx 09:00")).toBeNull();
  });

  it("every に週（w）を足した", () => {
    expect(parseSchedule("every 2w")).toMatchObject({ type: "every", amount: 2, unit: "w" });
    expect(parseSchedule("every 2w")?.type === "every" && parseSchedule("every 2w")).toMatchObject({
      ms: 14 * 24 * 60 * 60 * 1000,
    });
  });

  it("cron: 曜日・月の名前、?、@マクロ（他のスケジューラ互換）", () => {
    expect(parseSchedule("0 9 * * mon")).toMatchObject({ type: "cron" });
    expect(parseSchedule("0 9 * jan-mar *")).toMatchObject({ type: "cron" });
    expect(parseSchedule("0 9 1 * ?")).toMatchObject({ type: "cron" });
    expect(parseSchedule("@daily")).toMatchObject({ type: "cron" });
    expect(parseSchedule("@hourly")).toMatchObject({ type: "cron" });
    expect(parseSchedule("@nope")).toBeNull();
  });

  it("読み下し", () => {
    expect(describeSchedule("monthly day 25 09:00")).toBe("毎月25日 09:00");
    expect(describeSchedule("monthly day 1,15 09:00")).toBe("毎月1・15日 09:00");
    expect(describeSchedule("monthly lastday 18:00")).toBe("毎月最終日 18:00");
    expect(describeSchedule("monthly last fri 17:30")).toBe("毎月最終金曜 17:30");
    expect(describeSchedule("weekly mon,wed,fri 09:00")).toBe("毎週月・水・金曜 09:00");
    expect(describeSchedule("yearly day 4 1 09:00")).toBe("毎年4月1日 09:00");
    expect(describeSchedule("yearly lastday 3 18:00")).toBe("毎年3月の最終日 18:00");
    expect(describeSchedule("once 2026-09-01 09:00")).toBe("2026年9月1日 09:00（1回だけ）");
    expect(describeSchedule("every 2w")).toBe("2週間ごと");
  });
});
