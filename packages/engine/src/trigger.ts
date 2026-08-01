// トリガーノード（kind=trigger）の発火判定。docs/design.md 3.4/3.8/3.9 が仕様の正。
// 「ルーティーンであること」はフロー先頭のトリガーノードから導出する。Rx の思想を借りる:
// トリガー = Observable のソース、ラン = イベントの伝搬。起動方式は executor 軸で一貫させる:
//   - script トリガー = cron的な定期実行（schedule文字列を発火判定に使う。
//     parseSchedule/shouldCreateScheduledRun で判定）
//   - ai トリガー     = schedule をチェック間隔として使い、間隔ごとにエンジンがAIへ
//     「今発火すべきか」を判定させる
//   - human トリガー  = 手動発火(POST /fire)のみ。エンジンは何もしない
// ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
import { parseSchedule, shouldCreateScheduledRun } from "./schedule.js";
import type { Node } from "./types.js";

/** ai トリガーのチェック間隔が未指定/未対応の書式のときの既定値（1時間） */
export const DEFAULT_AI_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** kind=trigger かつ lifecycle=committed のノードだけがエンジンの対象
 *  （3.4「committedのみ自動実行」の原則。draft のトリガーはエンジンが無視する） */
export function isFireableTrigger(node: Node): boolean {
  return node.kind === "trigger" && node.lifecycle === "committed";
}

/**
 * script トリガーの発火判定。schedule が無い/未対応の書式は null を返す
 * （呼び出し側で警告ログを出す）。
 */
export function shouldFireScriptTrigger(
  scheduleText: string | null,
  latestRun: { created: string } | null,
  now: Date,
  hasRunningRun: boolean,
): boolean | null {
  if (!scheduleText) return null;
  const schedule = parseSchedule(scheduleText);
  if (!schedule) return null;
  return shouldCreateScheduledRun(schedule, latestRun, now, hasRunningRun);
}

/**
 * ai トリガーのチェック間隔(ms)を求める。schedule は every系のみ解釈する
 * （daily/weeklyは「チェック間隔」という用途には意味を持たないため無視する）。
 * 無指定/未対応の書式は既定1時間。
 */
export function resolveAiCheckIntervalMs(scheduleText: string | null): number {
  if (!scheduleText) return DEFAULT_AI_CHECK_INTERVAL_MS;
  const schedule = parseSchedule(scheduleText);
  if (!schedule || schedule.type !== "every") return DEFAULT_AI_CHECK_INTERVAL_MS;
  return schedule.ms;
}

/**
 * ai トリガーを今回評価すべきか。実行中のランが既にあればチェック自体をしない
 * （script トリガーの hasRunningRun による重複防止と同じ発想）。
 * lastCheckedAt はエンジンのメモリ管理（プロセス再起動で即再チェックされるのは許容する）。
 */
export function shouldEvaluateAiTrigger(
  intervalMs: number,
  lastCheckedAt: number | null,
  now: number,
  hasRunningRun: boolean,
): boolean {
  if (hasRunningRun) return false;
  if (lastCheckedAt === null) return true;
  return now - lastCheckedAt >= intervalMs;
}

/**
 * AIの判定出力を fire/skip として解釈する（decision.ts の parseBranchChoice と同じ救済方針:
 * 前後に説明が付いていても、行単位で fire/skip という単語が現れれば拾う）。
 * どちらとも判定できなければ null（呼び出し側は「出力が不正」として扱い、発火しない）。
 */
export function parseAiFireDecision(output: string): "fire" | "skip" | null {
  const trimmed = output.trim().toLowerCase();
  if (trimmed === "fire" || trimmed === "skip") return trimmed;
  for (const line of trimmed.split("\n").map((l) => l.trim())) {
    if (line === "fire" || line === "skip") return line as "fire" | "skip";
  }
  if (/\bfire\b/.test(trimmed)) return "fire";
  if (/\bskip\b/.test(trimmed)) return "skip";
  return null;
}

/**
 * ai トリガー向けのプロンプトを組み立てる（純粋関数）。発火条件は title/detail/impl(doc全文)
 * に書かれている想定（docs/design.md「条件は detail / impl(doc) に書かれている」）。
 */
export function buildTriggerPrompt(
  node: Pick<Node, "title" | "detail" | "impl">,
  now: Date,
): string {
  const lines: string[] = [
    "あなたは GraphWrangler（タスクグラフをAIと人間で分担するツール）のトリガー判定者です。",
    `トリガー: ${node.title}`,
  ];
  if (node.detail) lines.push(`補足: ${node.detail}`);
  if (node.impl && node.impl.type === "doc" && node.impl.text) {
    lines.push("", "発火条件（手順書）:", node.impl.text);
  }
  lines.push("", `現在時刻: ${now.toISOString()}`);
  lines.push(
    "",
    "発火すべきなら fire、見送るなら skip のみを1行で出力してください（他の文字・説明は含めないこと）。",
  );
  return lines.join("\n");
}
