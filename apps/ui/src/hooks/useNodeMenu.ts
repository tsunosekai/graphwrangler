// ---- 右クリックメニュー（第0層＝既存操作への近道。docs/design.md 4章の視距離3層に
//      新しい階を増やさない）。ここに新しい判断は置かず、ショートカット処理・
//      カードのボタン・パネルと同じ関数を呼ぶだけにする ----
import { useCallback, useMemo } from "react";
import { api } from "../lib/api";
import {
  collectDescendants,
  copyText,
  deletionOrder,
  hasUnread,
  markKeysRead,
  nodeUrl,
  readKeysForNode,
} from "../lib/actions";
import { confirmDialog } from "../lib/dialogs";
import { TRIAL_CONFIRM_MESSAGE } from "../lib/hints";
import { buildRemoveMessage, computeRemoveImpact, removeImpactWarnings } from "../lib/removal";
import { pushToast } from "../lib/toast";
import type { Node } from "../types";
import type { NodeMenuActions } from "../components/NodeCard";

interface Params {
  nodes: Node[];
  pageNode: Node | null;
  /** ランのページを開いているか（開いている間はテンプレート編集系の項目を出さない） */
  runView: { id: string } | null;
  /** 「ページへ移動 ▸」の候補（App が算出して渡す） */
  movePages: Node[];
  threadMeta: Record<string, string>;
  reads: Record<string, string>;
  onViewed: (key: string, lastTs: string | null) => void;
  onMutated: () => void;
  getSelectedNodeIds: () => string[];
  applySelection: (ids: string[]) => void;
  setEditingId: (id: string) => void;
  createNode: (parentId: string | null) => Promise<void>;
  duplicateSelection: () => Promise<void>;
  deleteSelectedNodes: () => Promise<void>;
  removeLeafFirst: (ids: string[]) => Promise<string[]>;
}

export function useNodeMenu({
  nodes,
  pageNode,
  runView,
  movePages,
  threadMeta,
  reads,
  onViewed,
  onMutated,
  getSelectedNodeIds,
  applySelection,
  setEditingId,
  createNode,
  duplicateSelection,
  deleteSelectedNodes,
  removeLeafFirst,
}: Params): { contextMenuEnabled: boolean; nodeMenu: NodeMenuActions | undefined } {
  // 粗いポインタ（タッチ主体）の環境では出さない: このペインのパン/ピンチは自前の touch
  // ハンドラが持っていて（useMobilePanZoom）、Radix の長押しメニューと重なると
  // 「パンしたつもりでメニューが出る」が起きやすい。右クリックのある環境だけの機能にする。
  // 幅ではなくポインタ種別で判定する——幅の狭いデスクトップ窓ではメニューを使えるように
  const contextMenuEnabled = useMemo(
    () => !window.matchMedia?.("(pointer: coarse)").matches,
    [],
  );

  /** 右クリックしたノードが未選択なら単独選択に切り替える。選択に含まれていればそのまま
   *  ——選択内での右クリックが選択を壊さないのはノードエディタ共通の流儀で、これにより
   *  「複製」「削除」が既存の選択ベースのハンドラをそのまま呼べる */
  const focusNodeForMenu = useCallback(
    (id: string) => {
      if (!getSelectedNodeIds().includes(id)) applySelection([id]);
    },
    [getSelectedNodeIds, applySelection],
  );

  // 「ここから下を全部 ▸」を出すかの判定はカードの描画ごとに要るので、ページのノードが
  // 変わったときにまとめて数えておく
  const descendantCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes) m.set(n.id, collectDescendants(nodes, n.id).size);
    return m;
  }, [nodes]);

  // 既読にする（テンプレート + そのノードの全ランぶん）。postReads は投げっぱなしなので、
  // onViewed（App のローカル上書き）でその場のバッジを消す——左レール・台帳と同じ経路
  const markNodeRead = useCallback(
    (id: string) => {
      markKeysRead(readKeysForNode(id, threadMeta), threadMeta, onViewed);
    },
    [threadMeta, onViewed],
  );

  const copyWithToast = useCallback(async (text: string, label: string) => {
    const ok = await copyText(text);
    pushToast(ok ? `${label}をコピーしました` : `${label}をコピーできませんでした`, ok ? "info" : "error");
  }, []);

  // 担当変更（NodePanel の担当 Select と同じ patch）。script 化のときだけ試走ゲートの確認を
  // 通す（NodePanel:685-693 の confirmPromotionIfNeeded と同じ趣旨。TRIAL_CONFIRM_MESSAGE は
  // NodePanel:108 の同名メッセージと同じ文面——パネルとメニューで別々の言い回しにしないための
  // 複製で、値の正本はパネル側）。実装ハッシュの突き合わせ（パネルの implStatus）までは
  // しないので、試走が成功済みでなければ確認する＝パネルより安全側に倒れるだけで、
  // 素通しにはならない
  const setNodeExecutor = useCallback(
    async (id: string, executor: Node["executor"]) => {
      const n = nodes.find((x) => x.id === id);
      if (!n || n.executor === executor) return;
      if (executor === "script") {
        const verified = n.impl?.type === "script" && n.implTrial?.success === true;
        if (!verified && !(await confirmDialog(TRIAL_CONFIRM_MESSAGE, { confirmLabel: "続ける" }))) return;
      }
      await api.patchNode(id, { executor });
      onMutated();
    },
    [nodes, onMutated],
  );

  // 別ページへ移動（BulkPanel の「ページへ移動」と同じ group の patch）
  const moveNodeToPage = useCallback(
    async (id: string, target: string) => {
      await api.patchNode(id, { group: target });
      onMutated();
      pushToast("ページへ移動しました（Ctrl+Zで戻せます）", "info");
    },
    [onMutated],
  );

  // 「ここから下を全部 → 計画済みにする」: 子孫のうち下書き（lifecycle=draft）だけを確定する。
  // patch の中身はカードの「計画済みにする」・BulkPanel の commitAll と同じ
  const commitDescendants = useCallback(
    async (id: string) => {
      const ids = collectDescendants(nodes, id);
      const targets = nodes.filter((n) => ids.has(n.id) && n.lifecycle === "draft");
      if (targets.length === 0) {
        pushToast("下書きのノードはありません", "info");
        return;
      }
      let ok = 0;
      for (const n of targets) {
        try {
          // トリガーは進捗を持たない（lifecycle だけ確定する）
          await api.patchNode(
            n.id,
            n.kind === "trigger" ? { lifecycle: "committed" } : { status: "pending", lifecycle: "committed" },
          );
          ok++;
        } catch {
          // api() 側でトースト表示済み（残りに適用を続ける）
        }
      }
      onMutated();
      pushToast(`${ok}件を計画済みにしました`, "info");
    },
    [nodes, onMutated],
  );

  // 「ここから下を全部 → 削除」: 子孫 + 自分を葉から順に消す。確認モーダルは通常の削除と
  // 同じ組み立て（巻き添え・ロック・切り離しの警告 + Ctrl+Z の案内）に件数を足したもの
  const removeSubtree = useCallback(
    async (id: string) => {
      const set = collectDescendants(nodes, id);
      set.add(id);
      const ids = deletionOrder(nodes, set);
      let warnings: string[] = [];
      try {
        const state = await api.getState();
        warnings = removeImpactWarnings(computeRemoveImpact(ids, state.nodes));
      } catch {
        // 状態の取り直しに失敗しても削除自体は進める（api() 側でトースト表示済み）
      }
      const ok = await confirmDialog(
        buildRemoveMessage(
          `このノードと下の ${ids.length - 1} 件、合わせて ${ids.length} 件を削除しますか？（Ctrl+Z で戻せます）`,
          warnings,
        ),
        { danger: true, confirmLabel: "削除" },
      );
      if (!ok) return;
      const deleted = await removeLeafFirst(ids);
      applySelection([]);
      onMutated();
      if (deleted.length > 0) pushToast(`${deleted.length}件削除しました（Ctrl+Zで戻せます）`, "info");
    },
    [nodes, removeLeafFirst, applySelection, onMutated],
  );

  // 試走（NodePanel の試走ボタンと同じ api・同じ文面）
  const runTrial = useCallback(
    async (id: string) => {
      try {
        const result = await api.trialNode(id);
        onMutated();
        pushToast(
          result.success ? "テスト成功" : `テスト失敗（exit ${result.exitCode ?? "?"}）`,
          result.success ? "info" : "error",
        );
      } catch {
        // api() 側でトースト表示済み
      }
    },
    [onMutated],
  );

  const nodeMenu = useMemo<NodeMenuActions | undefined>(() => {
    if (!contextMenuEnabled) return undefined;
    return {
      onOpen: focusNodeForMenu,
      rename: (id) => setEditingId(id),
      addChild: (id) => void createNode(id),
      duplicate: () => void duplicateSelection(),
      remove: () => void deleteSelectedNodes(),
      hasUnread: (id) => hasUnread(readKeysForNode(id, threadMeta), threadMeta, reads),
      markRead: markNodeRead,
      copyLink: (id) =>
        void copyWithToast(
          nodeUrl({ pageId: pageNode?.id ?? null, nodeId: id, runId: runView?.id ?? null }),
          "リンク",
        ),
      copyId: (id) => void copyWithToast(id, "ID"),
      setExecutor: (id, executor) => void setNodeExecutor(id, executor),
      // ランのページではテンプレートを書き換えないので移動先も出さない
      movePages: runView ? [] : movePages.map((p) => ({ id: p.id, title: p.title || "（無題）" })),
      moveToPage: (id, target) => void moveNodeToPage(id, target),
      descendantCount: (id) => descendantCounts.get(id) ?? 0,
      commitDescendants: (id) => void commitDescendants(id),
      removeSubtree: (id) => void removeSubtree(id),
      trial: (id) => void runTrial(id),
    };
  }, [
    contextMenuEnabled,
    focusNodeForMenu,
    setEditingId,
    createNode,
    duplicateSelection,
    deleteSelectedNodes,
    threadMeta,
    reads,
    markNodeRead,
    copyWithToast,
    pageNode,
    runView,
    setNodeExecutor,
    movePages,
    moveNodeToPage,
    descendantCounts,
    commitDescendants,
    removeSubtree,
    runTrial,
  ]);

  return { contextMenuEnabled, nodeMenu };
}
