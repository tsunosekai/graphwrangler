// チーム化（複数人運用。2026-08-04）の共有コンテキストとヘルパ。
// ログイン情報（/api/me）とユーザーロスター（/api/users）は App が起動時に1回取得し、
// TeamContext で全域へ配る（ポーリングしない。ロスターの変更はまれで、リロードで追いつけばよい）。
// degrade 原則: ロスターが2人未満の運用（個人利用・ログイン無し）では人系UI
// （担当者セレクト・関係者・人フィルタ・イニシャルバッジ）を一切出さない —— enabled がその判定。
// ログイン中のユーザーチップ（TopBar）だけは1人でも出してよい（me.email で判定する）。
import { createContext, useContext } from "react";
import type { Me, TeamUser } from "./api";
import type { Node } from "../types";

export type { Me, TeamUser };

export interface Team {
  me: Me;
  users: TeamUser[];
  /** ロスターが2人以上=チーム運用。人系UIはこれが true のときだけ出す */
  enabled: boolean;
  /** ロスターの再取得（ユーザー管理ダイアログでの追加・変更の反映用。2026-08-04）。
   *  Provider（App の TeamProvider）が実体を配る。既定は no-op */
  refreshUsers: () => void;
}

export const TeamContext = createContext<Team>({
  me: { email: null, displayName: null, admin: false, authRequired: false },
  users: [],
  enabled: false,
  refreshUsers: () => {},
});

export function useTeam(): Team {
  return useContext(TeamContext);
}

/** メール比較用の正規化（trim + 小文字）。メールの比較は必ずこれ経由にする——
 *  Google ログイン等は大文字混じりの表記を返しうるが、メールアドレスは実務上
 *  大文字小文字を区別しない（2026-08-04: 表記ゆれで自分のページが絞り込めない不具合の対策） */
export function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

/** 2つのメールが同一人物か（どちらかが空なら false）。生の === を各所に書かないための共通ヘルパ */
export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normEmail(a) === normEmail(b);
}

/** email の表示名: ロスターの displayName、無ければ @ より前 */
export function displayNameOf(email: string, users: TeamUser[]): string {
  const u = users.find((x) => sameEmail(x.email, email));
  return u?.displayName || email.split("@")[0];
}

/** アバター的バッジ用のイニシャル（表示名の先頭1文字） */
export function initialOf(email: string, users: TeamUser[]): string {
  return displayNameOf(email, users).slice(0, 1).toUpperCase();
}

/** ユーザーの決定的カラー（2026-08-04）: メールのハッシュから hue を決める。
 *  誰の色かがどの画面でも一致し、サーバに色設定を持たなくてよい。
 *  彩度55%/明度45%は「白いイニシャル文字が読め、ライト/ダーク両テーマで浮かない」狙い
 *  （既存の --human 等のトーンに合わせて彩度を上げすぎない） */
export function colorOf(email: string): string {
  const s = normEmail(email);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 55%, 45%)`;
}

/** 「あなたの番」（waiting）が自分の番か。assignee 未設定・未ログインは従来どおり全員の番。
 *  判定を各所（NodeCard / PageList / NodePanel / デスクトップ通知）で複製しないための共通ヘルパ */
export function turnIsMine(assignee: string | null | undefined, meEmail: string | null): boolean {
  return !assignee || !meEmail || sameEmail(assignee, meEmail);
}

/** ページの実効関係者: 手動 members ∪ 作成者 ∪ 配下ノード（group===page.id）の
 *  members・担当者・作成者の自動集計（2026-08-04）。手動設定だけに頼ると、配下に担当者が
 *  居るのにページのバッジ・人フィルタに現れない——「誰が絡んでいるページか」は配下から
 *  導出するのが実態に合う。重複はメール小文字正規化で除去し、表示表記は最初に見つかった
 *  ものをそのまま使う（表示名解決は displayNameOf が別途行うので表記は何でもよい） */
export function effectiveMembers(page: Node, allNodes: Node[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (email: string | null | undefined) => {
    if (!email) return;
    const key = normEmail(email);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(email);
  };
  for (const m of page.members ?? []) add(m);
  add(page.createdBy);
  for (const n of allNodes) {
    if (n.group !== page.id) continue;
    for (const m of n.members ?? []) add(m);
    add(n.assignee);
    add(n.createdBy);
  }
  return out;
}

/** ノードの pendingRequest が「自分の番」か（pendingRequest 無しは false） */
export function isMyTurn(
  node: { pendingRequest: string | null; assignee: string | null },
  meEmail: string | null,
): boolean {
  return node.pendingRequest !== null && turnIsMine(node.assignee, meEmail);
}
