// 振り返り（docs/design.md 3.25。2026-11-27 本人要望「ランの結果から手順書を直す仕組みを作って」）。
//
// ランどうしは会話を共有しない（threadContext.ts: あるランは別のランの会話を見ない）ので、
// 次のランへ引き継がれるのはテンプレート（各ノードの手順書・補足）だけ。ところが、ランの中で
// 起きた学び（人の苦情・訂正、AI の「手順と実際が違う」、失敗、意味のない待ち、AI が聞かないと
// 進めなかった質問）を手順へ戻す仕組みが無く、毎回同じことが起きていた。
//
// そこで、ランが終わったら AI がそのランを読み返し、手順の直し方を「案」として出す。人は
// 「反映する／反映しない」を1回選ぶだけで、反映はエンジンが行う。
//
// 流れ（すべてページノードの、そのランの会話の上で起きる）:
//   1. ランの終わり（running → done / cancelled）を周ごとの差分で拾う（前準備の
//      selectProjectPrep と同じ流儀。機能を入れた瞬間に過去のランを全部振り返らない）。
//      手動の依頼（run.retroRequest）も受ける
//   2. AI を呼ぶ（1周に1件。実行AIと同じ設定・全ツール。読むだけ）
//   3. 直す案が無ければ status「直すところはありませんでした」で終わり。あれば say で案を出し、
//      判断カード（反映する／反映しない）を開く
//   4. 回答を見て、反映するなら、案を作ったときの文面から変わっていないノードだけ書き換える
//   5. 結果を status で残す（これが「済み」の印。再起動しても繰り返さない）
//
// 印は payload.retro=true（+ runId・state）。state: none / failed / proposed / applied / rejected。
// proposed 以外は「この回の振り返りは終わった」を表す。
//
// プロンプト・解析・検証・判定は純粋関数（vitest の対象）、配線は下の tickRetro に置く。
import { createHash } from "node:crypto";
import { TOOL_PERMISSION_LINES, runIdOf } from "@graphwrangler/core";
import {
  ApiError,
  getRun,
  getThread,
  listAllRuns,
  openRequest,
  patchNode,
  postMessage,
  setRunRetroRequest,
} from "./api.js";
import { ENGINE_ACTOR, VIA } from "./actor.js";
import { aiExecutorName, runAiExecutor } from "./executor.js";
import { truncate, withSubSteps } from "./format.js";
import { log } from "./log.js";
import type { Actor, DecisionAnswer, DecisionRequest, Message, Node, NodePatch, Run } from "./types.js";

// ---- 定数 ----

/** 記録1件あたりの本文の上限（プロンプトに入れるとき） */
export const RETRO_BODY_LIMIT = 1500;
/** 記録全体の上限（プロンプトに入れるとき）。超えたぶんは優先度の低いものから落とす */
export const RETRO_TRACE_LIMIT = 40_000;
/** 案の本文（newText）の上限。手順を長くしすぎないための歯止め */
export const RETRO_NEW_TEXT_LIMIT = 8000;
/** 起動時に「返事待ちの案」を探しに行くランの古さの上限 */
export const RETRO_SCAN_DAYS = 60;

export const RETRO_OPTION_APPLY = "apply";
export const RETRO_OPTION_REJECT = "reject";

export type RetroField = "impl.text" | "detail";
export type RetroState = "none" | "failed" | "proposed" | "applied" | "rejected";

/** 判断カードの question に埋め込むラン紐付けの目印（承認ゲートの [ラン <id>] と同じ考え方。
 *  ページノードには別の用件のカードも来うるので、振り返り専用の目印にする） */
export function retroMarker(runId: string): string {
  return `[振り返り ${runId}]`;
}

// ---- 直せる欄 ----

/**
 * このノードで振り返りが直してよい欄（純粋関数）。1ノード1欄:
 * - ロック中（fixed）は直さない（やり方が確定済み。サーバも 409 で拒む）
 * - 手順書（impl=doc）がファイルにある（path だけ）なら、ファイルは直さず補足（detail）
 * - 手順書（impl=doc）が文面で持たれていれば impl.text
 * - スクリプト（impl=script）はコマンドを直さず補足（detail）
 * - 実装が無ければ補足（detail）
 */
export function editableField(node: Node): RetroField | null {
  if (node.fixed) return null;
  if (node.impl?.type === "doc" && !(node.impl.path && !node.impl.text)) return "impl.text";
  return "detail";
}

/** その欄のいまの文面（無ければ空文字） */
export function fieldText(node: Node, field: RetroField): string {
  if (field === "impl.text") return node.impl?.type === "doc" ? (node.impl.text ?? "") : "";
  return node.detail ?? "";
}

/** 文面の指紋（案を作ったときから書き換わっていないかの照合用） */
export function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** 書き換えの patch を作る。impl.text は他の impl のフィールド（path 等）を残す */
export function buildFieldPatch(node: Node, field: RetroField, newText: string): NodePatch {
  if (field === "impl.text") {
    const base = node.impl?.type === "doc" ? node.impl : { type: "doc" as const };
    return { impl: { ...base, type: "doc", text: newText } };
  }
  return { detail: newText };
}

// ---- ランの終わりを拾う ----

/** 前に見たとき以降に作られたかを判定するときの、時計のずれの見込み */
export const RETRO_CLOCK_SLACK_MS = 5 * 60 * 1000;

/**
 * 前に見たときのランの状態と比べて、終わったランを返す（純粋関数）。終わった＝
 * - 前は running で、いまは done / cancelled
 * - 前に見たときには無かった（＝その後に作られた）のに、もう終わっている。振り返りの周は
 *   手前の層が仕事をした周には回らないので、AI だけで流れる短いランは一度も running の姿を
 *   見せずに終わりうる。作成時刻が前に見た時刻より後のものに限る（git の取り込み等で
 *   古いランがまとめて現れたときに、一斉に振り返らないため）
 * prev=null（起動直後の1周目）は覚えるだけ——機能を入れた瞬間・再起動のたびに、過去に
 * 終わったランを全部振り返らないため。
 */
export function detectRunEndings(
  prev: { statuses: Map<string, string>; at: number } | null,
  runs: Array<Pick<Run, "id" | "status" | "created">>,
  now: number,
): { ended: string[]; seen: { statuses: Map<string, string>; at: number } } {
  const seen = { statuses: new Map(runs.map((r) => [r.id, r.status])), at: now };
  if (prev === null) return { ended: [], seen };
  const ended = runs
    .filter((r) => {
      if (r.status === "running") return false;
      const before = prev.statuses.get(r.id);
      if (before !== undefined) return before === "running";
      const created = Date.parse(r.created);
      return !Number.isNaN(created) && created >= prev.at - RETRO_CLOCK_SLACK_MS;
    })
    .map((r) => r.id);
  return { ended, seen };
}

/**
 * この周に振り返るランを1つ選ぶ（純粋関数）。手動の依頼（retroRequest）が最優先（古い順）。
 * 無ければ、終わりを拾った待ち行列の先頭。行列は「もう無いラン」を捨てて返す。
 */
export function pickRetroTarget(
  runs: Run[],
  queue: string[],
): { run: Run; manual: boolean; queue: string[] } | null {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const requested = runs
    .filter((r) => r.retroRequest === true && r.status !== "running")
    .sort((a, b) => a.created.localeCompare(b.created))[0];
  const rest = queue.filter((id) => byId.has(id));
  if (requested) return { run: requested, manual: true, queue: rest.filter((id) => id !== requested.id) };
  const nextId = rest[0];
  if (!nextId) return null;
  return { run: byId.get(nextId) as Run, manual: false, queue: rest.slice(1) };
}

// ---- 振り返りの印（ページノードのそのランの会話） ----

export interface RetroChange {
  nodeId: string;
  /** 案を作ったときのノード名（本文・結果の表示用） */
  title: string;
  field: RetroField;
  reason: string;
  what: string;
  newText: string;
  /** 案を作ったときの文面と指紋。反映時に書き換わっていないかを照合する */
  oldText: string;
  oldHash: string;
}

export interface RetroProposal {
  retro: true;
  runId: string;
  state: "proposed";
  summary: string;
  changes: RetroChange[];
  /** 案を出したときのページの status。カードへの回答でサーバがページを pending へ戻すので、
   *  アーカイブ済みのページを振り返ったときに元へ戻すために覚えておく */
  pageStatus: string;
}

function retroPayloadOf(m: Message, runId: string): { state: RetroState } | null {
  const p = m.payload as { retro?: unknown; runId?: unknown; state?: unknown } | null;
  if (!p || p.retro !== true || p.runId !== runId || typeof p.state !== "string") return null;
  return p as { state: RetroState };
}

export type RetroPhase =
  | { phase: "none" } // まだ振り返っていない
  | { phase: "final"; state: RetroState } // 振り返りは終わっている
  | {
      phase: "proposed";
      proposal: RetroProposal;
      /** 案のカード。null = まだ開けていない（ページに別のカードが開いていた等） */
      request: null | { id: string; status: "open" } | { id: string; status: "answered"; option: string | null };
    };

/**
 * ページノードのスレッド（そのランのスコープ）から、そのランの振り返りがどこまで進んだかを
 * 求める（純粋関数）。最後の印が正——手動でやり直したら、新しい印が前の結果を上書きする。
 */
export function deriveRetroPhase(messages: Message[], runId: string): RetroPhase {
  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (retroPayloadOf(messages[i], runId)) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) return { phase: "none" };
  const last = messages[lastIdx];
  const { state } = retroPayloadOf(last, runId) as { state: RetroState };
  if (state !== "proposed") return { phase: "final", state };
  const proposal = last.payload as RetroProposal;
  const marker = retroMarker(runId);
  const req = messages.slice(lastIdx + 1).find((m) => m.kind === "decision_request" && m.body.includes(marker));
  if (!req) return { phase: "proposed", proposal, request: null };
  if (req.requestStatus !== "answered") return { phase: "proposed", proposal, request: { id: req.id, status: "open" } };
  const answer = messages.find(
    (m) => m.kind === "decision_answer" && (m.payload as DecisionAnswer | null)?.requestId === req.id,
  );
  const option = answer ? ((answer.payload as DecisionAnswer).option ?? null) : null;
  return { phase: "proposed", proposal, request: { id: req.id, status: "answered", option } };
}

// ---- 記録（トレース）をプロンプト用に詰める ----

export interface TraceEntry {
  ts: string;
  nodeTitle: string;
  author: Actor;
  kind: Message["kind"];
  body: string;
  payload: unknown;
}

const KIND_LABEL: Record<string, string> = {
  say: "発言",
  decision_request: "質問カード",
  decision_answer: "回答",
  status: "記録",
  artifact: "成果物",
};

function authorLabel(a: Actor): string {
  if (a.kind === "human") return a.name ? `人（${a.name}）` : "人";
  if (a.kind === "agent") return "AI";
  return "システム";
}

/** 残す優先度（小さいほど残す）: 人の発言・質問と回答 > 失敗 > AI の発言 > その他の記録 */
export function tracePriority(e: TraceEntry): number {
  if (e.author.kind === "human" || e.kind === "decision_request" || e.kind === "decision_answer") return 0;
  if (e.kind === "status" && e.body.includes("失敗")) return 1;
  if (e.kind === "say" || e.kind === "artifact") return 2;
  return 3;
}

function shortTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatTraceEntry(e: TraceEntry): string {
  let body = truncate(e.body, RETRO_BODY_LIMIT);
  if (e.kind === "decision_answer") {
    const option = (e.payload as DecisionAnswer | null)?.option ?? null;
    body = `${option ? `「${option}」を選択` : "選ばずに返事"}${body ? `: ${body}` : ""}`;
  }
  return `- [${shortTime(e.ts)}] ${e.nodeTitle} / ${authorLabel(e.author)}の${KIND_LABEL[e.kind] ?? e.kind}: ${body || "（本文なし）"}`;
}

/**
 * 記録を時刻順の行にする（純粋関数）。全体が limit を超えるときは優先度の低いもの
 * （同じ優先度なら新しいもの）から落とし、落とした件数を返す。並びは時刻順のまま。
 */
export function selectTraceLines(
  entries: TraceEntry[],
  limit = RETRO_TRACE_LIMIT,
): { lines: string[]; omitted: number } {
  const sorted = [...entries].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const formatted = sorted.map((e, i) => ({ i, line: formatTraceEntry(e), pri: tracePriority(e) }));
  const order = [...formatted].sort((a, b) => a.pri - b.pri || a.i - b.i);
  const keep = new Set<number>();
  let used = 0;
  for (const f of order) {
    const cost = f.line.length + 1;
    if (used + cost > limit) continue;
    used += cost;
    keep.add(f.i);
  }
  return {
    lines: formatted.filter((f) => keep.has(f.i)).map((f) => f.line),
    omitted: formatted.length - keep.size,
  };
}

// ---- プロンプト ----

export interface RetroPromptInput {
  goal: Node;
  /** ページのテンプレートノード（ページ自身は含めない） */
  members: Node[];
  run: Pick<Run, "id" | "title" | "status" | "items" | "context"> & { snapshot?: Run["snapshot"] };
  traceLines: string[];
  omitted: number;
}

const ITEM_STATUS_LABEL: Record<string, string> = {
  pending: "未着手のまま",
  running: "実行中のまま",
  waiting: "人の番のまま",
  done: "完了",
  dropped: "中止",
  skipped: "飛ばした",
};

type SnapNode = NonNullable<Run["snapshot"]>["nodes"][number];

/** ランの時点の手順と今の手順が違うか（手順に効く項目だけを比べる） */
export function changedSinceRun(now: Node, then: SnapNode): boolean {
  const pick = (n: Pick<Node, "kind" | "detail" | "impl" | "parents" | "wait" | "branches" | "parentOptions">) =>
    JSON.stringify([n.kind, n.detail ?? null, n.impl ?? null, [...n.parents].sort(), n.wait ?? null, n.branches ?? null, n.parentOptions ?? {}]);
  return pick(now) !== pick(then);
}

/** 当時の手順の要約（今と違うノードだけに付ける）。長い手順書は頭だけ */
function thenBlock(then: SnapNode): string[] {
  const lines = [`- **このランの時点の手順は今と違う**（ランの後に直されている）。ランの時点では: 種類 ${then.kind}`];
  if (then.detail?.trim()) lines.push(`  - 補足: ${truncate(then.detail.trim(), 800)}`);
  if (then.impl?.type === "doc" && then.impl.text) lines.push(`  - 手順書: ${truncate(then.impl.text.trim(), 1500)}`);
  if (then.impl?.type === "script") lines.push(`  - スクリプト: ${then.impl.command}`);
  if (then.wait) lines.push(`  - 待ち方: ${then.wait}`);
  if (then.branches) lines.push(`  - 分岐: ${then.branches.map((b) => `${b.id}=${b.label}`).join(" / ")}`);
  return lines;
}

function memberBlock(n: Node, run: RetroPromptInput["run"]): string[] {
  const field = editableField(n);
  const lines = [`### ${n.id}「${n.title}」`];
  lines.push(`- 種類: ${n.kind} / 担当: ${n.executor}${n.approval ? " / 実行前に承認あり" : ""}`);
  const item = run.items[n.id];
  if (item) {
    lines.push(`- このランでの結果: ${ITEM_STATUS_LABEL[item.status] ?? item.status}${item.note ? `（${item.note}）` : ""}`);
  }
  lines.push(
    `- 直せる欄: ${
      field === null ? "なし（ロック中）" : field === "impl.text" ? "impl.text（手順書）" : "detail（補足）"
    }`,
  );
  lines.push(`- 補足（detail）: ${n.detail?.trim() ? `\n${n.detail.trim()}` : "なし"}`);
  if (n.impl?.type === "doc") {
    if (n.impl.text) lines.push("- 手順書（impl.text）:", n.impl.text.trim());
    if (n.impl.path) {
      lines.push(
        `- 手順書のファイル: ${n.impl.path}` +
          (n.impl.text ? "" : "（このファイルは直さない。直すべきことがあれば summary に書く）"),
      );
    }
  } else if (n.impl?.type === "script") {
    lines.push(`- スクリプト（直さない）: ${n.impl.command}`);
  }
  if (n.kind === "decision" && n.branches) {
    lines.push(`- 分岐の選択肢: ${n.branches.map((b) => `${b.id}=${b.label}`).join(" / ")}`);
  }
  if (n.schedule) lines.push(`- 起動方式: ${n.schedule}`);
  if (n.wait) lines.push(`- 待ち方: ${n.wait}`);
  // ランの後に手順が直っていることがある（例: 2026-11-27、分岐を足す前のランを、足した後の手順と
  // 見比べて「分岐の仕組みが壊れている」と誤って読んだ）。当時の手順を並べて見分けさせる
  if (run.snapshot) {
    const then = run.snapshot.nodes.find((s) => s.id === n.id);
    if (!then) lines.push("- このノードはランの後に足された（ランの時点には無かった）");
    else if (changedSinceRun(n, then)) lines.push(...thenBlock(then));
  }
  return lines;
}

/** 振り返りのプロンプトを組み立てる（純粋関数） */
export function buildRetroPrompt(input: RetroPromptInput): string {
  const { goal, members, run, traceLines, omitted } = input;
  const lines: string[] = [
    "あなたは GraphWrangler（タスクグラフをAIと人間で分担するツール）の「振り返り」担当です。",
    "ルーティーンのラン（1回ぶんの実行）が終わりました。このランの記録を読み、次のランがもっとうまく進むように、" +
      "手順（各ノードの手順書・補足）の直し方を**案として**出してください。",
    "ランどうしは会話を共有しないので、次のランへ引き継がれるのは手順の文面だけです。",
    "",
    ...TOOL_PERMISSION_LINES,
    "",
    "## 守ること（読むだけ）",
    "- グラフ・ファイル・データベースを書き換えない。誰にも何も送らない（メール・チャット・Discord も）",
    "- GraphWrangler の MCP でも、ノードの編集・投稿・カードを開く・ランの操作はしない",
    "- 確かめるための読み取り（手順が指すファイルや資料を開く、コマンドで今の状態を見るだけ）はしてよい",
    "- 質問して止まらない。あなたの出力は案だけで、反映するかは人が決め、反映はシステムが行う",
    "",
    "## 直す案の選び方",
    "- **このランの記録に根拠があるものだけ**。たとえば: 人の苦情・訂正・指示、AI の「手順と実際が違う」、" +
      "失敗、意味のない待ち、AI が人に聞かないと進めなかった質問",
    "- 一般的な改善・言い回しの手直し・好みの整理はしない。直す必要のないノードは出さない",
    "- 最小限で具体的に。手順の文面は短く保つ。足すなら要る一文だけ。言い換えて長くしない。" +
      "もともと書いてあることは消さない（間違いと分かったところは直す）",
    "- スクリプトのコマンドは直さない。直すべきなら summary に書く",
    "- 「直せる欄」が「なし」のノードは出さない（必要なら summary に書く）",
    "- 直す欄は、各ノードの「直せる欄」に書いたものを使う（impl.text = 手順書 / detail = 補足）",
    "- 直すところが無ければ changes は空でよい",
    "- 各ノードに「このランの時点の手順は今と違う」とあれば、ランの後にすでに直されている。" +
      "記録の問題が今の手順で防げるなら案は出さず、summary に「ランの後に直し済み」と書く。" +
      "今の手順とランの記録を突き合わせて、起きていないことを起きたと読まない",
    "",
    "## ゴール（このページ）",
    goal.title,
  ];
  if (goal.detail?.trim()) lines.push(goal.detail.trim());
  lines.push("", `## このラン: ${run.title}（${run.status === "cancelled" ? "途中で打ち切り" : "最後まで終わった"}）`);
  if (Object.keys(run.context).length > 0) {
    lines.push("ランのコンテキスト:");
    for (const [k, v] of Object.entries(run.context)) lines.push(`- ${k}: ${truncate(v, 300)}`);
  }
  lines.push("", "## このページのノード（手順）");
  for (const m of members) lines.push(...memberBlock(m, run), "");
  lines.push("## このランの記録（時刻順）");
  if (traceLines.length === 0) lines.push("（記録はありません）");
  else lines.push(...traceLines);
  if (omitted > 0) lines.push(`（長さの都合で、ほかに ${omitted} 件の記録を省きました）`);
  lines.push(
    "",
    "## 返し方",
    "最後に ```json のコードブロックを1つだけ書いてください。形:",
    "```json",
    '{"summary":"…","changes":[{"nodeId":"n-…","field":"impl.text","reason":"…","what":"…","newText":"…"}]}',
    "```",
    "- summary: 3行以内の平易な日本語。このランで何が起き、何を直すか（直さないならその理由）",
    "- reason: 1行。記録のどこが根拠か",
    "- what: 1〜2行。何がどう変わるか",
    "- newText: その欄を**直した後の全文**（差分ではない）",
    "専門用語は避け、作業する人の言葉で書いてください。",
  );
  return lines.join("\n");
}

// ---- 出力の解析と検証 ----

export interface RawRetroChange {
  nodeId?: unknown;
  field?: unknown;
  reason?: unknown;
  what?: unknown;
  newText?: unknown;
}

/** AI の出力から JSON を取り出す（純粋関数）。読めなければ null */
export function parseRetroOutput(text: string): { summary: string; changes: RawRetroChange[] } | null {
  const candidates: string[] = [];
  const fence = /```(?:json)?[^\n]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) candidates.push(m[1]);
  candidates.reverse(); // 最後のブロックが本命
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c.trim());
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const o = parsed as { summary?: unknown; changes?: unknown };
    if (o.changes !== undefined && !Array.isArray(o.changes)) continue;
    if (o.summary === undefined && o.changes === undefined) continue;
    const changes = ((o.changes as unknown[] | undefined) ?? []).filter(
      (c): c is RawRetroChange => !!c && typeof c === "object" && !Array.isArray(c),
    );
    return { summary: typeof o.summary === "string" ? cleanSummary(o.summary) : "", changes };
  }
  return null;
}

function cleanSummary(s: string): string {
  return truncate(
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join("\n"),
    400,
  );
}

function oneLine(v: unknown, limit: number): string {
  return typeof v === "string" ? truncate(v.replace(/\s*\r?\n\s*/g, " "), limit) : "";
}

/**
 * 案を1件ずつ確かめる（純粋関数）。通すのは: ページのノードである / 直せる欄と一致する
 * （欄の指定が無ければ直せる欄を使う）/ 新しい文面が空でなく、長すぎず、いまと違う /
 * 同じノード×欄の重複でない。落としたものは理由を返す（ログ・本文用）。
 */
export function validateRetroChanges(
  raw: RawRetroChange[],
  members: Node[],
): { valid: RetroChange[]; dropped: string[] } {
  const byId = new Map(members.map((n) => [n.id, n]));
  const valid: RetroChange[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const nodeId = typeof c.nodeId === "string" ? c.nodeId.trim() : "";
    const node = byId.get(nodeId);
    if (!node) {
      dropped.push(`${nodeId || "（ノード不明）"}: このページのノードではない`);
      continue;
    }
    const allowed = editableField(node);
    if (allowed === null) {
      dropped.push(`${node.title}: ロック中`);
      continue;
    }
    const field = c.field === undefined || c.field === null || c.field === "" ? allowed : c.field;
    if (field !== allowed) {
      dropped.push(`${node.title}: 直せない欄（${String(field)}）`);
      continue;
    }
    const newText = typeof c.newText === "string" ? c.newText.trim() : "";
    const oldText = fieldText(node, allowed);
    if (!newText) {
      dropped.push(`${node.title}: 新しい文面が空`);
      continue;
    }
    if (newText.length > RETRO_NEW_TEXT_LIMIT) {
      dropped.push(`${node.title}: 新しい文面が長すぎる`);
      continue;
    }
    if (newText === oldText.trim()) {
      dropped.push(`${node.title}: いまと同じ文面`);
      continue;
    }
    const key = `${node.id}:${allowed}`;
    if (seen.has(key)) {
      dropped.push(`${node.title}: 同じ欄の案が重複`);
      continue;
    }
    seen.add(key);
    valid.push({
      nodeId: node.id,
      title: node.title,
      field: allowed,
      reason: oneLine(c.reason, 200),
      what: oneLine(c.what, 300) || "手順を直す",
      newText,
      oldText,
      oldHash: textHash(oldText),
    });
  }
  return { valid, dropped };
}

// ---- 本文・カード ----

/** 案の発言の本文（短く。全文は載せない。全文は payload にある） */
export function buildProposalBody(summary: string, changes: RetroChange[], droppedCount: number): string {
  const lines = [`振り返り: ${summary || "このランの記録から、手順を直す案を作りました"}`, "", "直す案:"];
  for (const c of changes) lines.push(`- ${c.title}: ${c.what}（理由: ${c.reason || "記録より"}）`);
  if (droppedCount > 0) lines.push("", `（使えない案 ${droppedCount} 件は外しました）`);
  return lines.join("\n");
}

export function buildRetroRequest(run: Pick<Run, "id" | "title">, summary: string, changes: RetroChange[]): DecisionRequest {
  const firstLine = (summary.split("\n")[0] ?? "").trim();
  const context = [
    `「${run.title}」の振り返りで、手順を${changes.length}か所直す案ができました。`,
    firstLine ? truncate(firstLine, 160) : null,
    truncate(`直すところ: ${changes.map((c) => c.title).join("、")}`, 160),
  ]
    .filter((l): l is string => !!l)
    .join("\n");
  return {
    context,
    question: `この案を手順に反映しますか？ ${retroMarker(run.id)}`,
    options: [
      {
        id: RETRO_OPTION_APPLY,
        label: "反映する",
        then: "案のとおりに手順を書き換えます。次のランから効きます",
        recommended: true,
      },
      { id: RETRO_OPTION_REJECT, label: "反映しない", then: "手順はそのままです。案は会話に残ります" },
    ],
    impact: "reversible",
    undo: "反映したあとも、各ノードの手順を編集すれば戻せます（直す前の文面は記録に残ります）",
  };
}

// ---- 反映 ----

export type RetroApplyStep =
  | { change: RetroChange; patch: NodePatch }
  | { change: RetroChange; skip: string };

/**
 * 「反映する」の回答を受けて、案ごとに書き換えるか見送るかを決める（純粋関数）。
 * 案を作ったときの文面から変わっていたら見送る（その間に人が直したものを上書きしない）。
 */
export function planRetroApply(changes: RetroChange[], nodes: Node[], pageId: string): RetroApplyStep[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return changes.map((change) => {
    const node = byId.get(change.nodeId);
    if (!node || node.group !== pageId) return { change, skip: "ノードがもうこのページに無い" };
    if (node.fixed) return { change, skip: "ロックされた" };
    if (editableField(node) !== change.field) return { change, skip: "手順の形が変わった" };
    if (textHash(fieldText(node, change.field)) !== change.oldHash) {
      return { change, skip: "案を作ったあとに書き換えられていた" };
    }
    return { change, patch: buildFieldPatch(node, change.field, change.newText) };
  });
}

// ---- 配線（ネットワークI/Oあり） ----

let prevRunStatus: { statuses: Map<string, string>; at: number } | null = null;
let autoQueue: string[] = [];
/** 返事待ちの案（runId → ページid と、わかっていればカードの id） */
const awaiting = new Map<string, { pageId: string; requestId: string | null }>();
let startupScanned = false;
/** 同じランの振り返りを二重に走らせない（tick は直列だが、念のため） */
const inFlight = new Set<string>();

/** テスト用: モジュール内の状態を初期化する */
export function resetRetroState(): void {
  prevRunStatus = null;
  autoQueue = [];
  awaiting.clear();
  startupScanned = false;
  inFlight.clear();
}

async function pageRunThread(pageId: string, runId: string): Promise<Message[]> {
  const { messages } = await getThread(pageId, runId);
  return messages;
}

/** 起動して最初の周に1回だけ: 返事待ちのまま止まっていた案を拾い直す（再起動をまたぐため）。
 *  見るのはランを持つページだけ・最近のランの印だけ */
async function scanAwaitingOnStartup(nodes: Node[], runs: Run[]): Promise<void> {
  startupScanned = true;
  const since = Date.now() - RETRO_SCAN_DAYS * 24 * 60 * 60 * 1000;
  const recent = runs.filter((r) => r.status !== "running" && Date.parse(r.created) >= since);
  const pageIds = new Set(recent.map((r) => r.pageId));
  for (const pageId of pageIds) {
    if (!nodes.some((n) => n.id === pageId)) continue;
    try {
      const { messages } = await getThread(pageId, "all");
      for (const run of recent.filter((r) => r.pageId === pageId)) {
        const scoped = messages.filter(
          (m) => runIdOf(m) === run.id || (m.kind === "decision_request" && m.requestStatus === "open"),
        );
        const phase = deriveRetroPhase(scoped, run.id);
        if (phase.phase === "proposed") {
          awaiting.set(run.id, { pageId, requestId: phase.request?.id ?? null });
        }
      }
    } catch (err) {
      log(`振り返り: 起動時の見直しに失敗（このページは飛ばす）: page=${pageId} ${String(err)}`);
    }
  }
  if (awaiting.size > 0) log(`振り返り: 返事待ちの案 ${awaiting.size} 件を拾い直した`);
}

async function postRetroStatus(
  pageId: string,
  runId: string,
  state: RetroState,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await postMessage(
    pageId,
    { kind: "status", body, payload: { retro: true, runId, state, ...extra }, runId },
    ENGINE_ACTOR,
    VIA,
  );
}

/** 案のカードを開く。開けなければ false（ページに別のカードが開いている等。次の周に再試行） */
async function openRetroCard(page: Node, run: Pick<Run, "id" | "title">, proposal: RetroProposal): Promise<string | null> {
  if (page.pendingRequest) return null;
  try {
    const msg = await openRequest(
      page.id,
      buildRetroRequest(run, proposal.summary, proposal.changes),
      ENGINE_ACTOR,
      VIA,
      run.id,
    );
    log(`振り返り: カードを開いた run=${run.id} page=${page.id}`);
    return msg.id;
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 409)) {
      log(`振り返り: カードを開けなかった（次周に再試行）: run=${run.id} ${String(err)}`);
    }
    return null;
  }
}

/** 返事待ちの案を1件進める（カードを開く／回答を受けて反映する）。何かしたら true */
async function tickAwaiting(nodes: Node[], runs: Run[]): Promise<boolean> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [runId, entry] of [...awaiting]) {
    const page = byId.get(entry.pageId);
    if (!page) {
      awaiting.delete(runId);
      continue;
    }
    // カードが開いたままなら、スレッドを読まずに次へ（毎周の取得を省く）
    if (entry.requestId && page.pendingRequest === entry.requestId) continue;
    let phase: RetroPhase;
    try {
      phase = deriveRetroPhase(await pageRunThread(page.id, runId), runId);
    } catch (err) {
      log(`振り返り: 会話の取得に失敗（次周に再試行）: run=${runId} ${String(err)}`);
      continue;
    }
    if (phase.phase !== "proposed") {
      awaiting.delete(runId);
      continue;
    }
    const { proposal, request } = phase;
    if (request === null) {
      const run = runs.find((r) => r.id === runId) ?? { id: runId, title: "ラン" };
      const id = await openRetroCard(page, run, proposal);
      if (id) {
        awaiting.set(runId, { pageId: page.id, requestId: id });
        return true;
      }
      continue;
    }
    if (request.status === "open") {
      // 自由文の返事（ラリー）は Task AI が答える。カードは開いたまま待つ
      awaiting.set(runId, { pageId: page.id, requestId: request.id });
      continue;
    }
    await settleProposal(page, runId, proposal, request.option, nodes);
    awaiting.delete(runId);
    return true;
  }
  return false;
}

/** 回答に従って反映（または見送り）し、終わりの印を残す */
async function settleProposal(
  page: Node,
  runId: string,
  proposal: RetroProposal,
  option: string | null,
  nodes: Node[],
): Promise<void> {
  if (option === RETRO_OPTION_APPLY) {
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const step of planRetroApply(proposal.changes, nodes, page.id)) {
      if ("skip" in step) {
        skipped.push(`${step.change.title}（${step.skip}）`);
        continue;
      }
      try {
        await patchNode(step.change.nodeId, step.patch, ENGINE_ACTOR, VIA);
        applied.push(step.change.title);
      } catch (err) {
        skipped.push(`${step.change.title}（書き換えに失敗: ${truncate(String(err), 120)}）`);
      }
    }
    const lines = [applied.length > 0 ? "振り返り: 手順に反映しました" : "振り返り: 反映できた案はありませんでした"];
    for (const t of applied) lines.push(`- 反映: ${t}`);
    for (const t of skipped) lines.push(`- 見送り: ${t}`);
    await postRetroStatus(page.id, runId, "applied", lines.join("\n"), { applied, skipped });
    log(`振り返り: 反映 run=${runId} applied=${applied.length} skipped=${skipped.length}`);
  } else {
    await postRetroStatus(page.id, runId, "rejected", "振り返り: 反映しませんでした。手順はそのままです");
    log(`振り返り: 反映しない run=${runId}`);
  }
  // カードに答えるとサーバがページを pending へ戻す。アーカイブ済みのページだったら元へ戻す
  if (proposal.pageStatus === "done" || proposal.pageStatus === "dropped") {
    try {
      await patchNode(page.id, { status: proposal.pageStatus as Node["status"] }, ENGINE_ACTOR, VIA);
    } catch (err) {
      log(`振り返り: ページの状態を戻せなかった: page=${page.id} ${String(err)}`);
    }
  }
}

/** ランの記録をそのランのぶんだけ集める（ページノード + テンプレートノード + ワークアイテム） */
async function collectTrace(run: Run, nodes: Node[]): Promise<TraceEntry[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids = new Set<string>([run.pageId, ...Object.keys(run.items)]);
  for (const n of nodes) if (n.group === run.pageId) ids.add(n.id);
  const marker = retroMarker(run.id);
  const out: TraceEntry[] = [];
  for (const id of ids) {
    try {
      const { messages } = await getThread(id, run.id);
      for (const m of messages) {
        if (runIdOf(m) !== run.id) continue;
        // 前の振り返りの発言・カードは記録に混ぜない（自分の案を根拠にしないため）
        if ((m.payload as { retro?: unknown } | null)?.retro === true) continue;
        if (m.kind === "decision_request" && m.body.includes(marker)) continue;
        out.push({
          ts: m.ts,
          nodeTitle: byId.get(id)?.title ?? id,
          author: m.author,
          kind: m.kind,
          body: m.body,
          payload: m.payload,
        });
      }
    } catch (err) {
      log(`振り返り: 記録の取得に失敗（このノードは無しで続行）: run=${run.id} node=${id} ${String(err)}`);
    }
  }
  return out;
}

/** 1つのランを振り返る（AI を1回呼ぶ）。結果の発言と、案があればカードまで */
async function runRetro(run: Run, page: Node, nodes: Node[]): Promise<void> {
  const members = nodes
    .filter((n) => n.group === page.id)
    .sort((a, b) => a.created.localeCompare(b.created));
  const { lines, omitted } = selectTraceLines(await collectTrace(run, nodes));
  // 一覧（summary）のランには作成時点の構成が無いので、1件取り直して当時の手順と比べられるようにする
  let snapshot: Run["snapshot"];
  try {
    snapshot = (await getRun(run.id)).snapshot;
  } catch (err) {
    log(`振り返り: ランの控えの取得に失敗（今の手順だけで続行）: run=${run.id} ${String(err)}`);
  }
  const prompt = buildRetroPrompt({ goal: page, members, run: { ...run, snapshot }, traceLines: lines, omitted });
  log(`振り返り開始: run=${run.id} page=${page.id} title=${run.title} 記録=${lines.length}件 省略=${omitted}件`);
  const result = await runAiExecutor(prompt, page);
  if (!result.success) {
    await postRetroStatus(
      page.id,
      run.id,
      "failed",
      truncate(`振り返り: AI を呼べませんでした（${result.error ?? "不明なエラー"}）`, 500),
    );
    log(`振り返り失敗: run=${run.id} ${result.error ?? ""}`);
    return;
  }
  const parsed = parseRetroOutput(result.output);
  if (!parsed) {
    await postRetroStatus(page.id, run.id, "failed", "振り返り: AI の答えを読み取れませんでした（手順はそのままです）", {
      raw: truncate(result.output, 2000),
    });
    log(`振り返り: 出力を解析できない run=${run.id}`);
    return;
  }
  const { valid, dropped } = validateRetroChanges(parsed.changes, members);
  if (dropped.length > 0) log(`振り返り: 外した案 run=${run.id} ${dropped.join(" / ")}`);
  if (valid.length === 0) {
    const why = parsed.summary ? `（${parsed.summary.replace(/\n/g, " ")}）` : "";
    await postRetroStatus(page.id, run.id, "none", `振り返り: 直すところはありませんでした${why}`, {
      summary: parsed.summary,
    });
    log(`振り返り: 直すところなし run=${run.id}`);
    return;
  }
  const proposal: RetroProposal = {
    retro: true,
    runId: run.id,
    state: "proposed",
    summary: parsed.summary,
    changes: valid,
    pageStatus: page.status,
  };
  const actor: Actor = { kind: "agent", name: aiExecutorName() };
  await postMessage(
    page.id,
    {
      kind: "say",
      body: buildProposalBody(parsed.summary, valid, dropped.length),
      payload: withSubSteps({ ...proposal }, result),
      runId: run.id,
    },
    actor,
    VIA,
  );
  log(`振り返り: 案を出した run=${run.id} 件数=${valid.length}`);
  const requestId = await openRetroCard(page, run, proposal);
  awaiting.set(run.id, { pageId: page.id, requestId });
}

/**
 * 振り返りの1周ぶん。ランの終わりを拾い、返事待ちの案を進め、手が空いていれば1件振り返る。
 * 何かしたら true（AI を呼ぶのは1周に1件まで）。
 */
export async function tickRetro(nodes: Node[]): Promise<boolean> {
  let runs: Run[];
  try {
    runs = await listAllRuns();
  } catch (err) {
    log(`振り返り: ラン一覧の取得に失敗（この周は見送り）: ${String(err)}`);
    return false;
  }
  const { ended, seen } = detectRunEndings(prevRunStatus, runs, Date.now());
  prevRunStatus = seen;
  for (const id of ended) if (!autoQueue.includes(id)) autoQueue.push(id);
  if (!startupScanned) await scanAwaitingOnStartup(nodes, runs);

  if (await tickAwaiting(nodes, runs)) return true;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (;;) {
    const picked = pickRetroTarget(runs, autoQueue);
    if (!picked) return false;
    autoQueue = picked.queue;
    const { run, manual } = picked;
    if (manual) {
      // 依頼は先に下ろす（振り返りが長引いている間に、同じ依頼をもう一度拾わないように）
      try {
        await setRunRetroRequest(run.id, false);
      } catch (err) {
        log(`振り返り: 依頼を下ろせなかった（この周は見送り）: run=${run.id} ${String(err)}`);
        return false;
      }
      run.retroRequest = false;
    }
    const page = byId.get(run.pageId);
    if (!page || inFlight.has(run.id)) continue;
    // しまったページ（アーカイブ済み）は、頼まれたときだけ振り返る
    if (!manual && (page.status === "done" || page.status === "dropped")) continue;
    let phase: RetroPhase;
    try {
      phase = deriveRetroPhase(await pageRunThread(page.id, run.id), run.id);
    } catch (err) {
      log(`振り返り: 会話の取得に失敗（この周は見送り）: run=${run.id} ${String(err)}`);
      return false;
    }
    if (phase.phase === "proposed") {
      // 前の案の返事待ち。やり直さず、その案を進める
      awaiting.set(run.id, { pageId: page.id, requestId: phase.request?.id ?? null });
      if (manual) {
        // 印（payload.retro）は付けない——付けると新しい案と見なされ、カードを開き直してしまう
        await postMessage(
          page.id,
          {
            kind: "status",
            body: "振り返り: 前の案への返事待ちです。カードで選んでください",
            payload: { runId: run.id },
            runId: run.id,
          },
          ENGINE_ACTOR,
          VIA,
        );
      }
      return true;
    }
    // 自動は1回だけ（済みの印があれば繰り返さない）。手動はやり直してよい
    if (!manual && phase.phase === "final") continue;
    inFlight.add(run.id);
    try {
      await runRetro(run, page, nodes);
    } catch (err) {
      log(`振り返りで例外: run=${run.id} ${String(err)}`);
    } finally {
      inFlight.delete(run.id);
    }
    return true;
  }
}
