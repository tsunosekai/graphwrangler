// フォルダごとの AI 設定（docs/design.md 3.24）をサーバ側の AI（ノードの会話・全体チャット）に当てる。
// 決め方の正本は core の folderAiScope（実行AI＝engine も同じ関数を使う）。
import { type FolderAiScope, type GraphStore, NO_FOLDER_SCOPE, folderAiScope } from "@graphwrangler/core";

/** そのノード（またはページ）に効くフォルダの AI 設定。id が無い・見つからないなら「設定なし」 */
export function aiScopeFor(graph: GraphStore, nodeOrPageId: string | null | undefined): FolderAiScope {
  if (!nodeOrPageId || !graph.has(nodeOrPageId)) return NO_FOLDER_SCOPE;
  const byId = (id: string) => (graph.has(id) ? graph.get(id) : undefined);
  return folderAiScope(graph.get(nodeOrPageId), byId);
}
