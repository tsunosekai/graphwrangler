// ブラウザ標準の window.confirm / window.prompt を使わないための、アプリ内ダイアログの
// 薄いイベントバス（lib/toast.ts と同じ「コンポーネントツリーを経由しない」流儀）。
// 表示本体は components/DialogHost.tsx（App 直下に常駐）。
// 呼び出し側は Promise で結果を待つだけでよく、見た目・キーボード操作はホスト側に集約する。

export interface ConfirmOptions {
  /** OKボタンのラベル（既定 "OK"） */
  confirmLabel?: string;
  /** 破壊的操作（削除など）。OKボタンを destructive 色にする */
  danger?: boolean;
  /** 第3の選択肢（2026-08-09）。「消す代わりにこうする」を並べるためのもので、
   *  danger 指定の確認では**こちらが既定の推し**（primary色 + 初期フォーカス）になり、
   *  危ない方（confirm）は控えめなボタンに落ちる。使う側は confirmWithAltDialog を呼ぶ */
  alt?: { label: string };
}

/** confirm の結果。alt を出さない場合は "confirm" | "cancel" しか返らない */
export type ConfirmChoice = "confirm" | "alt" | "cancel";

export interface PromptOptions {
  defaultValue?: string;
  placeholder?: string;
  /** OKボタンのラベル（既定 "OK"） */
  confirmLabel?: string;
}

/** 任意入力フォーム（発火フォーム・human 完了ミニフォーム。docs/design.md 3.15）の1欄。
 *  Node.outputs の宣言（name/label/example）と同形——label をラベル、example をプレースホルダに使う */
export interface FormFieldDecl {
  name: string;
  label?: string | null;
  example?: string | null;
}

export interface FormOptions {
  /** 入力欄の宣言。空配列ならタイトル欄（あれば）だけの prompt 相当になる */
  fields: FormFieldDecl[];
  /** 各欄の初期値（同じページの直近ランの context プリフィル等）。キーは fields[].name */
  prefill?: Record<string, string>;
  /** ラン名などのタイトル入力欄。省略で出さない */
  titleInput?: { placeholder?: string; defaultValue?: string };
  /** OKボタンのラベル（既定 "OK"） */
  confirmLabel?: string;
}

/** values には空欄のキーは入らない（空文字の欄はキーごと送らない。docs/design.md 3.15） */
export interface FormResult {
  title: string;
  values: Record<string, string>;
}

export type DialogRequest =
  | ({ kind: "confirm"; message: string; resolve: (choice: ConfirmChoice) => void } & ConfirmOptions)
  | ({ kind: "prompt"; message: string; resolve: (value: string | null) => void } & PromptOptions)
  | ({ kind: "form"; message: string; resolve: (value: FormResult | null) => void } & FormOptions);

type Listener = (req: DialogRequest) => void;
let listener: Listener | null = null;

export function subscribeDialogs(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/** window.confirm の代替。OK で true、キャンセル/閉じるで false */
export function confirmDialog(message: string, opts: Omit<ConfirmOptions, "alt"> = {}): Promise<boolean> {
  return confirmWithAltDialog(message, opts).then((choice) => choice === "confirm");
}

/** 第3の選択肢つきの確認。「削除しますか？」に「消さずにアーカイブする」を並べる用途
 *  （2026-08-09 本人要望「基本こっちを選ばせたい」）。閉じる/キャンセルは "cancel" */
export function confirmWithAltDialog(message: string, opts: ConfirmOptions = {}): Promise<ConfirmChoice> {
  return new Promise((resolve) => {
    if (!listener) {
      resolve("cancel"); // ホスト未マウント（理論上起きない）。安全側=キャンセル扱い
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

/** 複数欄の任意入力フォーム（docs/design.md 3.15: 発火フォーム / human 完了ミニフォーム）。
 *  全欄が任意＝空のまま OK できる。OK で FormResult、キャンセル/閉じるで null */
export function formDialog(message: string, opts: FormOptions): Promise<FormResult | null> {
  return new Promise((resolve) => {
    if (!listener) {
      resolve(null);
      return;
    }
    listener({ kind: "form", message, resolve, ...opts });
  });
}
