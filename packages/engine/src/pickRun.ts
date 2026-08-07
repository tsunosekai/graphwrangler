// ラン（ルーティーンページの実行インスタンス）のワークアイテム選択。src/pick.ts と同じ方針で
// ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
import type { Node, Run, RunItem } from "./types.js";

export type RunAction =
  | { type: "execute"; run: Run; node: Node }
  | { type: "waiting-irreversible"; run: Run; node: Node }
  /** 担当=人間のタスクへ順番が回ってきた（ボールが人間へ渡った）。呼び出し側が
   *  items patch {status:"waiting"} し、それがサーバの「あなたの番」通知の発生源になる
   *  （2026-08-08 追加。それまで human アイテムは pending のまま放置され、ランが人間の
   *  ステップに到達しても橙ドットも Discord 通知も出なかった） */
  | { type: "human-turn"; run: Run; node: Node }
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
 * 対象: run.status=running のラン、item.status=pending、テンプレート kind=task かつ
 * executor=ai|script、テンプレート lifecycle=committed、ラン内依存（同じ手順のメンバーである
 * parents）が全て done/skipped。ラン created 昇順（古いランを先に）→ ラン内はテンプレート
 * created 昇順で最初の1件。
 *
 * - kind=decision のテンプレートは対象外（decisionRun.ts の selectRunDecisionAction が扱う。
 *   3.9: 分岐は choice 確定+skip伝搬という別の完了経路を持つため、ここでは拾わない）
 * - executor=human のテンプレートは実行しないが、順番が回ってきたら human-turn を返す
 *   （2026-08-08。「実行しない」＝「放置してよい」ではない: waiting へ上げて
 *   「あなたの番」の橙ドットと Discord 通知を発生させる。着手/完了は人間が押す）
 * - **lifecycle=draft のテンプレートは対象外**（items には入るが実行はされない。3.8
 *   「Fix/committed をランの参加条件にしない」の裏側: 参加＝items に入ることと、
 *   自動実行されることは別の話。committedのみ自動実行、という3.4の原則はここで担保する）
 * - approval=true（実行前承認）のテンプレートは実行せず waiting-irreversible を返す
 *   （呼び出し側が items patch {status:"waiting", note:"承認待ち"} し、以後の承認往復は
 *   approval.ts が担当する）
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
      if (node.kind !== "task") continue; // decision は decisionRun.ts が扱う
      if (node.lifecycle !== "committed") continue; // draft は items に入るが自動実行はしない
      if (!dependenciesSettled(node, run)) continue;

      // 担当=人間: 実行はしないが「あなたの番」へ上げる（通知と橙ドットの発生源）
      if (node.executor === "human") {
        return { type: "human-turn", run, node };
      }
      if (node.executor !== "ai" && node.executor !== "script") continue;

      if (node.approval) {
        return { type: "waiting-irreversible", run, node };
      }
      return { type: "execute", run, node };
    }
  }
  return { type: "none" };
}
