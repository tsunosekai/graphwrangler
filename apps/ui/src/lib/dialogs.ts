// ブラウザ標準の window.confirm / window.prompt を使わないための、アプリ内ダイアログの
// 薄いイベントバス（lib/toast.ts と同じ「コンポーネントツリーを経由しない」流儀）。
// 表示本体は components/DialogHost.tsx（App 直下に常駐）。
// 呼び出し側は Promise で結果を待つだけでよく、見た目・キーボード操作はホスト側に集約する。

export interface ConfirmOptions {
  /** OKボタンのラベル（既定 "OK"） */
  confirmLabel?: string;
  /** 破壊的操作（削除など）。OKボタンを destructive 色にする */
  danger?: boolean;
}

export interface PromptOptions {
  defaultValue?: string;
  placeholder?: string;
  /** OKボタンのラベル（既定 "OK"） */
  confirmLabel?: string;
}

export type DialogRequest =
  | ({ kind: "confirm"; message: string; resolve: (ok: boolean) => void } & ConfirmOptions)
  | ({ kind: "prompt"; message: string; resolve: (value: string | null) => void } & PromptOptions);

type Listener = (req: DialogRequest) => void;
let listener: Listener | null = null;

export function subscribeDialogs(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/** window.confirm の代替。OK で true、キャンセル/閉じるで false */
export function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!listener) {
      resolve(false); // ホスト未マウント（理論上起きない）。安全側=キャンセル扱い
      return;
    }
    listener({ kind: "confirm", message, resolve, ...opts });
  });
}

/** window.prompt の代替。OK で入力文字列、キャンセル/閉じるで null */
export function promptDialog(message: string, opts: PromptOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    if (!listener) {
      resolve(null);
      return;
    }
    listener({ kind: "prompt", message, resolve, ...opts });
  });
}
