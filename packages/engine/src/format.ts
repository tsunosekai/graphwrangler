// スレッド投稿・ログの整形（本文の切り詰めと payload の組み立て）。
import type { SubStep } from "./types.js";

export function truncate(text: string, limit: number): string {
  const t = text.trim();
  return t.length <= limit ? t : t.slice(0, limit) + "…";
}

/** 実行結果の subSteps（実行の内訳）を postMessage 用 payload にする。空/無ければ
 *  base をそのまま返す（status メッセージに subSteps が無いケースを既存互換で保つ） */
export function withSubSteps(
  base: Record<string, unknown> | undefined,
  result: { subSteps?: SubStep[] },
): Record<string, unknown> | undefined {
  if (!result.subSteps || result.subSteps.length === 0) return base;
  return { ...base, subSteps: result.subSteps };
}
