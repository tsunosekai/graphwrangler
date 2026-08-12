// NodePanel のスレッド3タブ（会話/履歴/実行記録）の振り分けと「新しい会話」区切りの導出。
// スレッドは経緯の正史なので実体は動かさず、区切りから毎回導出する（純関数のみ）
import type { MaterializedMessage } from "../../types";

export type PanelTab = "talk" | "history" | "log";

export function isChatBreak(m: MaterializedMessage): boolean {
  return Boolean((m.payload as { chatBreak?: boolean } | null)?.chatBreak);
}

/** 最後の「新しい会話」区切り（payload.chatBreak）の index。無ければ -1 */
export function findLastBreak(messages: MaterializedMessage[]): number {
  return messages.reduce((acc, m, i) => (isChatBreak(m) ? i : acc), -1);
}

// タブごとの表示対象（2026-08-02 3タブ化）:
//   会話(talk)      = 区切り以降の say + 判断のやりとり
//   履歴(history)   = 過去分も含む全ての会話（say + 判断）。「―― 新しい会話 ――」の
//                     区切り行も挟んで表示する（どこで区切ったか分かるように）
//   実行記録(log)   = status + artifact（エンジン実行・試走・状態変化・移行記録）。
//                     会話の区切り行は実行記録ではないので除く
export function inTab(m: MaterializedMessage, t: PanelTab): boolean {
  if (t === "talk") {
    return m.kind === "say" || m.kind === "decision_request" || m.kind === "decision_answer";
  }
  if (t === "history") {
    return (
      m.kind === "say" ||
      m.kind === "decision_request" ||
      m.kind === "decision_answer" ||
      isChatBreak(m)
    );
  }
  return (m.kind === "status" || m.kind === "artifact") && !isChatBreak(m);
}

// ---- 発言者（メンバー）フィルタ（2026-08-12 本人要望「会話履歴を、メンバーで
//      フィルタリングする機能を追加」）----
// 効かせるのは会話・履歴タブだけ。実行記録は機械が書く記録なので人で絞る意味がない。
// 選択肢はロスター全員ではなく**そのスレッドに実際に登場した人**から作る（居ない人を
// 並べても選ぶ意味がないうえ、1人しか居なければフィルタUI自体を出さずに済む）

/** フィルタ無し（全員） */
export const AUTHOR_ALL = "all";
/** AI・システム（人間以外の発言をまとめる） */
export const AUTHOR_AI = "ai";
/** 名前の無い人間の発言（ログイン無し運用）。AI 側へ寄せないための別枠 */
export const AUTHOR_HUMAN = "human";

/** 発言者キー: 人間はメール（小文字化）、名無しの人間は AUTHOR_HUMAN、それ以外は AUTHOR_AI */
export function authorKeyOf(m: MaterializedMessage): string {
  if (m.author.kind !== "human") return AUTHOR_AI;
  return m.author.name ? m.author.name.trim().toLowerCase() : AUTHOR_HUMAN;
}

/** フィルタ（AUTHOR_ALL / AUTHOR_AI / AUTHOR_HUMAN / メール）にこのメッセージが該当するか */
export function matchesAuthor(m: MaterializedMessage, filter: string): boolean {
  if (filter === AUTHOR_ALL) return true;
  return authorKeyOf(m) === filter.trim().toLowerCase();
}

/** スレッドに登場する発言者キーの一覧（登場順・重複なし）。フィルタの選択肢に使う */
export function collectAuthorKeys(messages: MaterializedMessage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    const key = authorKeyOf(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export interface PastSession {
  id: string;
  ts: string;
  messages: MaterializedMessage[];
}

/** 履歴タブ用: chatBreak で区切った過去セッション一覧（GraphWrangler AI のアーカイブ一覧と
 *  同じ意味）。ts は区切った時刻＝GraphWrangler AI の「新しい会話を押した時刻」に対応する */
export function splitSessions(messages: MaterializedMessage[]): PastSession[] {
  const pastSessions: PastSession[] = [];
  let seg: MaterializedMessage[] = [];
  for (const m of messages) {
    if (isChatBreak(m)) {
      const convo = seg.filter((x) => inTab(x, "talk"));
      if (convo.length > 0) pastSessions.push({ id: m.id, ts: m.ts, messages: convo });
      seg = [];
    } else {
      seg.push(m);
    }
  }
  return pastSessions;
}

/** 履歴カードに出す「最初の人間の発言の先頭40字」（GraphWrangler AI＝ChatDrawer の
 *  firstUserPreview と同じ規約。履歴タブの見た目を両者でそろえる） */
export function firstHumanPreview(messages: MaterializedMessage[]): string {
  const first = messages.find((m) => m.kind === "say" && m.author.kind === "human");
  return (first?.body ?? "").slice(0, 40) || "(発言なし)";
}
