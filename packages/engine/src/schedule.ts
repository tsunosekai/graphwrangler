// procedure ノードの node.schedule（自由文字列）を解釈し、新しいランを自動生成すべきか
// 判定する。ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
// docs/design.md 3.8「トリガー: スケジュール・イベントでランを生成」。
//
// 対応する書式はこの4つだけ（それ以外は無視して警告ログ。呼び出し側=index.ts の責務）:
//   - "every <N>m" / "every <N>h" / "every <N>d" … 最新ランの created から N 経過していたら新ラン
//   - "daily <HH:MM>"                              … 今日その時刻を過ぎていて、今日の分の
//                                                     ランがまだ無ければ新ラン
//   - "weekly <mon|tue|wed|thu|fri|sat|sun> <HH:MM>" … 今週その曜日時刻を過ぎていて、
//                                                       今週分のランがまだ無ければ新ラン

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type ParsedSchedule =
  | { type: "every"; ms: number; raw: string }
  | { type: "daily"; hour: number; minute: number; raw: string }
  | { type: "weekly"; weekday: Weekday; hour: number; minute: number; raw: string };

const EVERY_RE = /^every\s+(\d+)\s*(m|h|d)$/i;
const DAILY_RE = /^daily\s+(\d{1,2}):(\d{2})$/i;
const WEEKLY_RE = /^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/i;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** schedule 文字列をパースする。対応外の書式は null（呼び出し側で警告ログを出す） */
export function parseSchedule(text: string): ParsedSchedule | null {
  const trimmed = text.trim();

  const everyMatch = EVERY_RE.exec(trimmed);
  if (everyMatch) {
    const amount = Number(everyMatch[1]);
    if (amount <= 0) return null;
    const unit = everyMatch[2].toLowerCase();
    const ms = unit === "h" ? amount * MS_PER_HOUR : unit === "d" ? amount * MS_PER_DAY : amount * MS_PER_MINUTE;
    return { type: "every", ms, raw: text };
  }

  const dailyMatch = DAILY_RE.exec(trimmed);
  if (dailyMatch) {
    const hour = Number(dailyMatch[1]);
    const minute = Number(dailyMatch[2]);
    if (hour > 23 || minute > 59) return null;
    return { type: "daily", hour, minute, raw: text };
  }

  const weeklyMatch = WEEKLY_RE.exec(trimmed);
  if (weeklyMatch) {
    const weekday = weeklyMatch[1].toLowerCase() as Weekday;
    const hour = Number(weeklyMatch[2]);
    const minute = Number(weeklyMatch[3]);
    if (hour > 23 || minute > 59) return null;
    return { type: "weekly", weekday, hour, minute, raw: text };
  }

  return null;
}

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

/**
 * スケジュールに基づき、今このタイミングで新しいランを生成すべきか判定する（純粋関数）。
 *
 * - hasRunningRun=true（その手順に status=running のランが既にある）なら常に false
 *   （積み残し防止。前回分がまだ流れている間は積み増さない。README参照）
 * - "every": 最新ランが無ければ true。あれば now - latestRun.created >= ms で true
 *   （N の単位は m/h/d のいずれでも同じ判定。d は 24*60*60*1000ms に換算済み）
 * - "daily": 今日の目標時刻(hour:minute)を過ぎていない間は false。過ぎていれば、
 *   最新ランが無いか、最新ランがローカル暦で「今日」でなければ true
 *   （今日の分は trigger を問わず1本で足りる、という判定）
 * - "weekly": 対象曜日が今日で、かつ今日の目標時刻をまだ過ぎていない間は false（dailyと同じ理由。
 *   「無ければ即座に生成」にはしない）。それ以外は直近の対象曜日・時刻（必ず now 以前）を求め、
 *   最新ランが無いか、その時刻より前なら true（今週分は trigger を問わず1本で足りる、という判定。
 *   dailyの「同じ暦日か」の代わりに「直近の発火時刻より後か」で判定する）
 */
export function shouldCreateScheduledRun(
  schedule: ParsedSchedule,
  latestRun: { created: string } | null,
  now: Date,
  hasRunningRun: boolean,
): boolean {
  if (hasRunningRun) return false;

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

  // weekly
  const targetIndex = WEEKDAYS.indexOf(schedule.weekday);
  if (now.getDay() === targetIndex) {
    const targetToday = new Date(now);
    targetToday.setHours(schedule.hour, schedule.minute, 0, 0);
    if (now.getTime() < targetToday.getTime()) return false;
  }
  if (!latestRun) return true;
  const occurrence = lastWeeklyOccurrence(schedule.weekday, schedule.hour, schedule.minute, now);
  const last = new Date(latestRun.created);
  return last.getTime() < occurrence.getTime();
}
