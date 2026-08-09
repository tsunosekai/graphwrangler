// ランのコンテキスト（docs/design.md 3.15「ランのコンテキスト」）の共通部品:
// ##gw マーカー行の抽出と、script 実行へ渡す GW_* 環境変数の組み立て。
// ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
import type { ScriptParam } from "./types.js";

/** ##gw マーカー行（実行時の書き）。行全体が `##gw {"set":{...}}` の形（1行1個）。
 *  素の key=value 形式は無し——ログとの偽陽性衝突を避ける（3.15） */
const GW_MARKER_RE = /^##gw\s+(\{.*\})\s*$/;
/** `##gw {` で始まるがマーカーとして成立していない行の検出用（status に失敗として記録する対象） */
const GW_ATTEMPT_RE = /^##gw\s+\{/;

export interface GwMarkerExtraction {
  /** マーカー行（不正な試行行を含む）を取り除いた本文。say にはこちらを積む */
  body: string;
  /** 有効なマーカーの set を出現順に merge した結果（同一キーは last-write-wins） */
  set: Record<string, string>;
  /** 有効なマーカー行の数（プロジェクト層で「ランでのみ有効」status を出す判定に使う） */
  validCount: number;
  /** `##gw {` で始まるのに JSON として解釈できなかった行（実行は成功扱いのまま status に記録） */
  invalidLines: string[];
}

/** JSON 値を Record<string,string> へ緩く読む。値は string/number/boolean を許して文字列化する
 *  （スクリプトが数値をそのまま emit しても弾かないため）。それ以外の形は null（=不正） */
export function coerceStringRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else return null;
  }
  return out;
}

/** マーカーの JSON 部分を `{"set": {key: value}}` として読む。形が違えば null */
function parseGwSet(json: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return coerceStringRecord((parsed as { set?: unknown }).set);
}

/**
 * 出力テキストから ##gw マーカー行を抽出する（3.15「実行時の書き」）。
 * マーカー行と不正な試行行は body から取り除く（監査は呼び出し側が status で残す）。
 * `##gw` の後が `{` で始まらない行は普通のログとみなし body に残す。
 */
export function extractGwMarkers(output: string): GwMarkerExtraction {
  const bodyLines: string[] = [];
  const set: Record<string, string> = {};
  const invalidLines: string[] = [];
  let validCount = 0;
  for (const line of output.split(/\r?\n/)) {
    const m = GW_MARKER_RE.exec(line);
    if (m) {
      const parsed = parseGwSet(m[1]);
      if (parsed) {
        Object.assign(set, parsed);
        validCount += 1;
      } else {
        invalidLines.push(line.trim());
      }
      continue;
    }
    if (GW_ATTEMPT_RE.test(line)) {
      invalidLines.push(line.trim());
      continue;
    }
    bodyLines.push(line);
  }
  return { body: bodyLines.join("\n"), set, validCount, invalidLines };
}

/** GW_PARAM_ 環境変数名: name を大文字化し英数以外を `_` にする（3.15の契約） */
export function paramEnvName(name: string): string {
  return `GW_PARAM_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * ラン層の script 実行へ渡す環境変数を組み立てる（3.15「実行時の読み」）。
 * - GW_RUN_ID / GW_CONTEXT（context 全体の JSON）/ GW_RUN_DIR（ワークスペースモードのみ）
 * - GW_PARAM_<NAME>: 解決可能な各値。デフォルト値 → context の順で重ねることで、
 *   解決順「context 優先」を環境変数側でも再現する。コマンド中で参照されていない名前も
 *   含める——インジェクションガードに掛かった値の逃げ道（{name} 置換をやめて環境変数で
 *   読む）がここに無いと成立しないため
 */
export function buildContextEnv(
  runId: string,
  context: Record<string, string>,
  params: ScriptParam[] | null | undefined,
  runDir: string | null,
): Record<string, string> {
  const env: Record<string, string> = {
    GW_RUN_ID: runId,
    GW_CONTEXT: JSON.stringify(context),
  };
  if (runDir) env.GW_RUN_DIR = runDir;
  for (const p of params ?? []) {
    if (p.value !== null && p.value !== undefined && p.value !== "") {
      env[paramEnvName(p.name)] = p.value;
    }
  }
  for (const [k, v] of Object.entries(context)) env[paramEnvName(k)] = v;
  return env;
}
