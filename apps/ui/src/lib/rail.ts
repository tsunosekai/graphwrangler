// 左レール（ページ一覧）の並び順とフォルダ分けの純粋関数（2026-08-05 フォルダ + 手動並べ替え）。
// PageList からドラッグ処理の「結果どう並ぶか」だけを切り出したもの。
// 並びの正データはノードの order（数値。同じ入れ物の中でだけ意味を持つ）と
// folder（kind=folder ノードの id。null=直下）。
import type { Node } from "../types";

/** 同じ入れ物の中の並び: order 昇順（null=未指定は後ろ）→ created 昇順 → id。
 *  未指定を後ろに落とすことで、一度も並べ替えていない既存データは従来どおり作成順に並ぶ */
export function sortRail(list: Node[]): Node[] {
  return [...list].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    if (a.created !== b.created) return a.created < b.created ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/** ids の中で draggedId を targetId の前/後ろへ動かした新しい id 列を返す。
 *  targetId が ids に無い場合は末尾へ送る（入れ物をまたぐ移動の受け皿） */
export function moveWithin(
  ids: string[],
  draggedId: string,
  targetId: string,
  pos: "before" | "after",
): string[] {
  const rest = ids.filter((id) => id !== draggedId);
  const at = rest.indexOf(targetId);
  if (at < 0) return [...rest, draggedId];
  const insert = pos === "before" ? at : at + 1;
  return [...rest.slice(0, insert), draggedId, ...rest.slice(insert)];
}

export interface RailPatch {
  id: string;
  patch: { order?: number; folder?: string | null };
}

/** 並べ替え後の id 列から、**実際に値が変わるノードだけ**の patch を作る。
 *  order は 0..n-1 に詰め直す（毎回サーバへ送るのは差分だけなので、2回目以降の
 *  ドラッグでは数件しか飛ばない）。folder に undefined を渡すと所属は触らない */
export function railPatches(
  orderedIds: string[],
  byId: Map<string, Node>,
  folder?: string | null,
): RailPatch[] {
  const out: RailPatch[] = [];
  orderedIds.forEach((id, index) => {
    const node = byId.get(id);
    if (!node) return;
    const patch: RailPatch["patch"] = {};
    if (node.order !== index) patch.order = index;
    if (folder !== undefined && (node.folder ?? null) !== folder) patch.folder = folder;
    if (Object.keys(patch).length > 0) out.push({ id, patch });
  });
  return out;
}
