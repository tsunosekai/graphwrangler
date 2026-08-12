// script/ai トリガーの node.schedule（自由文字列）の文法。docs/design.md 3.8。
// もとは packages/engine/src/schedule.ts にあったパース部分を 2026-08-12 に core へ移動した:
// UI の構造化スケジュール入力（NodePanel の起動方式欄）がエンジンと同じ文法で検証・組み立てを
// するために、純粋なパース/整形だけをここへ置く。ラン作成の判定（shouldCreateScheduledRun）は
// エンジンの責務なので engine 側に残っている。
//
// 対応する書式（それ以外は解釈不能としてパースは null）:
//   - "every <N>m" / "every <N>h" / "every <N>d" … N 間隔
//   - "daily <HH:MM>"                              … 毎日その時刻
//   - "weekly <dow> <HH:MM>"                       … 毎週その曜日時刻（dow=mon..sun）
//   - "biweekly <dow> <HH:MM>"                     … 隔週（2026-08-12。錨は最後のラン実績）
//   - "monthly <1-5> <dow> <HH:MM>"                … 毎月第n曜日（第5が無い月はスキップ）
//   - "yearly <1-12> <1-5> <dow> <HH:MM>"          … 毎年◯月の第n曜日
//   - cron 5フィールド（"*/15 9-23 * * *" 等）      … * / 数値 / a-b / */n / a-b/n / カンマ区切り

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** UI 表示用の曜日名（describeSchedule と曜日セレクトの両方で使う） */
export const WEEKDAY_JA: Record<Weekday, string> = {
  sun: "日",
  mon: "月",
  tue: "火",
  wed: "水",
  thu: "木",
  fri: "金",
  sat: "土",
};

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

export type EveryUnit = "m" | "h" | "d";

export type ParsedSchedule =
  | { type: "every"; ms: number; amount: number; unit: EveryUnit; raw: string }
  | { type: "daily"; hour: number; minute: number; raw: string }
  | { type: "weekly"; weekday: Weekday; hour: number; minute: number; raw: string }
  // 隔週◯曜（2026-08-12 本人要望）。どちらの週かの錨は「最後のランから2週間」——
  // 固定の週パリティを持たず、実際のラン実績に追従する（判定は engine 側）
  | { type: "biweekly"; weekday: Weekday; hour: number; minute: number; raw: string }
  // 毎月第n◯曜（nth=1〜5。第5が無い月はその月はスキップ）
  | { type: "monthly"; nth: number; weekday: Weekday; hour: number; minute: number; raw: string }
  // 毎年◯月の第n◯曜（month=1〜12）
  | { type: "yearly"; month: number; nth: number; weekday: Weekday; hour: number; minute: number; raw: string }
  | { type: "cron"; fields: CronFields; raw: string };

const EVERY_RE = /^every\s+(\d+)\s*(m|h|d)$/i;
const DAILY_RE = /^daily\s+(\d{1,2}):(\d{2})$/i;
const WEEKLY_RE = /^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/i;
const BIWEEKLY_RE = /^biweekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/i;
// "monthly 2 tue 09:00" = 毎月第2火曜 09:00
const MONTHLY_RE = /^monthly\s+([1-5])\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/i;
// "yearly 4 2 tue 09:00" = 毎年4月の第2火曜 09:00
const YEARLY_RE = /^yearly\s+(\d{1,2})\s+([1-5])\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/i;

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
    const unit = everyMatch[2].toLowerCase() as EveryUnit;
    const ms = unit === "h" ? amount * MS_PER_HOUR : unit === "d" ? amount * MS_PER_DAY : amount * MS_PER_MINUTE;
    return { type: "every", ms, amount, unit, raw: text };
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

  const biweeklyMatch = BIWEEKLY_RE.exec(trimmed);
  if (biweeklyMatch) {
    const weekday = biweeklyMatch[1].toLowerCase() as Weekday;
    const hour = Number(biweeklyMatch[2]);
    const minute = Number(biweeklyMatch[3]);
    if (hour > 23 || minute > 59) return null;
    return { type: "biweekly", weekday, hour, minute, raw: text };
  }

  const monthlyMatch = MONTHLY_RE.exec(trimmed);
  if (monthlyMatch) {
    const nth = Number(monthlyMatch[1]);
    const weekday = monthlyMatch[2].toLowerCase() as Weekday;
    const hour = Number(monthlyMatch[3]);
    const minute = Number(monthlyMatch[4]);
    if (hour > 23 || minute > 59) return null;
    return { type: "monthly", nth, weekday, hour, minute, raw: text };
  }

  const yearlyMatch = YEARLY_RE.exec(trimmed);
  if (yearlyMatch) {
    const month = Number(yearlyMatch[1]);
    const nth = Number(yearlyMatch[2]);
    const weekday = yearlyMatch[3].toLowerCase() as Weekday;
    const hour = Number(yearlyMatch[4]);
    const minute = Number(yearlyMatch[5]);
    if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
    return { type: "yearly", month, nth, weekday, hour, minute, raw: text };
  }

  const cron = parseCron(trimmed);
  if (cron) return { type: "cron", fields: cron, raw: text };

  return null;
}

// ---- 整形（UI の構造化入力が schedule 文字列を組み立てる側。パースと同じファイルに置いて
//      文法の追加・変更が必ず両方向そろうようにする） ----

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 構造化された指定から schedule 文字列を組み立てる（parseSchedule の逆） */
export function formatSchedule(
  parsed:
    | { type: "every"; amount: number; unit: EveryUnit }
    | { type: "daily"; hour: number; minute: number }
    | { type: "weekly"; weekday: Weekday; hour: number; minute: number }
    | { type: "biweekly"; weekday: Weekday; hour: number; minute: number }
    | { type: "monthly"; nth: number; weekday: Weekday; hour: number; minute: number }
    | { type: "yearly"; month: number; nth: number; weekday: Weekday; hour: number; minute: number },
): string {
  if (parsed.type === "every") return `every ${parsed.amount}${parsed.unit}`;
  if (parsed.type === "daily") return `daily ${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
  const time = `${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
  if (parsed.type === "weekly") return `weekly ${parsed.weekday} ${time}`;
  if (parsed.type === "biweekly") return `biweekly ${parsed.weekday} ${time}`;
  if (parsed.type === "monthly") return `monthly ${parsed.nth} ${parsed.weekday} ${time}`;
  return `yearly ${parsed.month} ${parsed.nth} ${parsed.weekday} ${time}`;
}

const EVERY_UNIT_JA: Record<EveryUnit, string> = { m: "分", h: "時間", d: "日" };

/** schedule を日本語の読み下しにする（UI のプレビュー用）。解釈できなければ null */
export function describeSchedule(text: string | null): string | null {
  if (!text || !text.trim()) return null;
  const parsed = parseSchedule(text);
  if (!parsed) return null;
  if (parsed.type === "every") return `${parsed.amount}${EVERY_UNIT_JA[parsed.unit]}ごと`;
  if (parsed.type === "daily") return `毎日 ${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
  if (parsed.type === "cron") return `cron式（${parsed.raw.trim()}）`;
  const time = `${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
  const dow = `${WEEKDAY_JA[parsed.weekday]}曜`;
  if (parsed.type === "weekly") return `毎週${dow} ${time}`;
  if (parsed.type === "biweekly") return `隔週${dow} ${time}`;
  if (parsed.type === "monthly") return `毎月第${parsed.nth}${dow} ${time}`;
  return `毎年${parsed.month}月の第${parsed.nth}${dow} ${time}`;
}
