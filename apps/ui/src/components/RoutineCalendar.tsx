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
  // 常に6週ぶん（7×6=42セル）描く。月によって5週/6週で高さが変わると、月送りのたびに
  // モーダルの大きさが揺れて煩わしい（2026-08-12 本人指摘）。足りないぶんは空セルで埋める
  const trailingBlanks = 42 - leadingBlanks - daysInMonth;
  const isToday = (day: number) =>
    year === today.getFullYear() && monthIndex === today.getMonth() && day === today.getDate();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* サイズは内容に依らず固定（高さ 92vh・幅 95vw 上限 120rem）。月送りや件数で揺らさない。
          デスクトップではほぼ全画面まで広げる（2026-08-12 本人要望「もっと大きく」） */}
      <DialogContent className="flex h-[92vh] max-h-[92vh] w-[min(120rem,95vw)] max-w-none flex-col sm:max-w-none">
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

        {/* グリッドは常に「見出し1行 + 6週」の固定レイアウト（rows-[auto_repeat(6,1fr)]）で
            高さいっぱいに広げる。角丸なし（2026-08-12 本人指定）。1日に予定が多い日だけ
            そのセルの中でスクロールさせ、グリッド自体の高さは変えない */}
        <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[auto_repeat(6,1fr)] gap-px border border-border bg-border">
            {DOW_HEADER.map((d, i) => (
              <div
                key={d}
                className={cn(
                  "bg-muted px-1 py-1 text-center text-xs font-semibold text-muted-foreground",
                  i === 0 && "text-red-500/70",
                  i === 6 && "text-blue-500/70",
                )}
              >
                {d}
              </div>
            ))}
            {Array.from({ length: leadingBlanks }, (_, i) => (
              <div key={`blank-${i}`} className="min-h-0 bg-background/60" />
            ))}
            {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
              const entries = cells.get(day) ?? [];
              return (
                <div
                  key={day}
                  className={cn(
                    "flex min-h-0 flex-col gap-0.5 overflow-y-auto bg-background p-1",
                    isToday(day) && "bg-accent/40",
                  )}
                >
                  <span
                    className={cn(
                      "flex-shrink-0 text-xs leading-none text-muted-foreground",
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
                      className="w-full flex-shrink-0 truncate bg-accent px-1 py-0.5 text-left text-xs leading-tight hover:bg-accent/70"
                      onClick={() => onOpenPage(t.pageId)}
                    >
                      {t.time && <span className="mr-1 tabular-nums text-muted-foreground">{t.time}</span>}
                      {t.pageTitle}
                    </button>
                  ))}
                </div>
              );
            })}
            {/* 6週に満たないぶんの空セル（グリッドの高さを月によらず一定に保つ） */}
            {Array.from({ length: Math.max(0, trailingBlanks) }, (_, i) => (
              <div key={`trail-${i}`} className="min-h-0 bg-background/60" />
            ))}
        </div>
        {triggers.filter((t) => showFine || !t.fine).length === 0 && (
          <p className="flex-shrink-0 text-center text-sm text-muted-foreground">
            {fineCount > 0
              ? "週次以上のルーティーンはありません（毎日以下は上のチェックで表示できます）"
              : "定刻つきのルーティーンがありません（トリガーの起動方式で設定できます）"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
