// 「いつから起きているか」の追跡（2026-11-24。デスクトップ常駐化に伴う）。
// トリガーの catchUp=false（取りこぼした回は捨てる）を実現するための基準時刻を持つ。
// VPS と違い、PC は電源が落ちる・スリープする。その間に過ぎた定刻は、既定（catchUp=true）
// では次に起きたとき1本にまとめて実行し、catchUp=false のトリガーでは捨てる。
// 「捨てる」は判定式を変えずに、起きた時刻を「その回は済んだ」の基準に混ぜて表す
// （trigger.ts の mergeScheduleSetBaseline と同じ流儀）。
//
// 起きた時刻 = プロセス起動時刻、または最後にスリープから復帰した時刻。スリープは
// プロセスが生きたまま時間が飛ぶので、短い間隔のタイマーの「飛び」で検知する。
// tick ループの間隔では測らない——tick は AI の実行を await するので、長い実行と
// スリープの区別が付かない（タイマーは子プロセス待ちの間も回り続ける）。

const BEAT_MS = 10_000;
/** これ以上タイマーが飛んだら「止まっていた」とみなす */
export const SLEEP_GAP_MS = 90_000;

/** 純粋関数: 前回の拍から now までの空きが閾値を超えていれば、起きた時刻を now に更新する */
export function nextAwakeSince(
  awakeSince: number,
  lastBeat: number,
  now: number,
  gapMs = SLEEP_GAP_MS,
): number {
  return now - lastBeat > gapMs ? now : awakeSince;
}

let awakeSince = Date.now();
let lastBeat = awakeSince;

/** いま起きている区間の開始時刻（ms） */
export function getAwakeSince(): number {
  return awakeSince;
}

/** スリープ復帰の監視を始める（main.ts から1回だけ呼ぶ。プロセスの終了は妨げない） */
export function startAwakeWatch(): void {
  setInterval(() => {
    const now = Date.now();
    awakeSince = nextAwakeSince(awakeSince, lastBeat, now);
    lastBeat = now;
  }, BEAT_MS).unref();
}

/** catchUp=false のトリガー用: 基準（最新ラン等）と起きた時刻の新しい方を基準にする（純粋関数）。
 *  起きる前に過ぎた定刻は「済んだ」扱いになり、次の定刻から動く */
export function mergeAwakeBaseline(
  baseline: { created: string } | null,
  awakeSinceMs: number,
): { created: string } {
  if (!baseline || new Date(baseline.created).getTime() < awakeSinceMs) {
    return { created: new Date(awakeSinceMs).toISOString() };
  }
  return baseline;
}
