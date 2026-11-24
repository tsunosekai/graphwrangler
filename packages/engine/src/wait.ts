// 待ちノード（kind=wait）の判定。ネットワークI/Oを持たない純粋関数のみ（vitest の対象）。
// docs/design.md 3.17。配線（API への書き込み）は tickWait.ts。
//
// 待ちノードは「誰も何もしないが、時刻が来るまで先へ進ませない」ステップ。順番が回ってきたら
// 明ける時刻（waitUntil）を一度だけ決めて running にし、その時刻を過ぎたら done にする。
// 明ける時刻を先に決めて保存しておくので、エンジンが止まっていても（PC の電源断・スリープ）
// 起きたときに時刻を見比べるだけで正しく進む＝取りこぼしが構造的に無い。
import { parseWait, type ParsedWait } from "@graphwrangler/core";
import { isFrontier, isRunManagedMember } from "./pick.js";
import { targetTimeOn } from "./schedule.js";
import type { Node, Run } from "./types.js";

/** until の探索で先を見る日数（年1回の書式でも1年ちょっとで必ず当たる） */
const UNTIL_LOOKAHEAD_DAYS = 400;

/**
 * 待ちが明ける時刻を決める（純粋関数）。
 * - after（時間）: readyAt（順番が回ってきた時刻）＋その時間
 * - afterDays: readyAt の日付の N 日後の、指定時刻。**すでに過ぎていれば readyAt**
 *   （"after 0d 09:00" を 10:00 に迎えた等。翌日へ送らず、すぐ明ける）
 * - until: anchor より後で最初の、その暦の日時。anchor はランなら**ランの作成時刻**——
 *   「1日に始まったランの、次の9日」を指したいのであって、前のステップが遅れて10日に
 *   順番が回ってきたとき来月の9日まで待たせたいわけではない（そのときは既に過ぎているので
 *   すぐ明ける）。見つからなければ readyAt
 */
export function resolveWaitUntil(wait: ParsedWait, readyAt: Date, anchor: Date): Date {
  if (wait.type === "after") return new Date(readyAt.getTime() + wait.ms);

  if (wait.type === "afterDays") {
    const target = new Date(readyAt.getFullYear(), readyAt.getMonth(), readyAt.getDate() + wait.days);
    target.setHours(wait.hour, wait.minute, 0, 0);
    return target.getTime() > readyAt.getTime() ? target : readyAt;
  }

  const schedule = wait.schedule;
  if (schedule.type === "once") {
    return new Date(schedule.year, schedule.month - 1, schedule.day, schedule.hour, schedule.minute, 0, 0);
  }
  for (let ahead = 0; ahead <= UNTIL_LOOKAHEAD_DAYS; ahead++) {
    const day = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + ahead);
    const target = targetTimeOn(schedule, day);
    if (target && target.getTime() > anchor.getTime()) return target;
  }
  return readyAt;
}

/** スレッドやカードに残す一言（「12/9(水) 09:00 まで待機」）。ローカル時刻で書く */
export function waitNote(until: Date): string {
  const dow = ["日", "月", "火", "水", "木", "金", "土"][until.getDay()];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${until.getMonth() + 1}/${until.getDate()}(${dow}) ${pad(until.getHours())}:${pad(until.getMinutes())} まで待機`;
}

export type WaitAction =
  /** 順番が回ってきた。明ける時刻を決めて running にする（run が null ならプロジェクト層） */
  | { type: "start"; node: Node; run: Run | null; until: Date }
  /** 明ける時刻を過ぎた。done にして下流を進める */
  | { type: "finish"; node: Node; run: Run | null }
  /** 待ち方が空・解釈できない。待てないので、黙って止まる代わりに人の目に入る形で知らせる */
  | { type: "invalid"; node: Node; run: Run | null };

/** ラン内依存が揃っているか（pickRun.ts の dependenciesSettled と同じ定義） */
function runDependenciesSettled(node: Node, run: Run): boolean {
  return node.parents
    .filter((pid) => pid in run.items)
    .every((pid) => {
      const status = run.items[pid]?.status;
      return status === "done" || status === "skipped";
    });
}

/**
 * 今この周に処理すべき待ちノードを全部返す（純粋関数）。待ちは実行を伴わず軽いので、
 * 「1tick=1件」の枠に入れず毎周まとめて処理する（長い AI 実行の後ろで待ちが明けない、を避ける）。
 *
 * 対象は lifecycle=committed の kind=wait だけ（下書きは自動で進めない。3.4 の原則）。
 * - ラン層: running のランの中で、依存が揃った待ちアイテム
 * - プロジェクト層: ルーティーンのメンバーでない待ちノードで、親が全部 done/skipped のもの
 */
export function selectWaitActions(
  nodes: Node[],
  runs: Run[],
  triggerPages: Set<string>,
  now: Date,
): WaitAction[] {
  const actions: WaitAction[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const due = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() <= now.getTime();

  for (const run of runs) {
    if (run.status !== "running") continue;
    for (const [nodeId, item] of Object.entries(run.items)) {
      const node = byId.get(nodeId);
      if (!node || node.kind !== "wait" || node.lifecycle !== "committed") continue;
      if (item.status === "running" && item.waitUntil) {
        if (due(item.waitUntil)) actions.push({ type: "finish", node, run });
        continue;
      }
      if (item.status !== "pending" && !(item.status === "running" && !item.waitUntil)) continue;
      if (!runDependenciesSettled(node, run)) continue;
      const parsed = node.wait ? parseWait(node.wait) : null;
      if (!parsed) {
        // 同じ警告を毎周積まないよう、知らせるのは pending のときだけ（知らせたら waiting に倒す）
        if (item.status === "pending") actions.push({ type: "invalid", node, run });
        continue;
      }
      actions.push({ type: "start", node, run, until: resolveWaitUntil(parsed, now, new Date(run.created)) });
    }
  }

  for (const node of nodes) {
    if (node.kind !== "wait" || node.lifecycle !== "committed") continue;
    if (isRunManagedMember(node, triggerPages)) continue; // テンプレートはラン側が進める
    if (node.pendingRequest) continue;
    if (node.status === "running" && node.waitUntil) {
      if (due(node.waitUntil)) actions.push({ type: "finish", node, run: null });
      continue;
    }
    if (node.status !== "pending" && !(node.status === "running" && !node.waitUntil)) continue;
    if (!isFrontier(node, byId)) continue;
    const parsed = node.wait ? parseWait(node.wait) : null;
    if (!parsed) {
      if (node.status === "pending") actions.push({ type: "invalid", node, run: null });
      continue;
    }
    // プロジェクト層にはランが無いので、until の起点も「順番が回ってきた今」
    actions.push({ type: "start", node, run: null, until: resolveWaitUntil(parsed, now, now) });
  }
  return actions;
}
