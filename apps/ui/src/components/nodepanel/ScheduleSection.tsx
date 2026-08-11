// トリガーの起動方式（node.schedule）の構造化入力（docs/design.md 3.8）。
// 2026-08-12 まで生文字列の手打ち（"every 15m" 等を placeholder 頼りに書く）だったが、
// 書式を覚えていないと書けない・打ち間違いが「黙って動かないトリガー」になる（3.8 の
// schedule 警告で事後に気付くしかない）ため、方式セレクト + 数値/時刻/曜日のフォーム部品へ
// 置き換えた。文法の正本は @graphwrangler/core/schedule（エンジンのラン作成判定と同じパーサ）。
// 解釈できない既存値は従来どおりの生テキスト編集（自由入力）へフォールバックし、値を壊さない。
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
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Icon } from "../Icon";

/** セレクトで選ぶ起動方式。none=未設定（手動▶のみ）、raw=解釈できない既存値の生編集 */
type Mode = "none" | "every" | "daily" | "weekly" | "cron" | "raw";

const MODE_JA: Record<Exclude<Mode, "none" | "raw">, string> = {
  every: "間隔ごと",
  daily: "毎日",
  weekly: "毎週",
  cron: "cron式",
};

const EVERY_UNIT_OPTIONS: { value: EveryUnit; label: string }[] = [
  { value: "m", label: "分ごと" },
  { value: "h", label: "時間ごと" },
  { value: "d", label: "日ごと" },
];

const pad2 = (n: number) => String(n).padStart(2, "0");

interface FormState {
  mode: Mode;
  everyAmount: string; // 入力途中を保持するため文字列
  everyUnit: EveryUnit;
  time: string; // "HH:MM"（daily/weekly 共用）
  weekday: Weekday;
  cronText: string;
  rawText: string;
}

/** node.schedule から編集フォームの初期状態を導出する（未指定フィールドは既定値で埋める） */
function deriveState(schedule: string | null): FormState {
  const base: FormState = {
    mode: "none",
    everyAmount: "1",
    everyUnit: "h",
    time: "09:00",
    weekday: "mon",
    cronText: "",
    rawText: schedule ?? "",
  };
  if (!schedule || !schedule.trim()) return base;
  const parsed = parseSchedule(schedule);
  if (!parsed) return { ...base, mode: "raw" };
  if (parsed.type === "every") {
    return { ...base, mode: "every", everyAmount: String(parsed.amount), everyUnit: parsed.unit };
  }
  if (parsed.type === "daily") {
    return { ...base, mode: "daily", time: `${pad2(parsed.hour)}:${pad2(parsed.minute)}` };
  }
  if (parsed.type === "weekly") {
    return {
      ...base,
      mode: "weekly",
      weekday: parsed.weekday,
      time: `${pad2(parsed.hour)}:${pad2(parsed.minute)}`,
    };
  }
  return { ...base, mode: "cron", cronText: schedule.trim() };
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
  if (s.mode === "daily" || s.mode === "weekly") {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.time);
    if (!m) return undefined;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return undefined;
    return s.mode === "daily"
      ? formatSchedule({ type: "daily", hour, minute })
      : formatSchedule({ type: "weekly", weekday: s.weekday, hour, minute });
  }
  if (s.mode === "cron") {
    const text = s.cronText.trim();
    // cron は式として解釈できたときだけ保存する（不正な式を保存すると 3.8 の
    // schedule 警告どまり＝黙って動かないトリガーになるため、保存前に弾く）
    return text && parseSchedule(text)?.type === "cron" ? text : undefined;
  }
  // raw: 生テキストをそのまま（空は未設定へ）
  return s.rawText.trim() ? s.rawText : null;
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

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
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

        {/* 曜日（weekly のみ） */}
        {!intervalOnly && state.mode === "weekly" && (
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
        )}

        {/* 時刻（daily / weekly） */}
        {!intervalOnly && (state.mode === "daily" || state.mode === "weekly") && (
          <Input
            type="time"
            className="h-8 w-28"
            value={state.time}
            disabled={contentLocked}
            onChange={(e) => update({ time: e.target.value }, false)}
            onBlur={() => commit(state)}
          />
        )}
      </div>

      {/* cron 式（5フィールド）。不正な式は保存しない（下の⚠で知らせる） */}
      {!intervalOnly && state.mode === "cron" && (
        <Input
          className="h-8 font-mono text-xs"
          placeholder="*/15 9-23 * * *（分 時 日 月 曜日）"
          value={state.cronText}
          disabled={contentLocked}
          onChange={(e) => update({ cronText: e.target.value }, false)}
          onBlur={() => commit(state)}
          onKeyDown={blurOnEnter}
        />
      )}

      {/* 解釈できない既存値の生編集（値を壊さないためのフォールバック） */}
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
      ) : description ? (
        <p className="text-xs text-muted-foreground">
          {intervalOnly
            ? `${description}に、AIがランを作るべきか判定します（条件は概要や手順書に書く）`
            : `${description}に自動でランを作ります`}
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
