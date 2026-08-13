// ルーティーンの予定カレンダー（2026-08-12）の暦計算。
// 2026-01: 1日=木曜。月曜は 5,12,19,26 / 金曜は 2,9,16,23,30（第5金曜あり）
import { describe, expect, it } from "vitest";
import { parseSchedule } from "@graphwrangler/core/schedule";
import { isFineSchedule, latestRunCreatedOf, occurrenceDays } from "./routineCalendar";
import type { Run } from "../types";

const opts = { latestRunCreated: null, today: new Date(2026, 0, 14) };

describe("isFineSchedule: 毎日以下（既定フィルタで隠す対象）の判定", () => {
  it("every(分/時/1日ごと) / daily / 日付無制限の cron は細かい", () => {
    expect(isFineSchedule(parseSchedule("every 15m")!)).toBe(true);
    expect(isFineSchedule(parseSchedule("every 1d")!)).toBe(true);
    expect(isFineSchedule(parseSchedule("daily 09:00")!)).toBe(true);
    expect(isFineSchedule(parseSchedule("*/15 9-23 * * *")!)).toBe(true);
    // 2026-08-12 修正: 2日ごと・週ごとは日が飛ぶので「毎日以下」ではない＝隠さない
    expect(isFineSchedule(parseSchedule("every 3d")!)).toBe(false);
    expect(isFineSchedule(parseSchedule("every 2w")!)).toBe(false);
  });

  it("週次以上と日付指定つき cron は粗い（既定で表示）", () => {
    expect(isFineSchedule(parseSchedule("weekly mon 09:00")!)).toBe(false);
    expect(isFineSchedule(parseSchedule("biweekly fri 18:00")!)).toBe(false);
    expect(isFineSchedule(parseSchedule("monthly 2 tue 09:00")!)).toBe(false);
    expect(isFineSchedule(parseSchedule("yearly 4 2 tue 09:00")!)).toBe(false);
    expect(isFineSchedule(parseSchedule("0 9 1 * *")!)).toBe(false); // 毎月1日
    expect(isFineSchedule(parseSchedule("0 9 * * 1")!)).toBe(false); // 毎週月曜
    // 平日は週5回だが、同じ並びの "weekly mon,tue,wed,thu,fri" と扱いをそろえる（2026-08-14）
    expect(isFineSchedule(parseSchedule("weekday 09:00")!)).toBe(false);
  });
});

describe("occurrenceDays: 月内の発火予定日", () => {
  it("weekly は対象曜日の全日", () => {
    expect(occurrenceDays(parseSchedule("weekly mon 09:00")!, 2026, 0, opts)).toEqual([5, 12, 19, 26]);
  });

  // 2026-05: 1(金) のあとGW（2(土) 3(日=憲法記念日) 4 5 6(振替休日)）、7(木)から平常
  it("weekday は月〜金から祝日・振替休日を抜いた日", () => {
    expect(occurrenceDays(parseSchedule("weekday 09:00")!, 2026, 4, opts)).toEqual([
      1, 7, 8, 11, 12, 13, 14, 15, 18, 19, 20, 21, 22, 25, 26, 27, 28, 29,
    ]);
  });

  it("biweekly はランが無ければ today 基準の隔週（today=1/14 → 直近月曜 1/12 が錨）", () => {
    expect(occurrenceDays(parseSchedule("biweekly mon 09:00")!, 2026, 0, opts)).toEqual([12, 26]);
  });

  // 2026-08-14: 錨はページではなくトリガー単位。同じページの別トリガーのランに引きずられない
  it("biweekly の錨は自分のトリガーのランだけを見る", () => {
    const runs = {
      "p-1": [
        { created: new Date(2026, 0, 12, 9, 0).toISOString(), trigger: "trigger:t-other:schedule:x" },
        { created: new Date(2026, 0, 5, 9, 0).toISOString(), trigger: "trigger:t-mine:manual" },
      ],
    } as unknown as Record<string, Run[]>;
    expect(latestRunCreatedOf(runs, "p-1", "t-mine")).toBe(
      new Date(2026, 0, 5, 9, 0).toISOString(),
    );
    expect(latestRunCreatedOf(runs, "p-1", "t-none")).toBeNull();
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

// 2026-08-12「あらゆるタイミング」で足した書式のカレンダー表示
describe("occurrenceDays: 追加書式（毎月◯日・最終日・最終◯曜・毎年・1回だけ・複数曜日）", () => {
  it("毎月◯日は無い月を飛ばす（31日は2月に出ない）", () => {
    expect(occurrenceDays(parseSchedule("monthly day 25 09:00")!, 2026, 0, opts)).toEqual([25]);
    expect(occurrenceDays(parseSchedule("monthly day 1,15 09:00")!, 2026, 0, opts)).toEqual([1, 15]);
    expect(occurrenceDays(parseSchedule("monthly day 31 09:00")!, 2026, 1, opts)).toEqual([]);
  });

  it("毎月最終日は月ごとに 31/28 を解決する", () => {
    const s = parseSchedule("monthly lastday 18:00")!;
    expect(occurrenceDays(s, 2026, 0, opts)).toEqual([31]);
    expect(occurrenceDays(s, 2026, 1, opts)).toEqual([28]);
  });

  it("毎月最終◯曜（2026-01 の最終金曜=30 / 2026-02 は27）", () => {
    const s = parseSchedule("monthly last fri 17:30")!;
    expect(occurrenceDays(s, 2026, 0, opts)).toEqual([30]);
    expect(occurrenceDays(s, 2026, 1, opts)).toEqual([27]);
  });

  it("毎年◯月◯日・◯月の最終日は対象月だけ", () => {
    expect(occurrenceDays(parseSchedule("yearly day 1 20 09:00")!, 2026, 0, opts)).toEqual([20]);
    expect(occurrenceDays(parseSchedule("yearly day 1 20 09:00")!, 2026, 1, opts)).toEqual([]);
    expect(occurrenceDays(parseSchedule("yearly lastday 1 18:00")!, 2026, 0, opts)).toEqual([31]);
  });

  it("1回だけはその年月だけに1日出る", () => {
    const s = parseSchedule("once 2026-01-20 09:00")!;
    expect(occurrenceDays(s, 2026, 0, opts)).toEqual([20]);
    expect(occurrenceDays(s, 2026, 1, opts)).toEqual([]);
    expect(occurrenceDays(s, 2027, 0, opts)).toEqual([]);
  });

  it("複数曜日の毎週（月・水・金）", () => {
    // 2026-01: 月曜 5,12,19,26 / 水曜 7,14,21,28 / 金曜 2,9,16,23,30
    expect(occurrenceDays(parseSchedule("weekly mon,wed,fri 09:00")!, 2026, 0, opts)).toEqual([
      2, 5, 7, 9, 12, 14, 16, 19, 21, 23, 26, 28, 30,
    ]);
  });

  it("every 3d は錨（最新ラン。無ければ今日）から3日ごと", () => {
    const s = parseSchedule("every 3d")!;
    const withRun = { latestRunCreated: new Date(2026, 0, 1, 9, 0).toISOString(), today: new Date(2026, 0, 14) };
    expect(occurrenceDays(s, 2026, 0, withRun)).toEqual([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31]);
  });
});
