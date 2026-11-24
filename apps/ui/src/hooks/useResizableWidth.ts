// パネル幅のドラッグ変更（desk の --rail-w / --panel-w と同じ思想）。
// localStorage に保存し次回起動時に復元する（保存はログインユーザーごと。uiState.ts）。
import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { loadUiState, saveUiState } from "./uiState";

const WIDTH_EVENT = "gw:panel-width";

export function useResizableWidth(
  key: string,
  def: number,
  min: number,
  max: number,
): [number, (e: ReactPointerEvent, dir: 1 | -1) => void] {
  const [width, setWidth] = useState(() => {
    const saved = loadUiState(`gw.${key}`);
    const n = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  });

  // 同じ key を使う別のパネルと幅をそろえる。会話の列は1本で、中身（ノードの会話／複数選択／
  // 全体のチャット）が入れ替わるだけなので、どれかで幅を変えたら残りも同じ幅になる
  // （全体のチャットは隠れている間もマウントされたままなので、通知しないと古い幅が残る）
  useEffect(() => {
    const onSync = (ev: Event) => {
      const d = (ev as CustomEvent<{ key: string; width: number }>).detail;
      if (d?.key === key) setWidth(d.width);
    };
    window.addEventListener(WIDTH_EVENT, onSync);
    return () => window.removeEventListener(WIDTH_EVENT, onSync);
  }, [key]);

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
        saveUiState(`gw.${key}`, String(latest));
        window.dispatchEvent(new CustomEvent(WIDTH_EVENT, { detail: { key, width: latest } }));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, key, min, max],
  );

  return [width, startResize];
}
