// パラメータ宣言（スクリプトの引数。docs/design.md 3.5.1「担当×実装の対応表と試走ゲート」近く、
// 2026-07-31実装）。command 中の {name} プレースホルダを解決してから本走に渡す。
// 2026-08-09 ランのコンテキスト（3.15）対応: ラン層では context を渡し、解決順を
// ① run.context[name] → ② impl.params[].value（デフォルト値に降格）→ ③ 未入力エラー とする。
// プロジェクト層（ランが無い）は context を渡さず従来どおり ② のみ。
// packages/server/src/trial.ts の substituteParams と完全に同じロジックをここに複製している
// （server は engine に依存しないため。**変えたら両方直す**。試走は context を渡さずに呼ぶ）。
import type { ScriptParam } from "./types.js";

export type SubstituteParamsResult =
  | { ok: true; command: string; resolved: Record<string, string> }
  | { ok: false; kind: "missing"; missing: string[]; reason: string }
  | { ok: false; kind: "unsafe"; unsafe: string[]; reason: string };

/**
 * インジェクションガード（docs/design.md 3.15）。**run.context 由来の値のみ**に適用する。
 * context の書き手は人間だけでなく AI・スクリプト・外部 MCP になるため、
 * 「外部由来文字列 → AI が context へ転記 → コマンド置換」というプロンプトインジェクション→
 * シェルインジェクションの導線をここで遮断する。テンプレートのデフォルト値（人間が UI で
 * 入力）は従来どおり引用符エスケープのみ（自分のマシンで任意コマンドを書ける人間の入力を
 * 縛っても防御にならないため）。
 */
const CONTEXT_INJECTION_GUARD_RE = /[`$\\"';|&<>(){}\r\n]/;

/**
 * command 中の `{name}` プレースホルダを解決する。
 * - context があれば context[name] を優先し、無ければ params[].value（デフォルト値）。
 * - 値は二重引用符で囲む。デフォルト値は内部の `"` を `\"` にエスケープ、context 由来は
 *   ガード通過済み（`"` `\` を含まない）なのでそのまま囲む。
 * - どちらにも無い名前が残れば missing、context 由来の値がシェルのメタ文字を含めば unsafe
 *   （置換せず実行失敗。エラー文言で GW_PARAM_* 環境変数の使用へ誘導する）。
 * - ok:true の resolved には実際に置換した {name: 値}（context 由来+デフォルト値由来の両方）が
 *   入る（ラン層は RunItem.resolvedParams への記録に使う）。
 */
export function substituteParams(
  command: string,
  params: ScriptParam[] | null | undefined,
  context?: Record<string, string>,
): SubstituteParamsResult {
  const declared = new Map((params ?? []).map((p) => [p.name, p]));
  const missing: string[] = [];
  const unsafe: string[] = [];
  const resolved: Record<string, string> = {};
  const substituted = command.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const fromContext = context?.[name];
    if (fromContext !== undefined) {
      if (CONTEXT_INJECTION_GUARD_RE.test(fromContext)) {
        if (!unsafe.includes(name)) unsafe.push(name);
        return `{${name}}`;
      }
      resolved[name] = fromContext;
      return `"${fromContext}"`;
    }
    const p = declared.get(name);
    if (!p || p.value === null || p.value === undefined || p.value === "") {
      if (!missing.includes(name)) missing.push(name);
      return `{${name}}`;
    }
    resolved[name] = p.value;
    const escaped = p.value.replace(/"/g, '\\"');
    return `"${escaped}"`;
  });
  if (unsafe.length > 0) {
    return { ok: false, kind: "unsafe", unsafe, reason: unsafeContextParamsReason(unsafe) };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      kind: "missing",
      missing,
      reason: missingParamsReason(missing, context !== undefined),
    };
  }
  return { ok: true, command: substituted, resolved };
}

/** missing パラメータを failure recovery の reason 文言に変換する（index.ts の
 *  全 runScript 呼び出し箇所で共通利用。既存の失敗→リカバリの器（呼び出し元ごとの
 *  postMessage/patchNode|patchRunItem/openRequest の流儀）にそのまま乗せる）。
 *  withRunContext=true（ラン層）ではランのコンテキストにも無かったことが分かる文にする */
export function missingParamsReason(missing: string[], withRunContext = false): string {
  if (withRunContext) {
    return `パラメータが未入力です: ${missing.join(", ")}。ランのコンテキストにも無く、パネルの実装欄のデフォルト値も未入力です。コンテキストへ値を書くか、実装欄で値を入力してから『もう一度』を選んでください`;
  }
  return `パラメータが未入力です: ${missing.join(", ")}。パネルの実装欄で値を入力してから『もう一度』を選んでください`;
}

/** インジェクションガードに掛かった context 由来パラメータの reason 文言。
 *  値は環境変数 GW_PARAM_<NAME> でも渡している（シェル展開を通らないので安全）ため、
 *  スクリプト側での読み替えへ誘導する */
export function unsafeContextParamsReason(unsafe: string[]): string {
  return `ランのコンテキスト由来の値にシェルのメタ文字が含まれるため置換できません: ${unsafe.join(", ")}。値は環境変数 GW_PARAM_<名前を大文字化したもの> で渡しているので、コマンドの {名前} 置換ではなく環境変数から読み取るようスクリプトを変更してください`;
}
