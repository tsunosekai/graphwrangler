import { describe, expect, it } from "vitest";
import { parseSchedule, shouldCreateScheduledRun } from "../src/schedule.js";

describe("parseSchedule", () => {
  it("'every 15m' を15分間隔としてパースする", () => {
    expect(parseSchedule("every 15m")).toEqual({ type: "every", ms: 15 * 60 * 1000, raw: "every 15m" });
  });

  it("'every 2h' を2時間間隔としてパースする", () => {
    expect(parseSchedule("every 2h")).toEqual({ type: "every", ms: 2 * 60 * 60 * 1000, raw: "every 2h" });
  });

  it("'daily 09:00' を日次9:00としてパースする", () => {
    expect(parseSchedule("daily 09:00")).toEqual({ type: "daily", hour: 9, minute: 0, raw: "daily 09:00" });
  });

  it("前後の空白は無視する", () => {
    expect(parseSchedule("  every 5m  ")).toEqual({ type: "every", ms: 5 * 60 * 1000, raw: "  every 5m  " });
  });

  it("不正な書式(単位なし・範囲外時刻・無関係な文字列)はnull", () => {
    expect(parseSchedule("every 15")).toBeNull();
    expect(parseSchedule("daily 25:00")).toBeNull();
    expect(parseSchedule("daily 09:60")).toBeNull();
    expect(parseSchedule("weekly mon 09:00")).toBeNull();
    expect(parseSchedule("every 0m")).toBeNull();
  });
});

describe("shouldCreateScheduledRun: every", () => {
  it("最新ランが無ければtrue", () => {
    const schedule = parseSchedule("every 15m")!;
    const now = new Date("2026-01-01T00:20:00Z");
    expect(shouldCreateScheduledRun(schedule, null, now, false)).toBe(true);
  });

  it("経過時間がN未満ならfalse", () => {
    const schedule = parseSchedule("every 15m")!;
    const latestRun = { created: "2026-01-01T00:10:00Z" };
    const now = new Date("2026-01-01T00:20:00Z"); // 10分経過 < 15分
    expect(shouldCreateScheduledRun(schedule, latestRun, now, false)).toBe(false);
  });

  it("経過時間がN以上ならtrue", () => {
    const schedule = parseSchedule("every 15m")!;
    const latestRun = { created: "2026-01-01T00:00:00Z" };
    const now = new Date("2026-01-01T00:15:00Z"); // ちょうど15分経過
    expect(shouldCreateScheduledRun(schedule, latestRun, now, false)).toBe(true);
  });
});

describe("shouldCreateScheduledRun: daily", () => {
  it("目標時刻より前ならfalse", () => {
    const schedule = parseSchedule("daily 09:00")!;
    const now = new Date(2026, 0, 1, 8, 59); // ローカル 08:59
    expect(shouldCreateScheduledRun(schedule, null, now, false)).toBe(false);
  });

  it("目標時刻を過ぎていて今日の分がまだ無ければtrue", () => {
    const schedule = parseSchedule("daily 09:00")!;
    const now = new Date(2026, 0, 1, 9, 5); // ローカル 09:05
    const latestRun = { created: new Date(2025, 11, 31, 9, 5).toISOString() }; // 前日
    expect(shouldCreateScheduledRun(schedule, latestRun, now, false)).toBe(true);
  });

  it("今日の分が既にあればfalse", () => {
    const schedule = parseSchedule("daily 09:00")!;
    const now = new Date(2026, 0, 1, 9, 30);
    const latestRun = { created: new Date(2026, 0, 1, 9, 1).toISOString() }; // 今日の09:01に生成済み
    expect(shouldCreateScheduledRun(schedule, latestRun, now, false)).toBe(false);
  });
});

describe("shouldCreateScheduledRun: 重複防止", () => {
  it("hasRunningRun=trueなら every/daily どちらの条件を満たしていても常にfalse", () => {
    const every = parseSchedule("every 15m")!;
    const daily = parseSchedule("daily 09:00")!;
    const now = new Date(2026, 0, 1, 10, 0);
    expect(shouldCreateScheduledRun(every, null, now, true)).toBe(false);
    expect(shouldCreateScheduledRun(daily, null, now, true)).toBe(false);
  });
});
