// 「ルーティーンページ」判定（docs/design.md 3.8)。ページ種別の宣言ではなく、
// そのページのメンバーに kind=trigger のノードがいるかどうかから導出する。
import type { Node } from "../types";

/** page がルーティーンページか。members には page.group===page.id なノード群を渡す
 *  （GraphView は表示中ページのメンバーそのものを nodes として持っているのでそのまま渡せる） */
export function isRoutinePage(page: Node, members: Node[]): boolean {
  return members.some((n) => n.group === page.id && n.kind === "trigger");
}
