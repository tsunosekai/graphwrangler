// 左レールの行に対する操作（PageList から切り出し）。ドラッグの落とし先の書き戻し・
// フォルダ（棚）の作成/改名/削除・ページの改名/アーカイブ/削除・ラン作成/改名/打ち切り・既読。
// 行の描画（PageRow / FolderRow / RunRows）はここの関数を呼ぶだけで、api も確認ダイアログも
// 知らなくてよい。右クリックメニューは「既存操作への近道（第0層）」なので、ここで新しい
// 概念は作らず、パネル・台帳・ドラッグでできることと**同じ api・同じ確認文**を呼ぶ。
import { useRef } from "react";
import type { DragState, DropTarget, Section } from "../../hooks/useRailDnd";
import { cancelRunWithConfirm, markKeysRead, renameRunDialog } from "../../lib/actions";
import { api } from "../../lib/api";
import { confirmDialog, confirmWithAltDialog, promptDialog } from "../../lib/dialogs";
import { moveWithin, railPatches } from "../../lib/rail";
import type { RailIndex } from "../../lib/railIndex";
import { buildRemoveMessage, computeRemoveImpact, removeImpactWarnings } from "../../lib/removal";
import { isRoutinePage } from "../../lib/routine";
import { runTrigger } from "../../lib/run";
import type { Node, Run } from "../../types";
import type { RailSections } from "./sections";
import { isArchivedPage } from "./sections";

export interface PageActionsDeps {
  allNodes: Node[];
  pageRuns: Record<string, Run[]>;
  threadMeta: Record<string, string>;
  rail: RailIndex;
  sections: RailSections;
  onMutated: () => void;
  onViewed: (key: string, lastTs: string | null) => void;
  onRunsMutated: () => void;
  onSelectRun: (pageId: string, runId: string) => void;
}

export interface PageActions {
  applyDrop: (st: DragState, target: DropTarget) => Promise<void>;
  addFolder: (section: Section) => Promise<void>;
  renameFolder: (f: Node) => Promise<void>;
  removeFolder: (f: Node) => Promise<void>;
  renamePage: (f: Node) => Promise<void>;
  /** 指定キーを既読にする（サーバへ送る + ローカル上書きで即バッジを消す） */
  markRead: (keys: string[]) => void;
  moveToFolder: (f: Node, folderId: string | null) => Promise<void>;
  setPageArchived: (f: Node, archived: boolean) => Promise<void>;
  removePage: (f: Node) => Promise<void>;
  runPage: (f: Node, trigger: Node) => Promise<void>;
  renameRun: (r: Run) => Promise<void>;
  cancelRun: (r: Run) => Promise<void>;
}

export function usePageActions({
  allNodes,
  pageRuns,
  threadMeta,
  rail,
  sections,
  onMutated,
  onViewed,
  onRunsMutated,
  onSelectRun,
}: PageActionsDeps): PageActions {
  const { folderOf, inFolder, pageIdsIn, sectionOf, shelvesIn } = sections;

  /** 落とした結果の並びを order（と必要なら folder）へ書き戻す。変わった行だけ patch する */
  const applyOrder = async (orderedIds: string[], folder?: string | null) => {
    const patches = railPatches(orderedIds, rail.nodeById, folder);
    if (patches.length === 0) return;
    for (const p of patches) {
      try {
        await api.patchNode(p.id, p.patch);
      } catch {
        break; // エラーは api 側でトースト済み。中途半端な連打は避けて止める
      }
    }
    onMutated();
  };

  const applyDrop = async (st: DragState, target: DropTarget) => {
    if (st.kind === "folder") {
      // 棚同士の並べ替え（resolveDrop が同じ節の棚行 + before|after だけを通す）
      const ordered = moveWithin(
        shelvesIn(st.section).map((f) => f.id),
        st.id,
        target.id,
        target.pos === "before" ? "before" : "after",
      );
      await applyOrder(ordered);
      return;
    }
    // ページ: 行き先の入れ物（棚 / 節の直下）を決める。節は落とし先の節（＝掴んだページと同じ）
    const section: Section = target.section;
    const targetNode = target.kind === "page" ? (rail.nodeById.get(target.id) ?? null) : null;
    const folderId = target.kind === "folder" ? target.id : targetNode ? folderOf(targetNode) : null;
    const siblings = pageIdsIn(section, folderId).filter((id) => id !== st.id);
    const ordered =
      target.kind === "page"
        ? moveWithin([...siblings, st.id], st.id, target.id, target.pos === "before" ? "before" : "after")
        : [...siblings, st.id];
    await applyOrder(ordered, folderId);
  };

  // ---- フォルダの作成・リネーム・削除 ----
  const addFolder = async (section: Section) => {
    const name = await promptDialog(
      section === "routine" ? "新しいルーティーンのフォルダ名" : "新しいフォルダの名前",
      { placeholder: section === "routine" ? "例: 定期レポート" : "例: 受託", confirmLabel: "作成" },
    );
    if (name === null || !name.trim()) return;
    try {
      await api.addNode({
        title: name.trim(),
        kind: "folder",
        // null = プロジェクト節（既存データと同じ意味）。ルーティーン棚だけ明示する
        folderSection: section === "routine" ? "routine" : null,
        order: shelvesIn(section).length,
      });
      onMutated();
    } catch {
      // api 側でトースト済み
    }
  };
  const renameFolder = async (f: Node) => {
    const name = await promptDialog("フォルダ名", { defaultValue: f.title, confirmLabel: "変更" });
    if (name === null || !name.trim() || name.trim() === f.title) return;
    try {
      await api.patchNode(f.id, { title: name.trim() });
      onMutated();
    } catch {
      // api 側でトースト済み
    }
  };
  const removeFolder = async (f: Node) => {
    const count = inFolder(f.id).length;
    const ok = await confirmDialog(
      count > 0
        ? `フォルダ「${f.title || "（無題）"}」を削除しますか？\n中の ${count} 件は消えず、直下へ出ます。`
        : `フォルダ「${f.title || "（無題）"}」を削除しますか？`,
      { danger: true, confirmLabel: "削除" },
    );
    if (!ok) return;
    try {
      await api.removeNode(f.id, { force: true });
      onMutated();
    } catch {
      // api 側でトースト済み
    }
  };

  /** ページ名の変更。フォルダ行の✎（renameFolder）と同じ流儀 */
  const renamePage = async (f: Node) => {
    const name = await promptDialog(
      isRoutinePage(f, rail.membersOf(f.id)) ? "ルーティーン名" : "プロジェクト名",
      { defaultValue: f.title, confirmLabel: "変更" },
    );
    if (name === null || !name.trim() || name.trim() === f.title) return;
    try {
      await api.patchNode(f.id, { title: name.trim() });
      onMutated();
    } catch {
      // api 側でトースト済み
    }
  };

  const markRead = (keys: string[]) => {
    markKeysRead(keys, threadMeta, onViewed);
  };

  /** メニューの「フォルダへ移動」。ドラッグで棚へ落としたのと同じ結果（folder + order）に
   *  なるよう、落とし先の末尾へ置く applyDrop と同じ計算を通す */
  const moveToFolder = async (f: Node, folderId: string | null) => {
    const siblings = pageIdsIn(sectionOf(f), folderId).filter((id) => id !== f.id);
    await applyOrder([...siblings, f.id], folderId);
  };

  /** アーカイブ（節の出し入れ）。専用APIは無く status からの導出なので patch で切り替える */
  const setPageArchived = async (f: Node, archived: boolean) => {
    try {
      await api.patchNode(f.id, { status: archived ? "done" : "pending" });
      onMutated();
    } catch {
      // api 側でトースト済み
    }
  };

  /** ページの削除。メンバーの巻き添えはサーバ（force）が面倒を見るので、こちらは
   *  NodePanel の削除と同じ警告（removeImpactWarnings）を出すだけにする。
   *  アーカイブ済みでないページには「消さずにアーカイブする」を推しとして並べる
   *  （2026-08-09 本人要望。ページは会話も実行履歴もぶら下げた重い単位で、消すのは
   *  ほとんどの場合やりすぎ——既定の出口をアーカイブにする） */
  const removePage = async (f: Node) => {
    const impact = computeRemoveImpact([f.id], allNodes);
    const canArchive = !isArchivedPage(f);
    const choice = await confirmWithAltDialog(
      buildRemoveMessage(
        `「${f.title || "（無題）"}」を削除しますか？（Ctrl+Z で戻せます）`,
        removeImpactWarnings(impact),
      ),
      {
        danger: true,
        confirmLabel: "削除",
        ...(canArchive ? { alt: { label: "アーカイブする" } } : {}),
      },
    );
    if (choice === "alt") {
      await setPageArchived(f, true);
      return;
    }
    if (choice !== "confirm") return;
    try {
      await api.removeNode(f.id, { force: true });
      onMutated();
    } catch {
      // api 側でトースト済み
    }
  };

  /** ラン作成（ルーティーンページのトリガー）。フォームと確認文は lib/run.ts に集約してあり、
   *  カードの▶と同じものが出る。生まれたランのページへはラン子行クリックと同じ経路で移る */
  const firingRef = useRef(false);
  const runPage = async (f: Node, trigger: Node) => {
    if (firingRef.current) return; // 連打の幽霊ラン防止（カードの▶の firing と同じ役目）
    firingRef.current = true;
    try {
      const runs = pageRuns[f.id] ?? [];
      const run = await runTrigger(trigger, {
        runningRunCount: runs.filter((r) => r.status === "running").length,
        lastRunContext: runs[0]?.context ?? null,
      });
      if (!run) return;
      onMutated();
      onRunsMutated(); // 生まれたばかりのランは一覧にまだ載っていない
      onSelectRun(f.id, run.id);
    } finally {
      firingRef.current = false;
    }
  };

  /** ラン名の変更。台帳（LedgerView）の✎・グラフ上部の✎と同じダイアログ・同じ api */
  const renameRun = async (r: Run) => {
    if (!(await renameRunDialog(r))) return;
    onRunsMutated();
    onMutated();
  };

  /** ランの打ち切り。今は台帳タブでしかできない操作の近道（確認文も台帳と同じ） */
  const cancelRun = async (r: Run) => {
    if (!(await cancelRunWithConfirm(r))) return;
    onRunsMutated();
    onMutated();
  };

  return {
    applyDrop,
    addFolder,
    renameFolder,
    removeFolder,
    renamePage,
    markRead,
    moveToFolder,
    setPageArchived,
    removePage,
    runPage,
    renameRun,
    cancelRun,
  };
}
