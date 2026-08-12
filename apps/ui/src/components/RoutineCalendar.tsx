// ルーティーンの予定カレンダー（2026-08-12 本人要望「ルーティーンをカレンダーで見られる
// 機能がほしい。毎日とかの頻度が細かすぎる奴はフィルターできるように（デフォルトで
// 毎日以下は非表示）」）。
// 左レールのルーティーン節のカレンダーボタンから開くダイアログ。計算は lib/routineCalendar.ts
// （文法・暦は core/schedule と共通）。チップを押すとそのルーティーンのページへ移動する。
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { buildMonthCells, collectCalendarTriggers } from "../lib/routineCalendar";
import { cn } from "../lib/utils";
import type { Node, Run } from "../types";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

const DOW_HEADER = ["日", "月", "火", "水", "木", "金", "土"];

export function RoutineCalendarDialog({
  open,
  onOpenChange,
  allNodes,
  pageRuns,
  onOpenPage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allNodes: Node[];
  /** ページ id → ラン一覧（新しい順。biweekly の「どちらの週か」の錨に使う） */
  pageRuns: Record<string, Run[]>;
  /** チップのクリック → そのルーティーンのページを開く（呼び出し側でダイアログも閉じる） */
  onOpenPage: (pageId: string) => void;
}) {
  // 表示中の月（今月からの相対。ダイアログを開き直したら今月に戻る値でもよいが、
  // 「来月を見て閉じてもう一度開く」で戻るのは煩わしいので保持する）
  const [monthOffset, setMonthOffset] = useState(0);
  // 毎日以下（every / daily / 日付無制限の cron）の表示。既定は非表示（本人指定）
  const [showFine, setShowFine] = useState(false);

  const today = new Date();
  const shown = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const year = shown.getFullYear();
  const monthIndex = shown.getMonth();

  const triggers = useMemo(() => collectCalendarTriggers(allNodes), [allNodes]);
  const fineCount = useMemo(() => triggers.filter((t) => t.fine).length, [triggers]);
  const cells = useMemo(
    () => buildMonthCells(triggers, year, monthIndex, pageRuns, today, showFine),
    // today は分単位で変わっても結果に効かないので日付文字列で依存を安定させる
    // biome-ignore lint/correctness/useExhaustiveDependencies: today は日付だけ効く
    [triggers, year, monthIndex, pageRuns, showFine, today.toDateString()],
  );

  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const leadingBlanks = new Date(year, monthIndex, 1).getDay(); // 日曜始まり
  const isToday = (day: number) =>
    year === today.getFullYear() && monthIndex === today.getMonth() && day === today.getDate();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[min(60rem,92vw)] max-w-none flex-col sm:max-w-none">
        <DialogHeader>
          <DialogTitle>ルーティーンの予定</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => setMonthOffset((v) => v - 1)}>
              <ChevronLeft className="size-4" />
            </Button>
            <span className="min-w-28 text-center text-sm font-semibold">
              {year}年{monthIndex + 1}月
            </span>
            <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => setMonthOffset((v) => v + 1)}>
              <ChevronRight className="size-4" />
            </Button>
            {monthOffset !== 0 && (
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setMonthOffset(0)}>
                今月へ
              </Button>
            )}
          </div>
          {/* 細かい頻度のフィルタ（既定OFF）。隠している件数を添えて「消えている訳ではない」と分かるように */}
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showFine}
              onChange={(e) => setShowFine(e.target.checked)}
            />
            毎日以下の頻度も表示{fineCount > 0 && !showFine ? `（${fineCount}件 非表示中）` : ""}
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-7 gap-px rounded-md border border-border bg-border">
            {DOW_HEADER.map((d, i) => (
              <div
                key={d}
                className={cn(
                  "bg-muted px-1 py-0.5 text-center text-[11px] font-semibold text-muted-foreground",
                  i === 0 && "text-red-500/70",
                  i === 6 && "text-blue-500/70",
                )}
              >
                {d}
              </div>
            ))}
            {Array.from({ length: leadingBlanks }, (_, i) => (
              <div key={`blank-${i}`} className="min-h-20 bg-background/60" />
            ))}
            {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
              const entries = cells.get(day) ?? [];
              return (
                <div
                  key={day}
                  className={cn(
                    "flex min-h-20 flex-col gap-0.5 bg-background p-1",
                    isToday(day) && "bg-accent/40",
                  )}
                >
                  <span
                    className={cn(
                      "text-[11px] leading-none text-muted-foreground",
                      isToday(day) && "font-bold text-foreground",
                    )}
                  >
                    {day}
                  </span>
                  {entries.map((t) => (
                    <button
                      key={`${t.triggerId}-${day}`}
                      type="button"
                      title={`${t.pageTitle}（${t.description}）`}
                      className="w-full truncate rounded bg-accent px-1 py-0.5 text-left text-[11px] leading-tight hover:bg-accent/70"
                      onClick={() => onOpenPage(t.pageId)}
                    >
                      {t.time && <span className="mr-1 tabular-nums text-muted-foreground">{t.time}</span>}
                      {t.pageTitle}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          {triggers.filter((t) => showFine || !t.fine).length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {fineCount > 0
                ? "週次以上のルーティーンはありません（毎日以下は上のチェックで表示できます）"
                : "定刻つきのルーティーンがありません（トリガーの起動方式で設定できます）"}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
