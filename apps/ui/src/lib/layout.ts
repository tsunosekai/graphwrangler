// グラフビューの自動レイアウト。rankdir=TB 必須（文字が横書きなので縦に流す、docs/design.md）。
// GraphView に渡るのは表示中ページのメンバーだけ（ページノード自身は含まない）なので、
// dagre 1回のフラットなレイアウトで足りる。
import dagre from "@dagrejs/dagre";
import type { Node } from "../types";

export interface Pos {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 64;
/** カード左右の外付けバッジ（左: 完了チェック/スピナー、右: ロック/▶発火。どちらも
 *  ±30px はみ出す）が隣のノードと被らないための水平マージン。dagre に渡す幅だけ
 *  この分広げ、描画サイズは変えない（2026-07-31 本人指定）。nodesep はバッジ同士の
 *  すき間になるので小さめでよい */
const SIDE_BADGE_MARGIN = 30;

/** measured: 実測サイズ（React Flow の measured）。渡すとノードの縦幅に関わらず
 *  間隔が一定になる（dagre の ranksep は宣言サイズ基準なので、実寸を渡さないと
 *  高さの差ぶん見かけの間隔がばらつく）。無いノードは既定値で計算 */
export function layoutGraph(nodes: Node[], measured?: Map<string, Size>): Map<string, Pos> {
  const sizeOf = (id: string): Size =>
    measured?.get(id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 12, ranksep: 56 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const s = sizeOf(n.id);
    // 左右バッジのはみ出し分を幅に含める（中心座標は変わらないので自動的に真ん中に収まる）
    g.setNode(n.id, { width: s.width + SIDE_BADGE_MARGIN * 2, height: s.height });
  }
  for (const n of nodes) {
    for (const p of n.parents) if (ids.has(p)) g.setEdge(p, n.id);
  }
  dagre.layout(g);

  const positions = new Map<string, Pos>();
  for (const n of nodes) {
    const pos = g.node(n.id);
    const s = sizeOf(n.id);
    positions.set(n.id, { x: pos.x - s.width / 2, y: pos.y - s.height / 2 });
  }
  return positions;
}

/** ノード集合・親子・所属だけを見た署名。これが変わらない限りレイアウトを再計算しない
 *  （status/title の変化だけでノードが飛び回らないようにする） */
export function structureSignature(nodes: Node[]): string {
  return nodes
    .map((n) => `${n.id}:${n.group ?? ""}:${n.parents.slice().sort().join(",")}`)
    .sort()
    .join("|");
}
