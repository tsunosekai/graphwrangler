// ---- 左レールのドラッグ（フォルダ分け + 手動並べ替え。2026-08-05） ----
// PageList から「掴む・運ぶ・落とし先を決める」だけを切り出したもの。落とした結果を
// どう並べ直すか（order / folder の書き戻し）は呼び出し側（applyDrop）が持つ——
// こちらは行の data-rail-* 属性だけを見て、レールの中身は知らない。
// ドラッグはマウスもタッチも pointer events 1本で扱う（モバイルでも並べ替えられる）
import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { cn } from "../lib/utils";

/** 節。フォルダはプロジェクト節の中だけの概念で、ルーティーンは節内の並べ替えのみ */
export type Section = "project" | "routine";
/** 掴んでいるもの */
export interface DragState {
  id: string;
  kind: "page" | "folder";
  section: Section;
}
/** 落とし先。into = フォルダの中／節の末尾、before|after = その行の前後 */
export interface DropTarget {
  id: string;
  kind: "page" | "folder" | "root";
  section: Section;
  pos: "before" | "after" | "into";
}
/** 節見出し（＝その節の直下・末尾）を指す擬似 id */
export const ROOT_ROW: Record<Section, string> = { project: "__root__", routine: "__routine__" };

/** 掴みっぱなしで離した直後の click を「行の選択」と取らないための猶予（ms） */
const CLICK_GUARD_MS = 300;

export interface RailDnd {
  /** 掴んでいるもの（描画で薄くするのに使う） */
  drag: DragState | null;
  /** いまの落とし先（描画で線・縁取りを出すのに使う） */
  drop: DropTarget | null;
  /** 落とし先の見せ方のクラス。行の id を渡す */
  dropClass(id: string): string | undefined;
  /** 行そのものを掴むためのハンドラ（マウス限定。5px 動いたら掴みに昇格） */
  rowDragHandlers(st: DragState): {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
  };
  /** 取っ手（⠿）用。押した時点で掴む */
  beginDrag(e: React.PointerEvent, st: DragState): void;
  moveDrag(e: React.PointerEvent): void;
  endDrag(e: React.PointerEvent): void;
  /** 直前がドラッグだったか（click でページを開かないための印） */
  draggedRecently(): boolean;
}

export function useRailDnd(
  applyDrop: (st: DragState, target: DropTarget) => void | Promise<void>,
): RailDnd {
  const dragRef = useRef<DragState | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  const draggedAtRef = useRef(0);
  /** 行ドラッグの「押しただけ」状態（まだ掴んでいない）。少し動いたら掴みに昇格する */
  const pressRef = useRef<{ st: DragState; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  /** 座標の下にある行を読んで落とし先を決める（要素の data-rail-* 属性が正）。
   *  ページ: フォルダ行の上=中へ / 同じ節のページ行の上下半分=その前後。
   *  フォルダ: フォルダ行の前後だけ（フォルダの入れ子はUIでは扱わない） */
  const resolveDrop = (x: number, y: number, st: DragState): DropTarget | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(
      "[data-rail-row]",
    );
    if (!el) return null;
    const id = el.dataset.railRow!;
    const kind = el.dataset.railKind as DropTarget["kind"];
    const section = el.dataset.railSection as Section;
    if (id === st.id) return null;
    if (kind === "root") {
      if (st.kind === "folder") return null; // フォルダは節をまたがない
      return { id, kind, section, pos: "into" };
    }
    const rect = el.getBoundingClientRect();
    const pos: "before" | "after" = y < rect.top + rect.height / 2 ? "before" : "after";
    if (st.kind === "folder") {
      // 棚同士の並べ替えは同じ節の中だけ（2026-08-08。節をまたぐ移動はさせない）
      return kind === "folder" && section === st.section ? { id, kind, section, pos } : null;
    }
    if (kind === "folder") {
      // 棚へ入れられるのは同じ節のページだけ（プロジェクトをルーティーン棚へ入れない）
      return section === st.section ? { id, kind, section, pos: "into" } : null;
    }
    if (section !== st.section) return null; // プロジェクトとルーティーンは行き来させない
    return { id, kind, section, pos };
  };

  const beginDrag = (e: React.PointerEvent, st: DragState) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      // 取っ手の外へ出ても pointermove/up を取りこぼさないための捕捉。
      // 捕捉できない環境（既にポインタが離れている等）でも掴み自体は続行する
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 無視
    }
    dragRef.current = st;
    setDrag(st);
  };
  const moveDrag = (e: React.PointerEvent) => {
    const st = dragRef.current;
    if (!st) return;
    const target = resolveDrop(e.clientX, e.clientY, st);
    dropRef.current = target;
    setDrop(target);
  };
  const endDrag = (e: React.PointerEvent) => {
    const st = dragRef.current;
    const target = dropRef.current;
    dragRef.current = null;
    dropRef.current = null;
    setDrag(null);
    setDrop(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // 既に外れている場合は無視
    }
    if (!st) return;
    draggedAtRef.current = Date.now(); // 直後の click でページを開かないための印
    if (target) void applyDrop(st, target);
  };
  // ドラッグ中は画面外へ出た pointerup も拾う（掴んだまま離しても状態が残らないように）
  useEffect(() => {
    if (!drag) return;
    const cancel = () => {
      dragRef.current = null;
      dropRef.current = null;
      setDrag(null);
      setDrop(null);
    };
    window.addEventListener("pointercancel", cancel);
    return () => window.removeEventListener("pointercancel", cancel);
  }, [drag]);

  /** 落とし先の見せ方: 前後は行の縁に線、中へはフォルダ行を縁取る。
   *  線は inset の box-shadow ではなく絶対配置の擬似要素で描く——box-shadow は行の角丸
   *  （rounded-sm）に沿って端が丸まり、まっすぐな横線に見えないため（2026-08-06 本人指摘）。
   *  擬似要素は overflow-hidden が無い限り角丸に切られないので、端まで直線で出る */
  const dropClass = (id: string) => {
    if (drop?.id !== id) return undefined;
    if (drop.pos === "into") return "ring-1 ring-ai";
    return cn(
      "relative before:pointer-events-none before:absolute before:inset-x-0 before:h-0.5 before:bg-ai before:content-['']",
      // 行と行の隙間（gap-px）の中央に置き、どちらの行の線か迷わないようにする
      drop.pos === "before" ? "before:-top-px" : "before:-bottom-px",
    );
  };

  /** 行そのものを掴んでドラッグするためのハンドラ（2026-08-08 本人要望「持ち手アイコンを
   *  消して普通にドラッグ」）。クリック=選択と共存させるため、押しただけでは掴まず
   *  5px 動いたら掴みに昇格する。マウス限定——タッチはスクロールと取り合いになる
   *  （touch-action を行全体に切ると一覧が撫でられなくなる）ため、粗いポインタ環境では
   *  従来の取っ手（⠿）を残してそちらで掴む */
  const rowDragHandlers = (st: DragState) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      e.preventDefault(); // ドラッグ中に行のテキストが選択されるのを防ぐ（click はこれでもランを作る）
      pressRef.current = { st, x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const press = pressRef.current;
      if (press && !dragRef.current) {
        if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) < 5) return;
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          // 無視（掴み自体は続行）
        }
        dragRef.current = press.st;
        setDrag(press.st);
        return;
      }
      moveDrag(e);
    },
    onPointerUp: (e: React.PointerEvent) => {
      pressRef.current = null;
      endDrag(e);
    },
  });

  const draggedRecently = () => Date.now() - draggedAtRef.current < CLICK_GUARD_MS;

  return { drag, drop, dropClass, rowDragHandlers, beginDrag, moveDrag, endDrag, draggedRecently };
}
