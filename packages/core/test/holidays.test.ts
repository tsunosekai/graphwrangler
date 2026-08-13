import { describe, expect, it } from "vitest";
import { isJapaneseBusinessDay, isJapaneseHoliday, japaneseHolidayName } from "../src/holidays.js";

// schedule の "weekday"（平日）が正しく休みを飛ばすための土台。年ごとに動く祝日
// （ハッピーマンデー・春分秋分）と、派生の休み（振替休日・国民の休日）を実際の暦で確かめる。
// 日付は new Date(年, 月-1, 日) のローカル暦で作る（判定もローカル暦なのでズレない）。

const d = (year: number, month: number, day: number) => new Date(year, month - 1, day);

describe("japaneseHolidayName", () => {
  it("日付固定の祝日", () => {
    expect(japaneseHolidayName(d(2026, 1, 1))).toBe("元日");
    expect(japaneseHolidayName(d(2026, 2, 11))).toBe("建国記念の日");
    expect(japaneseHolidayName(d(2026, 2, 23))).toBe("天皇誕生日");
    expect(japaneseHolidayName(d(2026, 4, 29))).toBe("昭和の日");
    expect(japaneseHolidayName(d(2026, 8, 11))).toBe("山の日");
    expect(japaneseHolidayName(d(2026, 11, 23))).toBe("勤労感謝の日");
  });

  it("ハッピーマンデー（年ごとに日が動く）", () => {
    expect(japaneseHolidayName(d(2026, 1, 12))).toBe("成人の日"); // 1月第2月曜
    expect(japaneseHolidayName(d(2026, 7, 20))).toBe("海の日"); // 7月第3月曜
    expect(japaneseHolidayName(d(2026, 9, 21))).toBe("敬老の日"); // 9月第3月曜
    expect(japaneseHolidayName(d(2026, 10, 12))).toBe("スポーツの日"); // 10月第2月曜
    // 別の年でもずれる（2027年の成人の日は1/11）
    expect(japaneseHolidayName(d(2027, 1, 11))).toBe("成人の日");
    expect(japaneseHolidayName(d(2027, 1, 12))).toBeNull();
  });

  it("春分の日・秋分の日（天文計算）", () => {
    expect(japaneseHolidayName(d(2026, 3, 20))).toBe("春分の日");
    expect(japaneseHolidayName(d(2026, 9, 23))).toBe("秋分の日");
    expect(japaneseHolidayName(d(2027, 3, 21))).toBe("春分の日");
    expect(japaneseHolidayName(d(2027, 9, 23))).toBe("秋分の日");
  });

  it("振替休日は「祝日でない最初の日」まで送る（2026のGWは5/3日曜→5/6水曜）", () => {
    expect(d(2026, 5, 3).getDay()).toBe(0); // 前提: 憲法記念日が日曜
    expect(japaneseHolidayName(d(2026, 5, 4))).toBe("みどりの日"); // 祝日なので振替先にならない
    expect(japaneseHolidayName(d(2026, 5, 5))).toBe("こどもの日");
    expect(japaneseHolidayName(d(2026, 5, 6))).toBe("振替休日");
    expect(japaneseHolidayName(d(2026, 5, 7))).toBeNull();
  });

  it("国民の休日（祝日に挟まれた平日。2026は敬老の日と秋分の日の間）", () => {
    expect(japaneseHolidayName(d(2026, 9, 22))).toBe("国民の休日");
  });

  it("祝日でない日は null", () => {
    expect(japaneseHolidayName(d(2026, 6, 15))).toBeNull();
    expect(isJapaneseHoliday(d(2026, 6, 15))).toBe(false);
  });
});

describe("isJapaneseBusinessDay", () => {
  it("月〜金のうち祝日でない日だけ true", () => {
    expect(isJapaneseBusinessDay(d(2026, 5, 7))).toBe(true); // 木曜・祝日でない
    expect(isJapaneseBusinessDay(d(2026, 5, 6))).toBe(false); // 水曜だが振替休日
    expect(isJapaneseBusinessDay(d(2026, 5, 2))).toBe(false); // 土曜
    expect(isJapaneseBusinessDay(d(2026, 5, 3))).toBe(false); // 日曜（祝日でもある）
    expect(isJapaneseBusinessDay(d(2026, 9, 22))).toBe(false); // 火曜だが国民の休日
    expect(isJapaneseBusinessDay(d(2026, 9, 24))).toBe(true); // 連休明けの木曜
  });
});
