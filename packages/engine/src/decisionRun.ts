// procedure（手順ページ）テンプレートが kind=decision の場合のランアイテム選択と human往復。
// approval.ts の「waiting + 目印note」2段構え（承認カードと同型）を踏襲する: 同じテンプレート
// ノードが複数のランに同時に登場しうるため、node.pendingRequest は使わず、ランIDを question
// 文中のマーカーで束ねる（approval.ts の runGateMarker/findRunGate をそのまま再利用する）。
// docs/design.md 3.8/3.9。ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でテストする対象）。
import type { DecisionRequest, Node, Run, RunItem } from "./types.js";
import { findRunGate, gateKey, runGateMarker, type RunGateState } from "./approval.js";

/** 分岐の判断リクエストを開いた後、回答待ちの間 item に付ける目印（approval.ts の
 *  APPROVAL_WAITING_NOTE と同じ役割。この文字列を持つ waiting アイテムだけを対象にする） */
export const DECISION_WAITING_NOTE = "分岐待ち";

/** ラン内の依存充足（pickRun.ts の dependenciesSettled と同じ規則: 同ランに存在する親だけを見て、
 *  全て done|skipped なら充足） */
function dependenciesSettled(node: Node, run: Run): boolean {
  return node.parents
    .filter((pid) => pid in run.items)
    .every((pid) => {
      const status = run.items[pid]?.status;
      return status === "done" || status === "skipped";
    });
}

interface Entry {
  nodeId: string;
  item: RunItem;
  node: Node;
}

function decisionEntries(nodes: Node[], run: Run): Entry[] {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  return Object.entries(run.items)
    .map(([nodeId, item]) => ({ nodeId, item, node: nodesById.get(nodeId) }))
    .filter((e): e is Entry => e.node !== undefined && e.node.kind === "decision")
    .sort((a, b) => a.node.created.localeCompare(b.node.created));
}

export type RunDecisionAction =
  | { type: "none" }
  | { type: "execute-script"; run: Run; node: Node }
  | { type: "execute-ai"; run: Run; node: Node }
  | { type: "waiting-human"; run: Run; node: Node }; // human分岐。次周にopen-requestが担当する

/**
 * ラン内の pending な分岐アイテムを1件選ぶ（純粋関数）。executor=script/ai は即実行対象、
 * executor=human はまず waiting にする（承認連携(approval.ts)と同じ2段構え。
 * 判断リクエストを開く/回答を見るのは selectRunDecisionApprovalAction が次周に担当する）。
 * ラン created 昇順→ラン内はテンプレート created 昇順で最初の1件。
 */
export function selectRunDecisionAction(nodes: Node[], runs: Run[]): RunDecisionAction {
  const runningRuns = [...runs]
    .filter((r) => r.status === "running")
    .sort((a, b) => a.created.localeCompare(b.created));

  for (const run of runningRuns) {
    for (const { node, item } of decisionEntries(nodes, run)) {
      if (item.status !== "pending") continue;
      if (!dependenciesSettled(node, run)) continue;

      if (node.executor === "script") return { type: "execute-script", run, node };
      if (node.executor === "ai") return { type: "execute-ai", run, node };
      return { type: "waiting-human", run, node };
    }
  }
  return { type: "none" };
}

/** waiting(note=DECISION_WAITING_NOTE) の human 分岐アイテムを集める（呼び出し側が
 *  このリストの対象についてだけテンプレートノードのスレッドを取得すればよい） */
export function collectPendingRunDecisions(
  nodes: Node[],
  runs: Run[],
): Array<{ run: Run; node: Node }> {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const out: Array<{ run: Run; node: Node }> = [];
  for (const run of runs) {
    if (run.status !== "running") continue;
    for (const [nodeId, item] of Object.entries(run.items)) {
      if (item.status !== "waiting" || item.note !== DECISION_WAITING_NOTE) continue;
      const node = nodesById.get(nodeId);
      if (node && node.kind === "decision" && node.executor === "human") out.push({ run, node });
    }
  }
  return out;
}

/** human向け分岐の判断リクエストを組み立てる（options=branches。質問文にランIDのマーカーを
 *  埋め込む。approval.ts の buildRunApprovalRequest と同じ紐付け方式） */
export function buildRunDecisionRequest(node: Node, run: Run): DecisionRequest {
  const branches = node.branches ?? [];
  return {
    context: `手順「${run.title}」の分岐です。\n分岐: ${node.title}${node.detail ? `\n補足: ${node.detail}` : ""}`,
    question: `どちらに進めますか？ ${runGateMarker(run.id)}`,
    options: branches.map((b) => ({
      id: b.id,
      label: b.label,
      then: b.then ?? `「${b.label}」の枝に進む`,
    })),
    impact: node.impact,
    undo: null,
    expires: null,
    on_expire: null,
  };
}

export type RunDecisionApprovalAction =
  | { type: "none" }
  | { type: "open-request"; run: Run; node: Node } // waiting済みだがカード未発行
  | { type: "decide"; run: Run; node: Node; choice: string }; // human回答が来た

/**
 * waiting中の human 分岐について、スレッドのゲート状態（findRunGate で求めたもの。approval.ts
 * と同じ gateKey(run.id, nodeId) で受け渡す）から次のアクションを決める（純粋関数）。
 * - gate.status="none"（カード未発行）→ open-request
 * - gate.status="open"（発行済み・未回答）→ 何もしない（二重に開かない）
 * - gate.status="answered" かつ option が branches に存在 → decide
 * - それ以外（未知の回答）→ 次候補へ
 */
export function selectRunDecisionApprovalAction(
  nodes: Node[],
  runs: Run[],
  gateStates: Record<string, RunGateState>,
): RunDecisionApprovalAction {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const runningRuns = [...runs]
    .filter((r) => r.status === "running")
    .sort((a, b) => a.created.localeCompare(b.created));

  for (const run of runningRuns) {
    const entries: Array<{ nodeId: string; item: RunItem; node: Node }> = Object.entries(run.items)
      .map(([nodeId, item]) => ({ nodeId, item, node: nodesById.get(nodeId) }))
      .filter((e): e is { nodeId: string; item: RunItem; node: Node } => e.node !== undefined)
      .sort((a, b) => a.node.created.localeCompare(b.node.created));

    for (const { nodeId, item, node } of entries) {
      if (item.status !== "waiting" || item.note !== DECISION_WAITING_NOTE) continue;
      if (node.kind !== "decision" || node.executor !== "human") continue;

      const gate = gateStates[gateKey(run.id, nodeId)] ?? { status: "none" };
      if (gate.status === "none") return { type: "open-request", run, node };
      if (gate.status === "open") continue;

      if (gate.option && node.branches?.some((b) => b.id === gate.option)) {
        return { type: "decide", run, node, choice: gate.option };
      }
      // 未知の回答は無視して次候補へ（想定外。branches に無い option）
    }
  }
  return { type: "none" };
}
