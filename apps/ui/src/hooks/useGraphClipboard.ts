// ---- Ctrl+C/Ctrl+V/Ctrl+D 用のアプリ内クリップボード（モジュール変数。ページを跨いでも保持する） ----
import { useCallback, useState, type MutableRefObject } from "react";
import { api } from "../lib/api";
import { pushToast } from "../lib/toast";
import type { Pos } from "../lib/layout";
import type { Node } from "../types";

interface ClipboardNode {
  origId: string;
  title: string;
  detail: string | null;
  impl: Node["impl"];
  executor: Node["executor"];
  approval: Node["approval"];
  autonomy: Node["autonomy"];
  kind: Node["kind"];
  /** kind=decision のときの選択肢定義（コピーで引き継ぐ。他kindではnull。docs/design.md 3.9） */
  branches: Node["branches"];
  /** ランのコンテキストへの出力宣言（コピーで引き継ぐ。docs/design.md 3.15） */
  outputs: Node["outputs"];
  /** コピー元選択内で閉じた依存だけを覚える（外部への parents は貼り付け時に捨てる） */
  parentOrigIds: string[];
  /** parentOrigIds のうち親がdecisionのものについて、どの枝から生えるか（親id → 枝id） */
  parentOptions: Node["parentOptions"];
  pos: Pos;
}
let clipboard: ClipboardNode[] = [];

interface Params {
  /** 表示中ページのメンバー */
  nodes: Node[];
  /** 貼り付け/複製で作る新規ノードの所属先ページ */
  pageNode: Node | null;
  /** 現在選択中のノードid一覧（React Flow の内部 selected フラグから） */
  getSelectedNodeIds: () => string[];
  /** ノードid → 現在位置。コピー元の位置を覚え、貼り付け位置のオフセット計算に使う */
  positionsRef: MutableRefObject<Map<string, Pos>>;
  /** 新規ノードの「置きたい位置」予約。次のレイアウト再計算時に一度だけ適用される */
  overridesRef: MutableRefObject<Map<string, Pos>>;
  /** 貼り付け/複製で作った新規ノード群を、サーバから戻ってきた時点で選択状態にするための予約 */
  pendingSelectRef: MutableRefObject<Set<string> | null>;
  onMutated: () => void;
}

export function useGraphClipboard({
  nodes,
  pageNode,
  getSelectedNodeIds,
  positionsRef,
  overridesRef,
  pendingSelectRef,
  onMutated,
}: Params) {
  // クリップボード（モジュール変数）の中身の有無。ペインのメニューに「貼り付け」を
  // 出すかの判定に使う——モジュール変数のままでは Ctrl+C しても再レンダーが起きない
  const [hasClipboard, setHasClipboard] = useState(clipboard.length > 0);

  // Ctrl+C/Ctrl+D 共通: 選択中の id 群を ClipboardNode 群へ写し取る（thread は持たない。
  // 新規ノードとして貼り付ける）
  const buildClipboardEntries = useCallback(
    (ids: string[]): ClipboardNode[] => {
      const idSet = new Set(ids);
      return ids
        .map((id) => nodes.find((n) => n.id === id))
        .filter((n): n is Node => !!n)
        .map((n) => ({
          origId: n.id,
          title: n.title,
          detail: n.detail,
          impl: n.impl,
          executor: n.executor,
          approval: n.approval,
          autonomy: n.autonomy,
          kind: n.kind,
          // kind=decision の選択肢定義はそのまま引き継ぐ（無いと貼り付け時にサーバ検証で弾かれる）
          branches: n.branches,
          outputs: n.outputs,
          // 選択内で閉じた依存だけ覚える。外部への parents は貼り付け時に捨てる
          parentOrigIds: n.parents.filter((p) => idSet.has(p)),
          // 同様に、選択内で閉じたdecision親への枝の対応だけ引き継ぐ
          parentOptions: Object.fromEntries(
            Object.entries(n.parentOptions).filter(([decisionId]) => idSet.has(decisionId)),
          ),
          pos: positionsRef.current.get(n.id) ?? { x: 0, y: 0 },
        }));
    },
    [nodes, positionsRef],
  );

  // Ctrl+C: 選択ノードをモジュール変数のクリップボードへ
  const copySelection = useCallback(() => {
    const ids = getSelectedNodeIds();
    if (ids.length === 0) return;
    const entries = buildClipboardEntries(ids);
    clipboard = entries;
    setHasClipboard(entries.length > 0);
    pushToast(`${entries.length}件コピーしました`, "info");
  }, [buildClipboardEntries, getSelectedNodeIds]);

  // Ctrl+V/Ctrl+D 共通: エントリ群を新規ノードとして作り、選択内で閉じた依存だけ張り替える。
  // id はサーバ採番なので、まず全部作ってから旧id→新idマップで parents/parentOptions を patch する
  const materializeClipboard = useCallback(
    async (entries: ClipboardNode[], label: string) => {
      if (entries.length === 0) return;
      const idMap = new Map<string, string>();
      const createdIds: string[] = [];
      for (const entry of entries) {
        const created = await api.addNode({
          title: entry.title,
          detail: entry.detail,
          impl: entry.impl,
          executor: entry.executor,
          approval: entry.approval,
          autonomy: entry.autonomy,
          kind: entry.kind,
          branches: entry.branches,
          outputs: entry.outputs,
          group: pageNode?.id ?? null,
          lifecycle: "draft",
          status: "pending",
        });
        idMap.set(entry.origId, created.id);
        createdIds.push(created.id);
        // 元の位置+40pxオフセット。次のレイアウト再計算時に一度だけ適用される（handleConnectEnd と同じ仕組み）
        overridesRef.current.set(created.id, { x: entry.pos.x + 40, y: entry.pos.y + 40 });
      }
      for (const entry of entries) {
        const newParents = entry.parentOrigIds
          .map((pid) => idMap.get(pid))
          .filter((x): x is string => !!x);
        if (newParents.length === 0) continue;
        const newId = idMap.get(entry.origId);
        if (!newId) continue;
        const newParentOptions = Object.fromEntries(
          Object.entries(entry.parentOptions)
            .map(([oldDecisionId, branchId]) => [idMap.get(oldDecisionId), branchId] as const)
            .filter((pair): pair is [string, string] => !!pair[0]),
        );
        await api.patchNode(newId, { parents: newParents, parentOptions: newParentOptions });
      }
      // 作成したノード群がポーリングで出現したら選択する（App の selectedId は1件しか運べないため）
      pendingSelectRef.current = new Set(createdIds);
      onMutated();
      pushToast(`${createdIds.length}件${label}しました（Ctrl+Zで戻せます）`, "info");
    },
    [pageNode, overridesRef, pendingSelectRef, onMutated],
  );

  const pasteClipboard = useCallback(
    () => materializeClipboard(clipboard, "貼り付け"),
    [materializeClipboard],
  );

  // Ctrl+D: Ctrl+C→Ctrl+V 相当を一発で（モジュール変数のクリップボードは書き換えない）
  const duplicateSelection = useCallback(() => {
    const ids = getSelectedNodeIds();
    if (ids.length === 0) return Promise.resolve();
    return materializeClipboard(buildClipboardEntries(ids), "複製");
  }, [buildClipboardEntries, getSelectedNodeIds, materializeClipboard]);

  // Ctrl+V のガード用。モジュール変数を直接見る（hasClipboard は再レンダー用の写しなので、
  // 判定の正本はこちら）
  const canPaste = useCallback(() => clipboard.length > 0, []);

  return { hasClipboard, canPaste, copySelection, pasteClipboard, duplicateSelection };
}
