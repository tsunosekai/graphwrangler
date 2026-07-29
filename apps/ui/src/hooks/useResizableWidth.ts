// パネル幅のドラッグ変更（desk の --rail-w / --panel-w と同じ思想）。
// localStorage に保存し次回起動時に復元する。
import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";

export function useResizableWidth(
  key: string,
  def: number,
  min: number,
  max: number,
): [number, (e: ReactPointerEvent, dir: 1 | -1) => void] {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(`gw.${key}`);
    const n = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  });

  /** dir=1: ハンドルを右へ動かすと広がる（左パネル） / dir=-1: 左へ動かすと広がる（右パネル） */
  const startResize = useCallback(
    (e: ReactPointerEvent, dir: 1 | -1) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      let latest = startW;
      const onMove = (ev: PointerEvent) => {
        latest = Math.min(max, Math.max(min, startW + dir * (ev.clientX - startX)));
        setWidth(latest);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        localStorage.setItem(`gw.${key}`, String(latest));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, key, min, max],
  );

  return [width, startResize];
}
