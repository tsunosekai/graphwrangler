// 削除の巻き添え計算（NodePanel の削除ボタン / GraphView の Delete キー / BulkPanel の
// 一括削除で共用）。2026-08-01 本人指摘「ノードとかプロジェクトを消せない不具合がある。
// ロックされている場合はモーダルで確認してほしいけど、消せないのは違う」に基づき、
// 削除は原則いつでもできる・危ないケースは事前にモーダルで教える、へ方針変更した。
// サーバ側は removeNode の force=true がこの UI 確認とペア（packages/core/src/graph.ts）。
import type { Node } from "../types";

export interface RemoveImpact {
  /** 選択に含まれない巻き添え削除（ページのメンバー。入れ子も辿る）の数 */
  cascade: number;
  /** 削除集合の外で parents / parentOptions を切り離される子の数 */
  detach: number;
  /** 削除集合内のロック(Fix)済みノード数 */
  locked: number;
  /** 削除される全ノード id（選択 + 巻き添え） */
  removalSet: Set<string>;
}

export function computeRemoveImpact(ids: string[], allNodes: Node[]): RemoveImpact {
  const set = new Set(ids);
  const direct = set.size;
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of allNodes) {
      if (n.group !== null && set.has(n.group) && !set.has(n.id)) {
        set.add(n.id);
        grew = true;
      }
    }
  }
  const detach = allNodes.filter(
    (n) =>
      !set.has(n.id) &&
      (n.parents.some((p) => set.has(p)) ||
        Object.keys(n.parentOptions).some((d) => set.has(d))),
  ).length;
  const locked = allNodes.filter((n) => set.has(n.id) && n.fixed).length;
  return { cascade: set.size - direct, detach, locked, removalSet: set };
}

/** モーダルに出す警告行（空配列なら普通の削除＝追加の警告不要） */
export function removeImpactWarnings(impact: RemoveImpact): string[] {
  const w: string[] = [];
  if (impact.locked > 0) w.push(`ロック(Fix)中のノード ${impact.locked} 件を含みます`);
  if (impact.cascade > 0) w.push(`ページ内のノード ${impact.cascade} 件もまとめて削除されます`);
  if (impact.detach > 0) w.push(`残る子ノード ${impact.detach} 件は依存から切り離されます`);
  return w;
}

/** 確認モーダルの本文を組み立てる（warnings があれば ⚠ 行を続ける） */
export function buildRemoveMessage(base: string, warnings: string[]): string {
  return warnings.length === 0 ? base : `${base}\n\n${warnings.map((w) => `⚠ ${w}`).join("\n")}`;
}
