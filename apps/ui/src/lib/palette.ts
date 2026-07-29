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
