import { describe, expect, it } from "vitest";
import { SLEEP_GAP_MS, mergeAwakeBaseline, nextAwakeSince } from "../src/awake.js";
import { parseSchedule, shouldCreateScheduledRun } from "../src/schedule.js";

describe("nextAwakeSince（スリープ復帰の検知）", () => {
  it("拍が普通に続いている間は起きた時刻を動かさない", () => {
    expect(nextAwakeSince(1000, 50_000, 60_000)).toBe(1000);
  });
  it("拍が閾値より大きく飛んだら、起きた時刻を今にする", () => {
    const now = 50_000 + SLEEP_GAP_MS + 1;
    expect(nextAwakeSince(1000, 50_000, now)).toBe(now);
  });
});

describe("mergeAwakeBaseline（catchUp=false: 止まっていた間の回を捨てる）", () => {
  const awake = new Date(2026, 0, 7, 12, 0).getTime(); // 水曜 12:00 に起動

  it("基準が無い・起きる前なら、起きた時刻を基準にする", () => {
    expect(mergeAwakeBaseline(null, awake).created).toBe(new Date(awake).toISOString());
    const old = { created: new Date(2025, 11, 29, 9, 0).toISOString() };
    expect(mergeAwakeBaseline(old, awake).created).toBe(new Date(awake).toISOString());
  });

  it("起きた後のランがあればそれが基準のまま", () => {
    const later = { created: new Date(2026, 0, 7, 13, 0).toISOString() };
    expect(mergeAwakeBaseline(later, awake)).toBe(later);
  });

  it("weekly: 止まっていた間の月曜は捨て、次の月曜の定刻に動く", () => {
    const s = parseSchedule("weekly mon 09:00")!;
    const old = { created: new Date(2025, 11, 29, 9, 0).toISOString() };
    const baseline = mergeAwakeBaseline(old, awake);
    expect(shouldCreateScheduledRun(s, baseline, new Date(2026, 0, 7, 12, 1), { catchUp: false })).toBe(false);
    expect(shouldCreateScheduledRun(s, baseline, new Date(2026, 0, 12, 9, 0), { catchUp: false })).toBe(true);
  });

  it("daily: 定刻を過ぎてから起きた日は捨て、翌日の定刻に動く", () => {
    const s = parseSchedule("daily 09:00")!;
    const baseline = mergeAwakeBaseline(null, awake);
    expect(shouldCreateScheduledRun(s, baseline, new Date(2026, 0, 7, 12, 1), { catchUp: false })).toBe(false);
    expect(shouldCreateScheduledRun(s, baseline, new Date(2026, 0, 8, 9, 0), { catchUp: false })).toBe(true);
  });
});
