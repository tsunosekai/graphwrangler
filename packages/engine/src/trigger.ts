// トリガーノード（kind=trigger）の発火判定。docs/design.md 3.4/3.8/3.9 が仕様の正。
// 「ルーティーンであること」はフロー先頭のトリガーノードから導出する。Rx の思想を借りる:
// トリガー = Observable のソース、ラン = イベントの伝搬。起動方式は executor 軸で一貫させる:
//   - script トリガー = cron的な定期実行（schedule文字列を発火判定に使う。
//     parseSchedule/shouldCreateScheduledRun で判定）
//   - ai トリガー     = schedule をチェック間隔として使い、間隔ごとにエンジンがAIへ
//     「今発火すべきか」を判定させる
//   - human トリガー  = 手動発火(POST /fire)のみ。エンジンは何もしない
// impact=irreversible のトリガーは「発火前承認」: 自動発火の直前に go/skip の承認カードを
// トリガーのスレッドへ開き、go 回答の1回だけ発火する（task の実行前承認と同型。手動▶は
// 人間が押すこと自体が承認なのでゲートを通らない）。
// ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
import { parseSchedule, shouldCreateScheduledRun } from "./schedule.js";
import type { DecisionAnswer, DecisionRequest, Message, Node } from "./types.js";

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

// ---- 発火前承認（impact=irreversible のトリガー。docs/design.md 3.8） ----

/** 発火前承認カードの question に埋め込むマーカー。トリガーのスレッドから
 *  ゲート状態を復元するのに使う（approval.ts の runGateMarker と同じ方式） */
export const FIRE_GATE_MARKER = "[発火前承認]";

/** 発火の許可を求める判断リクエスト（task の buildIrreversibleGateRequest の発火版） */
export function buildFireApprovalRequest(node: Pick<Node, "title" | "detail">): DecisionRequest {
  const detail = node.detail ? `\n補足: ${node.detail}` : "";
  return {
    context: `トリガー「${node.title}」の発火条件を満たしました。${detail}`,
    question: `発火していいですか？ ${FIRE_GATE_MARKER}`,
    options: [
      { id: "go", label: "発火して", then: "ランを1本開始する" },
      { id: "skip", label: "今回は見送る", then: "この回は発火しない（次の周期でまた確認する）" },
    ],
    impact: "irreversible",
    undo: null,
  };
}

export type FireGateState =
  | { status: "none" } // まだカードを開いていない
  | { status: "open" } // 開いているが未回答
  | { status: "answered"; option: string | null; ts: string };

/** トリガーのスレッドから発火前承認ゲートの状態を求める（純粋関数）。
 *  FIRE_GATE_MARKER を含む decision_request のうち最新のものを見る */
export function findFireGate(messages: Message[]): FireGateState {
  const req = [...messages]
    .reverse()
    .find((m) => m.kind === "decision_request" && m.body.includes(FIRE_GATE_MARKER));
  if (!req) return { status: "none" };
  if (req.requestStatus !== "answered") return { status: "open" };
  const answer = [...messages]
    .reverse()
    .find(
      (m) =>
        m.kind === "decision_answer" &&
        (m.payload as DecisionAnswer | null)?.requestId === req.id,
    );
  if (!answer) return { status: "open" };
  return { status: "answered", option: (answer.payload as DecisionAnswer).option ?? null, ts: answer.ts };
}

/**
 * 発火判定の基準となる「最後の発火相当」（純粋関数）。最新ランと skip 回答の新しい方を返す。
 * skip をその回の発火とみなすことで、見送り直後に毎 tick 承認カードが再発行されるのを防ぐ
 * （every 系は skip から間隔経過後、daily/weekly は次の暦日/週まで黙る）。
 */
export function fireBaseline(
  latestRun: { created: string } | null,
  gate: FireGateState,
): { created: string } | null {
  const skipTs = gate.status === "answered" && gate.option === "skip" ? gate.ts : null;
  if (latestRun && skipTs) return { created: latestRun.created > skipTs ? latestRun.created : skipTs };
  if (skipTs) return { created: skipTs };
  return latestRun;
}

/** go 回答が「未消費」（最新ランより新しい）か（純粋関数）。発火すると run.created が
 *  回答より新しくなるため自動的に消費済みになる = 次の周期では改めて承認を求める
 *  （task の不可逆ゲートと同じ「毎回確認する」原則） */
export function hasUnconsumedGo(
  gate: FireGateState,
  latestRun: { created: string } | null,
): boolean {
  if (gate.status !== "answered" || gate.option !== "go") return false;
  return !latestRun || gate.ts > latestRun.created;
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
