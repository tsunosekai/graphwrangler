// グラフビューの自動レイアウト。rankdir=TB 必須（文字が横書きなので縦に流す、docs/design.md）。
// グループ（ゴール=ノード群のフォルダ）は2段階レイアウト:
//   1. 各グループの内部を dagre でレイアウトしてサイズを決める
//   2. グループ+非所属ノードを外側の dagre で配置（グループ間エッジは端点を所属グループに持ち上げる）
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

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 64;
const GROUP_PAD = 24;
const GROUP_TITLE_H = 28;
/** カード左右の外付けバッジ（左: 完了チェック/スピナー、右: ロック/▶発火。どちらも
 *  ±30px はみ出す）が隣のノードと被らないための水平マージン。dagre に渡す幅だけ
 *  この分広げ、描画サイズは変えない（2026-07-31 本人指定）。nodesep はバッジ同士の
 *  すき間になるので小さめでよい */
const SIDE_BADGE_MARGIN = 30;

export interface LayoutResult {
  /** グループ所属ノードは親からの相対座標、それ以外は絶対座標（React Flow の流儀） */
  positions: Map<string, Pos>;
  /** グループとして描くノード（メンバーを持つノード）のサイズ */
  groupSizes: Map<string, Size>;
}

function runDagre(
  items: { id: string; width: number; height: number }[],
  edges: [string, string][],
): dagre.graphlib.Graph {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 12, ranksep: 56 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const it of items) g.setNode(it.id, { width: it.width, height: it.height });
  for (const [a, b] of edges) g.setEdge(a, b);
  dagre.layout(g);
  return g;
}

/** measured: 実測サイズ（React Flow の measured）。渡すとノードの縦幅に関わらず
 *  間隔が一定になる（dagre の ranksep は宣言サイズ基準なので、実寸を渡さないと
 *  高さの差ぶん見かけの間隔がばらつく）。無いノードは既定値で計算 */
export function layoutGraph(nodes: Node[], measured?: Map<string, Size>): LayoutResult {
  const sizeOf = (id: string): Size =>
    measured?.get(id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
  // dagre 用のサイズ: 左右バッジのはみ出し分を幅に含める（中心座標は変わらないので、
  // 配置式は実寸のままで自動的に真ん中に収まる）
  const layoutSizeOf = (id: string): Size => {
    const s = sizeOf(id);
    return { width: s.width + SIDE_BADGE_MARGIN * 2, height: s.height };
  };
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const members = new Map<string, Node[]>();
  for (const n of nodes) {
    if (n.group && byId.has(n.group)) {
      const list = members.get(n.group) ?? [];
      list.push(n);
      members.set(n.group, list);
    }
  }

  const positions = new Map<string, Pos>();
  const groupSizes = new Map<string, Size>();

  // 1. グループ内部（MVP: 入れ子グループは未対応、直下メンバーのみ）
  for (const [groupId, list] of members) {
    const idSet = new Set(list.map((n) => n.id));
    const edges: [string, string][] = [];
    for (const n of list) {
      for (const p of n.parents) if (idSet.has(p)) edges.push([p, n.id]);
    }
    const g = runDagre(
      list.map((n) => ({ id: n.id, ...layoutSizeOf(n.id) })),
      edges,
    );
    let maxX = 0;
    let maxY = 0;
    for (const n of list) {
      const pos = g.node(n.id);
      const sz = sizeOf(n.id);
      const x = pos.x - sz.width / 2 + GROUP_PAD;
      const y = pos.y - sz.height / 2 + GROUP_PAD + GROUP_TITLE_H;
      positions.set(n.id, { x, y });
      // 右端は右バッジのはみ出し分まで箱に含める
      maxX = Math.max(maxX, x + sz.width + SIDE_BADGE_MARGIN);
      maxY = Math.max(maxY, y + sz.height);
    }
    groupSizes.set(groupId, { width: maxX + GROUP_PAD, height: maxY + GROUP_PAD });
  }

  // 2. 外側: グループ + どのグループにも属さないノード
  const liftTo = (id: string): string => {
    // エッジの端点を「外側レイヤーで実際に描かれるノード」へ持ち上げる
    let cur = byId.get(id);
    while (cur && cur.group && byId.has(cur.group)) cur = byId.get(cur.group);
    return cur?.id ?? id;
  };
  const topNodes = nodes.filter((n) => !(n.group && byId.has(n.group)));
  const topEdges = new Set<string>();
  const topEdgeList: [string, string][] = [];
  for (const n of nodes) {
    for (const p of n.parents) {
      if (!byId.has(p)) continue;
      const a = liftTo(p);
      const b = liftTo(n.id);
      if (a === b) continue;
      const key = `${a}->${b}`;
      if (!topEdges.has(key)) {
        topEdges.add(key);
        topEdgeList.push([a, b]);
      }
    }
  }
  const g = runDagre(
    topNodes.map((n) => {
      const size = groupSizes.get(n.id);
      return {
        id: n.id,
        width: size ? size.width : layoutSizeOf(n.id).width,
        height: size ? size.height + GROUP_TITLE_H : sizeOf(n.id).height,
      };
    }),
    topEdgeList,
  );
  for (const n of topNodes) {
    const pos = g.node(n.id);
    const size = groupSizes.get(n.id);
    const w = size ? size.width : sizeOf(n.id).width;
    const h = size ? size.height : sizeOf(n.id).height;
    positions.set(n.id, { x: pos.x - w / 2, y: pos.y - h / 2 });
  }

  return { positions, groupSizes };
}

/** ノード集合・親子・所属だけを見た署名。これが変わらない限りレイアウトを再計算しない
 *  （status/title の変化だけでノードが飛び回らないようにする） */
export function structureSignature(nodes: Node[]): string {
  return nodes
    .map((n) => `${n.id}:${n.group ?? ""}:${n.parents.slice().sort().join(",")}`)
    .sort()
    .join("|");
}
