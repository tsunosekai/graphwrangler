import { useEffect, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";

// モバイルの1本指パン: React Flow 標準は「画面ピクセル基準」のパンで、拡大中は
// スワイプしてもコンテンツがほとんど進まない。ズームに比例して速くする
// （1スワイプ＝同じコンテンツ距離。縮小時は等速のまま＝clamp min 1）ことで、
// 拡大倍率に関わらず感覚的に同じだけ動く（2026-08-02 本人要望）。
// ReactFlow 側の panOnDrag はモバイルでは無効化し（GraphView の props）、ここが唯一のパン経路。
// **2本指ピンチズームもここが唯一の経路**（2026-08-02 修正）。panOnDrag={false} にすると
// @xyflow/system の zoom filter が `!panOnDrag && event.type === 'touchstart'` で
// touchstart を丸ごと捨てるため、zoomOnPinch が既定 true でも d3-zoom がジェスチャを
// 開始できずピンチが死ぬ。自前パンを持った時点でピンチも自前で持つしかない。
// ノード/エッジ/ボタン上のタッチはノードドラッグ等の邪魔をしないよう素通しする
// （ただしピンチは指がノードに乗っていても効かせる——密なグラフで拾えないと使えないため。
//   ノードをドラッグ中だけは横取りしない）
export function useMobilePanZoom(
  paneRef: RefObject<HTMLDivElement>,
  isMobile: boolean,
  minZoom: number,
  maxZoom: number,
): void {
  const { getViewport, setViewport } = useReactFlow();
  useEffect(() => {
    if (!isMobile) return;
    const el = paneRef.current;
    if (!el) return;
    let last: { x: number; y: number } | null = null;
    let pinch: { dist: number; cx: number; cy: number } | null = null;
    const pannable = (t: EventTarget | null) => {
      const target = t as HTMLElement | null;
      if (!target?.closest) return false;
      if (target.closest(".react-flow__node,.react-flow__edge,.react-flow__controls,button,input,textarea,select")) return false;
      return !!target.closest(".react-flow__pane");
    };
    const gap = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a: Touch, b: Touch) => ({ cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 });
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2 && !el.querySelector(".react-flow__node.dragging")) {
        last = null;
        pinch = { dist: gap(e.touches[0], e.touches[1]), ...mid(e.touches[0], e.touches[1]) };
        return;
      }
      pinch = null;
      if (e.touches.length !== 1 || !pannable(e.target)) {
        last = null;
        return;
      }
      last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        const dist = gap(a, b);
        const { cx, cy } = mid(a, b);
        if (pinch.dist > 0) {
          const rect = el.getBoundingClientRect();
          const vp = getViewport();
          const zoom = Math.min(maxZoom, Math.max(minZoom, (vp.zoom * dist) / pinch.dist));
          // 直前の指の中心にあったグラフ上の点を、新しい指の中心へ置き直す。
          // これで「指の間が拡大の焦点」になり、2本指のまま動かせばパンにもなる
          const gx = (pinch.cx - rect.left - vp.x) / vp.zoom;
          const gy = (pinch.cy - rect.top - vp.y) / vp.zoom;
          setViewport({ x: cx - rect.left - gx * zoom, y: cy - rect.top - gy * zoom, zoom });
        }
        pinch = { dist, cx, cy };
        e.preventDefault(); // ブラウザのページズームを止める
        return;
      }
      if (!last || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - last.x;
      const dy = t.clientY - last.y;
      last = { x: t.clientX, y: t.clientY };
      const vp = getViewport();
      const f = Math.max(1, vp.zoom);
      setViewport({ x: vp.x + dx * f, y: vp.y + dy * f, zoom: vp.zoom });
      e.preventDefault(); // ブラウザのスクロール/バウンスを止める
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
      // ピンチ→1本指に減ったら、残った指でそのままパンを続けられるよう基準を取り直す
      last =
        e.touches.length === 1 && pannable(e.touches[0].target)
          ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
          : null;
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [isMobile, paneRef, getViewport, setViewport, minZoom, maxZoom]);
}
