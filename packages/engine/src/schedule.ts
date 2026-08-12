// script トリガーの node.schedule（自由文字列）から、新しいランを自動生成すべきかを
// 判定する。ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
// docs/design.md 3.8「トリガー起点のルーティーン」。
//
// 文法のパース（parseSchedule / parseCron / matchesCron）は 2026-08-12 に
// @graphwrangler/core の schedule.ts へ移動した——UI の構造化スケジュール入力が同じ文法で
// 検証・組み立てをするため。ここに残るのはラン作成の判定（いつ作るか）だけ。
// 既存の import 先を保つため、パース系はここから再エクスポートする。

import {
  parseSchedule,
  WEEKDAYS,
  matchesCron,
  lastDayOfMonth,
  lastWeekdayOfMonth,
  nthWeekdayOfMonth,
} from "@graphwrangler/core";
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 暦ベースの書式（every / cron / biweekly 以外）。「この日は対象日か」を1日単位で答えられる */
type CalendarSchedule = Extract<
  ParsedSchedule,
  {
    type:
      | "daily"
      | "weekly"
      | "monthly"
      | "monthlyLastDow"
      | "monthlyDay"
      | "monthlyLastDay"
      | "yearly"
      | "yearlyDay"
      | "yearlyLastDay";
  }
>;

/**
 * その日付が対象日なら、その日の予定時刻（Date）を返す。対象日でなければ null（純粋関数）。
 * 「毎月◯日」「最終日」「第n曜日」「最終◯曜」…の違いをここ1箇所に閉じ込め、
 * 直近の予定時刻の探索（lastOccurrenceOnOrBefore）は共通のループで済ませる。
 */
function targetTimeOn(schedule: CalendarSchedule, date: Date): Date | null {
  const year = date.getFullYear();
  const monthIndex = date.getMonth();
  const day = date.getDate();
  const at = () => {
    const d = new Date(year, monthIndex, day);
    d.setHours(schedule.hour, schedule.minute, 0, 0);
    return d;
  };
  switch (schedule.type) {
    case "daily":
      return at();
    case "weekly":
      return schedule.weekdays.includes(WEEKDAYS[date.getDay()]) ? at() : null;
    case "monthly": {
      const target = nthWeekdayOfMonth(year, monthIndex, schedule.nth, schedule.weekday);
      return target && target.getDate() === day ? at() : null;
    }
    case "monthlyLastDow":
      return lastWeekdayOfMonth(year, monthIndex, schedule.weekday).getDate() === day ? at() : null;
    case "monthlyDay":
      return schedule.days.includes(day) ? at() : null;
    case "monthlyLastDay":
      return lastDayOfMonth(year, monthIndex) === day ? at() : null;
    case "yearly": {
      if (monthIndex !== schedule.month - 1) return null;
      const target = nthWeekdayOfMonth(year, monthIndex, schedule.nth, schedule.weekday);
      return target && target.getDate() === day ? at() : null;
    }
    case "yearlyDay":
      return monthIndex === schedule.month - 1 && day === schedule.day ? at() : null;
    default: // yearlyLastDay
      return monthIndex === schedule.month - 1 && lastDayOfMonth(year, monthIndex) === day
        ? at()
        : null;
  }
}

/** now 以前で直近の予定時刻。見つからなければ null（1日ずつ最大 maxBackDays 日遡る——
 *  yearly でも1年ちょっとで必ず当たるので、素直なループで十分軽い） */
function lastOccurrenceOnOrBefore(
  schedule: CalendarSchedule,
  now: Date,
  maxBackDays = 400,
): Date | null {
  for (let back = 0; back <= maxBackDays; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    const target = targetTimeOn(schedule, day);
    if (target && target.getTime() <= now.getTime()) return target;
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
 *   （単位 m/h/d/w のいずれでも同じ判定。ms へ換算済み）
 * - "daily": 今日の目標時刻(hour:minute)を過ぎていない間は false。過ぎていれば、
 *   最新ランが無いか、最新ランがローカル暦で「今日」でなければ true
 *   （今日の分は trigger を問わず1本で足りる、という判定）
 * - "cron": 今この分がマッチしていて、その分の開始以降にランが無ければ true
 * - "biweekly"（2026-08-12）: weekly と同じ発生時刻の系で、最新ランが直近の発生の
 *   **1週間以上前**のときだけ true。固定の週パリティを持たず最後のラン実績が錨——
 *   最初のランを作った週から1週おきが自然に維持され、skip 回答も同じ式で効く
 * - それ以外（weekly / monthly系 / yearly系。暦ベース）: 「対象日当日で目標時刻より前なら
 *   false」を先に見たうえで、**直近の予定時刻（必ず now 以前）**を求め、最新ランがそれより
 *   前なら true。第5曜日や31日が無い月・2月の最終日など、存在しない日は自動で飛ばされる
 * - "once"（2026-08-12）: その日時を過ぎていて、まだその時刻以降のランが無ければ true
 *   （＝1回だけ。以後は永久に false）
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

  if (schedule.type === "once") {
    const target = new Date(schedule.year, schedule.month - 1, schedule.day, schedule.hour, schedule.minute, 0, 0);
    if (now.getTime() < target.getTime()) return false;
    return !latestRun || new Date(latestRun.created).getTime() < target.getTime();
  }

  if (schedule.type === "biweekly") {
    // 対象曜日当日で目標時刻より前なら見送り（weekly と同じガード）
    if (now.getDay() === WEEKDAYS.indexOf(schedule.weekday)) {
      const targetToday = new Date(now);
      targetToday.setHours(schedule.hour, schedule.minute, 0, 0);
      if (now.getTime() < targetToday.getTime()) return false;
    }
    if (!latestRun) return true;
    // 隔週の錨は最後のラン実績。直近の週次発生の1週間以上前に最後のランがあるときだけ作る
    const weeklyEquivalent: CalendarSchedule = {
      type: "weekly",
      weekdays: [schedule.weekday],
      hour: schedule.hour,
      minute: schedule.minute,
      raw: schedule.raw,
    };
    const occurrence = lastOccurrenceOnOrBefore(weeklyEquivalent, now);
    if (!occurrence) return false;
    return new Date(latestRun.created).getTime() < occurrence.getTime() - 7 * MS_PER_DAY;
  }

  // 暦ベース（weekly / monthly系 / yearly系）
  const todayTarget = targetTimeOn(schedule, now);
  if (todayTarget && now.getTime() < todayTarget.getTime()) return false; // 当日だが時刻前
  const occurrence = lastOccurrenceOnOrBefore(schedule, now);
  if (!occurrence) return false; // 直近の予定が見つからない（存在しない日ばかり等）
  if (!latestRun) return true;
  return new Date(latestRun.created).getTime() < occurrence.getTime();
}
