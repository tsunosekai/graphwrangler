// script トリガーの node.schedule（自由文字列）から、新しいランを自動生成すべきかを
// 判定する。ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
// docs/design.md 3.8「トリガー起点のルーティーン」。
//
// 文法のパース（parseSchedule / parseCron / matchesCron）は 2026-08-12 に
// @graphwrangler/core の schedule.ts へ移動した——UI の構造化スケジュール入力が同じ文法で
// 検証・組み立てをするため。ここに残るのはラン作成の判定（いつ作るか）だけ。
// 既存の import 先を保つため、パース系はここから再エクスポートする。

import { parseSchedule, WEEKDAYS, matchesCron } from "@graphwrangler/core";
import type { ParsedSchedule, Weekday } from "@graphwrangler/core";

export { parseSchedule, parseCron, matchesCron, WEEKDAYS } from "@graphwrangler/core";
export type { ParsedSchedule, CronField, CronFields, Weekday } from "@graphwrangler/core";

/** 2つの Date がローカル暦で同じ日か */
function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** now 以前で直近の「対象曜日の hour:minute」を返す（必ず now 以前になるよう調整する。
 *  today が対象曜日でも、その時刻をまだ過ぎていなければ1週間前の同曜日にする） */
function lastWeeklyOccurrence(weekday: Weekday, hour: number, minute: number, now: Date): Date {
  const targetIndex = WEEKDAYS.indexOf(weekday);
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  const daysSinceTarget = (d.getDay() - targetIndex + 7) % 7;
  d.setDate(d.getDate() - daysSinceTarget);
  if (d.getTime() > now.getTime()) {
    d.setDate(d.getDate() - 7);
  }
  return d;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** year年 monthIndex月(0-11) の「第nth 対象曜日」の hour:minute。
 *  その月に第nthが存在しない（第5など）場合は null */
function nthWeekdayOccurrence(
  year: number,
  monthIndex: number,
  nth: number,
  weekday: Weekday,
  hour: number,
  minute: number,
): Date | null {
  const first = new Date(year, monthIndex, 1);
  const offset = (WEEKDAYS.indexOf(weekday) - first.getDay() + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  const d = new Date(year, monthIndex, day, hour, minute, 0, 0);
  return d.getMonth() === monthIndex ? d : null;
}

/** now 以前で直近の「毎月第nth 対象曜日」発生時刻。月を遡って探す
 *  （第5指定で存在しない月はスキップされるぶんだけ遡る。上限つき） */
function lastMonthlyOccurrence(
  nth: number,
  weekday: Weekday,
  hour: number,
  minute: number,
  now: Date,
): Date | null {
  for (let back = 0; back < 24; back++) {
    const base = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const d = nthWeekdayOccurrence(base.getFullYear(), base.getMonth(), nth, weekday, hour, minute);
    if (d && d.getTime() <= now.getTime()) return d;
  }
  return null; // 第1〜4は毎月あるので実質第5のみ。24ヶ月遡って無ければ諦める
}

/** now 以前で直近の「毎年 month月の第nth 対象曜日」発生時刻。年を遡って探す */
function lastYearlyOccurrence(
  month: number,
  nth: number,
  weekday: Weekday,
  hour: number,
  minute: number,
  now: Date,
): Date | null {
  for (let back = 0; back < 8; back++) {
    const d = nthWeekdayOccurrence(now.getFullYear() - back, month - 1, nth, weekday, hour, minute);
    if (d && d.getTime() <= now.getTime()) return d;
  }
  return null;
}

/**
 * スケジュールに基づき、今このタイミングで新しいランを生成すべきか判定する（純粋関数）。
 *
 * **実行中のランがあっても判定に影響しない**（2026-08-08 本人指摘「前の Run が終わらないと
 * 次の Run がラン作成できない不具合」）。旧実装は status=running のランが1本でもあると
 * スケジュールラン作成を止めていたが、並列ラン（同じルーティーンを複数のランで回す）は
 * 設計上の前提であり、しかも人間の回答待ち（waiting）のランは長時間 running のままなので、
 * 「定刻に動くはずのルーティーンが黙って動かない」状態が常態化していた。
 * 同じ周期で二重に作らない保証は latestRun ベースの判定（下記）が担う。
 *
 * - "every": 最新ランが無ければ true。あれば now - latestRun.created >= ms で true
 *   （N の単位は m/h/d のいずれでも同じ判定。d は 24*60*60*1000ms に換算済み）
 * - "daily": 今日の目標時刻(hour:minute)を過ぎていない間は false。過ぎていれば、
 *   最新ランが無いか、最新ランがローカル暦で「今日」でなければ true
 *   （今日の分は trigger を問わず1本で足りる、という判定）
 * - "weekly": 対象曜日が今日で、かつ今日の目標時刻をまだ過ぎていない間は false（dailyと同じ理由。
 *   「無ければ即座に生成」にはしない）。それ以外は直近の対象曜日・時刻（必ず now 以前）を求め、
 *   最新ランが無いか、その時刻より前なら true（今週分は trigger を問わず1本で足りる、という判定。
 *   dailyの「同じ暦日か」の代わりに「直近のラン作成時刻より後か」で判定する）
 * - "biweekly"（2026-08-12）: weekly と同じ発生時刻の系で、最新ランが直近の発生の
 *   **1週間以上前**のときだけ true。固定の週パリティを持たず最後のラン実績が錨——
 *   最初のランを作った週から1週おきが自然に維持され、skip 回答も同じ式で効く
 * - "monthly"/"yearly"（2026-08-12）: 直近の「第n曜日」発生時刻（必ず now 以前。月/年を遡って
 *   求める。第5が無い月はスキップ）より最新ランが前なら true。対象日当日の時刻前ガードも
 *   weekly と同じ
 */
export function shouldCreateScheduledRun(
  schedule: ParsedSchedule,
  latestRun: { created: string } | null,
  now: Date,
): boolean {
  if (schedule.type === "every") {
    if (!latestRun) return true;
    const last = new Date(latestRun.created);
    return now.getTime() - last.getTime() >= schedule.ms;
  }

  if (schedule.type === "daily") {
    const target = new Date(now);
    target.setHours(schedule.hour, schedule.minute, 0, 0);
    if (now.getTime() < target.getTime()) return false;
    if (!latestRun) return true;
    const last = new Date(latestRun.created);
    return !isSameLocalDay(last, now);
  }

  if (schedule.type === "cron") {
    // 「今この分」がマッチしているときだけラン作成。同じ分に2回作らないよう、最新ランが
    // この分の開始以降なら見送る（エンジンは5秒間隔でここを通るため）
    if (!matchesCron(schedule.fields, now)) return false;
    if (!latestRun) return true;
    const minuteStart = new Date(now);
    minuteStart.setSeconds(0, 0);
    return new Date(latestRun.created).getTime() < minuteStart.getTime();
  }

  if (schedule.type === "monthly" || schedule.type === "yearly") {
    // weekly と同じ理由の「対象日当日で時刻前なら見送り」ガード（無いと当日の 0 時に
    // 前回分の追い付きランが走る——目標時刻まで待つ）
    const todayTarget = nthWeekdayOccurrence(
      now.getFullYear(),
      now.getMonth(),
      schedule.nth,
      schedule.weekday,
      schedule.hour,
      schedule.minute,
    );
    const monthOk = schedule.type === "monthly" || now.getMonth() === schedule.month - 1;
    if (
      monthOk &&
      todayTarget &&
      isSameLocalDay(todayTarget, now) &&
      now.getTime() < todayTarget.getTime()
    ) {
      return false;
    }
    const occurrence =
      schedule.type === "monthly"
        ? lastMonthlyOccurrence(schedule.nth, schedule.weekday, schedule.hour, schedule.minute, now)
        : lastYearlyOccurrence(
            schedule.month,
            schedule.nth,
            schedule.weekday,
            schedule.hour,
            schedule.minute,
            now,
          );
    if (!occurrence) return false; // 直近の発生が見つからない（第5が存在しない等）
    if (!latestRun) return true;
    return new Date(latestRun.created).getTime() < occurrence.getTime();
  }

  // weekly / biweekly（共通の「対象曜日当日で時刻前なら見送り」ガード）
  const targetIndex = WEEKDAYS.indexOf(schedule.weekday);
  if (now.getDay() === targetIndex) {
    const targetToday = new Date(now);
    targetToday.setHours(schedule.hour, schedule.minute, 0, 0);
    if (now.getTime() < targetToday.getTime()) return false;
  }
  if (!latestRun) return true;
  const occurrence = lastWeeklyOccurrence(schedule.weekday, schedule.hour, schedule.minute, now);
  const last = new Date(latestRun.created);
  if (schedule.type === "biweekly") {
    // 隔週: 直近の週次発生の**1週間以上前**に最後のランがある（＝先週分は休んだ）とき
    // だけ作る。固定の週パリティを持たず、最後のラン実績を錨にする——最初のランを
    // 作った週から1週おき、が自然に維持され、skip 回答（runBaseline）も同じ式で効く
    return last.getTime() < occurrence.getTime() - 7 * MS_PER_DAY;
  }
  return last.getTime() < occurrence.getTime();
}
