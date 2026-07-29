// アウトラインビュー: DAG を木として投影する（docs/design.md セクション「アウトラインビュー仕様」）。
// parents[0] を主親としてネスト、2本目以降の親は呼び出し側で「⇡チップ」として表示する。
import type { Node } from "../types";

export interface OutlineEntry {
  node: Node;
  children: OutlineEntry[];
  /** parents[1..] のうち実在するノード（⇡チップ用） */
  extraParents: Node[];
}

function siblingSort(a: Node, b: Node): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  return a.created.localeCompare(b.created);
}

export function buildOutline(nodes: Node[]): OutlineEntry[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const childrenOfPrimary = new Map<string, Node[]>();
  const roots: Node[] = [];

  for (const n of nodes) {
    // 主親（依存）があればその下、無ければ所属グループ（フォルダ）の下、どちらも無ければルート
    const primary = n.parents[0];
    const holder =
      primary && byId.has(primary) ? primary : n.group && byId.has(n.group) ? n.group : null;
    if (holder) {
      const list = childrenOfPrimary.get(holder) ?? [];
      list.push(n);
      childrenOfPrimary.set(holder, list);
    } else {
      roots.push(n);
    }
  }

  function build(n: Node): OutlineEntry {
    const children = (childrenOfPrimary.get(n.id) ?? []).slice().sort(siblingSort).map(build);
    const extraParents = n.parents
      .slice(1)
      .map((id) => byId.get(id))
      .filter((x): x is Node => Boolean(x));
    return { node: n, children, extraParents };
  }

  return roots.slice().sort(siblingSort).map(build);
}

/** node と同じ主親を持つ兄弟（node 自身を含む）を order/created 順で返す。Tab/Enter の計算に使う */
export function siblingsOf(nodes: Node[], node: Node): Node[] {
  const primary = node.parents[0] ?? null;
  return nodes.filter((n) => (n.parents[0] ?? null) === primary).sort(siblingSort);
}
