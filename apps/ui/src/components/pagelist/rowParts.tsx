// レールの行が共有する小さな部品（PageList から切り出し）。
import { GripVertical } from "lucide-react";
import type { DragState, RailDnd } from "../../hooks/useRailDnd";
import type { Dot } from "../../lib/railDots";
import { DOTS_HINT } from "../../lib/railDots";
import { cn } from "../../lib/utils";
import { Hint } from "../Hint";

/** 行の操作アイコン（✎🗑）の出し方。常時表示だとレールがごちゃついて名前が読みにくいので、
 *  マウスの hover とキーボードフォーカスのときだけ出す（2026-08-09 本人指示）。
 *  タッチ環境では hover が無いので出さない——長押しの右クリックメニューが同じ操作を持つ。
 *  行側に `group` が要る */
export const ROW_ACTION =
  "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:hidden";

/** 掴む取っ手（⠿）。タッチ（粗いポインタ）専用の入口として残す——マウスは行ごと掴める
 *  （hooks/useRailDnd.ts の rowDragHandlers） */
export function RailGrip({ st, dnd }: { st: DragState; dnd: RailDnd }) {
  return (
    <span
      className="hidden size-3.5 flex-shrink-0 cursor-grab touch-none items-center justify-center text-text-lo/60 hover:text-muted-foreground [@media(pointer:coarse)]:flex"
      onPointerDown={(e) => dnd.beginDrag(e, st)}
      onPointerMove={dnd.moveDrag}
      onPointerUp={dnd.endDrag}
      onClick={(e) => e.stopPropagation()}
    >
      <GripVertical className="size-3.5" />
    </span>
  );
}

/** ドット1粒の描画（粒の規則そのものは lib/railDots.ts、行ごとの粒の作り方は ./dots.ts）。
 *  ページ行・ラン子行が同じ見た目で並べる */
export const dotEl = (d: Dot) => (
  <Hint key={d.key} id="seat-dots" always={d.title} text={DOTS_HINT}>
    <i
      className={cn("size-[5px] flex-shrink-0 rounded-full", d.dim && "opacity-35")}
      style={{ background: d.color }}
    />
  </Hint>
);
