// script トリガーの node.schedule（自由文字列）を解釈し、新しいランを自動生成すべきか
// 判定する。ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
// docs/design.md 3.8「トリガー起点のルーティーン」。
//
// 対応する書式（それ以外は無視して警告ログ。呼び出し側=index.ts の責務）:
//   - "every <N>m" / "every <N>h" / "every <N>d" … 最新ランの created から N 経過していたら新ラン
//   - "daily <HH:MM>"                              … 今日その時刻を過ぎていて、今日の分の
//                                                     ランがまだ無ければ新ラン
//   - "weekly <mon|tue|wed|thu|fri|sat|sun> <HH:MM>" … 今週その曜日時刻を過ぎていて、
//                                                       今週分のランがまだ無ければ新ラン
//   - cron 5フィールド（"*/15 9-23 * * *" 等）      … 現在の分がマッチしたら新ラン
//     （2026-08-07 追加——人もAIも自然に cron で書くのに未対応で、書いたトリガーが黙って
//     動かない事故が多発していた。* / 数値 / a-b / */n / a-b/n / カンマ区切りに対応。
//     判定は「今この分がマッチしているか」なので、その分にエンジンが落ちていた場合の
//     追い付き発火はしない——every/daily と違い任意条件の遡り計算が高くつくため）

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** cron の1フィールド。null = "*"（無条件）、Set = マッチする値の集合 */
export type CronField = Set<number> | null;

export interface CronFields {
  minute: CronField;
  hour: CronField;
  /** 日（1-31）。dom/dow の両方が指定されている場合は cron 慣例どおり OR で判定する */
  dayOfMonth: CronField;
  month: CronField; // 1-12
  dayOfWeek: CronField; // 0-6（7 は 0=日曜へ正規化）
}

export type ParsedSchedule =
  | { type: "every"; ms: number; raw: string }
  | { type: "daily"; hour: number; minute: number; raw: string }
  | { type: "weekly"; weekday: Weekday; hour: number; minute: number; raw: string }
  | { type: "cron"; fields: CronFields; raw: string };

const EVERY_RE = /^every\s+(\d+)\s*(m|h|d)$/i;
const DAILY_RE = /^daily\s+(\d{1,2}):(\d{2})$/i;
const WEEKLY_RE = /^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/i;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// cron の1フィールドをパースする（"*" / "5" / "1-5" / ステップ付き（＊/15 や 1-9/2）/
// "1,3,5" の組み合わせ。ここを JSDoc にしないのは、ステップ表記の「アスタリスク+スラッシュ」が
// ブロックコメントを閉じてしまうため）。不正なら undefined（フィールド全体を不成立にする）
function parseCronField(text: string, min: number, max: number, normalize?: (v: number) => number): CronField | undefined {
  if (text === "*") return null;
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return undefined;
    const step = m[2] !== undefined ? Number(m[2]) : 1;
    if (step <= 0) return undefined;
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else if (m[1].includes("-")) {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(m[1]);
      // 単一値 + step（"5/2" 形）は cron 的には「5 から末尾まで」だが紛らわしいので単一値扱い
      hi = m[2] !== undefined ? max : lo;
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo > hi) return undefined;
    for (let v = lo; v <= hi; v += step) {
      const nv = normalize ? normalize(v) : v;
      if (nv < min || nv > max) return undefined;
      values.add(nv);
    }
  }
  return values;
}

/** 5フィールドの cron 式をパースする。式でなければ null */
export function parseCron(text: string): CronFields | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dayOfMonth = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dayOfWeek = parseCronField(parts[4], 0, 6, (v) => (v === 7 ? 0 : v)); // 7 = 日曜
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    return null;
  }
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/** now（ローカル時刻）が cron 式にマッチするか。dom と dow が両方指定されているときは
 *  cron 慣例どおり OR（どちらかが合えば日付条件を満たす） */
export function matchesCron(fields: CronFields, now: Date): boolean {
  const ok = (f: CronField, v: number) => f === null || f.has(v);
  if (!ok(fields.minute, now.getMinutes())) return false;
  if (!ok(fields.hour, now.getHours())) return false;
  if (!ok(fields.month, now.getMonth() + 1)) return false;
  const domOk = ok(fields.dayOfMonth, now.getDate());
  const dowOk = ok(fields.dayOfWeek, now.getDay());
  if (fields.dayOfMonth !== null && fields.dayOfWeek !== null) return domOk || dowOk;
  return domOk && dowOk;
}

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

  const cron = parseCron(trimmed);
  if (cron) return { type: "cron", fields: cron, raw: text };

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

  if (schedule.type === "cron") {
    // 「今この分」がマッチしているときだけ発火。同じ分に2回作らないよう、最新ランが
    // この分の開始以降なら見送る（エンジンは5秒間隔でここを通るため）
    if (!matchesCron(schedule.fields, now)) return false;
    if (!latestRun) return true;
    const minuteStart = new Date(now);
    minuteStart.setSeconds(0, 0);
    return new Date(latestRun.created).getTime() < minuteStart.getTime();
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
