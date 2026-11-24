// 人間ノードの「前準備」の受け渡しの書式（docs/design.md 3.18）。
// 人間の番が回ってくる前に AI が準備をして、その結果を人間ノードのチャットへ発言する。
// 発言は普通の Markdown で、チャット側が次の2つを特別に描く:
//   - コードブロック（```）       … コピーボタンが付く（送る文面・入力する値）
//   - ```gw-actions ブロック       … 実行ボタンになる（URL・フォルダ・ファイルを開く／コマンド）
// ここは gw-actions の文法の正本（エンジンのプロンプト・UI の描画・着手での実行が同じパーサを通す）。
// ネットワークI/Oを持たない純粋関数のみ。

/** 前準備の発言の目印（Message.payload.prep）。チャットはこれが付いた最新の発言を上に固定する */
export const PREP_PAYLOAD_KEY = "prep";

/** gw-actions ブロックの言語名 */
export const ACTIONS_LANG = "gw-actions";

export type GwAction =
  /** URL・フォルダ・ファイルを開く */
  | { type: "open"; label: string; target: string; auto: boolean }
  /** コマンドを実行する（デスクトップ版のみ） */
  | { type: "run"; label: string; command: string; auto: boolean };

/**
 * gw-actions ブロックの中身（1行1個の JSON）をパースする。
 *   {"label":"未払いフォルダを開く","open":"X:\\\\経理\\\\未払い"}
 *   {"label":"銀行を開く","open":"https://example.com/","auto":false}
 *   {"label":"下ごしらえ","run":"python prep.py"}
 * auto（既定 true）= 担当者が「着手」を押したときにまとめて実行する。false はボタンを押したときだけ。
 * 解釈できない行は捨てずに invalid へ返す（UI が「実行できない行」として見せる）。
 */
export function parseActions(text: string): { actions: GwAction[]; invalid: string[] } {
  const actions: GwAction[] = [];
  const invalid: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      // Windows のパスを \ 1本で書いた行（JSON としては不正）を救う。\\ はそのまま、
      // 単独の \ だけを \\ に直してもう一度読む
      try {
        obj = JSON.parse(line.replace(/\\(?!["\\/bfnrtu])/g, "\\\\"));
      } catch {
        invalid.push(line);
        continue;
      }
    }
    if (!obj || typeof obj !== "object") {
      invalid.push(line);
      continue;
    }
    const o = obj as Record<string, unknown>;
    const auto = o.auto !== false;
    const open = typeof o.open === "string" ? o.open.trim() : "";
    const run = typeof o.run === "string" ? o.run.trim() : "";
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : open || run;
    if (open && !run) actions.push({ type: "open", label, target: open, auto });
    else if (run && !open) actions.push({ type: "run", label, command: run, auto });
    else invalid.push(line);
  }
  return { actions, invalid };
}

const FENCE_RE = /^```[ \t]*gw-actions[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

/** Markdown 本文から、すべての gw-actions ブロックの実行項目を順に取り出す（着手での一括実行用） */
export function extractActions(markdown: string): GwAction[] {
  const out: GwAction[] = [];
  for (const m of markdown.matchAll(FENCE_RE)) out.push(...parseActions(m[1]).actions);
  return out;
}

/** 開く対象が Web の URL か（true ならブラウザでも開ける。false はパス＝デスクトップ版だけ） */
export function isWebUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}
