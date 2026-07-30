// 実行候補の選択と承認フローの判定。ネットワークI/Oを一切持たない純粋関数のみを置く
// （vitest でユニットテストする対象。docs/agent-contracts.md の担当領域どおり
// packages/engine 内で完結させる）。
import type { DecisionRequest, Node, Message } from "./types.js";

/** スケジューラの対象になりうる基本条件（frontier/status/メッセージ判定は別途 selectAction が見る）。
 *  手順（kind=procedure）のメンバー＝テンプレートは対象外: テンプレートは status を持たない思想で、
 *  実行はラン側のワークアイテムが担う。ここで除外しないとプロジェクト側エンジンにも拾われて
 *  二重実行になる（2026-07-29 に実際に発生した不具合） */
function isSchedulableKind(node: Node, byId: Map<string, Node>): boolean {
  if (node.group && byId.get(node.group)?.kind === "procedure") return false;
  return (
    node.lifecycle === "committed" &&
    node.kind === "task" &&
    (node.executor === "ai" || node.executor === "script")
  );
}

/** parents が全て done または skipped か（空配列=ルートは真）。存在しない親は「未完了」扱いにして
 *  安全側に倒す。skipped も充足扱いにするのは分岐(3.9)の合流ノードが片方の枝の skipped で
 *  止まらないようにするため（「skipped でない親が全て done」と同値。docs/design.md 3.9） */
export function isFrontier(node: Node, byId: Map<string, Node>): boolean {
  return node.parents.every((pid) => {
    const s = byId.get(pid)?.status;
    return s === "done" || s === "skipped";
  });
}

export function buildIndex(nodes: Node[]): Map<string, Node> {
  return new Map(nodes.map((n) => [n.id, n]));
}

export type EngineAction =
  | { type: "execute"; node: Node }
  | { type: "open-gate"; node: Node }
  | { type: "drop"; node: Node }
  | { type: "none" };

/** スレッド最新メッセージが decision_answer なら、その option を取り出す（無ければ undefined） */
function lastAnswerOption(message: Message | undefined): string | undefined {
  if (!message || message.kind !== "decision_answer") return undefined;
  const payload = message.payload as { option?: string | null } | null;
  return payload?.option ?? undefined;
}

/**
 * 実行可能なノードを1件選ぶ（純粋関数）。
 *
 * 対象条件: lifecycle=committed, kind=task, executor=ai|script, status=pending,
 * pendingRequest なし, frontier（parents が全て done）。created 昇順（古い順）で最初の1件。
 *
 * メッセージによる分岐（lastMessages は各ノードのスレッド最新メッセージ。無い/不要なら省略可）:
 * - 直前の decision_answer が option="abort"（失敗リカバリ）または "skip"（不可逆ゲート）
 *   → drop（status=dropped にする）
 * - impact=irreversible: 直前の decision_answer が option="go" のときだけ execute
 *   （この1回だけ許可）。それ以外（未承認・retry/modify等）は open-gate で承認カードを開く
 * - 上記以外（impact=safe/reversible）はそのまま execute
 */
export function selectAction(
  nodes: Node[],
  lastMessages: Record<string, Message | undefined> = {},
): EngineAction {
  const byId = buildIndex(nodes);
  const sorted = [...nodes].sort((a, b) => a.created.localeCompare(b.created));

  for (const node of sorted) {
    if (!isSchedulableKind(node, byId)) continue;
    if (node.status !== "pending") continue; // unplanned/running/waiting/done/dropped は除外
    if (node.pendingRequest) continue; // open request があるなら人間待ち（本来 pending とは両立しない想定だが念のため）
    if (!isFrontier(node, byId)) continue;

    const option = lastAnswerOption(lastMessages[node.id]);

    if (option === "abort" || option === "skip") {
      return { type: "drop", node };
    }

    if (node.impact === "irreversible") {
      if (option === "go") {
        return { type: "execute", node };
      }
      return { type: "open-gate", node };
    }

    return { type: "execute", node };
  }
  return { type: "none" };
}

/** ノード内容を専門用語なしで平易に要約する（判断カードの context 用。文脈税） */
function summarizeNodeForHuman(node: Node): string {
  const detail = node.detail ? `\n補足: ${node.detail}` : "";
  return `作業: ${node.title}${detail}`;
}

/** impact=irreversible ノードの実行許可を求める判断リクエスト */
export function buildIrreversibleGateRequest(node: Node): DecisionRequest {
  return {
    context: summarizeNodeForHuman(node),
    question: `これは元に戻せない操作です。実行していいですか？`,
    options: [
      { id: "go", label: "実行して", then: "エンジンが実行する" },
      { id: "skip", label: "やめる", then: "中止(dropped)にする" },
    ],
    impact: "irreversible",
    undo: null,
    expires: null,
    on_expire: null,
  };
}

/** 実行失敗/タイムアウト時に人間へ判断を仰ぐ判断リクエスト */
export function buildFailureRecoveryRequest(node: Node, reason: string): DecisionRequest {
  const trimmed = reason.length > 200 ? reason.slice(0, 200) + "…" : reason;
  return {
    context: `「${node.title}」の自動実行に失敗しました。\n理由: ${trimmed}`,
    question: "どうしますか？",
    options: [
      { id: "retry", label: "もう一度", then: "同じ内容でもう一度実行する" },
      { id: "modify", label: "内容を変える", then: "ノードを編集してもらってから再実行する" },
      { id: "abort", label: "中止", then: "中止(dropped)にする" },
    ],
    impact: "reversible",
    undo: null,
    expires: null,
    on_expire: null,
  };
}
