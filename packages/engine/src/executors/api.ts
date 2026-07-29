// executor=ai（engine.mode="api"）: ヘッドレスCLIを起動せず、サーバの /api/ai/complete
// （チャット設定のプロバイダ/APIキーで generateText、ツールなし）を呼ぶだけの薄い実行者。
// プロンプト組み立ては claude.ts の buildAiPrompt をそのまま流用する（executors/claude.ts 参照）。
import { completeAi, ApiError } from "../api.js";
import type { ExecResult } from "./claude.js";

/** /api/ai/complete を呼び、結果を ExecResult に変換する。
 *  キー未設定・プロバイダエラー・ネットワークエラーは全て success:false で返す
 *  （engine/src/index.ts 側は claude executor と同じ失敗リカバリ経路をそのまま使える） */
export async function runApi(prompt: string): Promise<ExecResult> {
  try {
    const text = await completeAi(prompt);
    return { success: true, output: text.trim() };
  } catch (err) {
    const message = err instanceof ApiError ? err.message : String(err);
    return { success: false, output: "", error: message };
  }
}
