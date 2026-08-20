// 「あなたの番」を鳴らすかの、グラフの形から決まる部分（純粋関数。zod も node も使わない）。
//
// サーバの Discord グラフ通知（server/open_request.ts・routes/runs.ts）と UI のデスクトップ通知
// （apps/ui/src/hooks/useDesktopNotify.ts）で規則が食い違わないよう、判定そのものはここに置く。
// 「誰に届けるか」「個人が受け取る設定か」は宛先解決・ユーザー設定の仕事で、ここでは扱わない。

/** 判定に必要なノードの形（テンプレートでもランのスナップショットでも満たせる最小集合） */
export interface TurnNode {
  kind: string;
  executor: string;
  assignee: string | null;
  parents: string[];
}

/** 親ノードの形。ran = その回に実際に行われたか（分岐で選ばれなかった枝・中止は false） */
export interface TurnParent {
  kind: string;
  executor: string;
  assignee: string | null;
  ran: boolean;
}

/** 人間が手を動かすノードか（kind=goal/trigger/folder には「あなたの番」が来ない） */
function isHumanWork(n: { kind: string; executor: string }): boolean {
  return n.executor === "human" && (n.kind === "task" || n.kind === "decision");
}

/** 「あなたの番」の宛先が同じか。どちらも未割当（null=全員宛）なら同じ宛先とみなす
 *  ——1人運用・未割当運用でも「同じ人の作業が続いている」を判定できる必要がある。
 *  メールは大文字小文字を区別しない（表記ゆれ対策。UI の normEmail と同じ規約） */
export function sameTurnOwner(a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * このノードが「同じ人の人間作業の続き」か（2026-08-20 本人指示「人間実行ノードかつ担当者が
 * 同じタスクが連続している場合のみ通知が出ないようにしてね」）。
 *
 * true の条件:
 *   - 自分が人間実行ノード（executor=human の task / decision）
 *   - 実際に行われた親（skipped/dropped でない親）が1つ以上あり、その**全部**が
 *     同じ担当者の人間実行ノード
 *
 * 「全部」にするのは合流点のため——AI やスクリプトの仕事が片方の親なら、その完了は人間に
 * とって新しい知らせなので鳴らす。親が無い（＝区間の先頭）ときも鳴らす。
 * 判定に使うのは通知の要否だけで、waiting への遷移も橙の「あなたの番」表示も変えない。
 */
export function isConsecutiveHumanTurn(
  node: TurnNode,
  parentOf: (id: string) => TurnParent | undefined,
): boolean {
  if (!isHumanWork(node)) return false;
  const ranParents = node.parents.map(parentOf).filter((p): p is TurnParent => p !== undefined && p.ran);
  if (ranParents.length === 0) return false;
  return ranParents.every((p) => isHumanWork(p) && sameTurnOwner(p.assignee, node.assignee));
}
