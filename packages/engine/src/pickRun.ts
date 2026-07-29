// ラン（手順ページの実行インスタンス）のワークアイテム選択。src/pick.ts と同じ方針で
// ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
// docs/agent-contracts.md F: エンジンのラン対応の担当領域。
import type { Node, Run, RunItem } from "./types.js";

export type RunAction =
  | { type: "execute"; run: Run; node: Node }
  | { type: "waiting-irreversible"; run: Run; node: Node }
  | { type: "none" };

/**
 * ノードのランへの依存が揃っているか。
 * 「ラン内依存」＝テンプレートの parents のうち、そのランのアイテムに存在するもの
 * （＝同じ手順のメンバー）だけを見る。手順の外のノードを親に持っていても、
 * このランの実行判定には関係しない（プロジェクト側の依存とランは別物）。
 * 揃っている＝該当する親アイテムが全て done か skipped。
 */
function dependenciesSettled(node: Node, run: Run): boolean {
  return node.parents
    .filter((pid) => pid in run.items)
    .every((pid) => {
      const status = run.items[pid]?.status;
      return status === "done" || status === "skipped";
    });
}

interface RunnableEntry {
  nodeId: string;
  item: RunItem;
  node: Node;
}

/**
 * 実行可能なランのワークアイテムを1件選ぶ（純粋関数）。
 *
 * 対象: run.status=running のラン、item.status=pending、テンプレート executor=ai|script、
 * ラン内依存（同じ手順のメンバーである parents）が全て done/skipped。
 * ラン created 昇順（古いランを先に）→ ラン内はテンプレート created 昇順で最初の1件。
 *
 * - executor=human のテンプレートは対象外（人間待ちのまま。ランの承認/担当UIは将来）
 * - impact=irreversible のテンプレートは実行せず waiting-irreversible を返す
 *   （呼び出し側が items patch {status:"waiting", note:"不可逆のため人間の実行待ち"} する。
 *   pick.ts の承認カード連携はランには未接続 = 将来）
 */
export function selectRunAction(nodes: Node[], runs: Run[]): RunAction {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const runningRuns = [...runs]
    .filter((r) => r.status === "running")
    .sort((a, b) => a.created.localeCompare(b.created));

  for (const run of runningRuns) {
    const entries: RunnableEntry[] = Object.entries(run.items)
      .map(([nodeId, item]) => ({ nodeId, item, node: nodesById.get(nodeId) }))
      .filter((e): e is RunnableEntry => e.node !== undefined)
      .sort((a, b) => a.node.created.localeCompare(b.node.created));

    for (const { node, item } of entries) {
      if (item.status !== "pending") continue; // running/waiting/done/dropped/skipped は対象外
      if (node.executor !== "ai" && node.executor !== "script") continue;
      if (!dependenciesSettled(node, run)) continue;

      if (node.impact === "irreversible") {
        return { type: "waiting-irreversible", run, node };
      }
      return { type: "execute", run, node };
    }
  }
  return { type: "none" };
}
