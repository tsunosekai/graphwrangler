import { useEffect } from "react";
import type { Node } from "../types";

/** 入力欄・ダイアログ・ChatDrawer にフォーカスがある間はショートカットを無効にする */
function isShortcutBlocked(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  if (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  ) {
    return true;
  }
  // radix Dialog(CommandPalette/SetupModal/ShortcutsDialog等)は role="dialog" を持つ
  if (target.closest('[role="dialog"]')) return true;
  // ChatDrawer のルート要素に data-shortcuts-block を付けてある
  if (target.closest("[data-shortcuts-block]")) return true;
  return false;
}

interface Params {
  nodes: Node[];
  /** 選択中の依存エッジ（Delete/Backspace の切断対象）。無ければノード削除に回る */
  selectedEdgeId: string | null;
  setSelectedEdgeId: (id: string | null) => void;
  setEditingId: (id: string | null) => void;
  setShortcutsOpen: (open: boolean) => void;
  getSelectedNodeIds: () => string[];
  applySelection: (ids: string[]) => void;
  cutEdge: (source: string, target: string) => Promise<void>;
  runUndo: () => Promise<void>;
  runRedo: () => Promise<void>;
  deleteSelectedNodes: () => Promise<void>;
  copySelection: () => void;
  canPaste: () => boolean;
  pasteClipboard: () => Promise<void>;
  duplicateSelection: () => Promise<void>;
  fitSelectionOrAll: () => void;
  realign: () => void;
  createNode: (parentId: string | null) => Promise<void>;
  createNodeAtCenter: () => Promise<void>;
  /** 選択中ノードがこのページのタスクならその id（Tab でその後続として作る） */
  selectedInPage: string | null;
}

// ---- ノードエディタ標準のキーボードショートカット（Houdini/Blender/ComfyUI 準拠）。
//      window で一元管理し、入力欄フォーカス中・ダイアログ/ChatDrawer 内では全て無効にする ----
export function useGraphShortcuts({
  nodes,
  selectedEdgeId,
  setSelectedEdgeId,
  setEditingId,
  setShortcutsOpen,
  getSelectedNodeIds,
  applySelection,
  cutEdge,
  runUndo,
  runRedo,
  deleteSelectedNodes,
  copySelection,
  canPaste,
  pasteClipboard,
  duplicateSelection,
  fitSelectionOrAll,
  realign,
  createNode,
  createNodeAtCenter,
  selectedInPage,
}: Params): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isShortcutBlocked(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      const keyLower = key.toLowerCase();

      if (mod && keyLower === "z") {
        e.preventDefault();
        if (e.shiftKey) void runRedo();
        else void runUndo();
        return;
      }
      if (key === "Delete" || key === "Backspace") {
        if (selectedEdgeId) {
          e.preventDefault();
          const [source, target_] = selectedEdgeId.split("->");
          void cutEdge(source, target_);
        } else if (getSelectedNodeIds().length > 0) {
          e.preventDefault();
          void deleteSelectedNodes();
        }
        return;
      }
      if (mod && keyLower === "a") {
        e.preventDefault();
        applySelection(nodes.map((n) => n.id));
        return;
      }
      if (mod && keyLower === "c") {
        if (getSelectedNodeIds().length === 0) return; // 通常のテキストコピーを邪魔しない
        // テキストを範囲選択しているときも奪わない（2026-08-07 本人報告「ctrl+c でテキストを
        // コピーできない」）。チャット欄やパネルの文をマウス選択してもフォーカスは body に
        // 残るため isShortcutBlocked では拾えない——選択の有無で判定する
        const textSel = window.getSelection();
        if (textSel && !textSel.isCollapsed && textSel.toString()) return;
        e.preventDefault();
        copySelection();
        return;
      }
      if (mod && keyLower === "v") {
        if (!canPaste()) return;
        e.preventDefault();
        void pasteClipboard();
        return;
      }
      if (mod && keyLower === "d") {
        if (getSelectedNodeIds().length === 0) return;
        e.preventDefault();
        void duplicateSelection();
        return;
      }
      if (!mod && keyLower === "f") {
        e.preventDefault();
        fitSelectionOrAll();
        return;
      }
      if (!mod && keyLower === "l") {
        e.preventDefault();
        realign();
        return;
      }
      if (key === "F2") {
        const ids = getSelectedNodeIds();
        // Fix済み（やり方確定）のノードはF2でのタイトル編集も開始しない
        // （docs/design.md 3.5 実効化。NodeCard のダブルクリック編集と同じガード）
        if (ids.length === 1 && !nodes.find((n) => n.id === ids[0])?.fixed) {
          e.preventDefault();
          setEditingId(ids[0]);
        }
        return;
      }
      if (key === "Tab") {
        e.preventDefault();
        if (selectedInPage) void createNode(selectedInPage);
        else void createNodeAtCenter();
        return;
      }
      if (key === "Escape") {
        applySelection([]);
        setSelectedEdgeId(null);
        return;
      }
      if (key === "?" || (e.shiftKey && key === "/")) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    selectedEdgeId,
    setSelectedEdgeId,
    setEditingId,
    setShortcutsOpen,
    cutEdge,
    runUndo,
    runRedo,
    nodes,
    applySelection,
    getSelectedNodeIds,
    deleteSelectedNodes,
    copySelection,
    canPaste,
    pasteClipboard,
    duplicateSelection,
    fitSelectionOrAll,
    realign,
    createNode,
    createNodeAtCenter,
    selectedInPage,
  ]);
}
