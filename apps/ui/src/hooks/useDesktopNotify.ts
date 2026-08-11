// 「あなたの番」が増えたときのデスクトップ通知。通知対象の集合（テンプレートの
// あなたの番 + 実行中ランの待ちアイテム）の算出も、通知以外に使い道が無いのでここに置く。
import { useEffect, useMemo, useRef } from "react";
import type { RunWaitItem } from "../components/TopBar";
import { isMyTurn, turnIsMine } from "../lib/team";
import type { Node, Run } from "../types";

export interface DesktopNotifyOptions {
  nodes: Node[];
  /** 全ページのラン一覧（ページ id → ラン配列） */
  railRuns: Record<string, Run[]>;
  myEmail: string | null;
  /** 通知の見出し（インスタンスのサイト名。2026-08-08 ブランディング） */
  siteTitle: string;
}

export function useDesktopNotify({ nodes, railRuns, myEmail, siteTitle }: DesktopNotifyOptions): void {
  // 実行中ランのワークアイテムで status=waiting のものを集める（あなたの番の一覧。
  // 受信箱UIは廃止済み（docs/design.md 4章②）で、今の用途はデスクトップ通知だけ）。
  // 同じルーティーンは並列で回せる（並行ラン）ため、各ページの最新1本ではなく
  // 実行中のラン**全部**を対象にする。key はラン id 込みなので通知の重複防止とも整合する
  const runWaitItems = useMemo<RunWaitItem[]>(() => {
    const items: RunWaitItem[] = [];
    for (const list of Object.values(railRuns)) {
      for (const run of list) {
        if (run.status !== "running") continue;
        for (const [nodeId, item] of Object.entries(run.items)) {
          if (item.status !== "waiting") continue;
          const tmpl = nodes.find((n) => n.id === nodeId);
          // 他人の番（テンプレートの assignee が他人）は自分への通知対象にしない（チーム化 2026-08-04）
          if (tmpl && !turnIsMine(tmpl.assignee, myEmail)) continue;
          const title = tmpl?.title || "（無題）";
          const label = item.note ? `[ラン] ${title}（${item.note}）` : `[ラン] ${title}`;
          items.push({ key: `${run.id}:${nodeId}`, nodeId, label });
        }
      }
    }
    return items;
  }, [railRuns, nodes, myEmail]);

  // あなたの番が増えたらデスクトップ通知（タブが非表示の時だけ。gw.notify がオン + 許可済み時のみ）。
  // 他人の番（assignee が他人）は通知しない（チーム化 2026-08-04。isMyTurn が判定を一元化）
  const inboxItemsRef = useRef<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    const combined: { id: string; title: string }[] = [
      ...nodes
        .filter((n) => isMyTurn(n, myEmail))
        .map((n) => ({ id: n.id, title: n.title || "（無題）" })),
      ...runWaitItems.map((item) => ({ id: item.key, title: item.label })),
    ];
    const prev = inboxItemsRef.current;
    if (prev) {
      const prevIds = new Set(prev.map((i) => i.id));
      const added = combined.filter((i) => !prevIds.has(i.id));
      if (
        added.length > 0 &&
        localStorage.getItem("gw.notify") === "1" &&
        document.visibilityState !== "visible" &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        const latest = added[added.length - 1];
        new Notification(siteTitle, { body: `あなたの番: ${latest.title}` });
      }
    }
    inboxItemsRef.current = combined;
  }, [nodes, runWaitItems, myEmail, siteTitle]);
}
