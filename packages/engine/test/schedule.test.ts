import { describe, expect, it } from "vitest";
import { parseSchedule, shouldCreateScheduledRun } from "../src/schedule.js";

describe("parseSchedule", () => {
  // every の amount/unit は 2026-08-12 追加（UI の構造化スケジュール入力がフォーム初期値に使う。
  // パースの正本は core/src/schedule.ts へ移動）
  it("'every 15m' を15分間隔としてパースする", () => {
    expect(parseSchedule("every 15m")).toEqual({ type: "every", ms: 15 * 60 * 1000, amount: 15, unit: "m", raw: "every 15m" });
  });

  it("'every 2h' を2時間間隔としてパースする", () => {
    expect(parseSchedule("every 2h")).toEqual({ type: "every", ms: 2 * 60 * 60 * 1000, amount: 2, unit: "h", raw: "every 2h" });
  });

  it("'daily 09:00' を日次9:00としてパースする", () => {
    expect(parseSchedule("daily 09:00")).toEqual({ type: "daily", hour: 9, minute: 0, raw: "daily 09:00" });
  });

  it("'every 3d' を3日間隔としてパースする", () => {
    expect(parseSchedule("every 3d")).toEqual({
      type: "every",
      ms: 3 * 24 * 60 * 60 * 1000,
      amount: 3,
      unit: "d",
      raw: "every 3d",
    });
  });

  it("'weekly mon 09:00' を毎週月曜9:00としてパースする", () => {
    expect(parseSchedule("weekly mon 09:00")).toEqual({
      type: "weekly",
      weekday: "mon",
      hour: 9,
      minute: 0,
      raw: "weekly mon 09:00",
    });
  });

  it("前後の空白は無視する", () => {
    expect(parseSchedule("  every 5m  ")).toEqual({ type: "every", ms: 5 * 60 * 1000, amount: 5, unit: "m", raw: "  every 5m  " });
  });

  it("不正な書式(単位なし・範囲外時刻・無関係な文字列)はnull", () => {
    expect(parseSchedule("every 15")).toBeNull();
    expect(parseSchedule("daily 25:00")).toBeNull();
    expect(parseSchedule("daily 09:60")).toBeNull();
    expect(parseSchedule("weekly xyz 09:00")).toBeNull(); // 未対応の曜日表記
    expect(parseSchedule("weekly mon 25:00")).toBeNull(); // 範囲外時刻
    expect(parseSchedule("every 0m")).toBeNull();
  });
});

describe("shouldCreateScheduledRun: every", () => {
  it("最新ランが無ければtrue", () => {
    const schedule = parseSchedule("every 15m")!;
    const now = new Date("2026-01-01T00:20:00Z");
    expect(shouldCreateScheduledRun(schedule, null, now)).toBe(true);
  });

  it("経過時間がN未満ならfalse", () => {
    const schedule = parseSchedule("every 15m")!;
    const latestRun = { created: "2026-01-01T00:10:00Z" };
    const now = new Date("2026-01-01T00:20:00Z"); // 10分経過 < 15分
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(false);
  });

  it("経過時間がN以上ならtrue", () => {
    const schedule = parseSchedule("every 15m")!;
    const latestRun = { created: "2026-01-01T00:00:00Z" };
    const now = new Date("2026-01-01T00:15:00Z"); // ちょうど15分経過
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(true);
  });
});

describe("shouldCreateScheduledRun: every (日単位)", () => {
  it("経過日数がN未満ならfalse", () => {
    const schedule = parseSchedule("every 2d")!;
    const latestRun = { created: "2026-01-01T00:00:00Z" };
    const now = new Date("2026-01-02T12:00:00Z"); // 1.5日経過 < 2日
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(false);
  });

  it("経過日数がN以上ならtrue", () => {
    const schedule = parseSchedule("every 2d")!;
    const latestRun = { created: "2026-01-01T00:00:00Z" };
    const now = new Date("2026-01-03T00:00:00Z"); // ちょうど2日経過
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(true);
  });
});

describe("shouldCreateScheduledRun: weekly", () => {
  // 2026-01-05 は月曜, 2026-01-07 は水曜, 2026-01-12 は次の月曜（node -e で確認済み）
  it("対象曜日で目標時刻より前ならfalse", () => {
    const schedule = parseSchedule("weekly mon 09:00")!;
    const now = new Date(2026, 0, 5, 8, 59); // 月曜 08:59
    expect(shouldCreateScheduledRun(schedule, null, now)).toBe(false);
  });

  it("対象曜日で目標時刻を過ぎていて、最新ランが無ければtrue", () => {
    const schedule = parseSchedule("weekly mon 09:00")!;
    const now = new Date(2026, 0, 5, 9, 5); // 月曜 09:05
    expect(shouldCreateScheduledRun(schedule, null, now)).toBe(true);
  });

  it("今週の分が既にあればfalse", () => {
    const schedule = parseSchedule("weekly mon 09:00")!;
    const now = new Date(2026, 0, 5, 9, 30); // 月曜 09:30
    const latestRun = { created: new Date(2026, 0, 5, 9, 1).toISOString() }; // 同じ月曜09:01に生成済み
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(false);
  });

  it("対象曜日でない日でも、今週分の対象曜日を過ぎていて未生成ならtrue", () => {
    const schedule = parseSchedule("weekly mon 09:00")!;
    const now = new Date(2026, 0, 7, 10, 0); // 水曜（今週の月曜09:00は既に過ぎている）
    const latestRun = { created: new Date(2025, 11, 29, 9, 5).toISOString() }; // 前週の月曜
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(true);
  });

  it("対象曜日でない日で、今週分が既にあればfalse", () => {
    const schedule = parseSchedule("weekly mon 09:00")!;
    const now = new Date(2026, 0, 7, 10, 0); // 水曜
    const latestRun = { created: new Date(2026, 0, 5, 9, 5).toISOString() }; // 今週の月曜
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(false);
  });
});

describe("shouldCreateScheduledRun: daily", () => {
  it("目標時刻より前ならfalse", () => {
    const schedule = parseSchedule("daily 09:00")!;
    const now = new Date(2026, 0, 1, 8, 59); // ローカル 08:59
    expect(shouldCreateScheduledRun(schedule, null, now)).toBe(false);
  });

  it("目標時刻を過ぎていて今日の分がまだ無ければtrue", () => {
    const schedule = parseSchedule("daily 09:00")!;
    const now = new Date(2026, 0, 1, 9, 5); // ローカル 09:05
    const latestRun = { created: new Date(2025, 11, 31, 9, 5).toISOString() }; // 前日
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(true);
  });

  it("今日の分が既にあればfalse", () => {
    const schedule = parseSchedule("daily 09:00")!;
    const now = new Date(2026, 0, 1, 9, 30);
    const latestRun = { created: new Date(2026, 0, 1, 9, 1).toISOString() }; // 今日の09:01に生成済み
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(false);
  });
});

describe("shouldCreateScheduledRun: biweekly（2026-08-12 追加。錨は最後のラン実績）", () => {
  // 2026-01-05 / 01-12 は月曜（weekly のテストと同じ暦）
  it("最新ランが無ければtrue（最初のランの週が錨になる）", () => {
    const schedule = parseSchedule("biweekly mon 09:00")!;
    const now = new Date(2026, 0, 5, 9, 5); // 月曜 09:05
    expect(shouldCreateScheduledRun(schedule, null, now)).toBe(true);
  });

  it("対象曜日で目標時刻より前ならfalse（weeklyと同じガード）", () => {
    const schedule = parseSchedule("biweekly mon 09:00")!;
    const now = new Date(2026, 0, 12, 8, 59);
    expect(shouldCreateScheduledRun(schedule, null, now)).toBe(false);
  });

  it("先週にランがある（=今回は休みの週）ならfalse", () => {
    const schedule = parseSchedule("biweekly mon 09:00")!;
    const now = new Date(2026, 0, 14, 10, 0); // 水曜。直近の対象時刻は 01-12(月) 09:00
    const latestRun = { created: new Date(2026, 0, 5, 9, 5).toISOString() }; // 1週間前の月曜に実行済み
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(false);
  });

  it("最後のランが2週間前ならtrue", () => {
    const schedule = parseSchedule("biweekly mon 09:00")!;
    const now = new Date(2026, 0, 14, 10, 0); // 直近の対象時刻は 01-12(月) 09:00
    const latestRun = { created: new Date(2025, 11, 29, 9, 5).toISOString() }; // 2週間前の月曜
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(true);
  });
});

describe("shouldCreateScheduledRun: monthly（毎月第n曜日。2026-08-12 追加）", () => {
  // 2026-01 の月曜: 5, 12, 19, 26（第2月曜=01-12）。2026-02 の第2月曜=02-09
  it("対象日当日で目標時刻より前ならfalse", () => {
    const schedule = parseSchedule("monthly 2 mon 09:00")!;
    const now = new Date(2026, 0, 12, 8, 59); // 第2月曜 08:59
    expect(shouldCreateScheduledRun(schedule, null, now)).toBe(false);
  });

  it("直近の第n曜日を過ぎていて未生成ならtrue", () => {
    const schedule = parseSchedule("monthly 2 mon 09:00")!;
    const now = new Date(2026, 0, 20, 10, 0); // 01-12 は過ぎている
    const latestRun = { created: new Date(2025, 11, 8, 9, 5).toISOString() }; // 前月（12月第2月曜）
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(true);
  });

  it("今月の分が既にあればfalse", () => {
    const schedule = parseSchedule("monthly 2 mon 09:00")!;
    const now = new Date(2026, 0, 20, 10, 0);
    const latestRun = { created: new Date(2026, 0, 12, 9, 5).toISOString() };
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(false);
  });

  it("翌月の第n曜日を過ぎたらまたtrue", () => {
    const schedule = parseSchedule("monthly 2 mon 09:00")!;
    const now = new Date(2026, 1, 9, 9, 5); // 2026-02-09 = 2月の第2月曜 09:05
    const latestRun = { created: new Date(2026, 0, 12, 9, 5).toISOString() };
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(true);
  });

  it("第5が無い月はスキップ（直近の存在する第5曜日で判定）", () => {
    // 2026-01 の金曜: 2,9,16,23,30（第5金曜=01-30）。2026-02 は第5金曜なし
    const schedule = parseSchedule("monthly 5 fri 09:00")!;
    const now = new Date(2026, 1, 28, 10, 0); // 2月末。直近の第5金曜は 01-30
    const latestRun = { created: new Date(2026, 0, 30, 9, 5).toISOString() };
    expect(shouldCreateScheduledRun(schedule, latestRun, now)).toBe(false); // 2月ぶんは作らない
  });
});

describe("shouldCreateScheduledRun: yearly（毎年◯月の第n曜日。2026-08-12 追加）", () => {
  // 2026-01 の第2月曜 = 01-12（成人の日パターン）
  it("今年の分が既にあればfalse・未生成ならtrue", () => {
    const schedule = parseSchedule("yearly 1 2 mon 09:00")!;
    const now = new Date(2026, 2, 1, 10, 0); // 3月（今年の1月第2月曜は過ぎている）
    const done = { created: new Date(2026, 0, 12, 9, 5).toISOString() };
    expect(shouldCreateScheduledRun(schedule, done, now)).toBe(false);
    const lastYear = { created: new Date(2025, 0, 13, 9, 5).toISOString() }; // 去年の分
    expect(shouldCreateScheduledRun(schedule, lastYear, now)).toBe(true);
  });

  it("対象日当日で目標時刻より前ならfalse", () => {
    const schedule = parseSchedule("yearly 1 2 mon 09:00")!;
    const now = new Date(2026, 0, 12, 8, 59);
    expect(shouldCreateScheduledRun(schedule, null, now)).toBe(false);
  });
});

describe("shouldCreateScheduledRun: 実行中ランがあっても定刻でランを作る（2026-08-08 修正）", () => {
  it("実行中ランの有無は判定に影響しない（旧仕様では常にfalseだった）", () => {
    const every = parseSchedule("every 15m")!;
    const daily = parseSchedule("daily 09:00")!;
    const weekly = parseSchedule("weekly mon 09:00")!;
    const cron = parseSchedule("* * * * *")!;
    const now = new Date(2026, 0, 5, 10, 0); // 月曜 10:00（weeklyの目標時刻も過ぎている）
    // 「前のランが人間の回答待ちで running のまま」でも、次の定刻ぶんは生成される
    expect(shouldCreateScheduledRun(every, null, now)).toBe(true);
    expect(shouldCreateScheduledRun(daily, null, now)).toBe(true);
    expect(shouldCreateScheduledRun(weekly, null, now)).toBe(true);
    expect(shouldCreateScheduledRun(cron, null, now)).toBe(true);
  });

  it("同じ周期での二重生成は latestRun 側の判定が防ぐ", () => {
    const every = parseSchedule("every 15m")!;
    const now = new Date(2026, 0, 5, 10, 0);
    const recent = { created: new Date(2026, 0, 5, 9, 50).toISOString() }; // 10分前
    expect(shouldCreateScheduledRun(every, recent, now)).toBe(false);
  });
});

describe("cron 書式（2026-08-07 追加）", () => {
  it("* * * * * は毎分マッチし、同じ分の二重生成はしない", () => {
    const schedule = parseSchedule("* * * * *")!;
    expect(schedule.type).toBe("cron");
    const now = new Date(2026, 0, 1, 9, 30, 20);
    expect(shouldCreateScheduledRun(schedule, null, now)).toBe(true);
    // この分の開始以降に生成済みなら見送り
    const sameMinute = { created: new Date(2026, 0, 1, 9, 30, 5).toISOString() };
    expect(shouldCreateScheduledRun(schedule, sameMinute, now)).toBe(false);
    // 前の分の生成なら新しく作る
    const prevMinute = { created: new Date(2026, 0, 1, 9, 29, 50).toISOString() };
    expect(shouldCreateScheduledRun(schedule, prevMinute, now)).toBe(true);
  });

  it("*/15 9-23 * * * は 9-23時の15分刻みだけマッチ", () => {
    const schedule = parseSchedule("*/15 9-23 * * *")!;
    expect(schedule.type).toBe("cron");
    expect(shouldCreateScheduledRun(schedule, null, new Date(2026, 0, 1, 9, 15))).toBe(true);
    expect(shouldCreateScheduledRun(schedule, null, new Date(2026, 0, 1, 9, 16))).toBe(false);
    expect(shouldCreateScheduledRun(schedule, null, new Date(2026, 0, 1, 8, 15))).toBe(false);
  });

  it("0 17 * * 1 は月曜17:00だけマッチ", () => {
    const schedule = parseSchedule("0 17 * * 1")!;
    expect(shouldCreateScheduledRun(schedule, null, new Date(2026, 0, 5, 17, 0))).toBe(true); // 月曜
    expect(shouldCreateScheduledRun(schedule, null, new Date(2026, 0, 6, 17, 0))).toBe(false); // 火曜
    expect(shouldCreateScheduledRun(schedule, null, new Date(2026, 0, 5, 16, 59))).toBe(false);
  });

  it("0 9 1 * * は毎月1日9:00だけマッチ（dom 指定）", () => {
    const schedule = parseSchedule("0 9 1 * *")!;
    expect(shouldCreateScheduledRun(schedule, null, new Date(2026, 1, 1, 9, 0))).toBe(true);
    expect(shouldCreateScheduledRun(schedule, null, new Date(2026, 1, 2, 9, 0))).toBe(false);
  });


  it("フィールド数や値が不正なら null（従来どおり警告ログ側へ）", () => {
    expect(parseSchedule("* * * *")).toBe(null);
    expect(parseSchedule("61 * * * *")).toBe(null);
    expect(parseSchedule("こんにちは")).toBe(null);
  });
});
