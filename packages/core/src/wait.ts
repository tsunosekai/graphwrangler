// 待ちノード（kind=wait）の「待ち方」の書式（node.wait。docs/design.md 3.17）。
// 文法の正本はここ1箇所で、UI の入力フォームもエンジンの判定も同じパーサを通す
// （起動方式 schedule.ts と同じ流儀）。ネットワークI/Oを持たない純粋関数のみ。
//
// 書式は2系統:
//   - "after 3h" / "after 30m" / "after 2w"  … 順番が回ってきてから、その時間だけ待つ
//   - "after 8d 09:00"                        … 順番が回ってきた日の N 日後の、その時刻まで待つ
//   - "until <暦の書式>"                      … 次のその日時まで待つ（例 "until monthly day 9 09:00"）
// until の暦の書式は起動方式と同じもの（daily / weekday / weekly / monthly系 / yearly系 / once）。
// every・cron・biweekly は「次の1点」が定まらない／意味が紛らわしいので受け付けない。
import {
  describeSchedule,
  parseSchedule,
  type EveryUnit,
  type ParsedSchedule,
} from "./schedule.js";

/** until に使える暦の書式（「次のその日時」が1点に定まるもの） */
export type WaitCalendarSchedule = Exclude<ParsedSchedule, { type: "every" | "cron" | "biweekly" }>;

export type ParsedWait =
  | { type: "after"; ms: number; amount: number; unit: EveryUnit; raw: string }
  | { type: "afterDays"; days: number; hour: number; minute: number; raw: string }
  | { type: "until"; schedule: WaitCalendarSchedule; raw: string };

const AFTER_RE = /^after\s+(\d+)\s*(m|h|d|w)$/i;
const AFTER_DAYS_AT_RE = /^after\s+(\d+)\s*d\s+(\d{1,2}):(\d{2})$/i;
const UNTIL_RE = /^until\s+(.+)$/i;

const UNIT_MS: Record<EveryUnit, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** 待ち方の文字列をパースする。対応外の書式は null */
export function parseWait(text: string): ParsedWait | null {
  const trimmed = text.trim();

  const daysAt = AFTER_DAYS_AT_RE.exec(trimmed);
  if (daysAt) {
    const days = Number(daysAt[1]);
    const hour = Number(daysAt[2]);
    const minute = Number(daysAt[3]);
    if (hour > 23 || minute > 59) return null;
    return { type: "afterDays", days, hour, minute, raw: text };
  }

  const after = AFTER_RE.exec(trimmed);
  if (after) {
    const amount = Number(after[1]);
    if (amount <= 0) return null;
    const unit = after[2].toLowerCase() as EveryUnit;
    return { type: "after", ms: amount * UNIT_MS[unit], amount, unit, raw: text };
  }

  const until = UNTIL_RE.exec(trimmed);
  if (until) {
    const schedule = parseSchedule(until[1]);
    if (!schedule) return null;
    if (schedule.type === "every" || schedule.type === "cron" || schedule.type === "biweekly") return null;
    return { type: "until", schedule, raw: text };
  }
  return null;
}

const UNIT_JA: Record<EveryUnit, string> = { m: "分", h: "時間", d: "日", w: "週間" };
const pad = (n: number) => String(n).padStart(2, "0");

/** 待ち方の読み下し（UI のプレビュー・カード表示用）。解釈できなければ null */
export function describeWait(text: string | null): string | null {
  if (!text || !text.trim()) return null;
  const parsed = parseWait(text);
  if (!parsed) return null;
  if (parsed.type === "after") return `${parsed.amount}${UNIT_JA[parsed.unit]}待つ`;
  if (parsed.type === "afterDays") {
    const day = parsed.days === 0 ? "当日" : `${parsed.days}日後`;
    return `${day}の ${pad(parsed.hour)}:${pad(parsed.minute)} まで待つ`;
  }
  const when = describeSchedule(parsed.schedule.raw);
  return when ? `次の「${when}」まで待つ` : null;
}
