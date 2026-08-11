// 左レールの行に並ぶドット（ちょぼ）を、行の材料から作る導出。ページ行はテンプレート構成
// （ノード1つ=点1つ）、ラン子行はそのランの進捗を出す。粒の規則（席順・色・薄さ）そのものは
// lib/railDots.ts が正で、ここはその適用先（メンバーノード / ランのワークアイテム）だけを持つ。
// 1粒の描画は components/pagelist/rowParts.tsx の dotEl（PageRow と RunRows が共有）。
import { EXECUTOR_JA, STATUS_JA } from "../../lib/labels";
import type { Dot } from "../../lib/railDots";
import { isSettled, SEAT_ORDER, seatColor, seatOf } from "../../lib/railDots";
import { turnIsMine } from "../../lib/team";
import type { Node, Run, Status } from "../../types";

/** 1行に出す粒の上限。あふれたぶんは行末の「+n」がまとめて示す */
export const MAX_DOTS = 16;

// 質問が開いている（pendingRequest あり）ノードは status が何であれ「あなたの番」扱い
// （NodeCard の visualStatus と同じ保険）。ただし assignee が他人なら waiting（橙）に
// 昇格させず、素の status のまま担当の席色で描く（チーム化 2026-08-04: 他人の番は橙にしない。
// waiting はノードの保存値には無い導出値なので、昇格しなければ橙にはならない）
export const effStatus = (n: Node, meEmail: string | null): Status =>
  n.pendingRequest && turnIsMine(n.assignee, meEmail) ? "waiting" : n.status;

/** ページ行のドット。テンプレート（メンバーノード）構成で、ルーティーンも同じ規則
 *  （ランの進捗は下のラン子行が持つ。2026-08-08 本人確認済みの分担） */
export function pageDots(members: Node[], meEmail: string | null): Dot[] {
  return members
    .slice()
    .sort(
      (a, b) =>
        SEAT_ORDER.indexOf(seatOf(effStatus(a, meEmail), a.executor)) -
        SEAT_ORDER.indexOf(seatOf(effStatus(b, meEmail), b.executor)),
    )
    .map((m) => ({
      key: m.id,
      title: `${m.title || "（無題）"} — ${EXECUTOR_JA[m.executor]}の席 / ${STATUS_JA[effStatus(m, meEmail)]}`,
      color: seatColor(effStatus(m, meEmail), m.executor),
      dim: isSettled(effStatus(m, meEmail)),
    }));
}

/** ラン1本ぶんの進捗ドット。ワークアイテムはテンプレート自身の status を持たないため、
 *  担当色はテンプレートノード（allNodes 内の同id）の executor を引く。テンプレートが
 *  見当たらない（削除済み等）場合は script 扱いにフォールバックする */
export function runDots(run: Run, nodeById: Map<string, Node>, meEmail: string | null): Dot[] {
  return Object.entries(run.items)
    .map(([nodeId, item]) => {
      const tmpl = nodeById.get(nodeId);
      const executor = tmpl?.executor ?? ("script" as const);
      // 他人の番（テンプレートの assignee が他人）の waiting は橙にしない（effStatus と同じ原則）
      const st: Status =
        item.status === "waiting" && !turnIsMine(tmpl?.assignee ?? null, meEmail) ? "pending" : item.status;
      return {
        key: nodeId,
        st,
        executor,
        title: `${tmpl?.title || "（無題）"} — ${EXECUTOR_JA[executor]}の席 / ${STATUS_JA[item.status]}`,
      };
    })
    .sort(
      (a, b) => SEAT_ORDER.indexOf(seatOf(a.st, a.executor)) - SEAT_ORDER.indexOf(seatOf(b.st, b.executor)),
    )
    .map(({ key, st, executor, title }) => ({
      key,
      title,
      color: seatColor(st, executor),
      dim: isSettled(st),
    }));
}
