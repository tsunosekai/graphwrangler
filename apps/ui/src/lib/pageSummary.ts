// ページ本体（プロジェクト／ルーティーン）のパネルに出す要約の導出（docs/design.md 3.23）。
// ページ本体は中のノードを束ねる入れ物で、それ自体は作業ではない——進み具合は中のノードから、
// いつ動くかは中のトリガーから読む。
import { describeSchedule } from "@graphwrangler/core/schedule";
import type { Node } from "../types";

/** パネルで「ページ本体」として扱うノードか（実行ノード用の欄を出さない） */
export function isPageNode(node: Pick<Node, "kind">): boolean {
  return node.kind === "goal" || node.kind === "folder";
}

export interface PageProgress {
  /** 片づいた数（完了・飛ばした・中止） */
  settled: number;
  total: number;
}

/** プロジェクトの進み具合: 直下の作業ノード（実行・判断・待ち）のうち片づいた数 */
export function pageProgress(page: Pick<Node, "id">, nodes: Node[]): PageProgress {
  const work = nodes.filter(
    (n) => n.group === page.id && (n.kind === "task" || n.kind === "decision" || n.kind === "wait"),
  );
  const settled = work.filter(
    (n) => n.status === "done" || n.status === "skipped" || n.status === "dropped",
  ).length;
  return { settled, total: work.length };
}

export interface PageTriggerLine {
  id: string;
  text: string;
  /** 自動では始まらない理由があるとき（下書き・起動条件なし・解釈不能） */
  warn: boolean;
}

/** ルーティーンの「いつ動くか」: 直下のトリガーごとに1行 */
export function pageTriggerLines(page: Pick<Node, "id">, nodes: Node[]): PageTriggerLine[] {
  return nodes
    .filter((n) => n.group === page.id && n.kind === "trigger")
    .map((t) => {
      if (t.executor === "human") return { id: t.id, text: "手動で開始", warn: false };
      const d = t.schedule ? describeSchedule(t.schedule) : null;
      if (!t.schedule) return { id: t.id, text: "起動条件が未設定（手動でしか始まりません）", warn: true };
      if (!d) return { id: t.id, text: `${t.schedule}（解釈不能）`, warn: true };
      if (t.lifecycle !== "committed") return { id: t.id, text: `${d}（未計画のため自動では始まりません）`, warn: true };
      return { id: t.id, text: t.executor === "ai" ? `${d}（AI が開始を判定）` : d, warn: false };
    });
}
