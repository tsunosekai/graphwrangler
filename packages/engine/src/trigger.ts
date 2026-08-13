// トリガーノード（kind=trigger）のラン作成判定。docs/design.md 3.4/3.8/3.9 が仕様の正。
// 「ルーティーンであること」はフロー先頭のトリガーノードから導出する。Rx の思想を借りる:
// トリガー = Observable のソース、ラン = イベントの伝搬。起動方式は executor 軸で一貫させる:
//   - script トリガー = cron的な定期実行（schedule文字列をラン作成の判定に使う。
//     parseSchedule/shouldCreateScheduledRun で判定）
//   - ai トリガー     = schedule をチェック間隔として使い、間隔ごとにエンジンがAIへ
//     「今ランを作るべきか」を判定させる
//   - human トリガー  = 手動でランを作る(POST /run)のみ。エンジンは何もしない
// approval=true のトリガーは「ラン前承認」: 自動でランを作る直前に go/skip の承認カードを
// トリガーのスレッドへ開き、go 回答の1回だけランを作る（task の実行前承認と同型。手動▶は
// 人間が押すこと自体が承認なのでゲートを通らない）。
// script トリガーに impl.command があれば「検知スクリプト」（2026-08-09。docs/design.md 3.15）:
// schedule をチェック間隔とし、間隔ごとにエンジンが command を実行して、stdout の JSON 行
// {"context":{...},"title":"..."} を emit された数だけランを作る（1行=1ラン。空出力=ラン作成なし）。
// ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
import { SCHEDULE_SET_MARKER } from "@graphwrangler/core";
import { coerceStringRecord } from "./context.js";
import { parseSchedule, shouldCreateScheduledRun } from "./schedule.js";
import type { DecisionAnswer, DecisionRequest, Message, Node } from "./types.js";

/** ai トリガー・検知スクリプトのチェック間隔が未指定/未対応の書式のときの既定値（1時間） */
export const DEFAULT_AI_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** kind=trigger かつ lifecycle=committed のノードだけがエンジンの対象
 *  （3.4「committedのみ自動実行」の原則。draft のトリガーはエンジンが無視する） */
export function isRunnableTrigger(node: Node): boolean {
  return node.kind === "trigger" && node.lifecycle === "committed";
}

/** 終いにしたページ（完了/中止 = アーカイブ節）か。
 *  ここに来たページのトリガーはランを作らせない（2026-08-09 本人報告の不具合）。
 *  それまでは所属ページの状態を一切見ていなかったので、「もう終わり」と完了にした
 *  ルーティーンが裏で回り続けていた。人が終いにした宣言（status）を自動実行の
 *  停止条件として扱う——止め方が「トリガーを消す/draftへ戻す」しか無いのは、
 *  完了という操作が用意されている以上おかしい。
 *  ページが取得できないとき（group 無し等）は false ＝従来どおりランを作らせる */
export function isClosedPage(page: Node | null | undefined): boolean {
  return !!page && (page.status === "done" || page.status === "dropped");
}

/**
 * ページのラン一覧から**そのトリガーが作った**ランだけを取り出す（純粋関数）。
 *
 * 2026-08-14 の修正。それまでエンジンはラン作成の判定にページのラン一覧の先頭
 * （＝そのページで最後に作られたラン）を使っていた。ページに複数のトリガーがあると、
 * 別のトリガーが作ったランを「自分の回はもう作った」と誤認して黙る——
 * 本人報告のページ（毎日21:00 / 毎日23:00 / 毎週金13:30 が同居）では、daily の判定が
 * 「最新ランが今日か」だけを見るため **21:00 のランが 23:00 の回を潰し、23:00 は永久に
 * 作られない**（逆向きは通るので、遅い時刻のトリガーだけが構造的に出ない）。
 * ランは作成時に出所を run.trigger = "trigger:<triggerId>:<via>" として持っているので、
 * 判定に渡す一覧をここで絞る。手動▶のラン（via=manual）も同じトリガーのものは残す
 * （「手で走らせたのでこの回は済み」は従来どおりの意図した挙動）。
 */
export function runsOfTrigger<T extends { trigger: string }>(runs: T[], triggerId: string): T[] {
  const prefix = `trigger:${triggerId}:`;
  return runs.filter((r) => r.trigger.startsWith(prefix));
}

/**
 * script トリガーのラン作成判定。schedule が無い/未対応の書式は null を返す
 * （呼び出し側で警告ログを出す）。
 */
export function shouldRunScriptTrigger(
  scheduleText: string | null,
  latestRun: { created: string } | null,
  now: Date,
): boolean | null {
  if (!scheduleText) return null;
  const schedule = parseSchedule(scheduleText);
  if (!schedule) return null;
  return shouldCreateScheduledRun(schedule, latestRun, now);
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

// ---- schedule を解釈できないトリガーの可視化（2026-08-11） ----
// shouldRunScriptTrigger が null（schedule 無し/未対応の書式）のとき、それまではエンジンの
// 警告ログに毎tick流れるだけだった——UI からは「このルーティーンは永久に動かない」ことが
// 分からず、黙って止まっているのと区別がつかない。トリガーのスレッドへ status を1回だけ
// 積んで人の目に入れる（毎tick積まない判定は hasScheduleWarning が担う）。

/** schedule を解決できないことを知らせる status の目印。スレッドから同じ警告を
 *  見つけ直すのに使う（RUN_GATE_MARKER と同じ「本文にマーカーを埋める」方式） */
export const SCHEDULE_WARNING_MARKER = "[schedule未解決]";

/** 上の警告の本文（純粋関数）。schedule 原文を本文へ含めるので、書き直しても解釈できない
 *  ままなら本文が変わり、新しい警告として改めて1回だけ積まれる */
export function buildScheduleWarningBody(scheduleText: string | null): string {
  const cause = scheduleText
    ? `schedule "${scheduleText}" を解釈できません`
    : "schedule が設定されていません";
  return (
    `${SCHEDULE_WARNING_MARKER} ${cause}。このトリガーはランを作りません` +
    "（対応する書式: every 15m|2h|3d|2w / daily 09:00 / weekday 09:00 / " +
    "weekly mon,wed,fri 09:00 / " +
    "biweekly mon 09:00 / monthly day 25 09:00 / monthly lastday 18:00 / monthly 2 tue 09:00 / " +
    "monthly last fri 17:30 / yearly day 4 1 09:00 / yearly lastday 3 18:00 / " +
    "yearly 4 2 tue 09:00 / once 2026-09-01 09:00 / cron 5フィールド）"
  );
}

/** 同じ警告を既にトリガーのスレッドへ積んでいるか（純粋関数）。最新の schedule 警告と
 *  本文が一致していれば黙る＝毎tick積まない */
export function hasScheduleWarning(messages: Message[], body: string): boolean {
  const latest = [...messages]
    .reverse()
    .find((m) => m.kind === "status" && m.body.includes(SCHEDULE_WARNING_MARKER));
  return latest?.body === body;
}

// ---- 検知スクリプト（impl.command のある script トリガー。docs/design.md 3.8/3.15） ----

/** script トリガーのうち「検知スクリプト」（impl.command あり）か。無条件 cron のラン作成
 *  （従来の script トリガー）との分岐に使う */
export function isDetectScriptTrigger(node: Pick<Node, "executor" | "impl">): boolean {
  return node.executor === "script" && node.impl?.type === "script";
}

/**
 * 検知スクリプトを今回実行すべきか（純粋関数）。schedule は「チェック間隔」として扱う:
 * - every 系: その間隔（ai トリガーと同じ in-memory lastCheckedAt 方式）
 * - daily/weekly/cron: shouldCreateScheduledRun を lastCheckedAt 基準で流用
 *   （「最新ラン」の代わりに「最後にチェックした時刻」を渡す。ラン作成の有無はスクリプトの
 *   emit が決めるので、ランの有無をここで見ない）
 * - 無指定/未対応の書式: 既定1時間
 * lastCheckedAt はエンジンのメモリ管理（プロセス再起動で即再チェックされるのは許容する）。
 */
export function shouldRunDetectScript(
  scheduleText: string | null,
  lastCheckedAt: number | null,
  now: Date,
): boolean {
  const schedule = scheduleText ? parseSchedule(scheduleText) : null;
  if (!schedule || schedule.type === "every") {
    const intervalMs = schedule?.type === "every" ? schedule.ms : DEFAULT_AI_CHECK_INTERVAL_MS;
    return shouldEvaluateAiTrigger(intervalMs, lastCheckedAt, now.getTime());
  }
  const baseline =
    lastCheckedAt === null ? null : { created: new Date(lastCheckedAt).toISOString() };
  return shouldCreateScheduledRun(schedule, baseline, now);
}

/** 検知スクリプトが emit した1イベント（= ラン1本の種）。3.8「payload 付きイベント」 */
export interface DetectEmitEvent {
  /** ランのコンテキストの初期値（3.15）。emit 行に context が無ければ {} */
  context: Record<string, string>;
  /** ラン名。無ければ null（サーバ既定の名前になる） */
  title: string | null;
}

export interface DetectEmitResult {
  events: DetectEmitEvent[];
  /** '{' で始まるのに JSON として解釈できなかった行（トリガーのスレッドへ失敗として記録する対象） */
  invalidLines: string[];
}

/** emit 行を1つのイベントへ緩く読む。context は string/number/boolean 値を文字列化して許す。
 *  形が違えば null（=不正行） */
function coerceEmitEvent(value: unknown): DetectEmitEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as { context?: unknown; title?: unknown };
  let context: Record<string, string> = {};
  if (obj.context !== undefined) {
    const coerced = coerceStringRecord(obj.context);
    if (!coerced) return null;
    context = coerced;
  }
  if (obj.title !== undefined && obj.title !== null && typeof obj.title !== "string") return null;
  return { context, title: typeof obj.title === "string" ? obj.title : null };
}

/**
 * 検知スクリプトの stdout から emit イベントを取り出す（純粋関数。docs/design.md 3.8）。
 * '{' で始まる各行を JSON の {"context":{...},"title":"..."} として読む（1行=1ラン）。
 * '{' 以外で始まる行はログとして無視する。'{' 始まりでパース不能・形が不正な行は
 * invalidLines に入れる（呼び出し側がトリガーのスレッドへ status で失敗記録する）。
 */
export function parseDetectEmitLines(output: string): DetectEmitResult {
  const events: DetectEmitEvent[] = [];
  const invalidLines: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalidLines.push(line);
      continue;
    }
    const event = coerceEmitEvent(parsed);
    if (!event) {
      invalidLines.push(line);
      continue;
    }
    events.push(event);
  }
  return { events, invalidLines };
}

/** イベントの人間向け1行要約（承認カードの文面・ログ用） */
export function describeRunEvent(event: DetectEmitEvent): string {
  const pairs = Object.entries(event.context)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  if (event.title && pairs) return `${event.title}（${pairs}）`;
  return event.title ?? (pairs || "(内容なし)");
}

/**
 * ai トリガーを今回評価すべきか。判定はチェック間隔だけで決まる
 * （2026-08-08: script トリガーと同じく「実行中ランがあれば評価しない」を撤廃した。
 * 前のランが人間の回答待ちで止まっている間、AI トリガーが永久に沈黙していたため）。
 * lastCheckedAt はエンジンのメモリ管理（プロセス再起動で即再チェックされるのは許容する）。
 */
export function shouldEvaluateAiTrigger(
  intervalMs: number,
  lastCheckedAt: number | null,
  now: number,
): boolean {
  if (lastCheckedAt === null) return true;
  return now - lastCheckedAt >= intervalMs;
}

/**
 * AIの判定出力を run/skip として解釈する（decision.ts の parseBranchChoice と同じ救済方針:
 * 前後に説明が付いていても行単位で拾う）。
 * どちらとも判定できなければ null（呼び出し側は「出力が不正」として扱い、ランを作らない）。
 * 判定は保守的に倒す制約がある——ラン作成は副作用のある側なので:
 * - run は**行全体の完全一致のみ**受ける（「今回は run しない」のような文中の
 *   run でランを作らない）
 * - skip は文中の単語一致でも受ける（見送りの過剰検出は安全）
 * - 両方が現れる混在出力は skip 側に倒す
 */
export function parseAiRunDecision(output: string): "run" | "skip" | null {
  const trimmed = output.trim().toLowerCase();
  const lines = trimmed.split("\n").map((l) => l.trim());
  if (lines.some((l) => l === "skip")) return "skip";
  if (lines.some((l) => l === "run")) return "run";
  if (/\bskip\b/.test(trimmed)) return "skip";
  return null;
}

// ---- ラン前承認（approval=true のトリガー。docs/design.md 3.8） ----

/** ラン前承認カードの question に埋め込むマーカー。トリガーのスレッドから
 *  ゲート状態を復元するのに使う（approval.ts の runGateMarker と同じ方式） */
export const RUN_GATE_MARKER = "[ラン前承認]";

/** ラン作成の許可を求める判断リクエスト（task の buildIrreversibleGateRequest のラン版）。
 *  event（検知スクリプトの emit / ai トリガーの ##gw 由来）があれば人間向けの内容を文面へ足す。
 *  機械可読な {context, title} 本体は、カードを開く直前に payload.runEvent 付きの status として
 *  トリガーのスレッドへ積んでおき（tickTrigger.ts）、go 回答時に findLatestRunEvent で復元する
 *  （DecisionRequest スキーマは固定形でスキーマ外フィールドを持てないため、保持はメッセージ
 *  payload 側が担う） */
export function buildRunApprovalRequest(
  node: Pick<Node, "title" | "detail">,
  event?: DetectEmitEvent | null,
): DecisionRequest {
  const detail = node.detail ? `\n補足: ${node.detail}` : "";
  const eventLine = event ? `\n検知イベント: ${describeRunEvent(event)}` : "";
  return {
    context: `トリガー「${node.title}」の開始条件を満たしました。${detail}${eventLine}`,
    question: `開始していいですか？ ${RUN_GATE_MARKER}`,
    options: [
      { id: "go", label: "開始して", then: "ランを1本開始する" },
      { id: "skip", label: "今回は見送る", then: "この回は開始しない（次の周期でまた確認する）" },
    ],
    impact: "irreversible",
    undo: null,
  };
}

/** メッセージ payload から検知イベント本体（payload.runEvent）を取り出す */
function readRunEventPayload(payload: unknown): unknown {
  return (payload as { runEvent?: unknown } | null)?.runEvent ?? null;
}

/**
 * トリガーのスレッドから、ラン前承認カードに対応する検知イベント（payload.runEvent）を
 * 復元する（純粋関数）。エンジンはカードを開く直前に status として積む（tickTrigger.ts の
 * 検知スクリプト / ai トリガー処理）。latestRun 以前の ts のものは前回のラン作成で消費済みと
 * みなして使わない（hasUnconsumedGo と同じ「ラン作成で消費」の流儀）。
 */
export function findLatestRunEvent(
  messages: Message[],
  latestRun: { created: string } | null,
): DetectEmitEvent | null {
  const m = [...messages]
    .reverse()
    .find((msg) => {
      if (!readRunEventPayload(msg.payload)) return false;
      if (latestRun && msg.ts <= latestRun.created) return false;
      return true;
    });
  if (!m) return null;
  return coerceEmitEvent(readRunEventPayload(m.payload));
}

export type RunGateState =
  | { status: "none" } // まだカードを開いていない
  | { status: "open" } // 開いているが未回答
  | { status: "answered"; option: string | null; ts: string };

/** トリガーのスレッドからラン前承認ゲートの状態を求める（純粋関数）。
 *  RUN_GATE_MARKER を含む decision_request のうち最新のものを見る */
export function findRunGate(messages: Message[]): RunGateState {
  const req = [...messages]
    .reverse()
    .find((m) => m.kind === "decision_request" && m.body.includes(RUN_GATE_MARKER));
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
 * ラン作成の基準となる「最後のラン作成相当」（純粋関数）。最新ランと skip 回答の新しい方を返す。
 * skip をその回のラン作成とみなすことで、見送り直後に毎 tick 承認カードが再発行されるのを防ぐ
 * （every 系は skip から間隔経過後、daily/weekly は次の暦日/週まで黙る）。
 */
export function runBaseline(
  latestRun: { created: string } | null,
  gate: RunGateState,
): { created: string } | null {
  const skipTs = gate.status === "answered" && gate.option === "skip" ? gate.ts : null;
  if (latestRun && skipTs) return { created: latestRun.created > skipTs ? latestRun.created : skipTs };
  if (skipTs) return { created: skipTs };
  return latestRun;
}

// ---- 起動方式の設定・変更直後の追い付き実行の抑止（2026-08-12 本人報告
// 「トリガーを変更した瞬間に実行される不具合があるかも」） ----
// server が schedule の設定・変更・committed 化のたびにスレッドへ積む [起動方式] status
// （core の SCHEDULE_SET_MARKER / buildScheduleSetBody）の時刻を「その回は済んだ」の基準に
// 混ぜる。これが無いと、設定した瞬間に「直近の過ぎた定刻」の追い付きランが即座に走る
// （every は必ず・daily/weekly/monthly/yearly も定刻を過ぎていれば）。
// 判定は基準が新しくなるほど false に倒れる（単調）ので、呼び出し側は粗い判定が true の
// ときだけスレッドを取得して混ぜ直せばよい（定常状態では追加の取得なし）

/** スレッドから最新の [起動方式] 記録の時刻を返す（無ければ null。純粋関数） */
export function latestScheduleSetAt(messages: Message[]): string | null {
  const m = [...messages]
    .reverse()
    .find((x) => x.kind === "status" && x.body.startsWith(SCHEDULE_SET_MARKER));
  return m?.ts ?? null;
}

/** baseline（最新ラン/skip回答）と [起動方式] 記録の新しい方を基準にする（純粋関数） */
export function mergeScheduleSetBaseline(
  baseline: { created: string } | null,
  scheduleSetAt: string | null,
): { created: string } | null {
  if (!scheduleSetAt) return baseline;
  if (!baseline || baseline.created < scheduleSetAt) return { created: scheduleSetAt };
  return baseline;
}

/** go 回答が「未消費」（最新ランより新しい）か（純粋関数）。ランを作ると run.created が
 *  回答より新しくなるため自動的に消費済みになる = 次の周期では改めて承認を求める
 *  （task の不可逆ゲートと同じ「毎回確認する」原則） */
export function hasUnconsumedGo(
  gate: RunGateState,
  latestRun: { created: string } | null,
): boolean {
  if (gate.status !== "answered" || gate.option !== "go") return false;
  return !latestRun || gate.ts > latestRun.created;
}

/**
 * ai トリガー向けのプロンプトを組み立てる（純粋関数）。ランを作る条件は title/detail/impl(doc全文)
 * に書かれている想定（docs/design.md「条件は detail / impl(doc) に書かれている」）。
 * outputs 宣言があれば、run 時に ##gw マーカーで context も出せることを指示する（3.15。
 * run 行 + マーカー行の形。マーカーは tickTrigger.ts が extractGwMarkers で取り出してラン作成へ渡す）。
 */
export function buildTriggerPrompt(
  node: Pick<Node, "title" | "detail" | "impl" | "outputs">,
  now: Date,
): string {
  const lines: string[] = [
    "あなたは GraphWrangler（タスクグラフをAIと人間で分担するツール）のトリガー判定者です。",
    `トリガー: ${node.title}`,
  ];
  if (node.detail) lines.push(`補足: ${node.detail}`);
  if (node.impl && node.impl.type === "doc" && node.impl.text) {
    lines.push("", "ランを作る条件（手順書）:", node.impl.text);
  }
  lines.push("", `現在時刻: ${now.toISOString()}`);
  lines.push(
    "",
    "ランを作るべきなら run、見送るなら skip のみを1行で出力してください（他の文字・説明は含めないこと）。",
  );
  if (node.outputs && node.outputs.length > 0) {
    lines.push(
      "ランを作る場合は、run の行に続けて次のキーを"
        + ' ##gw {"set":{"キー":"値"}} 形式の行（1行1個。行全体がこの形）で出力できます'
        + "（開始されるランのコンテキスト初期値になります）:",
      ...node.outputs.map(
        (o) =>
          `- ${o.name}${o.label ? `（${o.label}）` : ""}${o.example ? ` 例: ${o.example}` : ""}`,
      ),
    );
  }
  return lines.join("\n");
}
