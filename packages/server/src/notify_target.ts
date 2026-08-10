// Discord 通知の target（ページ名 + ノード名 + リンク材料）の組み立て。
// 3つの発生源（判断リクエスト・ラン待ち遷移・Task AI 返信）が同じ形を作るので1箇所に集約。
import type { GraphStore } from "@graphwrangler/core";
import type { NotifyTarget } from "./discord.js";

/** ノードから通知 target を組み立てる。run を渡すとラン経由の通知（runTitle/runId 付き）。
 *  node は id/title/group だけを要求する——テンプレート削除後は snapshot ノード
 *  （NodeSnapshot）からも組み立てられるようにするため */
export function notifyTargetOf(
  graph: GraphStore,
  node: { id: string; title: string; group: string | null },
  run?: { title: string; id: string },
): NotifyTarget {
  return {
    pageTitle: node.group && graph.has(node.group) ? graph.get(node.group).title : null,
    nodeId: node.id,
    nodeTitle: node.title || "（無題）",
    ...(run ? { runTitle: run.title, runId: run.id } : {}),
  };
}
