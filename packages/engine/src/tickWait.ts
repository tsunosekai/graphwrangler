// 待ちノード（kind=wait）の配線。判定は wait.ts（純粋関数）、ここはその結果を API へ書くだけ。
// docs/design.md 3.17。
import { listPageRuns, patchNode, patchRunItem, postMessage } from "./api.js";
import { ENGINE_ACTOR, VIA } from "./actor.js";
import { log } from "./log.js";
import { triggerPageIds } from "./pick.js";
import { selectWaitActions, waitNote } from "./wait.js";
import type { Node, Run } from "./types.js";

/** 待ち方が解釈できないときにスレッドへ残す一言。黙って止まると「なぜ進まないか」が
 *  誰にも見えないので、人の目に入る形にする */
function invalidWaitBody(node: Node): string {
  return node.wait
    ? `待ち方 "${node.wait}" を解釈できないため、この待ちは始められません。パネルの「待ち方」を直してください`
    : "待ち方が設定されていないため、この待ちは始められません。パネルの「待ち方」を設定してください";
}

/**
 * 待ちノードを1周ぶん処理する。待ちノードが1つも無ければ何もしない（API も叩かない）。
 * ラン一覧は待ちノードのあるページだけ取る。
 */
export async function tickWait(nodes: Node[]): Promise<void> {
  const waits = nodes.filter((n) => n.kind === "wait" && n.lifecycle === "committed");
  if (waits.length === 0) return;

  const triggerPages = triggerPageIds(nodes);
  const pages = new Set(waits.map((n) => n.group).filter((g): g is string => !!g && triggerPages.has(g)));
  const runs: Run[] = [];
  for (const pageId of pages) {
    try {
      runs.push(...(await listPageRuns(pageId)).filter((r) => r.status === "running"));
    } catch (err) {
      log(`待ちノード: ラン一覧取得に失敗（この周は除外）: page=${pageId} ${String(err)}`);
    }
  }

  for (const action of selectWaitActions(nodes, runs, triggerPages, new Date())) {
    const { node, run } = action;
    const where = run ? `run=${run.id} ` : "";
    try {
      if (action.type === "start") {
        const waitUntil = action.until.toISOString();
        const note = waitNote(action.until);
        if (run) {
          await patchRunItem(run.id, node.id, { status: "running", note, waitUntil }, ENGINE_ACTOR, VIA);
        } else {
          await patchNode(node.id, { status: "running", waitUntil }, ENGINE_ACTOR, VIA);
        }
        log(`待ち開始: ${where}node=${node.id} title=${node.title} ${note}`);
      } else if (action.type === "finish") {
        if (run) {
          await patchRunItem(run.id, node.id, { status: "done", note: "待ち明け" }, ENGINE_ACTOR, VIA);
        } else {
          await patchNode(node.id, { status: "done" }, ENGINE_ACTOR, VIA);
        }
        log(`待ち明け: ${where}node=${node.id} title=${node.title}`);
      } else {
        if (run) {
          await patchRunItem(
            run.id,
            node.id,
            { status: "waiting", note: "待ち方が未設定・解釈不能" },
            ENGINE_ACTOR,
            VIA,
          );
        } else {
          // プロジェクト層: 「やり方未定（未計画）」へ戻す。直して計画済みにすれば、また対象になる
          await patchNode(node.id, { status: "unplanned" }, ENGINE_ACTOR, VIA);
        }
        await postMessage(
          node.id,
          { kind: "status", body: invalidWaitBody(node), ...(run ? { runId: run.id } : {}) },
          ENGINE_ACTOR,
          VIA,
        );
        log(`待ち方を解釈できない: ${where}node=${node.id} wait="${node.wait ?? ""}"`);
      }
    } catch (err) {
      log(`待ちノードの更新に失敗（次周に持ち越し）: ${where}node=${node.id} ${String(err)}`);
    }
  }
}
