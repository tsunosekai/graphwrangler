// トリガーの起動方式（node.schedule）の構造化入力（docs/design.md 3.8）。
// 2026-08-12 まで生文字列の手打ち（"every 15m" 等を placeholder 頼りに書く）だったが、
// 書式を覚えていないと書けない・打ち間違いが「黙って動かないトリガー」になる（3.8 の
// schedule 警告で事後に気付くしかない）ため、方式セレクト + 数値/時刻/曜日のフォーム部品へ
// 置き換えた。文法の正本は @graphwrangler/core/schedule（エンジンのラン作成判定と同じパーサ）。
// 解釈できない既存値は従来どおりの生テキスト編集（自由入力）へフォールバックし、値を壊さない。
//
// 2026-08-12 拡張（本人要望「毎月最終日」「毎月何日」「あらゆるタイミングが登録できるように」）:
// 毎月・毎年は「指定のしかた」を副セレクトで選ぶ（日付 / 最終日 / 第n曜日 / 最終◯曜）。
// 毎週は曜日を複数選べる（平日だけ・週2回が1本で書ける）。1回だけ（once）も追加。
import { useEffect, useState } from "react";
import {
  WEEKDAYS,
  WEEKDAY_JA,
  describeSchedule,
  formatSchedule,
  parseSchedule,
  type EveryUnit,
  type Weekday,
} from "@graphwrangler/core/schedule";
import type { NodePatchInput } from "../../lib/api";
import type { Node } from "../../types";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Icon } from "../Icon";

/** セレクトで選ぶ起動方式。none=未設定（手動▶のみ）、raw=解釈できない既存値の生編集 */
type Mode =
  | "none"
  | "every"
  | "daily"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "yearly"
  | "once"
  | "cron"
  | "raw";

const MODE_JA: Record<Exclude<Mode, "none" | "raw">, string> = {
  every: "間隔ごと",
  daily: "毎日",
  weekly: "毎週",
  biweekly: "隔週",
  monthly: "毎月",
  yearly: "毎年",
  once: "1回だけ",
  cron: "cron式",
};

/** 「毎月」の指定のしかた */
type MonthMode = "day" | "lastday" | "nth" | "lastdow";
const MONTH_MODE_JA: Record<MonthMode, string> = {
  day: "◯日",
  lastday: "最終日",
  nth: "第n曜日",
  lastdow: "最終◯曜",
};

/** 「毎年」の指定のしかた */
type YearMode = "day" | "lastday" | "nth";
const YEAR_MODE_JA: Record<YearMode, string> = {
  day: "◯月◯日",
  lastday: "◯月の最終日",
  nth: "◯月の第n曜日",
};

const EVERY_UNIT_OPTIONS: { value: EveryUnit; label: string }[] = [
  { value: "m", label: "分ごと" },
  { value: "h", label: "時間ごと" },
  { value: "d", label: "日ごと" },
  { value: "w", label: "週ごと" },
];

const NTH_JA = ["第1", "第2", "第3", "第4", "第5"];

const pad2 = (n: number) => String(n).padStart(2, "0");

interface FormState {
  mode: Mode;
  everyAmount: string; // 入力途中を保持するため文字列
  everyUnit: EveryUnit;
  time: string; // "HH:MM"（daily と暦系で共用）
  /** 毎週の曜日（複数可） */
  weekdays: Weekday[];
  /** 隔週・第n曜日・最終◯曜で使う単一の曜日 */
  weekday: Weekday;
  monthMode: MonthMode;
  yearMode: YearMode;
  nth: string; // "1".."5"
  month: string; // "1".."12"
  dayOfMonth: string; // "1".."31"
  onceDate: string; // "YYYY-MM-DD"
  cronText: string;
  rawText: string;
}

/** node.schedule から編集フォームの初期状態を導出する（未指定フィールドは既定値で埋める） */
function deriveState(schedule: string | null): FormState {
  const today = new Date();
  const base: FormState = {
    mode: "none",
    everyAmount: "1",
    everyUnit: "h",
    time: "09:00",
    weekdays: ["mon"],
    weekday: "mon",
    monthMode: "day",
    yearMode: "day",
    nth: "1",
    month: "1",
    dayOfMonth: "1",
    onceDate: `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`,
    cronText: "",
    rawText: schedule ?? "",
  };
  if (!schedule || !schedule.trim()) return base;
  const parsed = parseSchedule(schedule);
  if (!parsed) return { ...base, mode: "raw" };
  if (parsed.type === "every") {
    return { ...base, mode: "every", everyAmount: String(parsed.amount), everyUnit: parsed.unit };
  }
  if (parsed.type === "cron") return { ...base, mode: "cron", cronText: schedule.trim() };
  const time = { time: `${pad2(parsed.hour)}:${pad2(parsed.minute)}` };
  switch (parsed.type) {
    case "daily":
      return { ...base, mode: "daily", ...time };
    case "weekly":
      return { ...base, mode: "weekly", weekdays: parsed.weekdays, ...time };
    case "biweekly":
      return { ...base, mode: "biweekly", weekday: parsed.weekday, ...time };
    case "monthly":
      return {
        ...base,
        mode: "monthly",
        monthMode: "nth",
        nth: String(parsed.nth),
        weekday: parsed.weekday,
        ...time,
      };
    case "monthlyLastDow":
      return { ...base, mode: "monthly", monthMode: "lastdow", weekday: parsed.weekday, ...time };
    case "monthlyDay":
      // 複数日（"1,15"）はこのフォームでは1日しか編集できず、保存すると片方が消えてしまう。
      // 値を壊さないよう生編集へ倒す（曜日と違い31個のトグルは重すぎるため単一入力にしている）
      if (parsed.days.length > 1) return { ...base, mode: "raw" };
      return { ...base, mode: "monthly", monthMode: "day", dayOfMonth: String(parsed.days[0]), ...time };
    case "monthlyLastDay":
      return { ...base, mode: "monthly", monthMode: "lastday", ...time };
    case "yearly":
      return {
        ...base,
        mode: "yearly",
        yearMode: "nth",
        month: String(parsed.month),
        nth: String(parsed.nth),
        weekday: parsed.weekday,
        ...time,
      };
    case "yearlyDay":
      return {
        ...base,
        mode: "yearly",
        yearMode: "day",
        month: String(parsed.month),
        dayOfMonth: String(parsed.day),
        ...time,
      };
    case "yearlyLastDay":
      return { ...base, mode: "yearly", yearMode: "lastday", month: String(parsed.month), ...time };
    default: // once
      return {
        ...base,
        mode: "once",
        onceDate: `${parsed.year}-${pad2(parsed.month)}-${pad2(parsed.day)}`,
        ...time,
      };
  }
}

/** フォーム状態から schedule 文字列を組み立てる。組み立て不能（入力途中）は undefined、
 *  「未設定にする」は null */
function buildSchedule(s: FormState): string | null | undefined {
  if (s.mode === "none") return null;
  if (s.mode === "every") {
    const amount = Number(s.everyAmount);
    if (!Number.isInteger(amount) || amount <= 0) return undefined;
    return formatSchedule({ type: "every", amount, unit: s.everyUnit });
  }
  if (s.mode === "cron") {
    const text = s.cronText.trim();
    // cron は式として解釈できたときだけ保存する（不正な式を保存すると 3.8 の
    // schedule 警告どまり＝黙って動かないトリガーになるため、保存前に弾く）
    return text && parseSchedule(text)?.type === "cron" ? text : undefined;
  }
  if (s.mode === "raw") return s.rawText.trim() ? s.rawText : null;

  // ここから時刻を持つ暦系
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.time);
  if (!m) return undefined;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return undefined;
  const nth = Number(s.nth);
  const month = Number(s.month);
  const day = Number(s.dayOfMonth);

  switch (s.mode) {
    case "daily":
      return formatSchedule({ type: "daily", hour, minute });
    case "weekly":
      if (s.weekdays.length === 0) return undefined; // 曜日を1つも選んでいない＝保存しない
      return formatSchedule({ type: "weekly", weekdays: s.weekdays, hour, minute });
    case "biweekly":
      return formatSchedule({ type: "biweekly", weekday: s.weekday, hour, minute });
    case "monthly":
      if (s.monthMode === "day") return formatSchedule({ type: "monthlyDay", days: [day], hour, minute });
      if (s.monthMode === "lastday") return formatSchedule({ type: "monthlyLastDay", hour, minute });
      if (s.monthMode === "lastdow")
        return formatSchedule({ type: "monthlyLastDow", weekday: s.weekday, hour, minute });
      return formatSchedule({ type: "monthly", nth, weekday: s.weekday, hour, minute });
    case "yearly":
      if (s.yearMode === "day") return formatSchedule({ type: "yearlyDay", month, day, hour, minute });
      if (s.yearMode === "lastday") return formatSchedule({ type: "yearlyLastDay", month, hour, minute });
      return formatSchedule({ type: "yearly", month, nth, weekday: s.weekday, hour, minute });
    default: {
      // once
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.onceDate);
      if (!d) return undefined;
      return formatSchedule({
        type: "once",
        year: Number(d[1]),
        month: Number(d[2]),
        day: Number(d[3]),
        hour,
        minute,
      });
    }
  }
}

/** 曜日トグル（毎週の複数曜日）。平日・毎日のプリセットも添える */
function WeekdayPicker({
  value,
  disabled,
  onChange,
}: {
  value: Weekday[];
  disabled?: boolean;
  onChange: (next: Weekday[]) => void;
}) {
  const toggle = (d: Weekday) => {
    const next = value.includes(d) ? value.filter((x) => x !== d) : [...value, d];
    onChange(WEEKDAYS.filter((x) => next.includes(x))); // 曜日順に整列
  };
  return (
    <span className="flex items-center gap-1">
      <span className="flex overflow-hidden rounded-md border border-border">
        {WEEKDAYS.map((d) => (
          <button
            key={d}
            type="button"
            disabled={disabled}
            aria-pressed={value.includes(d)}
            className={cn(
              "h-7 w-7 border-r border-border text-xs last:border-r-0",
              value.includes(d)
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:bg-accent",
              d === "sun" && !value.includes(d) && "text-red-500/70",
              d === "sat" && !value.includes(d) && "text-blue-500/70",
            )}
            onClick={() => toggle(d)}
          >
            {WEEKDAY_JA[d]}
          </button>
        ))}
      </span>
      <button
        type="button"
        disabled={disabled}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => onChange(["mon", "tue", "wed", "thu", "fri"])}
      >
        平日
      </button>
    </span>
  );
}

/**
 * トリガーの起動方式エディタ。executor=script は全書式、executor=ai は「チェック間隔」
 * （every のみ解釈。3.8）なので間隔ビルダーだけを出す。
 * 保存は「フォームが完全な値になった瞬間」（セレクト変更は即時、テキスト系は blur）。
 */
export function ScheduleSection({
  node,
  contentLocked,
  patch,
}: {
  node: Node;
  contentLocked: boolean;
  patch: (fields: NodePatchInput) => Promise<void>;
}) {
  const [state, setState] = useState<FormState>(() => deriveState(node.schedule));
  // ノード切替・外部変更（AIやMCP経由の書き換え）へ追随する。編集途中の上書きを避けるため
  // 「今のフォームが表す schedule と外部値が違うときだけ」リセットする
  useEffect(() => {
    setState((prev) => {
      const current = buildSchedule(prev);
      if (current !== undefined && (current ?? null) === (node.schedule ?? null)) return prev;
      return deriveState(node.schedule);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.schedule]);

  const intervalOnly = node.executor === "ai";

  const commit = async (next: FormState) => {
    const built = buildSchedule(next);
    if (built === undefined) return; // 入力途中は保存しない（blur時に再判定される）
    if ((built ?? null) !== (node.schedule ?? null)) await patch({ schedule: built });
  };

  /** セレクト系の変更は状態更新と同時に保存まで行う */
  const update = (fields: Partial<FormState>, save = true) => {
    const next = { ...state, ...fields };
    setState(next);
    if (save) void commit(next);
  };

  const blurOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };

  // AIトリガーに every 以外が書いてある＝エンジンは無視して既定1時間になる（3.8）。
  // 生編集フォールバックで見せて直せるようにする
  const aiIgnored =
    intervalOnly && !!node.schedule && parseSchedule(node.schedule)?.type !== "every";

  const description = describeSchedule(node.schedule);
  /** 曜日を1つ選ぶセレクト（隔週・第n曜日・最終◯曜で共用） */
  const weekdaySelect = (
    <Select
      value={state.weekday}
      disabled={contentLocked}
      onValueChange={(v) => update({ weekday: v as Weekday })}
    >
      <SelectTrigger className="h-8 w-24 flex-shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {WEEKDAYS.map((d) => (
          <SelectItem key={d} value={d}>
            {WEEKDAY_JA[d]}曜
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  /** 第n セレクト */
  const nthSelect = (
    <Select value={state.nth} disabled={contentLocked} onValueChange={(v) => update({ nth: v })}>
      <SelectTrigger className="h-8 w-20 flex-shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {NTH_JA.map((label, i) => (
          <SelectItem key={label} value={String(i + 1)}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  /** 月セレクト */
  const monthSelect = (
    <Select value={state.month} disabled={contentLocked} onValueChange={(v) => update({ month: v })}>
      <SelectTrigger className="h-8 w-20 flex-shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: 12 }, (_, i) => String(i + 1)).map((m) => (
          <SelectItem key={m} value={m}>
            {m}月
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  /** 日セレクト（1〜31。無い日の月は飛ばす仕様＝下の注記で伝える） */
  const daySelect = (
    <Select
      value={state.dayOfMonth}
      disabled={contentLocked}
      onValueChange={(v) => update({ dayOfMonth: v })}
    >
      <SelectTrigger className="h-8 w-20 flex-shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
          <SelectItem key={d} value={d}>
            {d}日
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const timeInput = (
    <Input
      type="time"
      className="h-8 w-28"
      value={state.time}
      disabled={contentLocked}
      onChange={(e) => update({ time: e.target.value }, false)}
      onBlur={() => commit(state)}
    />
  );

  return (
    <div className="flex flex-col gap-1.5">
      {/* flex-wrap: 毎年（方式+副方式+月+日+時刻）はパネル幅に収まらないので折り返す */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* 方式セレクト。ai は every 固定なので出さない（間隔ビルダーだけ） */}
        {!intervalOnly && (
          <Select
            value={state.mode}
            disabled={contentLocked}
            onValueChange={(v) => {
              const mode = v as Mode;
              // 方式を選んだ瞬間に既定値で確定する（daily=09:00 等）。cron だけは
              // 式が入るまで保存できないので状態変更のみ
              update({ mode }, mode !== "cron" && mode !== "raw");
            }}
          >
            <SelectTrigger className="h-8 w-32 flex-shrink-0">
              <SelectValue placeholder="起動方式" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">手動のみ</SelectItem>
              {(Object.keys(MODE_JA) as (keyof typeof MODE_JA)[]).map((m) => (
                <SelectItem key={m} value={m}>
                  {MODE_JA[m]}
                </SelectItem>
              ))}
              {/* 解釈できない既存値のときだけ現れる逃げ道（値を壊さないため） */}
              {state.mode === "raw" && <SelectItem value="raw">自由入力</SelectItem>}
            </SelectContent>
          </Select>
        )}

        {/* 間隔ビルダー（every / aiのチェック間隔） */}
        {(state.mode === "every" || (intervalOnly && state.mode !== "raw")) && (
          <>
            <Input
              type="number"
              min={1}
              className="h-8 w-20"
              placeholder={intervalOnly ? "1" : undefined}
              value={state.everyAmount}
              disabled={contentLocked}
              onChange={(e) => update({ mode: "every", everyAmount: e.target.value }, false)}
              onBlur={() => commit({ ...state, mode: "every" })}
              onKeyDown={blurOnEnter}
            />
            <Select
              value={state.everyUnit}
              disabled={contentLocked}
              onValueChange={(v) => update({ mode: "every", everyUnit: v as EveryUnit })}
            >
              <SelectTrigger className="h-8 w-28 flex-shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVERY_UNIT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}

        {/* 毎月・毎年の「指定のしかた」 */}
        {!intervalOnly && state.mode === "monthly" && (
          <Select
            value={state.monthMode}
            disabled={contentLocked}
            onValueChange={(v) => update({ monthMode: v as MonthMode })}
          >
            <SelectTrigger className="h-8 w-28 flex-shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(MONTH_MODE_JA) as MonthMode[]).map((m) => (
                <SelectItem key={m} value={m}>
                  {MONTH_MODE_JA[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {!intervalOnly && state.mode === "yearly" && (
          <Select
            value={state.yearMode}
            disabled={contentLocked}
            onValueChange={(v) => update({ yearMode: v as YearMode })}
          >
            <SelectTrigger className="h-8 w-32 flex-shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(YEAR_MODE_JA) as YearMode[]).map((m) => (
                <SelectItem key={m} value={m}>
                  {YEAR_MODE_JA[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* 毎年は先に月を選ぶ */}
        {!intervalOnly && state.mode === "yearly" && monthSelect}
        {/* 日付指定（毎月◯日 / 毎年◯月◯日） */}
        {!intervalOnly &&
          ((state.mode === "monthly" && state.monthMode === "day") ||
            (state.mode === "yearly" && state.yearMode === "day")) &&
          daySelect}
        {/* 第n（第n曜日） */}
        {!intervalOnly &&
          ((state.mode === "monthly" && state.monthMode === "nth") ||
            (state.mode === "yearly" && state.yearMode === "nth")) &&
          nthSelect}
        {/* 曜日1つ（隔週 / 第n曜日 / 最終◯曜） */}
        {!intervalOnly &&
          (state.mode === "biweekly" ||
            (state.mode === "monthly" && (state.monthMode === "nth" || state.monthMode === "lastdow")) ||
            (state.mode === "yearly" && state.yearMode === "nth")) &&
          weekdaySelect}
        {/* 曜日を複数（毎週） */}
        {!intervalOnly && state.mode === "weekly" && (
          <WeekdayPicker
            value={state.weekdays}
            disabled={contentLocked}
            onChange={(weekdays) => update({ weekdays })}
          />
        )}
        {/* 1回だけの日付 */}
        {!intervalOnly && state.mode === "once" && (
          <Input
            type="date"
            className="h-8 w-36"
            value={state.onceDate}
            disabled={contentLocked}
            onChange={(e) => update({ onceDate: e.target.value }, false)}
            onBlur={() => commit(state)}
          />
        )}

        {/* 時刻（暦系すべて） */}
        {!intervalOnly &&
          ["daily", "weekly", "biweekly", "monthly", "yearly", "once"].includes(state.mode) &&
          timeInput}
      </div>

      {/* cron 式（5フィールド）。不正な式は保存しない（下の⚠で知らせる） */}
      {!intervalOnly && state.mode === "cron" && (
        <Input
          className="h-8 font-mono text-xs"
          placeholder="*/15 9-23 * * *（分 時 日 月 曜日。mon / jan / @daily も可）"
          value={state.cronText}
          disabled={contentLocked}
          onChange={(e) => update({ cronText: e.target.value }, false)}
          onBlur={() => commit(state)}
          onKeyDown={blurOnEnter}
        />
      )}

      {/* 解釈できない既存値・フォームで編集しきれない値の生編集（値を壊さないためのフォールバック） */}
      {state.mode === "raw" && (
        <Input
          className="h-8 font-mono text-xs"
          value={state.rawText}
          disabled={contentLocked}
          onChange={(e) => update({ rawText: e.target.value }, false)}
          onBlur={() => commit(state)}
          onKeyDown={blurOnEnter}
        />
      )}

      {/* 読み下しプレビュー / 警告。保存済みの node.schedule を読むので「実際に効く設定」を示す */}
      {aiIgnored ? (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <Icon name="alert" size={12} />
          AIトリガーは間隔（every）だけ解釈します。この設定は無視され、既定の1時間ごとになります
        </p>
      ) : node.schedule && !description ? (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <Icon name="alert" size={12} />
          解釈できない書式のため、このトリガーは自動でランを作りません
        </p>
      ) : state.mode === "cron" && state.cronText.trim() && node.schedule !== state.cronText.trim() ? (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <Icon name="alert" size={12} />
          cron式として解釈できません（5フィールド: 分 時 日 月 曜日）
        </p>
      ) : state.mode === "weekly" && state.weekdays.length === 0 ? (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <Icon name="alert" size={12} />
          曜日を1つ以上選んでください
        </p>
      ) : description ? (
        <p className="text-xs text-muted-foreground">
          {intervalOnly
            ? `${description}に、AIがランを作るべきか判定します（条件は概要や手順書に書く）`
            : `${description}に自動でランを作ります`}
          {/* 31日など、その日が無い月は飛ばす（月末に寄せたいなら「最終日」を使う） */}
          {state.mode === "monthly" && state.monthMode === "day" && Number(state.dayOfMonth) > 28
            ? `（${state.dayOfMonth}日が無い月は飛ばします。月末に寄せたいなら「最終日」）`
            : ""}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {intervalOnly
            ? "未設定（既定の1時間ごとにAIが判定。条件は概要や手順書に書く）"
            : "自動では開始しません（ノードの ▶ で手動開始のみ）"}
        </p>
      )}
    </div>
  );
}
