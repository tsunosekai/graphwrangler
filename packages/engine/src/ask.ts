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
import { runGateMarker } from "./approval.js";
import type { Autonomy, DecisionAnswer, DecisionRequest, Message, Node } from "./types.js";

/** autonomy=high の実行失敗を人間に渡す前に自動で試し直す回数 */
export const MAX_AUTO_RETRIES = 2;

/** ランアイテムの「AIが質問中」note の接頭辞（approval.ts の APPROVAL_WAITING_NOTE と同じ役割） */
export const AI_QUESTION_WAITING_NOTE = "AI質問待ち";

function truncate(text: string, limit: number): string {
  const t = text.trim();
  return t.length <= limit ? t : t.slice(0, limit) + "…";
}

export interface AiQuestion {
  question: string;
  /** AIが提示した選択肢（0〜3個に切り詰めて使う。無ければ「おまかせで続行」を補う） */
  options: string[];
  /** 質問の下に書かれた判断材料の補足（無ければ空文字） */
  context: string;
}

/**
 * AI出力が QUESTION プロトコルか判定する。1行目が `QUESTION: 質問文`（全角コロン可、
 * 大文字小文字不問）なら質問とみなし、続く `OPTION: 選択肢` 行と残りの補足を取り出す。
 * それ以外の出力は null（=通常の作業成果）。
 */
export function parseAiQuestion(output: string): AiQuestion | null {
  const lines = output.trim().split(/\r?\n/);
  const first = lines[0]?.match(/^QUESTION[:：]\s*(.+)$/i);
  if (!first) return null;
  const options: string[] = [];
  const rest: string[] = [];
  for (const line of lines.slice(1)) {
    const opt = line.match(/^OPTION[:：]\s*(.+)$/i);
    if (opt) options.push(opt[1].trim());
    else rest.push(line);
  }
  return { question: first[1].trim(), options, context: rest.join("\n").trim() };
}

/**
 * AIの質問を人間向けの判断リクエストへ変換する。AI提示の選択肢は id "ai:1".. で並べ
 * （無ければ「おまかせで続行」）、末尾に必ず「中止」(id "abort") を付ける——abort は
 * pick.ts の selectAction / ラン側の質問tickが drop として解釈する予約id。
 * それ以外の回答（ai:* や自由文）は「回答を踏まえて再実行」になる。
 * runId を渡すと question にランの紐付けマーカーを埋め込む（approval.ts と同じ方式）。
 */
export function buildAiQuestionRequest(node: Node, q: AiQuestion, runId?: string): DecisionRequest {
  const aiOptions =
    q.options.length > 0
      ? q.options.slice(0, 3).map((label, i) => ({
          id: `ai:${i + 1}`,
          label: truncate(label, 80),
          then: "この方針でAIが作業を続ける",
        }))
      : [
          {
            id: "ai:proceed",
            label: "おまかせで続行",
            then: "AIが自分の判断で決めて作業を続ける",
          },
        ];
  const contextLines = [`AIが「${node.title}」の作業中に人間の判断を求めています。`];
  if (q.context) contextLines.push(truncate(q.context, 300));
  return {
    context: contextLines.join("\n"),
    question: runId ? `${q.question} ${runGateMarker(runId)}` : q.question,
    options: [
      ...aiOptions,
      {
        id: "abort",
        label: "中止",
        then: runId ? "このランではこのアイテムを中止する" : "このタスクを中止(dropped)にする",
      },
    ],
    impact: "safe",
    undo: null,
  };
}

/** 実行失敗を人間に渡さず自動で試し直すか（autonomy=high のみ、MAX_AUTO_RETRIES まで） */
export function shouldAutoRetry(autonomy: Autonomy, retriesSoFar: number): boolean {
  return autonomy === "high" && retriesSoFar < MAX_AUTO_RETRIES;
}

/** QUESTION プロトコルの説明（normal/low のプロンプトに入れる。high には入れない） */
const QUESTION_PROTOCOL_LINES = [
  "人間の判断が必要になったときは、作業を進めずに次の形式**だけ**を出力して終了してください:",
  "QUESTION: <人間への質問（1行）>",
  "OPTION: <選択肢>（任意。1行1個で最大3個。選んでほしい方針があるときに）",
  "（以降の行は判断材料の補足として自由に書いてよい）",
];

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
