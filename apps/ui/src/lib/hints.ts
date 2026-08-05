// ヒント（マウスオーバーの説明吹き出し）の状態と共有文言（2026-08-05 本人要望）。
// - 出し方は一律マウスオーバー（旧「?」アイコンは廃止。スマホで出ないのは許容）
// - 各ヒントの「OK」でそのヒントは二度と出ない / 設定で全体の無効化・リセットができる
// - 状態は localStorage 持ち（metaOpen 等と同じ「UI状態」の扱い。正データには混ぜない）
// - 同じ概念には同じ id を使う（カードとパネルで重複して OK を押させない）
import { useSyncExternalStore } from "react";

const OFF_KEY = "gw.hints.off";
const DONE_KEY = "gw.hints.done";

function readDone(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DONE_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

let done = readDone();
let off = (() => {
  try {
    return localStorage.getItem(OFF_KEY) === "1";
  } catch {
    return false;
  }
})();

let version = 0;
const listeners = new Set<() => void>();
function emit() {
  version++;
  listeners.forEach((l) => l());
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 購読フック。呼んでおくと dismiss / 設定変更で再レンダーされる（戻り値は使わなくてよい） */
export function useHintsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

export function hintsEnabled(): boolean {
  return !off;
}

export function isHintDismissed(id: string): boolean {
  return done.has(id);
}

export function dismissHint(id: string) {
  if (done.has(id)) return;
  done.add(id);
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
  } catch {
    // 永続化は補助機能
  }
  emit();
}

export function setHintsEnabled(v: boolean) {
  off = !v;
  try {
    localStorage.setItem(OFF_KEY, off ? "1" : "0");
  } catch {
    // 無視
  }
  emit();
}

/** OKで消したヒントを全部再表示する（設定の「リセット」） */
export function resetHints() {
  done = new Set();
  try {
    localStorage.setItem(DONE_KEY, "[]");
  } catch {
    // 無視
  }
  emit();
}

/** 複数箇所（カード/パネル）で同じ概念に使う共有文言。1概念=1 id=1文。
 *  ここに無い1箇所きりのヒントは使う側にベタ書きでよい */
export const HINT_TEXT = {
  // 最重要（2026-08-05 本人指定）: 担当は「誰がその作業を始めるのか」。
  // AI/スクリプト担当でも間に人間作業が挟まる例外はあり得る、が伝わるように
  executor:
    "その作業を「始める」のが誰か（人間 / AI / スクリプト）。AIやスクリプトが担当でも、実行前承認や途中の質問への回答など、人間の作業が間に挟まることがあります",
  assignee:
    "担当=人間のとき、実際に始めるのが誰か。「あなたの番」の橙表示や通知はこの人にだけ出ます",
  kind: "実行=ふつうの作業。判断=完了時に枝をひとつ選び、選ばれなかった枝の先はスキップされる。トリガー=発火するとラン（実行インスタンス）が生まれる起点",
  impl: "やり方の中身。担当=人間なら読む手順書、担当=AIなら実行時プロンプトに渡る手順書、担当=スクリプトなら実行コマンド。担当と実装の種類が合っていないと実行に使われません",
  fixed:
    "Fix=やり方の確定。Fix済みのノードはAIが実装を書き換えず、UI上の編集もロックされる。クリックで切り替え",
  approval:
    "実行の直前に人間の承認ゲートを通す（外部公開・送信・削除など取り返しのつかない操作向け）。トリガーでは自動発火の直前に挟まる（手動の▶はそのまま発火）",
  autonomy:
    "AIがどこまで人間に聞かずに進むか。高=聞かずに最後まで（失敗も自動で試し直す）。低=迷ったら質問カードで人間に判断を仰ぐ。実行前承認とは独立",
  unread:
    "前回の既読より新しいメッセージがある印。スレッドを1秒表示すると既読になる（既読は端末間で同期される）",
  commitPlan:
    "下書き→確定。やり方が決まった印で、確定して「待ち」になったノードだけをエンジンが実行する",
  fire: "今すぐ発火してラン（実行インスタンス）を開始する。同じルーティーンは並列で回せる（ランの名前で世界線を区別）",
  pageProject:
    "トリガーを持たないページ。ゴールに向かって一度きり進める。ノードにトリガーを置くと自動でルーティーンに変わる",
  pageRoutine:
    "トリガーを持つページ。発火のたびにラン（実行インスタンス）が生まれ、進捗はランごとに付く（台帳ビューで一覧できる）",
  statusLegend:
    "状態の記号: 破線円=未計画 / 空円=待ち / 半分塗り=進行中 / 中点付き=あなたの番（回答待ち） / 塗り+チェック=完了 / ×=中止 / 斜線=スキップ（分岐で選ばれなかった枝）",
} as const;
