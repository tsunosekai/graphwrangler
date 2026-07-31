// パラメータ宣言（試走ゲート近く。docs/design.md 3.5.1）の未入力チェック。
// 実際の置換・エスケープはサーバ/エンジン側（packages/server/src/trial.ts の substituteParams）が
// 行う。UI 側は「試走ボタンを disabled にするか」の判定にだけ使うので、command 中の `{name}`
// プレースホルダのうち宣言が無い/value が未入力(null/空文字)のものを集めるだけの軽量版。
import type { ScriptParam } from "../types";

/** command 中の `{name}` プレースホルダのうち、未入力（宣言なし or value 空）の名前一覧を返す。
 *  空配列 = 試走可能（プレースホルダが無い、または全て入力済み） */
export function missingParamNames(command: string, params: ScriptParam[] | null | undefined): string[] {
  const declared = new Map((params ?? []).map((p) => [p.name, p]));
  const missing: string[] = [];
  for (const match of command.matchAll(/\{([^{}]+)\}/g)) {
    const name = match[1];
    const p = declared.get(name);
    const hasValue = !!p && p.value != null && p.value !== "";
    if (!hasValue && !missing.includes(name)) missing.push(name);
  }
  return missing;
}
