// チーム化（複数人運用。2026-08-04）の共有コンテキストとヘルパ。
// ログイン情報（/api/me）とユーザーロスター（/api/users）は App が起動時に1回取得し、
// TeamContext で全域へ配る（ポーリングしない。ロスターの変更はまれで、リロードで追いつけばよい）。
// degrade 原則: ロスターが2人未満の運用（個人利用・ログイン無し）では人系UI
// （担当者セレクト・関係者・人フィルタ・イニシャルバッジ）を一切出さない —— enabled がその判定。
// ログイン中のユーザーチップ（TopBar）だけは1人でも出してよい（me.email で判定する）。
import { createContext, useContext } from "react";
import type { Me, TeamUser } from "./api";

export type { Me, TeamUser };

export interface Team {
  me: Me;
  users: TeamUser[];
  /** ロスターが2人以上=チーム運用。人系UIはこれが true のときだけ出す */
  enabled: boolean;
}

export const TeamContext = createContext<Team>({
  me: { email: null, displayName: null, authRequired: false },
  users: [],
  enabled: false,
});

export function useTeam(): Team {
  return useContext(TeamContext);
}

/** email の表示名: ロスターの displayName、無ければ @ より前 */
export function displayNameOf(email: string, users: TeamUser[]): string {
  const u = users.find((x) => x.email === email);
  return u?.displayName || email.split("@")[0];
}

/** アバター的バッジ用のイニシャル（表示名の先頭1文字） */
export function initialOf(email: string, users: TeamUser[]): string {
  return displayNameOf(email, users).slice(0, 1).toUpperCase();
}

/** 「あなたの番」（waiting）が自分の番か。assignee 未設定・未ログインは従来どおり全員の番。
 *  判定を各所（NodeCard / PageList / NodePanel / デスクトップ通知）で複製しないための共通ヘルパ */
export function turnIsMine(assignee: string | null | undefined, meEmail: string | null): boolean {
  return !assignee || !meEmail || assignee === meEmail;
}

/** ノードの pendingRequest が「自分の番」か（pendingRequest 無しは false） */
export function isMyTurn(
  node: { pendingRequest: string | null; assignee: string | null },
  meEmail: string | null,
): boolean {
  return node.pendingRequest !== null && turnIsMine(node.assignee, meEmail);
}
