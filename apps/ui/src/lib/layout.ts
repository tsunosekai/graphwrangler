// グラフビューの自動レイアウト。rankdir=TB 必須（文字が横書きなので縦に流す、docs/design.md）。
import dagre from "@dagrejs/dagre";
import type { Node } from "../types";

export interface Pos {
  x: number;
  y: number;
}

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 76;

export function layoutPositions(nodes: Node[]): Map<string, Pos> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 32, ranksep: 64 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const n of nodes) {
    for (const p of n.parents) {
      if (ids.has(p)) g.setEdge(p, n.id);
    }
  }
  dagre.layout(g);

  const out = new Map<string, Pos>();
  for (const n of nodes) {
    const pos = g.node(n.id);
    out.set(n.id, { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 });
  }
  return out;
}

/** ノード集合・親子関係だけを見た署名。これが変わらない限りレイアウトを再計算しない
 *  （status/title の変化だけでノードが飛び回らないようにする） */
export function structureSignature(nodes: Node[]): string {
  return nodes
    .map((n) => `${n.id}:${n.parents.slice().sort().join(",")}`)
    .sort()
    .join("|");
}
