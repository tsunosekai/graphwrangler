// 展開（「ノード内ノード」→ 実ノード連鎖）。docs/design.md 3.14 参照。
// AI実行ノードが実際に行った操作の内訳（SubStep[]。実行記録 status メッセージの
// payload.subSteps）を、そのノードを置き換える実ノードの連鎖（parents で直列に繋いだ
// task ノード群）へ展開する。ノードidは history が下がる正データ（3.1）で、展開は
// 「意図的な削除+追加」——各ステップ（addNode/patchNode/removeNode）が独立した op として
// ops.jsonl に乗るため、undo は逆操作N件で戻る（1つの巨大トランザクションopにはしない。
// GraphStore.applyDecision と同じ設計思想）。
import {
  GraphError,
  GraphStore,
  ThreadStore,
  subStepsOf,
  type NodeImpl,
  type OpMeta,
} from "@graphwrangler/core";

export interface ExpandResult {
  created: string[];
}

/** SubStep 1件から作る新ノードの detail（Why: どの実行から来たかを後から追えるように）。
 *  入力の要約があれば添えるが、SubStep.input は既に保存前に切り詰め済みなので、
 *  ここでは全体を~500文字にもう一段軽く切り詰めるだけに留める */
function detailFor(step: { tool: string; input: string | null }): string {
  let text = `AI実行の内訳から展開（ツール: ${step.tool}）`;
  if (step.input) text += `\n入力: ${step.input}`;
  return text.length > 500 ? text.slice(0, 500) : text;
}

/**
 * ノード id を、そのスレッドの messageId が持つ実行記録の内訳（subSteps）から
 * 再構築した実ノード連鎖で置き換える。
 *
 * ガード（すべて409。MVPは「怪しければ拒否」で安全側に倒す）:
 * - subSteps が空 → 内訳が無い
 * - node.kind !== "task" → 展開できるのは実行ノードだけ
 * - node.fixed → Fix されたノードは「やり方が確定」しているので展開（やり方の分解）はできない
 * - ページ化している（他ノードの group が自分を指す）→ 中身を持つノードは展開できない
 * - 分岐の配線対象になっている（自分の parentOptions が非空 = 自分がどこかの decision の
 *   特定の枝からぶら下がっている。または他ノードの parentOptions のキーが自分 = 自分が
 *   decision として参照されている）→ 展開すると配線が消える。plain な parents 参照だけが
 *   安全に付け替えられる対象
 */
export function expandNode(
  graph: GraphStore,
  threads: ThreadStore,
  id: string,
  messageId: string,
  meta: OpMeta,
): ExpandResult {
  const node = graph.get(id); // 404: node not found

  const message = threads.list(id).find((m) => m.id === messageId);
  if (!message) {
    throw new GraphError(`このノードのスレッドにメッセージが見つかりません: ${messageId}`, 404);
  }

  const subSteps = subStepsOf(message.payload)
    .slice()
    .sort((a, b) => a.index - b.index);
  if (subSteps.length === 0) {
    throw new GraphError("この記録には実行の内訳がありません", 409);
  }
  if (node.kind !== "task") {
    throw new GraphError("task ノードのみ展開できます", 409);
  }
  if (node.fixed) {
    throw new GraphError("Fix されたノードは展開できない", 409);
  }

  const allNodes = graph.state().nodes;
  if (allNodes.some((n) => n.group === id)) {
    throw new GraphError("ページ化しているノードは展開できない", 409);
  }
  const isWired =
    Object.keys(node.parentOptions).length > 0 ||
    allNodes.some((n) => n.id !== id && Object.hasOwn(n.parentOptions, id));
  if (isWired) {
    throw new GraphError("分岐の配線対象になっているため展開できない", 409);
  }

  // ---- 実ノード連鎖の作成: 最初のノードは元ノードの parents を継承、以降は直前のノード1つだけを親に持つ直列連鎖 ----
  const created: string[] = [];
  let previousId: string | null = null;
  for (const step of subSteps) {
    const isScript = step.tool === "Bash" && !!step.command;
    const impl: NodeImpl | null = isScript ? { type: "script", command: step.command! } : null;
    const created_ = graph.addNode(
      {
        title: step.title,
        detail: detailFor(step),
        impl,
        kind: "task",
        executor: isScript ? "script" : "ai",
        lifecycle: "draft",
        group: node.group,
        parents: previousId ? [previousId] : node.parents,
      },
      meta,
    );
    created.push(created_.id);
    previousId = created_.id;
  }
  const lastId = created[created.length - 1];

  // ---- 子の付け替え: 元ノードを parents に持っていたノードは、連鎖の最後のノードへ繋ぎ替える ----
  for (const n of allNodes) {
    if (n.id === id) continue;
    if (n.parents.includes(id)) {
      graph.patchNode(n.id, { parents: n.parents.map((p) => (p === id ? lastId : p)) }, meta);
    }
  }

  // ---- 元ノードの削除: 子は付け替え済み・メンバーは無い（ガード済み）ので force 不要 ----
  graph.removeNode(id, meta);

  return { created };
}
