// 左レール（PageList）が行ごとに引く派生値の索引（2026-08-10 性能）。
// 素直に書くとページ行1本ごとに allNodes（配下ノード探し）と threadMeta（未読キー探し）を
// 舐め直すことになり、描画1回で「ページ数 × 全ノード数 × threadMeta のキー数」だけ回る。
// ここで「group → 直下のノード」と「ノードid → そのノードの会話キー」を**一度だけ**作れば、
// 行の描画はどちらも引いた件数ぶんで済み、全体で O(全ノード + threadMeta のキー数 + ページ数)
// になる。集合の中身は素朴な走査と同じ——出る数も色も変えないための索引でしかない。
import type { Node } from "../types";
import { isUnreadKey } from "./unread";

/** 引くたびに空配列を作らないための共有の空（返り値は読み取り専用に扱う） */
const NO_NODES: Node[] = [];
const NO_KEYS: string[] = [];

export interface RailIndex {
  /** ノードid → ノード */
  nodeById: Map<string, Node>;
  /** その入れ物（group）の直下ノード。並びは allNodes の順（`filter` と同じ） */
  membersOf(groupId: string): Node[];
  /** そのノードの会話キー（threadMeta のキーのうち "<id>" と "<id>@<ランid>"）。
   *  集合は lib/actions.ts の readKeysForNode と同じ */
  keysOf(nodeId: string): string[];
  /** ページ配下（入れ子の group も辿る）の会話キー全部。ページ自身のぶんも含める。
   *  集合は lib/actions.ts の readKeysForPage と同じ（順序は問わない使い方だけをする） */
  readKeysForPage(pageId: string): string[];
  /** そのノードの未読数（テンプレート側 + 全ランぶん）。lib/unread.ts の unreadCountForNode と同じ */
  unreadCount(nodeId: string, reads: Record<string, string>): number;
}

export function buildRailIndex(allNodes: Node[], threadMeta: Record<string, string>): RailIndex {
  const nodeById = new Map<string, Node>();
  const byGroup = new Map<string, Node[]>();
  for (const n of allNodes) {
    nodeById.set(n.id, n);
    if (n.group === null) continue;
    const list = byGroup.get(n.group);
    if (list) list.push(n);
    else byGroup.set(n.group, [n]);
  }

  // 会話キーの仕分け。"<ノードid>@<ランid>" の @ より前がノードid
  // （@ はノードid・ランidに現れない = lib/unread.ts の threadKey の規約）
  const keysByNode = new Map<string, string[]>();
  for (const key of Object.keys(threadMeta)) {
    const at = key.indexOf("@");
    const nodeId = at < 0 ? key : key.slice(0, at);
    const list = keysByNode.get(nodeId);
    if (list) list.push(key);
    else keysByNode.set(nodeId, [key]);
  }

  const membersOf = (groupId: string): Node[] => byGroup.get(groupId) ?? NO_NODES;
  const keysOf = (nodeId: string): string[] => keysByNode.get(nodeId) ?? NO_KEYS;

  return {
    nodeById,
    membersOf,
    keysOf,
    readKeysForPage(pageId: string): string[] {
      const keys = [...keysOf(pageId)];
      const seen = new Set<string>([pageId]);
      const stack = [pageId];
      while (stack.length > 0) {
        for (const child of membersOf(stack.pop()!)) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          stack.push(child.id);
          keys.push(...keysOf(child.id));
        }
      }
      return keys;
    },
    unreadCount(nodeId: string, reads: Record<string, string>): number {
      let count = 0;
      for (const key of keysOf(nodeId)) if (isUnreadKey(key, threadMeta, reads)) count += 1;
      return count;
    },
  };
}
