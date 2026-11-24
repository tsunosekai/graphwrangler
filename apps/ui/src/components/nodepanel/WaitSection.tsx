// 待ちノード（kind=wait）の「待ち方」（node.wait）の入力（docs/design.md 3.17）。
// 起動方式（ScheduleSection）と同じく、生文字列の手打ちではなくフォームで組み立てる。
// 文法の正本は @graphwrangler/core/wait（エンジンの判定と同じパーサ）。フォームで表せない
// 既存値は生テキスト編集へフォールバックし、値を壊さない。
import { useEffect, useState } from "react";
import { WEEKDAYS, WEEKDAY_JA, type EveryUnit, type Weekday } from "@graphwrangler/core/schedule";
import { describeWait, parseWait } from "@graphwrangler/core/wait";
import type { NodePatchInput } from "../../lib/api";
import type { Node } from "../../types";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Icon } from "../Icon";

type Mode = "after" | "afterDays" | "untilMonthly" | "untilWeekly" | "untilDaily" | "raw";

const MODE_JA: Record<Exclude<Mode, "raw">, string> = {
  after: "時間で待つ",
  afterDays: "◯日後の時刻まで",
  untilMonthly: "次の◯日まで",
  untilWeekly: "次の◯曜日まで",
  untilDaily: "次のその時刻まで",
};

const UNIT_OPTIONS: { value: EveryUnit; label: string }[] = [
  { value: "m", label: "分" },
  { value: "h", label: "時間" },
  { value: "d", label: "日" },
  { value: "w", label: "週間" },
];

interface FormState {
  mode: Mode;
  amount: string;
  unit: EveryUnit;
  days: string;
  time: string;
  dayOfMonth: string;
  weekday: Weekday;
  rawText: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

const DEFAULT_STATE: FormState = {
  mode: "afterDays",
  amount: "1",
  unit: "d",
  days: "7",
  time: "09:00",
  dayOfMonth: "1",
  weekday: "mon",
  rawText: "",
};

/** 保存済みの node.wait をフォームの状態へ戻す。フォームで表せない値は raw へ */
function toState(wait: string | null): FormState {
  if (!wait) return DEFAULT_STATE;
  const parsed = parseWait(wait);
  if (!parsed) return { ...DEFAULT_STATE, mode: "raw", rawText: wait };
  if (parsed.type === "after") {
    return { ...DEFAULT_STATE, mode: "after", amount: String(parsed.amount), unit: parsed.unit };
  }
  if (parsed.type === "afterDays") {
    return {
      ...DEFAULT_STATE,
      mode: "afterDays",
      days: String(parsed.days),
      time: `${pad(parsed.hour)}:${pad(parsed.minute)}`,
    };
  }
  const s = parsed.schedule;
  if (s.type === "daily") {
    return { ...DEFAULT_STATE, mode: "untilDaily", time: `${pad(s.hour)}:${pad(s.minute)}` };
  }
  if (s.type === "weekly" && s.weekdays.length === 1) {
    return { ...DEFAULT_STATE, mode: "untilWeekly", weekday: s.weekdays[0], time: `${pad(s.hour)}:${pad(s.minute)}` };
  }
  if (s.type === "monthlyDay" && s.days.length === 1) {
    return {
      ...DEFAULT_STATE,
      mode: "untilMonthly",
      dayOfMonth: String(s.days[0]),
      time: `${pad(s.hour)}:${pad(s.minute)}`,
    };
  }
  return { ...DEFAULT_STATE, mode: "raw", rawText: wait };
}

/** フォームの状態から node.wait を組み立てる。入力途中（不正）なら undefined */
function build(state: FormState): string | undefined {
  const timeOk = /^\d{1,2}:\d{2}$/.test(state.time);
  let text: string;
  switch (state.mode) {
    case "after":
      text = `after ${state.amount}${state.unit}`;
      break;
    case "afterDays":
      if (!timeOk) return undefined;
      text = `after ${state.days}d ${state.time}`;
      break;
    case "untilMonthly":
      if (!timeOk) return undefined;
      text = `until monthly day ${state.dayOfMonth} ${state.time}`;
      break;
    case "untilWeekly":
      if (!timeOk) return undefined;
      text = `until weekly ${state.weekday} ${state.time}`;
      break;
    case "untilDaily":
      if (!timeOk) return undefined;
      text = `until daily ${state.time}`;
      break;
    default:
      text = state.rawText.trim();
  }
  return parseWait(text) ? text : undefined;
}

export function WaitSection({
  node,
  contentLocked,
  patch,
}: {
  node: Node;
  contentLocked: boolean;
  patch: (p: NodePatchInput) => Promise<void> | void;
}) {
  const [state, setState] = useState<FormState>(() => toState(node.wait ?? null));
  // 別ノードへ切り替えた・外から値が変わったときにフォームを合わせ直す
  // biome-ignore lint/correctness/useExhaustiveDependencies: node.id と node.wait が変わったときだけ同期する
  useEffect(() => {
    setState(toState(node.wait ?? null));
  }, [node.id, node.wait]);

  const commit = async (next: FormState) => {
    const built = build(next);
    if (built === undefined) return; // 入力途中は保存しない
    if (built !== (node.wait ?? null)) await patch({ wait: built });
  };
  /** 状態を更新し、セレクト類は即保存（テキスト系は blur で保存） */
  const update = (p: Partial<FormState>, save = true) => {
    const next = { ...state, ...p };
    setState(next);
    if (save) void commit(next);
  };

  const description = describeWait(node.wait ?? null);
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
  const numberInput = (key: "amount" | "days", min: number) => (
    <Input
      type="number"
      min={min}
      className="h-8 w-20"
      value={state[key]}
      disabled={contentLocked}
      onChange={(e) => update({ [key]: e.target.value } as Partial<FormState>, false)}
      onBlur={() => commit(state)}
    />
  );

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-muted-foreground">待ち方</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          value={state.mode}
          disabled={contentLocked}
          onValueChange={(v) => update({ mode: v as Mode })}
        >
          <SelectTrigger className="h-8 w-44 flex-shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(MODE_JA) as Exclude<Mode, "raw">[]).map((m) => (
              <SelectItem key={m} value={m}>
                {MODE_JA[m]}
              </SelectItem>
            ))}
            {state.mode === "raw" && <SelectItem value="raw">自由入力</SelectItem>}
          </SelectContent>
        </Select>

        {state.mode === "after" && (
          <>
            {numberInput("amount", 1)}
            <Select
              value={state.unit}
              disabled={contentLocked}
              onValueChange={(v) => update({ unit: v as EveryUnit })}
            >
              <SelectTrigger className="h-8 w-24 flex-shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNIT_OPTIONS.map((u) => (
                  <SelectItem key={u.value} value={u.value}>
                    {u.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        {state.mode === "afterDays" && (
          <>
            {numberInput("days", 0)}
            <span className="text-sm text-muted-foreground">日後の</span>
            {timeInput}
          </>
        )}
        {state.mode === "untilMonthly" && (
          <>
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
            {timeInput}
          </>
        )}
        {state.mode === "untilWeekly" && (
          <>
            <Select
              value={state.weekday}
              disabled={contentLocked}
              onValueChange={(v) => update({ weekday: v as Weekday })}
            >
              <SelectTrigger className="h-8 w-20 flex-shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAYS.map((w) => (
                  <SelectItem key={w} value={w}>
                    {WEEKDAY_JA[w]}曜
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {timeInput}
          </>
        )}
        {state.mode === "untilDaily" && timeInput}
      </div>

      {state.mode === "raw" && (
        <Input
          className="h-8 font-mono text-xs"
          placeholder="after 8d 09:00 / after 3h / until monthly day 9 09:00"
          value={state.rawText}
          disabled={contentLocked}
          onChange={(e) => update({ rawText: e.target.value }, false)}
          onBlur={() => commit(state)}
        />
      )}

      {description ? (
        <p className="text-xs text-muted-foreground">
          順番が回ってきたら、{description}。時刻が来ると自動で完了して次へ進みます
          {state.mode === "afterDays" ? "（数えはじめは、前のノードが終わった日）" : ""}
          {state.mode.startsWith("until")
            ? "（ルーティーンでは、ランが始まった後で最初のその日時。すでに過ぎていたら待たずに進みます）"
            : ""}
        </p>
      ) : (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <Icon name="alert" size={12} />
          {node.wait ? "解釈できない書式です。このままでは待てません" : "待ち方が未設定です"}
        </p>
      )}
    </div>
  );
}
