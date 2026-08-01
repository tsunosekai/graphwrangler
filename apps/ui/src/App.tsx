import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatDrawer } from "./components/ChatDrawer";
import { CommandPalette } from "./components/CommandPalette";
import { GraphView } from "./components/GraphView";
import { NodePanel } from "./components/NodePanel";
import { PageList } from "./components/PageList";
import { SetupModal } from "./components/SetupModal";
import { ToastHost } from "./components/ToastHost";
import { TopBar, type RunWaitItem } from "./components/TopBar";
import { api, type SettingsView } from "./lib/api";
import { usePolling } from "./hooks/usePolling";
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

  useEffect(() => saveUiState("gw.selectedId", selectedId), [selectedId]);
  useEffect(() => saveUiState("gw.pageId", pageIdRaw), [pageIdRaw]);
  useEffect(() => saveUiState("gw.chatOpen", chatOpen ? "1" : "0"), [chatOpen]);
  // ノードエディタ標準の複数選択: グラフ上での選択件数。NodePanel の「他N件選択中」表示に使う
  const [selectionCount, setSelectionCount] = useState(0);
  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  // 未読バッジ用のノードごとの最終メッセージ時刻
  const threadMeta = useMemo(() => data?.threadMeta ?? {}, [data]);

  // ページ = フォルダ（kind=goal、またはメンバーを持つノード）。zinsei desk の左レール方式
  const folders = useMemo(() => {
    const hasMembers = new Set(nodes.map((n) => n.group).filter(Boolean) as string[]);
    return nodes.filter((n) => n.kind === "goal" || hasMembers.has(n.id));
  }, [nodes]);

  const pageId = pageIdRaw ?? folders[0]?.id ?? null;
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
  const { data: latestRuns } = usePolling(async (): Promise<Record<string, Run | null>> => {
    if (routinePageIds.length === 0) return {};
    const entries = await Promise.all(
      routinePageIds.map(async (id) => {
        try {
          const { runs } = await api.listRuns(id);
          return [id, runs[0] ?? null] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }, 5000);

  // ---- アクティブなラン（docs/design.md 3.8: トリガー起点のルーティーン。グラフ投影用）。
  //      「最新ラン」（上の latestRuns。状態不問。PageList のちょぼ用）とは別物——ここで欲しいのは
  //      「現在表示中のページの、status==="running" な最新1本」。複数ランが並走中でも
  //      running のものだけを対象にする（他は台帳ビューで見る想定。design.md 3.8）。
  //      現在ページだけを見れば良いので、全ルーティーンページを N+1 取得する latestRuns とは
  //      別に軽量ポーリングする ----
  const isCurrentPageRoutine = pageNode ? isRoutinePage(pageNode, nodes) : false;
  const { data: activeRun, refresh: refreshActiveRun } = usePolling(async (): Promise<Run | null> => {
    if (!pageId || !isCurrentPageRoutine) return null;
    try {
      const { runs } = await api.listRuns(pageId);
      // listRuns は新しい順（LedgerView と同じ前提）。running のうち最新の1本を採る
      return runs.find((r) => r.status === "running") ?? null;
    } catch {
      return null;
    }
  }, 3000);
  // ページを切り替えたら次の3秒ポーリングを待たずに即座に取り直す（切替直後の古い投影を避ける）
  useEffect(() => {
    refreshActiveRun();
  }, [pageId, isCurrentPageRoutine, refreshActiveRun]);

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
      const n = nodes.find((x) => x.id === id);
      if (!n) return;
      if (folders.some((f) => f.id === id)) setPageId(id);
      else if (n.group) setPageId(n.group);
    },
    [nodes, folders],
  );

  return (
    // 背景色は body が持つ（格子と一体）。ここに不透明背景を敷くと格子が隠れる
    <div className="flex h-full flex-col text-foreground">
      <TopBar
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
        onUndo={handleUndo}
        onCaptureGoal={handleCaptureGoal}
      />
      <div className="flex min-h-0 flex-1">
        <PageList
          folders={folders}
          allNodes={nodes}
          pageId={pageId}
          threadMeta={threadMeta}
          latestRuns={latestRuns ?? {}}
          onSelectPage={(id) => {
            setPageId(id);
            setSelectedId(id);
          }}
        />
        <GraphView
          nodes={pageNodes}
          pageNode={pageNode}
          selectedId={selectedId}
          threadMeta={threadMeta}
          activeRun={activeRun ?? null}
          onSelect={selectNode}
          onMutated={handleMutated}
          onSelectionCountChange={setSelectionCount}
        />
        {selectedNode && (
          <NodePanel
            key={selectedNode.id}
            node={selectedNode}
            allNodes={nodes}
            activeRun={activeRun ?? null}
            onMutated={handleMutated}
            onClose={() => setSelectedId(null)}
            onSelect={selectNode}
            selectedCount={selectionCount}
          />
        )}
        {chatOpen && (
          <ChatDrawer
            pageId={pageId}
            pageTitle={pageNode?.title ?? null}
            selectedNodeId={selectedId}
            onMutated={handleMutated}
            onClose={() => setChatOpen(false)}
          />
        )}
      </div>
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
    </div>
  );
}
