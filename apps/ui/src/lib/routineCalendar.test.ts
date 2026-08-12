// ルーティーンの予定カレンダー（2026-08-12）の暦計算。
// 2026-01: 1日=木曜。月曜は 5,12,19,26 / 金曜は 2,9,16,23,30（第5金曜あり）
import { describe, expect, it } from "vitest";
import { parseSchedule } from "@graphwrangler/core/schedule";
import { isFineSchedule, occurrenceDays } from "./routineCalendar";

const opts = { latestRunCreated: null, today: new Date(2026, 0, 14) };

describe("isFineSchedule: 毎日以下（既定フィルタで隠す対象）の判定", () => {
  it("every / daily / 日付無制限の cron は細かい", () => {
    expect(isFineSchedule(parseSchedule("every 15m")!)).toBe(true);
    expect(isFineSchedule(parseSchedule("every 3d")!)).toBe(true);
    expect(isFineSchedule(parseSchedule("daily 09:00")!)).toBe(true);
    expect(isFineSchedule(parseSchedule("*/15 9-23 * * *")!)).toBe(true);
  });

  it("週次以上と日付指定つき cron は粗い（既定で表示）", () => {
    expect(isFineSchedule(parseSchedule("weekly mon 09:00")!)).toBe(false);
    expect(isFineSchedule(parseSchedule("biweekly fri 18:00")!)).toBe(false);
    expect(isFineSchedule(parseSchedule("monthly 2 tue 09:00")!)).toBe(false);
    expect(isFineSchedule(parseSchedule("yearly 4 2 tue 09:00")!)).toBe(false);
    expect(isFineSchedule(parseSchedule("0 9 1 * *")!)).toBe(false); // 毎月1日
    expect(isFineSchedule(parseSchedule("0 9 * * 1")!)).toBe(false); // 毎週月曜
  });
});

describe("occurrenceDays: 月内の発火予定日", () => {
  it("weekly は対象曜日の全日", () => {
    expect(occurrenceDays(parseSchedule("weekly mon 09:00")!, 2026, 0, opts)).toEqual([5, 12, 19, 26]);
  });

  it("biweekly はランが無ければ today 基準の隔週（today=1/14 → 直近月曜 1/12 が錨）", () => {
    expect(occurrenceDays(parseSchedule("biweekly mon 09:00")!, 2026, 0, opts)).toEqual([12, 26]);
  });

  it("biweekly は最新ランの週が錨（1/5 のランがあれば 5,19）", () => {
    expect(
      occurrenceDays(parseSchedule("biweekly mon 09:00")!, 2026, 0, {
        latestRunCreated: new Date(2026, 0, 5, 9, 5).toISOString(),
        today: new Date(2026, 0, 14),
      }),
    ).toEqual([5, 19]);
  });

  it("monthly は第n曜日の1日だけ・第5が無い月は空", () => {
    expect(occurrenceDays(parseSchedule("monthly 2 mon 09:00")!, 2026, 0, opts)).toEqual([12]);
    expect(occurrenceDays(parseSchedule("monthly 5 fri 09:00")!, 2026, 0, opts)).toEqual([30]);
    expect(occurrenceDays(parseSchedule("monthly 5 fri 09:00")!, 2026, 1, opts)).toEqual([]); // 2月に第5金曜なし
  });

  it("yearly は対象月だけに出る", () => {
    const y = parseSchedule("yearly 1 2 mon 09:00")!;
    expect(occurrenceDays(y, 2026, 0, opts)).toEqual([12]);
    expect(occurrenceDays(y, 2026, 1, opts)).toEqual([]);
  });

  it("cron は日付フィールドで絞られる（毎月1日の例）・daily は全日", () => {
    expect(occurrenceDays(parseSchedule("0 9 1 * *")!, 2026, 0, opts)).toEqual([1]);
    expect(occurrenceDays(parseSchedule("daily 09:00")!, 2026, 1, opts)).toHaveLength(28);
  });
});
