// 未読バッジの既読管理。サーバ持ちの既読（2026-08-02 localStorage からサーバへ移した
// ＝PC で読めばスマホでも既読）に、ローカルの即時上書きを重ねる。
import { useCallback, useMemo, useState } from "react";

export interface ReadState {
  /** ノード（会話）ごとの既読時刻。サーバ値とローカル上書きを新しいほう勝ちでマージ済み */
  reads: Record<string, string>;
  /** 会話を見た印を即座に付ける。key は lib/unread.ts の threadKey */
  markViewed: (key: string, lastTs: string | null) => void;
}

export function useReadState(serverReads: Record<string, string>): ReadState {
  // 既読のローカル上書き（2026-08-05 本人指示「見たら即」。旧: 1秒待ち）。
  // NodePanel がスレッドを表示すると onViewed が呼ばれ、サーバの reads が次の
  // ポーリング（最大3秒）で追いつくのを待たずにバッジを消す。マージは新しいほう勝ち
  const [readOverrides, setReadOverrides] = useState<Record<string, string>>({});
  const reads = useMemo(() => {
    const merged = { ...serverReads };
    for (const [id, ts] of Object.entries(readOverrides)) {
      if (!merged[id] || merged[id] < ts) merged[id] = ts;
    }
    return merged;
  }, [serverReads, readOverrides]);
  // lastTs（スレッド最終メッセージ＝サーバ発行の時刻）があればそれを使う。端末の時計が
  // サーバより遅れていると、クライアント時刻の上書きでは未読が消えないため（2026-08-05）
  // key は会話の単位（"<ノードid>" or "<ノードid>@<ランid>"。lib/unread.ts の threadKey）
  const markViewed = useCallback((key: string, lastTs: string | null) => {
    setReadOverrides((prev) => ({ ...prev, [key]: lastTs ?? new Date().toISOString() }));
  }, []);

  return { reads, markViewed };
}
