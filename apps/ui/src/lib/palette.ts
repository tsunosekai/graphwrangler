// Ctrl+K 全ノード検索オーバーレイを開くための薄いイベントバス（lib/toast.ts と同じ流儀:
// コンポーネントツリーを経由せず、TopBar の🔍ボタンから常駐の CommandPalette を起こす）。
type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeOpenPalette(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function openPalette(): void {
  for (const fn of listeners) fn();
}

// ショートカット一覧ダイアログも同じ流儀（ボタンはヘッダー、ダイアログと "?" キーは
// GraphView が持つ。2026-07-31 本人指示でボタンをヘッダーへ移設）
const shortcutListeners = new Set<Listener>();

export function subscribeOpenShortcuts(fn: Listener): () => void {
  shortcutListeners.add(fn);
  return () => shortcutListeners.delete(fn);
}

export function openShortcuts(): void {
  for (const fn of shortcutListeners) fn();
}
