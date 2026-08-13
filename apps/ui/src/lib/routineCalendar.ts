// ルーティーンのカレンダー表示（2026-08-12 本人要望「ルーティーンをカレンダーで見られる
// 機能がほしい。毎日とかの頻度が細かすぎる奴はフィルターできるように（デフォルトで
// 毎日以下は非表示）」）の純関数。文法・暦計算は @graphwrangler/core/schedule と共通。
// エンジンのラン作成判定（engine/schedule.ts）と厳密に同じ「次にいつ走るか」の再現では
// なく、**予定表として読める近似**を出す（biweekly / every Nd の錨は最新ランに合わせる）。
import {
  cronMatchesDate,
  lastDayOfMonth,
  lastWeekdayOfMonth,
  nthWeekdayOfMonth,
  parseSchedule,
  WEEKDAYS,
  describeSchedule,
  type ParsedSchedule,
  type Weekday,
} from "@graphwrangler/core/schedule";
import { isJapaneseBusinessDay } from "@graphwrangler/core/holidays";
import type { Node, Run } from "../types";

export interface CalendarTrigger {
  triggerId: string;
  pageId: string;
  pageTitle: string;
  /** "HH:MM"。every 系は null（時刻を持たない） */
  time: string | null;
  /** チップに出す短いラベル（time があれば "HH:MM"、無ければ "15分ごと" 等） */
  label: string;
  /** 読み下し（ツールチップ用。describeSchedule） */
  description: string;
  /** 「毎日以下」の細かい頻度か（既定フィルタで隠す対象） */
  fine: boolean;
  parsed: ParsedSchedule;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 「毎日以下」（1日に1回以上の頻度）か。既定フィルタで隠す対象。
 *  - every は m/h と「1日ごと」まで。2日ごと・週ごとは日が飛ぶので隠さない（2026-08-12 修正）
 *  - cron は日付フィールド（日・月・曜日）が全部 "*" なら毎日発火＝細かい扱い */
export function isFineSchedule(parsed: ParsedSchedule): boolean {
  if (parsed.type === "every") {
    if (parsed.unit === "m" || parsed.unit === "h") return true;
    return parsed.unit === "d" && parsed.amount <= 1;
  }
  if (parsed.type === "daily") return true;
  if (parsed.type === "cron") {
    const f = parsed.fields;
    return f.dayOfMonth === null && f.month === null && f.dayOfWeek === null;
  }
  return false;
}

/** ページ（group）→ そのページのトリガーたち、からカレンダーの材料を作る。
 *  対象: committed / executor=script / schedule が解釈できる / ページが終いでない */
export function collectCalendarTriggers(allNodes: Node[]): CalendarTrigger[] {
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const out: CalendarTrigger[] = [];
  for (const n of allNodes) {
    if (n.kind !== "trigger" || n.lifecycle !== "committed" || n.executor !== "script") continue;
    if (!n.schedule || !n.group) continue;
    const page = byId.get(n.group);
    if (!page || page.status === "done" || page.status === "dropped") continue;
    const parsed = parseSchedule(n.schedule);
    if (!parsed) continue;
    const description = describeSchedule(n.schedule) ?? n.schedule;
    const time =
      parsed.type === "every" || parsed.type === "cron"
        ? null
        : `${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
    out.push({
      triggerId: n.id,
      pageId: page.id,
      pageTitle: page.title || "（無題）",
      time,
      label: time ?? description,
      description,
      fine: isFineSchedule(parsed),
      parsed,
    });
  }
  return out;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** now 以前で直近の「対象曜日 00:00」（biweekly の錨計算用） */
function lastWeekdayOnOrBefore(weekday: Weekday, base: Date): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const back = (d.getDay() - WEEKDAYS.indexOf(weekday) + 7) % 7;
  d.setDate(d.getDate() - back);
  return d;
}

/**
 * year年 monthIndex月(0-11) のうち、このトリガーが「発火する予定の日」の日番号（1始まり）。
 *
 * - daily / every: 全日（既定フィルタでは隠れている。表示したときは毎日チップが出る）
 * - weekday: 平日（月〜金かつ祝日でない日）。毎週の月〜金と違い祝日が抜ける
 * - weekly: 対象曜日の日
 * - biweekly: 対象曜日のうち、錨（最新ランの直近対象曜日。ランが無ければ today 基準の
 *   直近対象曜日）と週差が偶数の日——エンジンの「最後のランから2週間」の近似
 * - monthly / yearly: 第n対象曜日の日（無い月・対象外の月は空）
 * - cron: 日付フィールドがマッチする日
 */
export function occurrenceDays(
  parsed: ParsedSchedule,
  year: number,
  monthIndex: number,
  opts: { latestRunCreated: string | null; today: Date },
): number[] {
  const daysInMonth = lastDayOfMonth(year, monthIndex);
  const all = () => Array.from({ length: daysInMonth }, (_, i) => i + 1);
  /** その月の中で条件に合う日を集める小道具 */
  const pick = (ok: (day: number, date: Date) => boolean) => {
    const out: number[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      if (ok(day, new Date(year, monthIndex, day))) out.push(day);
    }
    return out;
  };

  if (parsed.type === "daily") return all();

  if (parsed.type === "every") {
    // 1日に何度も走るものは全日。日・週の刻みは「錨（最新ラン。無ければ今日）から N 日ごと」
    if (parsed.unit === "m" || parsed.unit === "h") return all();
    const stepDays = parsed.unit === "w" ? parsed.amount * 7 : parsed.amount;
    if (stepDays <= 1) return all();
    const a = opts.latestRunCreated ? new Date(opts.latestRunCreated) : opts.today;
    const anchor = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    return pick((_day, date) => {
      const diff = Math.round((date.getTime() - anchor.getTime()) / MS_PER_DAY);
      return diff % stepDays === 0;
    });
  }

  if (parsed.type === "weekday") return pick((_day, date) => isJapaneseBusinessDay(date));

  if (parsed.type === "weekly") {
    const targets = new Set(parsed.weekdays.map((d) => WEEKDAYS.indexOf(d)));
    return pick((_day, date) => targets.has(date.getDay()));
  }

  if (parsed.type === "biweekly") {
    const target = WEEKDAYS.indexOf(parsed.weekday);
    // 錨（最新ランの直近対象曜日。ランが無ければ today 基準）から週差が偶数の週だけ
    const anchorBase = opts.latestRunCreated ? new Date(opts.latestRunCreated) : opts.today;
    const anchor = lastWeekdayOnOrBefore(parsed.weekday, anchorBase);
    return pick((_day, date) => {
      if (date.getDay() !== target) return false;
      const weeks = Math.round((date.getTime() - anchor.getTime()) / (7 * MS_PER_DAY));
      return ((weeks % 2) + 2) % 2 === 0;
    });
  }

  if (parsed.type === "monthly" || parsed.type === "yearly") {
    if (parsed.type === "yearly" && monthIndex !== parsed.month - 1) return [];
    const d = nthWeekdayOfMonth(year, monthIndex, parsed.nth, parsed.weekday);
    return d ? [d.getDate()] : [];
  }

  if (parsed.type === "monthlyLastDow") {
    return [lastWeekdayOfMonth(year, monthIndex, parsed.weekday).getDate()];
  }

  if (parsed.type === "monthlyDay") {
    // 31日など、その月に無い日は飛ばす（月末に寄せたいなら「毎月最終日」を使う）
    return parsed.days.filter((d) => d <= daysInMonth);
  }

  if (parsed.type === "monthlyLastDay") return [daysInMonth];

  if (parsed.type === "yearlyDay") {
    if (monthIndex !== parsed.month - 1 || parsed.day > daysInMonth) return [];
    return [parsed.day];
  }

  if (parsed.type === "yearlyLastDay") {
    return monthIndex === parsed.month - 1 ? [daysInMonth] : [];
  }

  if (parsed.type === "once") {
    return parsed.year === year && parsed.month - 1 === monthIndex ? [parsed.day] : [];
  }

  // cron: 日付レベルのマッチ（分・時は無視）
  return pick((_day, date) => cronMatchesDate(parsed.fields, date));
}

/** ページの最新ラン作成時刻（biweekly / every Nd の錨用）。無ければ null */
export function latestRunCreatedOf(pageRuns: Record<string, Run[]>, pageId: string): string | null {
  const runs = pageRuns[pageId];
  return runs && runs.length > 0 ? runs[0].created : null; // App の一覧は created 降順
}

export interface CalendarCellEntry {
  trigger: CalendarTrigger;
}

/** 月のセルへ流し込む形: 日番号 → その日のトリガー（時刻順、時刻なしは末尾） */
export function buildMonthCells(
  triggers: CalendarTrigger[],
  year: number,
  monthIndex: number,
  pageRuns: Record<string, Run[]>,
  today: Date,
  showFine: boolean,
): Map<number, CalendarTrigger[]> {
  const cells = new Map<number, CalendarTrigger[]>();
  for (const t of triggers) {
    if (t.fine && !showFine) continue;
    const days = occurrenceDays(t.parsed, year, monthIndex, {
      latestRunCreated: latestRunCreatedOf(pageRuns, t.pageId),
      today,
    });
    for (const day of days) {
      const list = cells.get(day) ?? [];
      list.push(t);
      cells.set(day, list);
    }
  }
  for (const list of cells.values()) {
    list.sort((a, b) => (a.time ?? "99").localeCompare(b.time ?? "99"));
  }
  return cells;
}
