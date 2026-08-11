// AI executor の「人間に判断を促す」往復（QUESTION プロトコル）と autonomy（自律度）の
// 判定。ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
//
// 仕組み（2026-08-03 本人指示「判断を促す仕組みも必要」「autonomy と一緒に実装」）:
// - AI executor のプロンプトに「人間の判断が必要なら QUESTION: 形式で出力して止まる」
//   規約を入れる（autonomy=high では入れない）。エンジンは出力を parseAiQuestion で判定し、
//   質問なら done にせず判断リクエストを開く。人間の回答は次回実行のプロンプトに
//   スレッド経緯として差し込まれる（buildThreadContextLines）
// - autonomy=high は逆方向: 質問規約を出さず「聞かずに進め」と指示し、実行失敗も
//   まず自動リトライする（shouldAutoRetry）。approval（実行前承認ゲート）は
//   autonomy に関わらず残る（安全装置はノード属性で無効化しない）
//
// **プロトコル本体（parseAiQuestion / 判断リクエストへの変換 / 説明文）は core へ移した**
// （2026-08-11）——スレッドの Task AI も同じ規約で人間を呼べるようにしたため。ここに残るのは
// エンジン固有の判断（autonomy・自動リトライ・再実行プロンプトの経緯組み立て）だけ。
import {
  type AiQuestion,
  QUESTION_PROTOCOL_LINES,
  buildAiQuestionRequest as buildAiQuestionRequestCore,
} from "@graphwrangler/core";
import { runGateMarker } from "./approval.js";
import type { Autonomy, DecisionAnswer, DecisionRequest, Message, Node } from "./types.js";

export { parseAiQuestion, type AiQuestion } from "@graphwrangler/core";

/** autonomy=high の実行失敗を人間に渡す前に自動で試し直す回数 */
export const MAX_AUTO_RETRIES = 2;

/** ランアイテムの「AIが質問中」note の接頭辞（approval.ts の APPROVAL_WAITING_NOTE と同じ役割） */
export const AI_QUESTION_WAITING_NOTE = "AI質問待ち";

/** AIの質問を判断リクエストへ変換する（core の実装に、エンジンのラン紐付けマーカーを渡す）。
 *  runId を渡すと question に `[ラン <id>]` が埋まり、回答からどのランの質問か復元できる */
export function buildAiQuestionRequest(node: Node, q: AiQuestion, runId?: string): DecisionRequest {
  return buildAiQuestionRequestCore(node.title, q, runId ? runGateMarker(runId) : null);
}

/** 実行失敗を人間に渡さず自動で試し直すか（autonomy=high のみ、MAX_AUTO_RETRIES まで） */
export function shouldAutoRetry(autonomy: Autonomy, retriesSoFar: number): boolean {
  return autonomy === "high" && retriesSoFar < MAX_AUTO_RETRIES;
}

/**
 * 自律度ごとのプロンプト追加行。
 * high = 質問規約を出さず「聞かずに進め」/ normal = 規約あり・最終手段 /
 * low = 規約あり・迷ったら質問するほうへ倒す
 */
export function autonomyPromptLines(autonomy: Autonomy): string[] {
  if (autonomy === "high") {
    return [
      "人間に判断を仰がず、あなたの判断で最後まで進めてください。",
      "前提が曖昧なら合理的な仮定を置いて進め、置いた仮定は結果に明記してください。",
    ];
  }
  if (autonomy === "low") {
    return [
      ...QUESTION_PROTOCOL_LINES,
      "前提が曖昧・選択肢の優劣が明確でない・好みが分かれると感じたら、自分で決めずに人間へ質問してください（迷ったら質問するほうに倒す）。",
    ];
  }
  return [
    ...QUESTION_PROTOCOL_LINES,
    "基本は自分で判断して進め、本当に人間にしか決められないことだけ質問してください。",
  ];
}

function truncate(text: string, limit: number): string {
  const t = text.trim();
  return t.length <= limit ? t : t.slice(0, limit) + "…";
}

/** question からランの紐付けマーカーを外す（人間向け・再実行プロンプト向けの表示用） */
function stripRunMarker(text: string): string {
  return text.replace(/\s*\[ラン [^\]]+\]/g, "").trim();
}

/**
 * ノード自身のスレッドから、再実行プロンプトに差し込む経緯を組み立てる（純粋関数）。
 * - AIの質問（id "ai:*" の選択肢を持つ decision_request）で回答済みのもの → 直近3件の
 *   Q&A（選択肢のラベル + 自由記入 note）
 * - 末尾が実行失敗の status → 失敗理由（自動リトライ・failure recovery の再実行で
 *   同じやり方を繰り返さないための文脈）
 */
export function buildThreadContextLines(messages: Message[]): string[] {
  const lines: string[] = [];

  const answered = messages.filter(
    (m) =>
      m.kind === "decision_request" &&
      m.requestStatus === "answered" &&
      ((m.payload as { request?: DecisionRequest } | null)?.request?.options ?? []).some((o) =>
        o.id.startsWith("ai:"),
      ),
  );
  for (const req of answered.slice(-3)) {
    const request = (req.payload as { request: DecisionRequest }).request;
    const answer = messages.find(
      (m) =>
        m.kind === "decision_answer" && (m.payload as DecisionAnswer | null)?.requestId === req.id,
    );
    if (!answer) continue;
    const payload = answer.payload as DecisionAnswer;
    const label = request.options.find((o) => o.id === payload.option)?.label ?? null;
    const parts = [label, payload.note].filter(Boolean);
    if (parts.length === 0) continue;
    lines.push(
      `あなたは人間に質問しました:「${stripRunMarker(request.question)}」→ 人間の回答: ${parts.join(" / ")}`,
    );
  }

  const lastStatus = [...messages].reverse().find((m) => m.kind === "status");
  if (lastStatus?.body.startsWith("実行失敗")) {
    lines.push(`直前の試行は失敗しています（${truncate(lastStatus.body, 200)}）。原因を踏まえてやり方を変えてください。`);
  }

  return lines;
}
