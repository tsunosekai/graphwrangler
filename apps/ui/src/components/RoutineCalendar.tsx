// ルーティーンの予定カレンダー（2026-08-12 本人要望「ルーティーンをカレンダーで見られる
// 機能がほしい。毎日とかの頻度が細かすぎる奴はフィルターできるように（デフォルトで
// 毎日以下は非表示）」）。
// 左レールのルーティーン節のカレンダーボタンから開くダイアログ。計算は lib/routineCalendar.ts
// （文法・暦は core/schedule と共通）。チップを押すとそのルーティーンのページへ移動する。
//
// 2026-11-26 本人要望「フォルダごとに表示非表示出来るように」「フォルダからも開けるように」:
// - 上に、ルーティーンの入っているフォルダのチップを並べ、押すと表示・非表示が切り替わる。
//   どれを隠しているかは覚えておく（次に開いたときも同じ）
// - フォルダの行から開いたときは、**そのフォルダだけ**を表示した状態で開く。これは一時的な絞り込みで、
//   覚えている表示設定は書き換えない（フォルダから1回覗いただけで、普段の表示が変わらないように）
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { loadUiState, saveUiState } from "../hooks/uiState";
import { NO_FOLDER, buildMonthCells, collectCalendarTriggers } from "../lib/routineCalendar";
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
  focusFolderId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allNodes: Node[];
  /** ページ id → ラン一覧（新しい順。biweekly の「どちらの週か」の錨に使う） */
  pageRuns: Record<string, Run[]>;
  /** チップのクリック → そのルーティーンのページを開く（呼び出し側でダイアログも閉じる） */
  onOpenPage: (pageId: string) => void;
  /** フォルダの行から開いたとき、そのフォルダの id（そのフォルダだけを表示して開く）。
   *  ルーティーン節のボタンから開いたときは null */
  focusFolderId?: string | null;
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

  // フォルダごとの表示切替。チップに並べるのは、定刻つきルーティーンが実際に入っているフォルダだけ
  const folders = useMemo(() => {
    const titleOf = new Map(allNodes.filter((n) => n.kind === "folder").map((n) => [n.id, n.title || "（無題）"]));
    const ids = [...new Set(triggers.map((t) => t.folderId))];
    return ids
      .map((id) => ({ id, title: id === NO_FOLDER ? "フォルダなし" : (titleOf.get(id) ?? "（無題）") }))
      .sort((a, b) => (a.id === NO_FOLDER ? 1 : b.id === NO_FOLDER ? -1 : a.title.localeCompare(b.title, "ja")));
  }, [allNodes, triggers]);
  // 覚えている「隠すフォルダ」
  const [savedHidden, setSavedHidden] = useState<Set<string>>(() => {
    try {
      const raw = loadUiState("gw.calHiddenFolders");
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  // フォルダの行から開いたときの一時的な絞り込み（null = 絞り込みなし＝覚えている設定を使う）
  const [focusHidden, setFocusHidden] = useState<Set<string> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 開いた瞬間（と開き先のフォルダ）にだけ決め直す
  useEffect(() => {
    if (!open) return;
    setFocusHidden(focusFolderId ? new Set(folders.map((f) => f.id).filter((id) => id !== focusFolderId)) : null);
  }, [open, focusFolderId]);
  const hiddenFolders = focusHidden ?? savedHidden;
  const toggleFolder = (id: string) => {
    const next = new Set(hiddenFolders);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (focusHidden) setFocusHidden(next);
    else {
      setSavedHidden(next);
      saveUiState("gw.calHiddenFolders", JSON.stringify([...next]));
    }
  };

  const visible = useMemo(() => triggers.filter((t) => !hiddenFolders.has(t.folderId)), [triggers, hiddenFolders]);
  const fineCount = useMemo(() => visible.filter((t) => t.fine).length, [visible]);
  // today は分単位で変わっても結果に効かないので日付文字列で依存を安定させる
  const todayKey = today.toDateString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: today は日付だけ効く（todayKey で代表させる）
  const cells = useMemo(
    () => buildMonthCells(triggers, year, monthIndex, pageRuns, today, showFine, hiddenFolders),
    [triggers, year, monthIndex, pageRuns, showFine, todayKey, hiddenFolders],
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

        {/* フォルダごとの表示切替。フォルダが1つだけ（＝切り替える意味が無い）なら出さない */}
        {folders.length > 1 && (
          <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">フォルダ:</span>
            {folders.map((f) => {
              const shown = !hiddenFolders.has(f.id);
              return (
                <button
                  key={f.id || "none"}
                  type="button"
                  aria-pressed={shown}
                  title={shown ? "押すと隠す" : "押すと表示する"}
                  className={cn(
                    "rounded-full border px-2 py-0.5",
                    shown
                      ? "border-ai/60 bg-ai/10 text-foreground"
                      : "border-border text-text-lo line-through opacity-70",
                  )}
                  onClick={() => toggleFolder(f.id)}
                >
                  {f.title}
                </button>
              );
            })}
            {focusHidden && (
              <button
                type="button"
                className="ml-1 text-text-lo underline hover:text-foreground"
                title="フォルダから開いたときの一時的な絞り込みをやめ、ふだんの表示設定に戻す"
                onClick={() => setFocusHidden(null)}
              >
                ふだんの表示に戻す
              </button>
            )}
          </div>
        )}

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
        {visible.filter((t) => showFine || !t.fine).length === 0 && (
          <p className="flex-shrink-0 text-center text-sm text-muted-foreground">
            {triggers.length > 0 && visible.length === 0
              ? "表示するフォルダがありません（上のフォルダのチップで表示できます）"
              : fineCount > 0
              ? "週次以上のルーティーンはありません（毎日以下は上のチェックで表示できます）"
              : "定刻つきのルーティーンがありません（トリガーの起動方式で設定できます）"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
