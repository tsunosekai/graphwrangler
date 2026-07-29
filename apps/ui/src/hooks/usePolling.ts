// 汎用ポーリングフック。内容が変わっていなければ setState しない
// （新しい配列参照のたびに再描画すると、編集中の入力コンポーネントを不必要に揺らすため）。
import { useCallback, useEffect, useRef, useState } from "react";

export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const prevJson = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
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
  }, [refresh, intervalMs]);

  return { data, refresh };
}
