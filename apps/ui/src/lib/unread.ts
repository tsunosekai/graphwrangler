// 未読判定のキー（2026-08-08 本人指摘「テンプレートのノードにも通知が出てしまい、
// こっちには何も新情報が無い」）。会話がランごとに分かれた（design.md 5.3）ので、
// 未読・既読もその単位で持つ:
//   "<ノードid>"            … テンプレート（設計図）側の会話
//   "<ノードid>@<ランid>"   … そのランの会話
// サーバの threadMeta（最終メッセージ時刻）と reads（既読時刻）は同じキーで並ぶので、
// 突き合わせはこのキーを通す。@ はノードid・ランidに現れない文字なので衝突しない。
export function threadKey(nodeId: string, runId?: string | null): string {
  return runId ? `${nodeId}@${runId}` : nodeId;
}

/** そのキーに未読があるか。last（最終メッセージ時刻）が無ければ会話自体が無い＝未読なし。
 *  既読の記録が無いものは「初見＝未読」（開けば消える。2026-08-02 の規約を踏襲） */
export function isUnreadKey(
  key: string,
  threadMeta: Record<string, string>,
  reads: Record<string, string>,
): boolean {
  const last = threadMeta[key];
  if (!last) return false;
  const read = reads[key];
  return !read || last > read;
}

/** ノードの未読（テンプレート側 + 全ランぶん）を数える。左レールのページ行のように
 *  「このページのどこかに新しいことがある」を出す用途 */
export function unreadCountForNode(
  nodeId: string,
  threadMeta: Record<string, string>,
  reads: Record<string, string>,
): number {
  let count = 0;
  const prefix = `${nodeId}@`;
  for (const key of Object.keys(threadMeta)) {
    if (key !== nodeId && !key.startsWith(prefix)) continue;
    if (isUnreadKey(key, threadMeta, reads)) count += 1;
  }
  return count;
}
