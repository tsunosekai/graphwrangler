// 「ルーティーンページ」判定（docs/design.md 3.8 新モデル）。
// ページ種別(kind=procedure)の宣言ではなく、そのページのメンバーに kind=trigger のノードが
// いるかどうかから導出する。旧データ（kind=procedure のまま trigger を持たない）も
// 後方互換で true 扱いにする（design.md: 「procedure は廃止・後方互換のため enum にのみ残置」）。
import type { Node } from "../types";

/** page がルーティーンページか。members には page.group===page.id なノード群を渡す
 *  （GraphView は表示中ページのメンバーそのものを nodes として持っているのでそのまま渡せる） */
export function isRoutinePage(page: Node, members: Node[]): boolean {
  if (page.kind === "procedure") return true;
  return members.some((n) => n.group === page.id && n.kind === "trigger");
}
