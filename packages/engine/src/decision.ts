// 分岐ノード（kind=decision、プロジェクト層）の実行候補選択と script/ai 出力の解釈。
// pick.ts と同じ方針: ネットワークI/Oを一切持たない純粋関数のみを置く（vitest でユニットテストする対象）。
// docs/design.md 3.9 が仕様の正。
import type { DecisionRequest, Message, Node } from "./types.js";
import { isRunManagedMember, triggerPageIds } from "./pick.js";

/** ルーティーンページ（トリガーノードを持つページ）配下の decision はプロジェクト側
 *  スケジューラの対象外（pick.ts の isSchedulableKind/isRunManagedMember と同じ理由。
 *  ランのワークアイテムは decisionRun.ts が扱う） */
function isDecisionCandidateKind(node: Node, triggerPages: Set<string>): boolean {
  return (
    node.kind === "decision" &&
    node.lifecycle === "committed" &&
    !isRunManagedMember(node, triggerPages)
  );
}

/** parents が全て done または skipped か（pick.ts の isFrontier と同じ規則） */
function isFrontierForDecision(node: Node, byId: Map<string, Node>): boolean {
  return node.parents.every((pid) => {
    const s = byId.get(pid)?.status;
    return s === "done" || s === "skipped";
  });
}

export type DecisionAction =
  | { type: "execute-script"; node: Node } // script実行→stdoutを枝idとして解釈
  | { type: "execute-ai"; node: Node } // AIに選ばせる
  | { type: "open-human-request"; node: Node } // human: 判断リクエストを開く
  | { type: "decide"; node: Node; choice: string } // human: 回答が来ていたので確定する
  | { type: "drop"; node: Node } // 失敗リカバリでabort回答 → 中止(dropped)
  | { type: "none" };

/** スレッド最新メッセージが decision_answer なら、その option を取り出す（pick.ts の
 *  lastAnswerOption と同じ形） */
function lastAnswerOption(message: Message | undefined): string | undefined {
  if (!message || message.kind !== "decision_answer") return undefined;
  const payload = message.payload as { option?: string | null } | null;
  return payload?.option ?? undefined;
}

/**
 * 実行可能な decision ノードを1件選ぶ（純粋関数）。
 *
 * 対象条件: lifecycle=committed, kind=decision, 手順メンバーでない, frontier（parents が
 * 全て done|skipped）, status=pending（done/dropped/skipped/waiting/running/unplanned は除外。
 * pick.ts の「status=waiting は候補にならない」と同じ理由: human への判断リクエストや
 * 失敗リカバリの間は node.status=waiting になり、そのまま自然に除外される）。created 昇順で最初の1件。
 *
 * - 直前のdecision_answerが option="abort"（失敗リカバリ）なら drop（pick.ts と同じ規約）
 * - executor=human は、直前のスレッドメッセージ(lastMessages)が decision_answer で有効な
 *   枝idを持っていれば「decide」（/decide を呼んで確定する）を返す。まだ何も答えていなければ
 *   「open-human-request」（判断リクエストを開く。既存の /request が status=waiting にする）。
 *   この判定は pick.ts の lastAnswerOption と同じ形（server の /answer が pendingRequest を
 *   クリアし status を pending に戻した後、次tickでスレッド末尾を見て確定する）
 * - executor=script/ai はそのまま実行対象（失敗時は index.ts が buildFailureRecoveryRequest で
 *   retry/modify/abort を仰ぐ。retry/modify は次tickで通常どおり再実行される）
 */
export function selectDecisionAction(
  nodes: Node[],
  lastMessages: Record<string, Message | undefined> = {},
): DecisionAction {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const triggerPages = triggerPageIds(nodes);
  const sorted = [...nodes].sort((a, b) => a.created.localeCompare(b.created));

  for (const node of sorted) {
    if (!isDecisionCandidateKind(node, triggerPages)) continue;
    if (node.status !== "pending") continue;
    if (!isFrontierForDecision(node, byId)) continue;

    const option = lastAnswerOption(lastMessages[node.id]);
    if (option === "abort") {
      return { type: "drop", node };
    }

    if (node.executor === "human") {
      if (option && node.branches?.some((b) => b.id === option)) {
        return { type: "decide", node, choice: option };
      }
      return { type: "open-human-request", node };
    }
    if (node.executor === "script") return { type: "execute-script", node };
    return { type: "execute-ai", node };
  }
  return { type: "none" };
}

/** human向けの判断リクエストを branches から組み立てる（options=branches。then が無い枝は
 *  簡易文言で補う。DecisionRequest の options は then 必須のため） */
export function buildDecisionRequest(node: Node): DecisionRequest {
  const branches = node.branches ?? [];
  return {
    context: `分岐「${node.title}」です。${node.detail ? `\n補足: ${node.detail}` : ""}`,
    question: "どちらに進めますか？",
    options: branches.map((b) => ({
      id: b.id,
      label: b.label,
      then: b.then ?? `「${b.label}」の枝に進む`,
    })),
    impact: node.impact,
    undo: null,
  };
}

/** AI executor 向けのプロンプト（branches を提示し、枝idのみ1行で出力させる） */
export function buildDecisionPrompt(node: Node): string {
  const branches = node.branches ?? [];
  const lines: string[] = [
    "あなたは GraphWrangler（タスクグラフをAIと人間で分担するツール）の分岐ノードの判断者です。",
    `分岐: ${node.title}`,
  ];
  if (node.detail) lines.push(`補足: ${node.detail}`);
  lines.push("", "選べる枝:");
  for (const b of branches) {
    lines.push(`- id=${b.id} label=${b.label}${b.then ? ` then=${b.then}` : ""}`);
  }
  lines.push(
    "",
    "上のいずれかの枝の id のみを1行で出力してください（他の文字・説明は含めないこと）。",
  );
  return lines.join("\n");
}

/** script/ai の出力(trim済み)を枝idとして解釈する。一致しなければ null。
 *  AIは前後に説明を付けがちなので、行単位でも枝idと一致するか救済的に見る */
export function parseBranchChoice(node: Node, output: string): string | null {
  const branches = node.branches ?? [];
  const trimmed = output.trim();
  const direct = branches.find((b) => b.id === trimmed);
  if (direct) return direct.id;
  for (const line of trimmed.split("\n").map((l) => l.trim())) {
    const hit = branches.find((b) => b.id === line);
    if (hit) return hit.id;
  }
  return null;
}
