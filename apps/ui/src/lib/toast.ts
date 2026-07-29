// 画面上部の一時トースト。api.ts の fetch ラッパがエラーを拾ってここへ流す
// （コンポーネントツリーを経由しない薄いイベントバス）。
type Listener = (message: string) => void;

const listeners = new Set<Listener>();

export function subscribeToast(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function pushToast(message: string): void {
  for (const fn of listeners) fn(message);
}
