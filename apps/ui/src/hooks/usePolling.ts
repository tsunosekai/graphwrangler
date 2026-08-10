// 汎用ポーリングフック。内容が変わっていなければ setState しない
// （新しい配列参照のたびに再描画すると、編集中の入力コンポーネントを不必要に揺らすため）。
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * @param restartKey 取得条件が変わったことを表す文字列。変わった瞬間に即取得し直す
 *   （2026-08-08）。fetcher は ref に退避していて依存にならないため、これが無いと
 *   「条件が揃う前に1回空振りし、次の取得は intervalMs 後」になる——左レールのラン一覧が
 *   出るまで5秒かかっていたのがこれ（ノード一覧が届く前に空のページ集合で走っていた）
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, restartKey?: string) {
  const [data, setData] = useState<T | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const prevJson = useRef<string | null>(null);
  // 世代カウンタ。取得条件（restartKey / intervalMs）が変わるたびに進み、旧世代で投げた
  // in-flight の応答は捨てる（古い条件の結果を新しい条件のデータとして載せない）
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const gen = generation.current;
    try {
      const result = await fetcherRef.current();
      if (gen !== generation.current) return;
      const json = JSON.stringify(result);
      if (json !== prevJson.current) {
        prevJson.current = json;
        setData(result);
      }
    } catch {
      // api() 側で既にトースト表示済み。直近の正常なデータを保持する
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    let cancelled = false;
    const tick = async () => {
      if (!cancelled) await refresh();
    };
    tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh, intervalMs, restartKey]);

  return { data, refresh };
}
