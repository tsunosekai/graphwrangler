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
const NODESEP = 12;
/** カード左右の外付けバッジ（左: 完了チェック/スピナー、右: ロック/▶発火。どちらも
 *  ±30px はみ出す）が隣のノードと被らないための水平マージン。dagre に渡す幅だけ
 *  この分広げ、描画サイズは変えない（2026-07-31 本人指定）。nodesep はバッジ同士の
 *  すき間になるので小さめでよい */
const SIDE_BADGE_MARGIN = 30;

/** measured: 実測サイズ（React Flow の measured）。渡すとノードの縦幅に関わらず
 *  間隔が一定になる（dagre の ranksep は宣言サイズ基準なので、実寸を渡さないと
 *  高さの差ぶん見かけの間隔がばらつく）。無いノードは既定値で計算。
 *
 *  prev: 整列前のノード位置（top-left）。渡すと同ランク内の左右順を整列前のまま保つ
 *  （dagre の交差最小化が兄弟の順番を勝手に入れ替えるのを防ぐ、2026-08-03 本人指示）。
 *  段の割り当てと縦間隔は dagre のまま。prev に無いノード（新規）は dagre の置いた
 *  位置を順序キーに使う */
export function layoutGraph(
  nodes: Node[],
  measured?: Map<string, Size>,
  prev?: Map<string, Pos>,
): Map<string, Pos> {
  const sizeOf = (id: string): Size =>
    measured?.get(id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
  // 順序比較は中心 x で行う（prev は top-left なので幅の半分を足す）
  const prevCenterX = (id: string): number | undefined => {
    const p = prev?.get(id);
    return p === undefined ? undefined : p.x + sizeOf(id).width / 2;
  };

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: NODESEP, ranksep: 56 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(nodes.map((n) => n.id));
  // 投入順が dagre の初期順序（DFS）になるので、旧 x 順で入れて交差最小化の
  // 出発点を「いまの並び」に寄せる（同着の並びが投入順で決まる）
  const ordered = prev
    ? nodes
        .slice()
        .sort(
          (a, b) =>
            (prevCenterX(a.id) ?? Number.POSITIVE_INFINITY) -
            (prevCenterX(b.id) ?? Number.POSITIVE_INFINITY),
        )
    : nodes;
  for (const n of ordered) {
    const s = sizeOf(n.id);
    // 左右バッジのはみ出し分を幅に含める（中心座標は変わらないので自動的に真ん中に収まる）
    g.setNode(n.id, { width: s.width + SIDE_BADGE_MARGIN * 2, height: s.height });
  }
  for (const n of ordered) {
    for (const p of n.parents) if (ids.has(p)) g.setEdge(p, n.id);
  }
  dagre.layout(g);

  // 後処理: dagre が入れ替えた同ランク内の左右順を旧 x 順へ戻す（保証はこちらが持つ。
  // 同ランクのノードは dagre では中心 y が同一値になるので y でグループ化できる）
  if (prev) {
    const rows = new Map<number, string[]>();
    for (const n of nodes) {
      const y = g.node(n.id).y;
      const row = rows.get(y);
      if (row) row.push(n.id);
      else rows.set(y, [n.id]);
    }
    for (const row of rows.values()) {
      if (row.length < 2) continue;
      row.sort((a, b) => g.node(a).x - g.node(b).x);
      const desired = row
        .slice()
        .sort((a, b) => (prevCenterX(a) ?? g.node(a).x) - (prevCenterX(b) ?? g.node(b).x));
      if (desired.every((id, i) => id === row[i])) continue;
      // 段の中心を保ったまま、旧 x 順に左から詰め直す（幅はバッジ込みの dagre 幅）
      const left = Math.min(...row.map((id) => g.node(id).x - g.node(id).width / 2));
      const right = Math.max(...row.map((id) => g.node(id).x + g.node(id).width / 2));
      const totalW =
        desired.reduce((sum, id) => sum + g.node(id).width, 0) + NODESEP * (desired.length - 1);
      let x = (left + right) / 2 - totalW / 2;
      for (const id of desired) {
        const w = g.node(id).width;
        g.node(id).x = x + w / 2;
        x += w + NODESEP;
      }
    }
  }

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
