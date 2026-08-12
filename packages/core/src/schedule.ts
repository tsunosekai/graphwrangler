// script/ai トリガーの node.schedule（自由文字列）の文法。docs/design.md 3.8。
// もとは packages/engine/src/schedule.ts にあったパース部分を 2026-08-12 に core へ移動した:
// UI の構造化スケジュール入力（NodePanel の起動方式欄）がエンジンと同じ文法で検証・組み立てを
// するために、純粋なパース/整形だけをここへ置く。ラン作成の判定（shouldCreateScheduledRun）は
// エンジンの責務なので engine 側に残っている。
//
// 対応する書式（それ以外は解釈不能としてパースは null）:
//   - "every <N>m|h|d|w"                     … N 間隔（w=週。2026-08-12 追加）
//   - "daily <HH:MM>"                        … 毎日その時刻
//   - "weekly <dow[,dow…]> <HH:MM>"          … 毎週その曜日時刻（複数曜日可。2026-08-12）
//   - "biweekly <dow> <HH:MM>"               … 隔週（錨は最後のラン実績）
//   - "monthly <1-5> <dow> <HH:MM>"          … 毎月第n曜日（第5が無い月はスキップ）
//   - "monthly last <dow> <HH:MM>"           … 毎月最終◯曜（2026-08-12）
//   - "monthly day <D[,D…]> <HH:MM>"         … 毎月◯日（複数可。無い日の月はスキップ。2026-08-12）
//   - "monthly lastday <HH:MM>"              … 毎月最終日（2026-08-12）
//   - "yearly <1-12> <1-5> <dow> <HH:MM>"    … 毎年◯月の第n曜日
//   - "yearly day <1-12> <D> <HH:MM>"        … 毎年◯月◯日（2026-08-12）
//   - "yearly lastday <1-12> <HH:MM>"        … 毎年◯月の最終日（2026-08-12）
//   - "once <YYYY-MM-DD> <HH:MM>"            … その日時に1回だけ（2026-08-12）
//   - cron 5フィールド（"*/15 9-23 * * *" 等）… * / 数値 / a-b / */n / a-b/n / カンマ区切り。
//     曜日・月は3文字名（mon / jan）も可、"?" は "*" と同じ、"@daily" 等のマクロも可（2026-08-12）
//
// 2026-08-12 の拡張は本人指示「あらゆるタイミングが登録できるように、他のOSSと比べて
// 足りてないものは入れておいて」。cron 互換（名前・?・マクロ）と、cron では書けない
// 「最終日」「最終◯曜」「1回だけ」を足した（cron の L は非対応のままで、専用書式で表す）。

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

export type EveryUnit = "m" | "h" | "d" | "w";

export type ParsedSchedule =
  | { type: "every"; ms: number; amount: number; unit: EveryUnit; raw: string }
  | { type: "daily"; hour: number; minute: number; raw: string }
  // 毎週。複数曜日を持てる（"weekly mon,wed,fri 09:00"。平日だけ・週2回などが1本で書ける）
  | { type: "weekly"; weekdays: Weekday[]; hour: number; minute: number; raw: string }
  // 隔週◯曜（2026-08-12 本人要望）。どちらの週かの錨は「最後のランから2週間」——
  // 固定の週パリティを持たず、実際のラン実績に追従する（判定は engine 側）。
  // 錨がぶれるので曜日は1つだけ（複数にすると「その週の2日目」の扱いが決まらない）
  | { type: "biweekly"; weekday: Weekday; hour: number; minute: number; raw: string }
  // 毎月第n◯曜（nth=1〜5。第5が無い月はその月はスキップ）
  | { type: "monthly"; nth: number; weekday: Weekday; hour: number; minute: number; raw: string }
  // 毎月最終◯曜（第5とは違い、第4が最終の月は第4に出る）
  | { type: "monthlyLastDow"; weekday: Weekday; hour: number; minute: number; raw: string }
  // 毎月◯日（複数可。31日など無い月はスキップ——月末に寄せたいなら monthlyLastDay を使う）
  | { type: "monthlyDay"; days: number[]; hour: number; minute: number; raw: string }
  // 毎月最終日（28/29/30/31 を月ごとに自動で解決）
  | { type: "monthlyLastDay"; hour: number; minute: number; raw: string }
  // 毎年◯月の第n◯曜（month=1〜12）
  | { type: "yearly"; month: number; nth: number; weekday: Weekday; hour: number; minute: number; raw: string }
  // 毎年◯月◯日（記念日・年次手続き）
  | { type: "yearlyDay"; month: number; day: number; hour: number; minute: number; raw: string }
  // 毎年◯月の最終日
  | { type: "yearlyLastDay"; month: number; hour: number; minute: number; raw: string }
  // 指定日時に1回だけ（済んだら二度と作らない）
  | { type: "once"; year: number; month: number; day: number; hour: number; minute: number; raw: string }
  | { type: "cron"; fields: CronFields; raw: string };

const DOW = "mon|tue|wed|thu|fri|sat|sun";
const EVERY_RE = /^every\s+(\d+)\s*(m|h|d|w)$/i;
const DAILY_RE = /^daily\s+(\d{1,2}):(\d{2})$/i;
const WEEKLY_RE = new RegExp(`^weekly\\s+((?:${DOW})(?:\\s*,\\s*(?:${DOW}))*)\\s+(\\d{1,2}):(\\d{2})$`, "i");
const BIWEEKLY_RE = new RegExp(`^biweekly\\s+(${DOW})\\s+(\\d{1,2}):(\\d{2})$`, "i");
// "monthly 2 tue 09:00" = 毎月第2火曜 09:00
const MONTHLY_RE = new RegExp(`^monthly\\s+([1-5])\\s+(${DOW})\\s+(\\d{1,2}):(\\d{2})$`, "i");
// "monthly last fri 09:00" = 毎月最終金曜 09:00
const MONTHLY_LAST_DOW_RE = new RegExp(`^monthly\\s+last\\s+(${DOW})\\s+(\\d{1,2}):(\\d{2})$`, "i");
// "monthly day 25 09:00" / "monthly day 1,15 09:00"
const MONTHLY_DAY_RE = /^monthly\s+day\s+(\d{1,2}(?:\s*,\s*\d{1,2})*)\s+(\d{1,2}):(\d{2})$/i;
// "monthly lastday 09:00" = 毎月最終日 09:00
const MONTHLY_LASTDAY_RE = /^monthly\s+lastday\s+(\d{1,2}):(\d{2})$/i;
// "yearly 4 2 tue 09:00" = 毎年4月の第2火曜 09:00
const YEARLY_RE = new RegExp(`^yearly\\s+(\\d{1,2})\\s+([1-5])\\s+(${DOW})\\s+(\\d{1,2}):(\\d{2})$`, "i");
// "yearly day 4 1 09:00" = 毎年4月1日 09:00
const YEARLY_DAY_RE = /^yearly\s+day\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/i;
// "yearly lastday 3 18:00" = 毎年3月の最終日 18:00
const YEARLY_LASTDAY_RE = /^yearly\s+lastday\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/i;
// "once 2026-09-01 09:00" = その日時に1回だけ
const ONCE_RE = /^once\s+(\d{4})-(\d{1,2})-(\d{1,2})[\sT]+(\d{1,2}):(\d{2})$/i;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/** cron の曜日フィールドで使える3文字名（他のスケジューラとの互換。2026-08-12） */
const CRON_DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
/** cron の月フィールドで使える3文字名 */
const CRON_MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** cron のマクロ（@daily 等）。他のスケジューラで広く使えるので受ける */
const CRON_MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** "1,15" のような数値リストを解釈する（重複除去・昇順）。範囲外・空は null */
function parseNumberList(text: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < min || n > max) return null;
    out.add(n);
  }
  return out.size > 0 ? [...out].sort((a, b) => a - b) : null;
}

/** 曜日リスト（"mon,wed,fri"）を解釈する。曜日順（日曜始まり）に整列・重複除去 */
function parseWeekdayList(text: string): Weekday[] | null {
  const out = new Set<Weekday>();
  for (const part of text.split(",")) {
    const d = part.trim().toLowerCase() as Weekday;
    if (!WEEKDAYS.includes(d)) return null;
    out.add(d);
  }
  if (out.size === 0) return null;
  return WEEKDAYS.filter((d) => out.has(d));
}

// cron の1フィールドをパースする（"*" / "5" / "1-5" / ステップ付き（＊/15 や 1-9/2）/
// "1,3,5" の組み合わせ。名前（mon / jan）と "?"（= "*" 扱い）も受ける。
// ここを JSDoc にしないのは、ステップ表記の「アスタリスク+スラッシュ」が
// ブロックコメントを閉じてしまうため）。不正なら undefined（フィールド全体を不成立にする）
function parseCronField(
  text: string,
  min: number,
  max: number,
  normalize?: (v: number) => number,
  names?: Record<string, number>,
): CronField | undefined {
  if (text === "*" || text === "?") return null; // "?" は Quartz 互換（= 指定なし）
  const toNumber = (token: string): number => {
    const t = token.trim().toLowerCase();
    if (names && t in names) return names[t];
    return /^\d+$/.test(t) ? Number(t) : Number.NaN;
  };
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return undefined;
    const step = m[2] !== undefined ? Number(m[2]) : 1;
    if (step <= 0) return undefined;
    const body = m[1].trim();
    let lo: number;
    let hi: number;
    if (body === "*" || body === "?") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      lo = toNumber(a);
      hi = toNumber(b);
    } else {
      lo = toNumber(body);
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

/** 5フィールドの cron 式をパースする。式でなければ null（"@daily" 等のマクロも受ける） */
export function parseCron(text: string): CronFields | null {
  const expanded = CRON_MACROS[text.trim().toLowerCase()] ?? text;
  const parts = expanded.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dayOfMonth = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12, undefined, CRON_MONTH_NAMES);
  // 7 = 日曜（0 と同じ）。名前（mon 等）も受ける
  const dayOfWeek = parseCronField(parts[4], 0, 6, (v) => (v === 7 ? 0 : v), CRON_DOW_NAMES);
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
  /** "HH:MM" の妥当性（時 0-23 / 分 0-59）。各書式の末尾で共通に使う */
  const time = (h: string, m: string): { hour: number; minute: number } | null => {
    const hour = Number(h);
    const minute = Number(m);
    return hour > 23 || minute > 59 ? null : { hour, minute };
  };

  const everyMatch = EVERY_RE.exec(trimmed);
  if (everyMatch) {
    const amount = Number(everyMatch[1]);
    if (amount <= 0) return null;
    const unit = everyMatch[2].toLowerCase() as EveryUnit;
    const perUnit =
      unit === "h" ? MS_PER_HOUR : unit === "d" ? MS_PER_DAY : unit === "w" ? MS_PER_WEEK : MS_PER_MINUTE;
    return { type: "every", ms: amount * perUnit, amount, unit, raw: text };
  }

  const dailyMatch = DAILY_RE.exec(trimmed);
  if (dailyMatch) {
    const t = time(dailyMatch[1], dailyMatch[2]);
    return t ? { type: "daily", ...t, raw: text } : null;
  }

  const weeklyMatch = WEEKLY_RE.exec(trimmed);
  if (weeklyMatch) {
    const weekdays = parseWeekdayList(weeklyMatch[1]);
    const t = time(weeklyMatch[2], weeklyMatch[3]);
    return weekdays && t ? { type: "weekly", weekdays, ...t, raw: text } : null;
  }

  const biweeklyMatch = BIWEEKLY_RE.exec(trimmed);
  if (biweeklyMatch) {
    const weekday = biweeklyMatch[1].toLowerCase() as Weekday;
    const t = time(biweeklyMatch[2], biweeklyMatch[3]);
    return t ? { type: "biweekly", weekday, ...t, raw: text } : null;
  }

  const monthlyMatch = MONTHLY_RE.exec(trimmed);
  if (monthlyMatch) {
    const nth = Number(monthlyMatch[1]);
    const weekday = monthlyMatch[2].toLowerCase() as Weekday;
    const t = time(monthlyMatch[3], monthlyMatch[4]);
    return t ? { type: "monthly", nth, weekday, ...t, raw: text } : null;
  }

  const monthlyLastDowMatch = MONTHLY_LAST_DOW_RE.exec(trimmed);
  if (monthlyLastDowMatch) {
    const weekday = monthlyLastDowMatch[1].toLowerCase() as Weekday;
    const t = time(monthlyLastDowMatch[2], monthlyLastDowMatch[3]);
    return t ? { type: "monthlyLastDow", weekday, ...t, raw: text } : null;
  }

  const monthlyDayMatch = MONTHLY_DAY_RE.exec(trimmed);
  if (monthlyDayMatch) {
    const days = parseNumberList(monthlyDayMatch[1], 1, 31);
    const t = time(monthlyDayMatch[2], monthlyDayMatch[3]);
    return days && t ? { type: "monthlyDay", days, ...t, raw: text } : null;
  }

  const monthlyLastDayMatch = MONTHLY_LASTDAY_RE.exec(trimmed);
  if (monthlyLastDayMatch) {
    const t = time(monthlyLastDayMatch[1], monthlyLastDayMatch[2]);
    return t ? { type: "monthlyLastDay", ...t, raw: text } : null;
  }

  const yearlyMatch = YEARLY_RE.exec(trimmed);
  if (yearlyMatch) {
    const month = Number(yearlyMatch[1]);
    const nth = Number(yearlyMatch[2]);
    const weekday = yearlyMatch[3].toLowerCase() as Weekday;
    const t = time(yearlyMatch[4], yearlyMatch[5]);
    return month >= 1 && month <= 12 && t
      ? { type: "yearly", month, nth, weekday, ...t, raw: text }
      : null;
  }

  const yearlyDayMatch = YEARLY_DAY_RE.exec(trimmed);
  if (yearlyDayMatch) {
    const month = Number(yearlyDayMatch[1]);
    const day = Number(yearlyDayMatch[2]);
    const t = time(yearlyDayMatch[3], yearlyDayMatch[4]);
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 && t
      ? { type: "yearlyDay", month, day, ...t, raw: text }
      : null;
  }

  const yearlyLastDayMatch = YEARLY_LASTDAY_RE.exec(trimmed);
  if (yearlyLastDayMatch) {
    const month = Number(yearlyLastDayMatch[1]);
    const t = time(yearlyLastDayMatch[2], yearlyLastDayMatch[3]);
    return month >= 1 && month <= 12 && t ? { type: "yearlyLastDay", month, ...t, raw: text } : null;
  }

  const onceMatch = ONCE_RE.exec(trimmed);
  if (onceMatch) {
    const year = Number(onceMatch[1]);
    const month = Number(onceMatch[2]);
    const day = Number(onceMatch[3]);
    const t = time(onceMatch[4], onceMatch[5]);
    // 実在する日付か（2026-02-30 のような値を弾く）
    const d = new Date(year, month - 1, day);
    const real = d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
    return real && t ? { type: "once", year, month, day, ...t, raw: text } : null;
  }

  const cron = parseCron(trimmed);
  if (cron) return { type: "cron", fields: cron, raw: text };

  return null;
}

// ---- 暦の共通ヘルパ（engine のラン作成判定と UI のカレンダー表示が同じ計算を使う） ----

/** その月の日数（= 最終日の日番号） */
export function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** year年 monthIndex月(0-11) の「第nth 対象曜日」の日付（00:00）。
 *  その月に第nthが存在しない（第5など）場合は null */
export function nthWeekdayOfMonth(
  year: number,
  monthIndex: number,
  nth: number,
  weekday: Weekday,
): Date | null {
  const first = new Date(year, monthIndex, 1);
  const offset = (WEEKDAYS.indexOf(weekday) - first.getDay() + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  const d = new Date(year, monthIndex, day);
  return d.getMonth() === monthIndex ? d : null;
}

/** year年 monthIndex月(0-11) の「最終 対象曜日」の日付（00:00）。必ず存在する */
export function lastWeekdayOfMonth(year: number, monthIndex: number, weekday: Weekday): Date {
  const last = new Date(year, monthIndex, lastDayOfMonth(year, monthIndex));
  const back = (last.getDay() - WEEKDAYS.indexOf(weekday) + 7) % 7;
  last.setDate(last.getDate() - back);
  return last;
}

/** cron 式がその**日付**にマッチするか（分・時のフィールドは無視する。カレンダーの
 *  「この日に発火があるか」用。dom/dow の OR は matchesCron と同じ cron 慣例） */
export function cronMatchesDate(fields: CronFields, date: Date): boolean {
  const ok = (f: CronField, v: number) => f === null || f.has(v);
  if (!ok(fields.month, date.getMonth() + 1)) return false;
  const domOk = ok(fields.dayOfMonth, date.getDate());
  const dowOk = ok(fields.dayOfWeek, date.getDay());
  if (fields.dayOfMonth !== null && fields.dayOfWeek !== null) return domOk || dowOk;
  return domOk && dowOk;
}

// ---- 起動方式の設定・変更の記録（2026-08-12） ----
// server がトリガーの schedule を設定・変更・有効化（committed 化）したときにスレッドへ積む
// status の目印。エンジンはこの時刻を「その回は済んだ」の基準に使う——これが無いと、
// 起動方式を設定した瞬間に「直近の過ぎた定刻」の追い付きランが即座に走る
// （本人報告「トリガーを変更した瞬間に実行される不具合があるかも」。every は設定直後に必ず、
// daily/weekly/monthly/yearly も直近の定刻を過ぎていれば即実行されていた）。
// SCHEDULE_WARNING_MARKER（engine/trigger.ts）と同じ「本文にマーカーを埋める」方式

export const SCHEDULE_SET_MARKER = "[起動方式]";

/** 起動方式の設定・変更を記録する status の本文（読み下し付き。監査とエンジン基準の両用） */
export function buildScheduleSetBody(before: string | null, after: string | null): string {
  const show = (s: string | null) => (s ? (describeSchedule(s) ?? s) : "手動のみ");
  return `${SCHEDULE_SET_MARKER} ${show(before)} → ${show(after)}（次の定刻から自動で開始します）`;
}

const EVERY_UNIT_JA: Record<EveryUnit, string> = { m: "分", h: "時間", d: "日", w: "週間" };

// ---- 整形（UI の構造化入力が schedule 文字列を組み立てる側。パースと同じファイルに置いて
//      文法の追加・変更が必ず両方向そろうようにする） ----

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 構造化された指定から schedule 文字列を組み立てる（parseSchedule の逆） */
export function formatSchedule(
  parsed:
    | { type: "every"; amount: number; unit: EveryUnit }
    | { type: "daily"; hour: number; minute: number }
    | { type: "weekly"; weekdays: Weekday[]; hour: number; minute: number }
    | { type: "biweekly"; weekday: Weekday; hour: number; minute: number }
    | { type: "monthly"; nth: number; weekday: Weekday; hour: number; minute: number }
    | { type: "monthlyLastDow"; weekday: Weekday; hour: number; minute: number }
    | { type: "monthlyDay"; days: number[]; hour: number; minute: number }
    | { type: "monthlyLastDay"; hour: number; minute: number }
    | { type: "yearly"; month: number; nth: number; weekday: Weekday; hour: number; minute: number }
    | { type: "yearlyDay"; month: number; day: number; hour: number; minute: number }
    | { type: "yearlyLastDay"; month: number; hour: number; minute: number }
    | { type: "once"; year: number; month: number; day: number; hour: number; minute: number },
): string {
  if (parsed.type === "every") return `every ${parsed.amount}${parsed.unit}`;
  const time = `${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
  switch (parsed.type) {
    case "daily":
      return `daily ${time}`;
    case "weekly":
      return `weekly ${parsed.weekdays.join(",")} ${time}`;
    case "biweekly":
      return `biweekly ${parsed.weekday} ${time}`;
    case "monthly":
      return `monthly ${parsed.nth} ${parsed.weekday} ${time}`;
    case "monthlyLastDow":
      return `monthly last ${parsed.weekday} ${time}`;
    case "monthlyDay":
      return `monthly day ${parsed.days.join(",")} ${time}`;
    case "monthlyLastDay":
      return `monthly lastday ${time}`;
    case "yearly":
      return `yearly ${parsed.month} ${parsed.nth} ${parsed.weekday} ${time}`;
    case "yearlyDay":
      return `yearly day ${parsed.month} ${parsed.day} ${time}`;
    case "yearlyLastDay":
      return `yearly lastday ${parsed.month} ${time}`;
    default:
      return `once ${parsed.year}-${pad2(parsed.month)}-${pad2(parsed.day)} ${time}`;
  }
}

/** schedule を日本語の読み下しにする（UI のプレビュー用）。解釈できなければ null */
export function describeSchedule(text: string | null): string | null {
  if (!text || !text.trim()) return null;
  const parsed = parseSchedule(text);
  if (!parsed) return null;
  if (parsed.type === "every") return `${parsed.amount}${EVERY_UNIT_JA[parsed.unit]}ごと`;
  if (parsed.type === "cron") return `cron式（${parsed.raw.trim()}）`;
  const time = `${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
  const dow = (d: Weekday) => `${WEEKDAY_JA[d]}曜`;
  switch (parsed.type) {
    case "daily":
      return `毎日 ${time}`;
    case "weekly":
      return `毎週${parsed.weekdays.map((d) => WEEKDAY_JA[d]).join("・")}曜 ${time}`;
    case "biweekly":
      return `隔週${dow(parsed.weekday)} ${time}`;
    case "monthly":
      return `毎月第${parsed.nth}${dow(parsed.weekday)} ${time}`;
    case "monthlyLastDow":
      return `毎月最終${dow(parsed.weekday)} ${time}`;
    case "monthlyDay":
      return `毎月${parsed.days.join("・")}日 ${time}`;
    case "monthlyLastDay":
      return `毎月最終日 ${time}`;
    case "yearly":
      return `毎年${parsed.month}月の第${parsed.nth}${dow(parsed.weekday)} ${time}`;
    case "yearlyDay":
      return `毎年${parsed.month}月${parsed.day}日 ${time}`;
    case "yearlyLastDay":
      return `毎年${parsed.month}月の最終日 ${time}`;
    default:
      return `${parsed.year}年${parsed.month}月${parsed.day}日 ${time}（1回だけ）`;
  }
}
