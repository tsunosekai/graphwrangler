import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BulkPanel } from "./components/BulkPanel";
import { ChatDrawer } from "./components/ChatDrawer";
import { DialogHost } from "./components/DialogHost";
import { CommandPalette } from "./components/CommandPalette";
import { GraphView } from "./components/GraphView";
import { NodePanel } from "./components/NodePanel";
import { PageList } from "./components/PageList";
import { SetupModal } from "./components/SetupModal";
import { ToastHost } from "./components/ToastHost";
import { TopBar, type RunWaitItem } from "./components/TopBar";
import { MobileNav, type MobileView } from "./components/MobileNav";
import { api, type SettingsView } from "./lib/api";
import { cn } from "./lib/utils";
import { usePolling } from "./hooks/usePolling";
import { useIsMobile } from "./hooks/useIsMobile";
import { isRoutinePage } from "./lib/routine";
import { pushToast } from "./lib/toast";
import type { Run } from "./types";

/** localStorage の安全な読み書き（UI状態の永続化。2026-07-31 本人要望
 *  「リロードしても開閉や幅を保持」。幅とテーマ・レール開閉は各コンポーネントで保存済み） */
function loadUiState(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function saveUiState(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 無視（永続化は補助機能）
  }
}

export default function App() {
  const { data, refresh } = usePolling(() => api.getState(), 3000);
  const [selectedId, setSelectedId] = useState<string | null>(() => loadUiState("gw.selectedId"));
  const [pageIdRaw, setPageId] = useState<string | null>(() => loadUiState("gw.pageId"));
  const [chatOpen, setChatOpen] = useState(() => loadUiState("gw.chatOpen") === "1");
  // モバイル（<768px）はヘッダー+下部タブバーを除き、一覧/グラフ/ノード/チャットの
  // どれか1つが画面を専有する（2026-08-02 本人指定）。永続化しない（開くたびグラフから）
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<MobileView>("graph");

  useEffect(() => saveUiState("gw.selectedId", selectedId), [selectedId]);
  useEffect(() => saveUiState("gw.pageId", pageIdRaw), [pageIdRaw]);
  useEffect(() => saveUiState("gw.chatOpen", chatOpen ? "1" : "0"), [chatOpen]);
  // ノードエディタ標準の複数選択: 選択中の id 一覧。2件以上で一括編集パネル（BulkPanel）を出す
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  // 未読バッジ用のノードごとの最終メッセージ時刻
  const threadMeta = useMemo(() => data?.threadMeta ?? {}, [data]);

  // ページ = フォルダ（kind=goal、またはメンバーを持つノード）。zinsei desk の左レール方式
  const folders = useMemo(() => {
    const hasMembers = new Set(nodes.map((n) => n.group).filter(Boolean) as string[]);
    return nodes.filter((n) => n.kind === "goal" || hasMembers.has(n.id));
  }, [nodes]);

  // 表示中ページが削除された場合も先頭ページへフォールバックする（削除直後に空画面へ
  // 取り残されないように。localStorage の古い pageId も同じ経路で吸収される）
  const pageId = folders.some((f) => f.id === pageIdRaw) ? pageIdRaw : (folders[0]?.id ?? null);
  const pageNode = folders.find((f) => f.id === pageId) ?? null;
  const pageNodes = useMemo(() => nodes.filter((n) => n.group === pageId), [nodes, pageId]);

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

  // ---- ルーティーンページの最新ラン（PageList の左レールドット + TopBar のラン待ち統合の両方が使う。
  //      ページ数ぶんの N+1 取得を1箇所に集約する）。
  //      「ルーティーンであること」は isRoutinePage が判定する（docs/design.md 3.8。
  //      trigger ノードをメンバーに持つこと） ----
  const routinePageIds = useMemo(
    () => folders.filter((f) => isRoutinePage(f, nodes)).map((f) => f.id),
    [folders, nodes],
  );
  const { data: pageRunInfo } = usePolling(async (): Promise<
    Record<string, { latest: Run | null; running: number }>
  > => {
    if (routinePageIds.length === 0) return {};
    const entries = await Promise.all(
      routinePageIds.map(async (id) => {
        try {
          const { runs } = await api.listRuns(id);
          return [
            id,
            { latest: runs[0] ?? null, running: runs.filter((r) => r.status === "running").length },
          ] as const;
        } catch {
          return [id, { latest: null, running: 0 }] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }, 5000);
  const latestRuns = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(pageRunInfo ?? {}).map(([id, info]) => [id, info.latest]),
      ) as Record<string, Run | null>,
    [pageRunInfo],
  );
  // 実行中ラン数（並走中の世界線の数）。左レールのバッジ表示に使う
  const runningCounts = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(pageRunInfo ?? {}).map(([id, info]) => [id, info.running]),
      ) as Record<string, number>,
    [pageRunInfo],
  );

  // ---- 実行中ラン一覧（docs/design.md 3.8: トリガー起点のルーティーン。グラフ投影用）。
  //      「最新ラン」（上の latestRuns。状態不問。PageList のちょぼ用）とは別物。
  //      同じルーティーンは並列で回せる（パラレルワールド: 同じテンプレートグラフ・別のラン状態）
  //      ため、現在ページの status==="running" を全部持ち、どの世界線をグラフに投影するかを
  //      projectedRunId で選ぶ（切替UIは GraphView のツールバー。既定は最新の1本） ----
  const isCurrentPageRoutine = pageNode ? isRoutinePage(pageNode, nodes) : false;
  const { data: runningRunsData, refresh: refreshActiveRun } = usePolling(async (): Promise<Run[]> => {
    if (!pageId || !isCurrentPageRoutine) return [];
    try {
      const { runs } = await api.listRuns(pageId);
      // listRuns は新しい順（LedgerView と同じ前提）
      return runs.filter((r) => r.status === "running");
    } catch {
      return [];
    }
  }, 3000);
  const runningRuns = useMemo(() => runningRunsData ?? [], [runningRunsData]);
  const [projectedRunId, setProjectedRunId] = useState<string | null>(null);
  // ページを切り替えたら投影選択をリセットし、次の3秒ポーリングを待たずに即座に取り直す
  useEffect(() => {
    setProjectedRunId(null);
    refreshActiveRun();
  }, [pageId, isCurrentPageRoutine, refreshActiveRun]);
  const activeRun = runningRuns.find((r) => r.id === projectedRunId) ?? runningRuns[0] ?? null;

  // 実行中ランのワークアイテムで status=waiting のものを集める（あなたの番の一覧。
  // 受信箱UIは廃止済み（docs/design.md 4章②）で、今の用途はデスクトップ通知だけ）
  const runWaitItems = useMemo<RunWaitItem[]>(() => {
    if (!latestRuns) return [];
    const items: RunWaitItem[] = [];
    for (const run of Object.values(latestRuns)) {
      if (!run || run.status !== "running") continue;
      for (const [nodeId, item] of Object.entries(run.items)) {
        if (item.status !== "waiting") continue;
        const title = nodes.find((n) => n.id === nodeId)?.title || "（無題）";
        const label = item.note ? `[ラン] ${title}（${item.note}）` : `[ラン] ${title}`;
        items.push({ key: `${run.id}:${nodeId}`, nodeId, label });
      }
    }
    return items;
  }, [latestRuns, nodes]);

  // あなたの番が増えたらデスクトップ通知（タブが非表示の時だけ。gw.notify がオン + 許可済み時のみ）
  const inboxItemsRef = useRef<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    const combined: { id: string; title: string }[] = [
      ...nodes.filter((n) => n.pendingRequest).map((n) => ({ id: n.id, title: n.title || "（無題）" })),
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
        new Notification("GraphWrangler", { body: `あなたの番: ${latest.title}` });
      }
    }
    inboxItemsRef.current = combined;
  }, [nodes, runWaitItems]);

  // ---- AI設定（初回セットアップ + いつでも開ける⚙） ----
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        if (!s.setupDone) setSettingsOpen(true);
      })
      .catch(() => {
        // トースト表示済み。設定は開かないままにする
      });
  }, []);

  const handleMutated = useCallback(() => {
    refresh();
  }, [refresh]);

  // ヘッダーのゴール捕獲欄（2026-08-01: 受信箱を置き換えた新規プロジェクトの唯一の入口。
  // docs/design.md 4章 ②）。書いた瞬間に goal ノード = 空のページを作り、そこへ移動する
  const handleCaptureGoal = useCallback(
    async (title: string) => {
      try {
        const created = await api.addNode({ title, kind: "goal" });
        refresh();
        setPageId(created.id);
        setSelectedId(created.id);
        setMobileView("graph"); // モバイル: 作ったプロジェクトのグラフへ
        pushToast(`プロジェクト「${title}」を作りました`, "info");
      } catch {
        // api() 側でエラートースト表示済み
      }
    },
    [refresh],
  );

  // ヘッダーの「元に戻す」（Ctrl+Z のショートカット処理は GraphView 側）
  const handleUndo = useCallback(async () => {
    try {
      await api.undo();
      pushToast("元に戻しました", "info");
      refresh();
    } catch {
      // api() 側でエラートースト表示済み
    }
  }, [refresh]);

  // どこから選択されても、そのノードのページへ移動する（受信箱ジャンプ用）
  const selectNode = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (!id) return;
      // モバイル: ノードを選んだらノード詳細ビューへ（タップ→詳細の自動遷移）
      if (isMobile) setMobileView("node");
      const n = nodes.find((x) => x.id === id);
      if (!n) return;
      if (folders.some((f) => f.id === id)) setPageId(id);
      else if (n.group) setPageId(n.group);
    },
    [nodes, folders, isMobile],
  );

  // モバイルの実効ビュー: 「ノード」ビューで表示できるものが無ければグラフへ倒す
  // （選択解除・削除直後に空画面へ取り残されないように）。デスクトップは null（全ペイン共存）
  const hasNodeView = selectedIds.length > 1 || selectedNode !== null;
  const mv: MobileView | null = isMobile ? (mobileView === "node" && !hasNodeView ? "graph" : mobileView) : null;

  return (
    // 背景色は body が持つ（格子と一体）。ここに不透明背景を敷くと格子が隠れる
    <div className="flex h-full flex-col text-foreground">
      <TopBar
        chatOpen={mv !== null ? mv === "chat" : chatOpen}
        onToggleChat={() =>
          isMobile
            ? setMobileView((v) => (v === "chat" ? "graph" : "chat"))
            : setChatOpen((v) => !v)
        }
        onOpenSettings={() => setSettingsOpen(true)}
        onUndo={handleUndo}
        onCaptureGoal={handleCaptureGoal}
      />
      {/* モバイル（mv ≠ null）はどれか1つのビューだけを表示する。
          - 一覧/ノード詳細: 非表示時はアンマウント（ノード詳細は表示中に既読化する副作用が
            あるため、隠れたまま既読が進まないように）
          - グラフ/チャット: マウントは維持して display:none（グラフはビュー切替のたびの
            再レイアウトを避け、チャットは応答ストリーミングを切らないため） */}
      <div className="flex min-h-0 flex-1">
        {(mv === null || mv === "pages") && (
          <PageList
            folders={folders}
            allNodes={nodes}
            pageId={pageId}
            threadMeta={threadMeta}
            latestRuns={latestRuns}
            runningCounts={runningCounts}
            forceExpanded={isMobile}
            onSelectPage={(id) => {
              setPageId(id);
              setSelectedId(id);
              setMobileView("graph"); // モバイル: プロジェクトを選んだらグラフへ
            }}
          />
        )}
        <div className={cn("contents", mv !== null && mv !== "graph" && "hidden")}>
          <GraphView
            nodes={pageNodes}
            pageNode={pageNode}
            selectedId={selectedId}
            threadMeta={threadMeta}
            activeRun={activeRun}
            runningRuns={runningRuns}
            onProjectRun={setProjectedRunId}
            onSelect={selectNode}
            onMutated={handleMutated}
            onSelectionIdsChange={setSelectedIds}
          />
        </div>
        {(mv === null || mv === "node") &&
          (selectedIds.length > 1 ? (
            <BulkPanel
              nodes={nodes.filter((n) => selectedIds.includes(n.id))}
              folders={folders}
              pageId={pageId}
              onMutated={handleMutated}
              onClose={() => {
                setSelectedIds([]);
                setSelectedId(null);
                setMobileView("graph");
              }}
            />
          ) : (
            selectedNode && (
              <NodePanel
                key={selectedNode.id}
                node={selectedNode}
                allNodes={nodes}
                activeRun={activeRun}
                onMutated={handleMutated}
                onClose={() => {
                  setSelectedId(null);
                  setMobileView("graph");
                }}
                onSelect={selectNode}
              />
            )
          ))}
        {(mv === null ? chatOpen : true) && (
          <div className={cn("contents", mv !== null && mv !== "chat" && "hidden")}>
            <ChatDrawer
              pageId={pageId}
              pageTitle={pageNode?.title ?? null}
              selectedNodeId={selectedId}
              onMutated={handleMutated}
              onClose={() => (isMobile ? setMobileView("graph") : setChatOpen(false))}
            />
          </div>
        )}
      </div>
      {isMobile && (
        <MobileNav
          view={mv ?? "graph"}
          nodeEnabled={hasNodeView}
          nodeLabel={selectedIds.length > 1 ? `${selectedIds.length}件選択` : (selectedNode?.title || null)}
          onChange={setMobileView}
        />
      )}
      <CommandPalette nodes={nodes} folders={folders} onSelect={selectNode} />
      {settingsOpen && settings && (
        <SetupModal
          settings={settings}
          forced={!settings.setupDone}
          onSaved={(next) => {
            setSettings(next);
            setSettingsOpen(false);
          }}
          onSkip={async () => {
            const next = await api.updateSettings({ setupDone: true }).catch(() => settings);
            setSettings(next);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <ToastHost />
      <DialogHost />
    </div>
  );
}
