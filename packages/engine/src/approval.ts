// ラン（ルーティーンページ）の不可逆ワークアイテムを人間の承認と連携させる。
// pickRun.ts の selectRunAction が waiting-irreversible を返した後の続き:
//   1) items patch {status:"waiting", note:APPROVAL_WAITING_NOTE} + テンプレートノードへ
//      POST /request で承認カードを開く（呼び出し側=index.ts が行う。ここでは判定のみ）
//   2) 以後の tick でテンプレートノードのスレッドを確認し、decision_answer があれば
//      go→実行 / skip→skipped にする
// 判断リクエストの payload は指定できないため、question 文中に "[ラン <runId>]" を
// 埋め込んでランと紐付ける（テンプレートノードは複数のランに同時に登場しうるため、
// ノードidだけでは束ねられない）。
// ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
import type { DecisionAnswer, DecisionRequest, Message, Node, Run, RunItem } from "./types.js";

/** items patch の note に使う目印。この文字列がノートに入っている waiting アイテムだけを
 *  「承認カードを開いた不可逆アイテム」として扱う */
export const APPROVAL_WAITING_NOTE = "承認待ち";

/** decision_request の question に埋め込むランの紐付けマーカー */
export function runGateMarker(runId: string): string {
  return `[ラン ${runId}]`;
}

/** approval=true（実行前承認）なランアイテムの実行許可を求める判断リクエスト */
export function buildRunApprovalRequest(node: Node, run: Run): DecisionRequest {
  const detail = node.detail ? `\n補足: ${node.detail}` : "";
  return {
    context: `手順「${run.title}」の実行中です。\n作業: ${node.title}${detail}`,
    question: `これは元に戻せない操作です。実行していいですか？ ${runGateMarker(run.id)}`,
    options: [
      { id: "go", label: "実行して", then: "このランでこの1回だけ実行する" },
      { id: "skip", label: "このランでは飛ばす", then: "このランではこのアイテムを見送る(skipped)にする" },
    ],
    impact: "irreversible",
    undo: null,
  };
}

export type RunGateState =
  | { status: "none" } // まだ承認カードを開いていない
  | { status: "open" } // 開いているが未回答
  | { status: "answered"; option: string | null };

/**
 * テンプレートノードのスレッドから、指定ランに紐づく承認ゲートの状態を求める（純粋関数）。
 * "[ラン <runId>]" マーカーを含む decision_request のうち最新のものを見る。
 */
export function findRunGate(messages: Message[], runId: string): RunGateState {
  const marker = runGateMarker(runId);
  const req = [...messages].reverse().find((m) => m.kind === "decision_request" && m.body.includes(marker));
  if (!req) return { status: "none" };
  if (req.requestStatus !== "answered") return { status: "open" };
  const answer = [...messages]
    .reverse()
    .find(
      (m) =>
        m.kind === "decision_answer" &&
        (m.payload as DecisionAnswer | null)?.requestId === req.id,
    );
  const option = answer ? ((answer.payload as DecisionAnswer).option ?? null) : null;
  return { status: "answered", option };
}

/** 承認待ち（waiting かつ note=APPROVAL_WAITING_NOTE）のランアイテムを集める（純粋関数）。
 *  呼び出し側はこの一覧のテンプレートノードのスレッドだけを取得すればよい（全ノード分は叩かない） */
export function collectPendingApprovalItems(nodes: Node[], runs: Run[]): Array<{ run: Run; node: Node }> {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const out: Array<{ run: Run; node: Node }> = [];
  for (const run of runs) {
    if (run.status !== "running") continue;
    for (const [nodeId, item] of Object.entries(run.items)) {
      if (item.status !== "waiting" || item.note !== APPROVAL_WAITING_NOTE) continue;
      const node = nodesById.get(nodeId);
      if (node && node.approval) out.push({ run, node });
    }
  }
  return out;
}

/** `${runId}:${nodeId}` 形式のキー（gateStates の受け渡しに使う） */
export function gateKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

export type RunApprovalAction =
  | { type: "none" }
  | { type: "open-gate"; run: Run; node: Node } // まだカードを開いていない→開く
  | { type: "execute"; run: Run; node: Node } // go回答→この1回だけ実行
  | { type: "skip"; run: Run; node: Node }; // skip回答→skippedにする

/**
 * 承認待ちのランアイテムを1件処理する（純粋関数。ネットワークI/Oなし）。
 * gateStates は呼び出し側が collectPendingApprovalItems の対象について
 * テンプレートノードのスレッドから findRunGate で求めた結果を gateKey(run.id, nodeId) で渡す。
 *
 * - gate.status="none"（カード未発行）→ open-gate（呼び出し側が POST /request する）
 * - gate.status="open"（発行済み・未回答）→ none（二重にカードを開かない。回答を待つ）
 * - gate.status="answered" かつ option="go" → execute（この1回だけ）
 * - gate.status="answered" かつ option="skip" → skip（呼び出し側が items patch skipped する）
 * - それ以外（go/skip以外のoption。承認カードはこの2択のみなので想定外）→ 次の候補へ
 *
 * ラン created 昇順→ラン内はテンプレート created 昇順で最初の1件のみ返す（pickRun.ts と同じ方針）。
 */
export function selectRunApprovalAction(
  nodes: Node[],
  runs: Run[],
  gateStates: Record<string, RunGateState>,
): RunApprovalAction {
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
      if (item.status !== "waiting" || item.note !== APPROVAL_WAITING_NOTE) continue;
      if (!node.approval) continue;

      const gate = gateStates[gateKey(run.id, nodeId)] ?? { status: "none" };
      if (gate.status === "none") return { type: "open-gate", run, node };
      if (gate.status === "open") continue; // 発行済み・未回答。二重に開かず次の候補へ

      if (gate.option === "go") return { type: "execute", run, node };
      if (gate.option === "skip") return { type: "skip", run, node };
      // go/skip 以外は想定外（承認カードの選択肢はこの2つだけ）。何もせず次の候補へ
    }
  }
  return { type: "none" };
}
