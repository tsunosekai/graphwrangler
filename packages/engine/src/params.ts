// パラメータ宣言（スクリプトの引数。docs/design.md 3.5.1「担当×実装の対応表と試走ゲート」近く、
// 2026-07-31実装）。command 中の {name} プレースホルダを impl.params[].value で置換してから
// 本走に渡す。packages/server/src/trial.ts の substituteParams と完全に同じロジックを
// ここに複製している（server は engine に依存しないため。**変えたら両方直す**）。
import type { ScriptParam } from "./types.js";

export type SubstituteParamsResult = { ok: true; command: string } | { ok: false; missing: string[] };

/**
 * command 中の `{name}` プレースホルダを対応する params[].value へ置換する。値は二重引用符で
 * 囲み、内部の `"` は `\"` にエスケープする。宣言に無い `{xxx}` や value が未入力（null/空文字）の
 * 宣言が残っていれば `{ok:false, missing:[名前...]}` を返す（重複名は1回だけ）。
 */
export function substituteParams(
  command: string,
  params: ScriptParam[] | null | undefined,
): SubstituteParamsResult {
  const declared = new Map((params ?? []).map((p) => [p.name, p]));
  const missing: string[] = [];
  const substituted = command.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const p = declared.get(name);
    if (!p || p.value === null || p.value === undefined || p.value === "") {
      if (!missing.includes(name)) missing.push(name);
      return `{${name}}`;
    }
    const escaped = p.value.replace(/"/g, '\\"');
    return `"${escaped}"`;
  });
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, command: substituted };
}

/** missing パラメータを failure recovery の reason 文言に変換する（index.ts の
 *  全 runScript 呼び出し箇所で共通利用。既存の失敗→リカバリの器（呼び出し元ごとの
 *  postMessage/patchNode|patchRunItem/openRequest の流儀）にそのまま乗せる） */
export function missingParamsReason(missing: string[]): string {
  return `パラメータが未入力です: ${missing.join(", ")}。パネルの実装欄で値を入力してから『もう一度』を選んでください`;
}
