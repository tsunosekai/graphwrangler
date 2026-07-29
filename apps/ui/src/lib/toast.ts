// 画面上部の一時トースト。api.ts の fetch ラッパがエラーを拾ってここへ流す
// （コンポーネントツリーを経由しない薄いイベントバス）。
export type ToastKind = "error" | "info";
type Listener = (message: string, kind: ToastKind) => void;

const listeners = new Set<Listener>();

export function subscribeToast(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** kind 既定は "error"（api.ts の既存呼び出しと互換）。undo/redo 成功時などは "info" を渡す */
export function pushToast(message: string, kind: ToastKind = "error"): void {
  for (const fn of listeners) fn(message, kind);
}
