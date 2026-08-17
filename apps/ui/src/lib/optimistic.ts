// 楽観更新オーバーレイ（2026-08-17 本人報告「プラン済み/着手/完了ボタンの反応が遅い」）。
// 進捗ボタンは従来「PATCH の往復 → ポーリング（3〜5秒）で反映」だったため、押してから
// 見た目が変わるまで最悪数秒あった。ここは「期待値」を即座に積んで App が nodes / runs に
// 重ねて描き、サーバの応答・ポーリングを待たずに画面を変える。
// - PATCH 成功 → 取り直し（refresh）で土台が期待値に追いつくと reconcile が自動で剥がす
// - PATCH 失敗 → その場で剥がす（見た目が元に戻る。エラートーストは api() 側が出す）
// 期待値は enum/真偽値/文字列の素朴な値だけを想定する（サーバは patch した値をそのまま
// echo するので、キーごとの JSON 比較で「追いついた」を判定できる）
import { useSyncExternalStore } from "react";
import type { Node, Run, RunItemStatus } from "../types";
import { api, type NodePatchInput } from "./api";

const nodeOverlays = new Map<string, NodePatchInput>();
/** key は runId と nodeId を改行で連結したもの（id に改行は現れない） */
const runItemOverlays = new Map<string, RunItemStatus>();

let version = 0;
const listeners = new Set<() => void>();
function bump(): void {
  version++;
  for (const l of listeners) l();
}

/** オーバーレイが変わるたびに進む版数。App はこれを memo の依存に足して重ね直す */
export function useOptimisticVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}

// App が登録する「今すぐ取り直す」口（/state と ラン一覧）。連打・一括操作で
// 取り直しが N 回走らないよう、短い猶予でまとめる
let refreshState: () => void = () => {};
let refreshRuns: () => void = () => {};
let stateTimer = 0;
let runsTimer = 0;
function scheduleStateRefresh(): void {
  if (stateTimer) return;
  stateTimer = window.setTimeout(() => {
    stateTimer = 0;
    refreshState();
  }, 80);
}
function scheduleRunsRefresh(): void {
  if (runsTimer) return;
  runsTimer = window.setTimeout(() => {
    runsTimer = 0;
    refreshRuns();
  }, 80);
}

export function registerOptimisticRefreshers(fns: { state: () => void; runs: () => void }): void {
  refreshState = fns.state;
  refreshRuns = fns.runs;
}

const runItemKey = (runId: string, nodeId: string) => runId + "\n" + nodeId;

// ---- 重ね描き（App / LedgerView が取得データに被せる。オーバーレイが空なら参照そのまま） ----

export function applyNodeOverlays(nodes: Node[]): Node[] {
  if (nodeOverlays.size === 0) return nodes;
  return nodes.map((n) => {
    const o = nodeOverlays.get(n.id);
    return o ? ({ ...n, ...o } as Node) : n;
  });
}

export function applyRunOverlays(run: Run): Run {
  if (runItemOverlays.size === 0) return run;
  let items: Run["items"] | null = null;
  for (const [id, item] of Object.entries(run.items)) {
    const st = runItemOverlays.get(runItemKey(run.id, id));
    if (st !== undefined && st !== item.status) {
      items = items ?? { ...run.items };
      items[id] = { ...item, status: st };
    }
  }
  return items ? { ...run, items } : run;
}

export function applyRunListOverlays(runs: Run[]): Run[] {
  if (runItemOverlays.size === 0) return runs;
  return runs.map(applyRunOverlays);
}

export function applyRunMapOverlays(map: Record<string, Run[]>): Record<string, Run[]> {
  if (runItemOverlays.size === 0) return map;
  const out: Record<string, Run[]> = {};
  for (const [k, v] of Object.entries(map)) out[k] = applyRunListOverlays(v);
  return out;
}

// ---- 剥がし（App がポーリング結果の到着時に呼ぶ。土台が期待値に追いついた分だけ消す） ----

export function reconcileNodeOverlays(nodes: Node[]): void {
  if (nodeOverlays.size === 0) return;
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  let changed = false;
  for (const [id, o] of nodeOverlays) {
    const base = byId.get(id);
    if (!base) continue; // まだ一覧に見えていない（取得の遅れ）なら保持し続ける
    const matched = Object.entries(o).every(
      ([k, v]) => JSON.stringify((base as unknown as Record<string, unknown>)[k]) === JSON.stringify(v),
    );
    if (matched) {
      nodeOverlays.delete(id);
      changed = true;
    }
  }
  if (changed) bump();
}

export function reconcileRunOverlays(runs: Run[]): void {
  if (runItemOverlays.size === 0) return;
  let changed = false;
  for (const run of runs) {
    for (const [nodeId, item] of Object.entries(run.items)) {
      const key = runItemKey(run.id, nodeId);
      if (runItemOverlays.get(key) === item.status) {
        runItemOverlays.delete(key);
        changed = true;
      }
    }
  }
  if (changed) bump();
}

// ---- 操作（進捗ボタン等はこちらを呼ぶ。api.patchNode / api.patchRunItem の楽観版） ----

/** ノードの patch を即座に画面へ反映してからサーバへ送る。失敗時は見た目を戻して re-throw
 *  （呼び出し側の catch/ダイアログ維持の慣行は api.patchNode と同じ。トーストは api() 側） */
export async function optimisticPatchNode(id: string, fields: NodePatchInput): Promise<void> {
  const prev = nodeOverlays.get(id);
  nodeOverlays.set(id, { ...prev, ...fields });
  bump();
  try {
    await api.patchNode(id, fields);
    scheduleStateRefresh();
  } catch (e) {
    nodeOverlays.delete(id);
    bump();
    throw e;
  }
}

/** ランのワークアイテムの status 更新の楽観版（note だけの更新は従来の api を使う） */
export async function optimisticPatchRunItem(
  runId: string,
  nodeId: string,
  status: RunItemStatus,
): Promise<void> {
  const key = runItemKey(runId, nodeId);
  const prev = runItemOverlays.get(key);
  runItemOverlays.set(key, status);
  bump();
  try {
    await api.patchRunItem(runId, nodeId, { status });
    scheduleRunsRefresh();
    scheduleStateRefresh(); // 進捗の記録メッセージで threadMeta も動く
  } catch (e) {
    if (prev === undefined) runItemOverlays.delete(key);
    else runItemOverlays.set(key, prev);
    bump();
    throw e;
  }
}
