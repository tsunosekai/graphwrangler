// 複数選択時の一括編集パネル。単一選択の NodePanel を置き換えて表示する。
// 一括で意味のあるプロパティだけを対象にする:
//   担当 / 実行前承認 / プラン済みにする・下書きに戻す / Fix・解除 / ページ移動 / 削除
// タイトル・detail・実装・進捗（着手/完了）・種別・schedule・分岐の枝は個別性が高いので
// 対象外（1件選択のパネルで編集する）。
// Fix済みノードの「やり方」フィールド（担当・承認・ページ）はサーバが409で拒否するため、
// 事前に対象から外して適用件数をトーストで知らせる。
import { useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/api";
import { confirmDialog } from "../lib/dialogs";
import { buildRemoveMessage, computeRemoveImpact, removeImpactWarnings } from "../lib/removal";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { pushToast } from "../lib/toast";
import type { Node } from "../types";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

interface Props {
  /** 選択中のノード群（2件以上） */
  nodes: Node[];
  /** ページ移動先の候補（App の folders） */
  folders: Node[];
  /** 現在表示中のページ id（移動先候補から「現在のページ」と分かるように） */
  pageId: string | null;
  onMutated: () => void;
  onClose: () => void;
}

const EXECUTOR_JA: Record<Node["executor"], string> = { human: "人間", ai: "AI", script: "スクリプト" };

export function BulkPanel({ nodes, folders, pageId, onMutated, onClose }: Props) {
  const [width, startResize] = useResizableWidth("panelW", 380, 300, 640);
  const [busy, setBusy] = useState(false);
  const [moveTarget, setMoveTarget] = useState("");

  // Fix済みは「やり方」フィールド（担当/承認/ページ）を変更できない
  const unfixed = nodes.filter((n) => !n.fixed);
  const fixedCount = nodes.length - unfixed.length;

  /** targets へ patch を順に適用し、適用数・対象外数をトーストで知らせる共通処理 */
  const apply = async (
    label: string,
    targets: Node[],
    patch: (n: Node) => Parameters<typeof api.patchNode>[1],
  ) => {
    if (busy) return;
    if (targets.length === 0) {
      pushToast(`${label}: 対象になるノードがありません`, "info");
      return;
    }
    setBusy(true);
    let ok = 0;
    try {
      for (const n of targets) {
        try {
          await api.patchNode(n.id, patch(n));
          ok++;
        } catch {
          // api() 側でトースト表示済み（続行して残りに適用する）
        }
      }
      onMutated();
      const excluded = nodes.length - targets.length;
      pushToast(
        `${label}: ${ok}件に適用${excluded > 0 ? `（対象外 ${excluded}件）` : ""}`,
        "info",
      );
    } finally {
      setBusy(false);
    }
  };

  // ---- 担当（Fix済みは対象外） ----
  const executors = new Set(nodes.map((n) => n.executor));
  const commonExecutor = executors.size === 1 ? nodes[0].executor : "";

  // ---- 実行前承認（担当=人間には意味が無い。Fix済みも対象外） ----
  const approvalTargets = unfixed.filter((n) => n.executor !== "human");
  const allIrreversible =
    approvalTargets.length > 0 && approvalTargets.every((n) => n.impact === "irreversible");

  // ---- プラン済み / 下書き ----
  const commitTargets = nodes.filter((n) => n.lifecycle === "draft" || n.status === "unplanned");
  const draftTargets = nodes.filter((n) => n.lifecycle === "committed");

  // ---- Fix ----
  const fixTargets = nodes.filter((n) => !n.fixed);
  const unfixTargets = nodes.filter((n) => n.fixed);

  const commitAll = async () => {
    if (commitTargets.some((n) => n.executor === "script" && n.kind !== "trigger")) {
      const ok = await confirmDialog(
        "スクリプト担当のノードを含みます。試走が済んでいない可能性がありますが続けますか？",
        { confirmLabel: "続ける" },
      );
      if (!ok) return;
    }
    void apply("プラン済みにする", commitTargets, (n) =>
      // トリガーは進捗を持たない（lifecycle だけ確定する）
      n.kind === "trigger" ? { lifecycle: "committed" } : { status: "pending", lifecycle: "committed" },
    );
  };

  const moveAll = () => {
    if (!moveTarget) return;
    void apply("ページへ移動", unfixed.filter((n) => n.group !== moveTarget), () => ({
      group: moveTarget,
    })).then(() => onClose());
  };

  // 削除は依存の葉から順に試す（GraphView の Delete キーと同じ方針）。force 付きなので
  // ロック中も消える——巻き添え・切り離し・ロックは確認モーダルの警告行で事前に見せる
  // （2026-08-01 本人指摘「消せないのは違う。ロックはモーダルで確認」。巻き添えの計算には
  // ページ外の全ノードが要るため /api/state を取り直す）
  const deleteAll = async () => {
    if (busy) return;
    let warnings: string[] = [];
    try {
      const state = await api.getState();
      warnings = removeImpactWarnings(computeRemoveImpact(nodes.map((n) => n.id), state.nodes));
    } catch {
      // 状態の取り直しに失敗しても削除自体は進める（api() 側でトースト表示済み）
    }
    const ok = await confirmDialog(
      buildRemoveMessage(`選択中の ${nodes.length} 件を削除しますか？（Ctrl+Z で戻せます）`, warnings),
      { danger: true, confirmLabel: "削除" },
    );
    if (!ok) return;
    setBusy(true);
    try {
      let remaining = nodes.map((n) => n.id);
      const deleted: string[] = [];
      while (remaining.length > 0) {
        let removedAny = false;
        const still: string[] = [];
        for (const id of remaining) {
          try {
            await api.removeNode(id, { force: true });
            deleted.push(id);
            removedAny = true;
          } catch {
            still.push(id);
          }
        }
        remaining = still;
        if (!removedAny) break;
      }
      onMutated();
      pushToast(`${deleted.length}件削除しました（Ctrl+Zで戻せます）`, "info");
      if (deleted.length === nodes.length) onClose();
    } finally {
      setBusy(false);
    }
  };

  const sectionLabel = "text-xs font-semibold tracking-wide text-muted-foreground";

  return (
    <aside
      data-mobile-panel="right"
      className="relative flex flex-shrink-0 flex-col gap-3 overflow-y-auto border-l bg-background p-4"
      style={{ width }}
    >
      <div className="resize-handle resize-handle-left" onPointerDown={(e) => startResize(e, -1)} />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-lg font-semibold">{nodes.length} 件を選択中</span>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="選択を解除">
          <X />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        共通のプロパティをまとめて変更できます。タイトル・実装・進捗などは1件選択で編集します
        {fixedCount > 0 && `（Fix済み ${fixedCount}件は担当・承認・ページ移動の対象外）`}
      </p>

      <div className="flex flex-col gap-1.5">
        <span className={sectionLabel}>担当</span>
        <Select
          value={commonExecutor}
          disabled={busy || unfixed.length === 0}
          onValueChange={(v) => void apply("担当を変更", unfixed, () => ({ executor: v as Node["executor"] }))}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="（混在）" />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(EXECUTOR_JA) as Node["executor"][]).map((k) => (
              <SelectItem key={k} value={k}>
                {EXECUTOR_JA[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {approvalTargets.length > 0 && (
        <label className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
          <span>
            実行前承認
            <span className="ml-1.5 text-xs text-muted-foreground">
              （AI/スクリプト担当 {approvalTargets.length}件）
            </span>
          </span>
          <Switch
            checked={allIrreversible}
            disabled={busy}
            onCheckedChange={(v) =>
              void apply("実行前承認", approvalTargets, () => ({ impact: v ? "irreversible" : "safe" }))
            }
          />
        </label>
      )}

      <div className="flex flex-col gap-1.5">
        <span className={sectionLabel}>プラン</span>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy || commitTargets.length === 0} onClick={commitAll}>
            プラン済みにする（{commitTargets.length}）
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || draftTargets.length === 0}
            onClick={() => void apply("下書きに戻す", draftTargets, () => ({ lifecycle: "draft" }))}
          >
            下書きに戻す（{draftTargets.length}）
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={sectionLabel}>Fix（ロック）</span>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || fixTargets.length === 0}
            onClick={() => void apply("Fix", fixTargets, () => ({ fixed: true }))}
          >
            まとめて Fix（{fixTargets.length}）
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || unfixTargets.length === 0}
            onClick={() => void apply("Fix解除", unfixTargets, () => ({ fixed: false }))}
          >
            解除（{unfixTargets.length}）
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={sectionLabel}>ページへ移動</span>
        <div className="flex gap-2">
          <Select value={moveTarget} disabled={busy} onValueChange={setMoveTarget}>
            <SelectTrigger className="min-w-0 flex-1">
              <SelectValue placeholder="移動先のページを選ぶ" />
            </SelectTrigger>
            <SelectContent>
              {folders.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {(f.title || "（無題）") + (f.id === pageId ? "（現在のページ）" : "")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !moveTarget || unfixed.length === 0}
            onClick={moveAll}
          >
            移動
          </Button>
        </div>
      </div>

      <div className="mt-2 border-t border-border pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-destructive/40 text-destructive"
          disabled={busy}
          onClick={() => void deleteAll()}
        >
          {nodes.length} 件を削除
        </Button>
      </div>
    </aside>
  );
}
