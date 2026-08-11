// 汎用ポーリングフック。内容が変わっていなければ setState しない
// （新しい配列参照のたびに再描画すると、編集中の入力コンポーネントを不必要に揺らすため）。
import { useCallback, useEffect, useRef, useState } from "react";

/** 取得に失敗したあとの再試行間隔。本来の間隔が長い取得（ランのグラフは60秒）でも、
 *  サーバの再起動やネットワークの一瞬の途切れから数秒で復帰させる */
const RETRY_MS = 2000;

/**
 * @param restartKey 取得条件が変わったことを表す文字列。変わった瞬間に即取得し直す
 *   （2026-08-08）。fetcher は ref に退避していて依存にならないため、これが無いと
 *   「条件が揃う前に1回空振りし、次の取得は intervalMs 後」になる——左レールのラン一覧が
 *   出るまで5秒かかっていたのがこれ（ノード一覧が届く前に空のページ集合で走っていた）
 *
 * 取得は**前回が終わってから**次を積む（setInterval だと応答が間隔より遅いときに
 * 要求が重なり、古い応答が後着して新しい結果を上書きしうる）。
 * 失敗しても直近の正常なデータは保持する——呼び出し側の fetcher で握り潰して空を
 * 返すと、一度の失敗で画面から実体が消える（2026-08-11 の「急に消える」不具合）。
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, restartKey?: string) {
  const [data, setData] = useState<T | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const prevJson = useRef<string | null>(null);
  // 世代カウンタ。取得条件（restartKey / intervalMs）が変わるたびに進み、旧世代で投げた
  // in-flight の応答は捨てる（古い条件の結果を新しい条件のデータとして載せない）
  const generation = useRef(0);

  /** 取得して反映する。成功したら true（呼び出し側の再スケジュールが間隔を決めるのに使う） */
  const refresh = useCallback(async (): Promise<boolean> => {
    const gen = generation.current;
    try {
      const result = await fetcherRef.current();
      if (gen !== generation.current) return true; // 条件が変わった。新しい世代に任せる
      const json = JSON.stringify(result);
      if (json !== prevJson.current) {
        prevJson.current = json;
        setData(result);
      }
      return true;
    } catch {
      // 直近の正常なデータを保持したまま、少し待って再試行する
      return false;
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    const gen = generation.current;
    let cancelled = false; // アンマウント（次の effect が無い＝世代が進まない）用
    let timer = 0;
    const loop = async () => {
      const ok = await refresh();
      if (cancelled || gen !== generation.current) return; // 条件が変わった＝この周回は終わり
      timer = window.setTimeout(loop, ok ? intervalMs : Math.min(intervalMs, RETRY_MS));
    };
    void loop();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refresh, intervalMs, restartKey]);

  return { data, refresh };
}
