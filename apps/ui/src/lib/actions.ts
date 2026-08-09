// 右クリックメニュー（コンテキストメニュー）から使う共通ヘルパ。メニューは
// 「既存操作への近道（第0層）」なので、ここには **新しい概念を持ち込まない**——
// 既存の判定（unread.ts）・URL 組み立て（route.ts）・API（api.ts）を束ねるだけ。
// 複数の呼び出し元（左レール / ノード / ラン / 台帳）で同じ挙動になるよう、
// 「まとめ削除の順」「既読キーの集め方」といった地味な決まりごとをここに集約する。
import type { Node } from "../types";
import { api, postReads } from "./api";
import { confirmDialog, promptDialog } from "./dialogs";
import { buildRoute } from "./route";
import { isUnreadKey, threadKey } from "./unread";

/** rootId の子孫（parents を辿って到達できるノード）の id 集合。root 自身は含めない。
 *  循環は起こらない前提（DAG）だが、念のため visited で保護する */
export function collectDescendants(nodes: Node[], rootId: string): Set<string> {
  // parent -> 子ids の索引を一度だけ作る（毎回 filter すると深いグラフで効く）
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    for (const p of n.parents) {
      const list = childrenOf.get(p);
      if (list) list.push(n.id);
      else childrenOf.set(p, [n.id]);
    }
  }
  const found = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (child === rootId || found.has(child)) continue; // 循環保護
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}

/** 葉から順（子孫が先、親が後）に並べた削除順。サーバが「子を持つノードは消せない」を
 *  検証するため、まとめ削除はこの順に実行する。メンバー（group で自分を指すノード）も
 *  同じ検証に掛かる（packages/core/src/graph.ts removeNode）ので、依存(parents)と
 *  包含(group)の両方を「先に消すべき側」として扱う */
export function deletionOrder(nodes: Node[], ids: Set<string>): string[] {
  const targets = nodes.filter((n) => ids.has(n.id));
  const pending = new Set(targets.map((n) => n.id));
  const order: string[] = [];
  while (pending.size > 0) {
    // まだ消していないノードから参照されていない（＝葉）ものを取り出す
    const leaves = targets.filter(
      (n) =>
        pending.has(n.id) &&
        !targets.some(
          (other) =>
            pending.has(other.id) &&
            other.id !== n.id &&
            (other.parents.includes(n.id) || other.group === n.id),
        ),
    );
    if (leaves.length === 0) {
      // 循環（本来起きない）。残りは入力順のまま流して止まらないようにする
      for (const n of targets) if (pending.has(n.id)) order.push(n.id);
      break;
    }
    for (const n of leaves) {
      order.push(n.id);
      pending.delete(n.id);
    }
  }
  return order;
}

/** 共有できる絶対URL。window.location.origin + pathname + buildRoute(...) */
export function nodeUrl(s: {
  pageId?: string | null;
  nodeId?: string | null;
  runId?: string | null;
}): string {
  const hash = buildRoute({
    pageId: s.pageId ?? null,
    nodeId: s.nodeId ?? null,
    runId: s.runId ?? null,
    chat: false,
  });
  return `${window.location.origin}${window.location.pathname}${hash}`;
}

/** クリップボードへコピー。navigator.clipboard が使えない環境（非セキュアコンテキスト・
 *  古い WebView）では textarea + execCommand へフォールバックする。成否を返す */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 権限拒否など。下のフォールバックへ落ちる
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    // 画面に見えない・スクロールを動かさない位置へ置く
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** そのノードに紐づく既読キー全部（テンプレート側 + 全ランぶん）。threadMeta のキーから導く
 *  （会話が存在しないキーは既読にしても意味が無いので、threadMeta にあるものだけ） */
export function readKeysForNode(nodeId: string, threadMeta: Record<string, string>): string[] {
  const template = threadKey(nodeId);
  const prefix = `${nodeId}@`;
  const keys: string[] = [];
  for (const key of Object.keys(threadMeta)) {
    if (key === template || key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/** ページ（pageId）配下の全メンバーノードぶんの既読キー。ページ自身のノードも含める。
 *  入れ子のグループも辿る（削除の巻き添え計算 removal.ts と同じ「不動点まで広げる」流儀） */
export function readKeysForPage(
  pageId: string,
  nodes: Node[],
  threadMeta: Record<string, string>,
): string[] {
  const members = new Set<string>([pageId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (n.group !== null && members.has(n.group) && !members.has(n.id)) {
        members.add(n.id);
        grew = true;
      }
    }
  }
  const keys: string[] = [];
  for (const id of members) keys.push(...readKeysForNode(id, threadMeta));
  return keys;
}

/** 指定キーを既読にする（postReads）。各キーには threadMeta の最終メッセージ時刻を入れる
 *  ——クライアントの時計がサーバより遅れていると「既読にしたのにバッジが消えない」が
 *  起きるため（api.ts:213 周辺の規約）。threadMeta に無いキーは現在時刻+5秒。
 *  空配列なら何もしない。既読にしたキー数を返す。
 *  onViewed（App の readOverrides = NodePanel の onViewed と同じもの）を渡すと、
 *  送信が投げっぱなしでもバッジがその場で消える——渡さないと次のポーリングまで残る */
export function markKeysRead(
  keys: string[],
  threadMeta: Record<string, string>,
  onViewed?: (key: string, lastTs: string | null) => void,
): number {
  if (keys.length === 0) return 0;
  const fallback = new Date(Date.now() + 5000).toISOString();
  const marks: Record<string, string> = {};
  for (const key of keys) marks[key] = threadMeta[key] ?? fallback;
  postReads(marks);
  if (onViewed) for (const key of keys) onViewed(key, threadMeta[key] ?? null);
  return Object.keys(marks).length;
}

/** ラン名の変更（ダイアログ → api.renameRun）。グラフ上部の✎・台帳の✎と右クリック・
 *  左レールのラン子行の右クリックで、同じ文言と同じ no-op 判定（空 / 変更なしなら何もしない）
 *  にするため1箇所に置く。実際に名前が変わったときだけ true——呼び出し側は再取得の
 *  面倒（どの一覧を引き直すか）だけを持てばよい */
export async function renameRunDialog(run: { id: string; title: string }): Promise<boolean> {
  const title = await promptDialog("ランの名前", {
    defaultValue: run.title,
    confirmLabel: "変更",
  });
  if (title === null) return false;
  const trimmed = title.trim();
  if (!trimmed || trimmed === run.title) return false;
  try {
    await api.renameRun(run.id, trimmed);
    return true;
  } catch {
    return false; // api() 側でトースト表示済み
  }
}

/** ランの打ち切り（確認 → api.cancelRun）。実行ラベルはダイアログの「キャンセル」ボタンと
 *  紛れないよう「打ち切る」。打ち切ったときだけ true */
export async function cancelRunWithConfirm(run: { id: string; title: string }): Promise<boolean> {
  const ok = await confirmDialog(
    `ラン「${run.title}」を打ち切りますか？\nアイテムはそれ以上進まなくなります。`,
    { danger: true, confirmLabel: "打ち切る" },
  );
  if (!ok) return false;
  try {
    await api.cancelRun(run.id);
    return true;
  } catch {
    return false; // api() 側でトースト表示済み
  }
}

/** 指定キーのうち未読のものがあるか（メニュー項目の disabled 判定用） */
export function hasUnread(
  keys: string[],
  threadMeta: Record<string, string>,
  reads: Record<string, string>,
): boolean {
  return keys.some((key) => isUnreadKey(key, threadMeta, reads));
}
