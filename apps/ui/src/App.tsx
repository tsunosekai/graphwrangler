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
import type { Run } from "./types";

export default function App() {
  const { data, refresh } = usePolling(() => api.getState(), 3000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageIdRaw, setPageId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  // ノードエディタ標準の複数選択（QOL）: グラフ上での選択件数。NodePanel の「他N件選択中」表示に使う
  const [selectionCount, setSelectionCount] = useState(0);
  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  // QOL-7: 未読バッジ用のノードごとの最終メッセージ時刻
  const threadMeta = useMemo(() => data?.threadMeta ?? {}, [data]);

  // ページ = フォルダ（kind=goal/procedure、またはメンバーを持つノード）。zinsei desk の左レール方式
  const folders = useMemo(() => {
    const hasMembers = new Set(nodes.map((n) => n.group).filter(Boolean) as string[]);
    return nodes.filter((n) => n.kind === "goal" || n.kind === "procedure" || hasMembers.has(n.id));
  }, [nodes]);

  const pageId = pageIdRaw ?? folders[0]?.id ?? null;
  const pageNode = folders.find((f) => f.id === pageId) ?? null;
  const pageNodes = useMemo(() => nodes.filter((n) => n.group === pageId), [nodes, pageId]);

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

  // ---- ルーティーンページの最新ラン（PageList の左レールドット + TopBar のラン待ち統合の両方が使う。
  //      procedure 数ぶんの N+1 取得を1箇所に集約する） ----
  const procedureIds = useMemo(
    () => folders.filter((f) => f.kind === "procedure").map((f) => f.id),
    [folders],
  );
  const { data: latestRuns } = usePolling(async (): Promise<Record<string, Run | null>> => {
    if (procedureIds.length === 0) return {};
    const entries = await Promise.all(
      procedureIds.map(async (id) => {
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

  // 実行中ランのワークアイテムで status=waiting のものを受信箱項目として集める（B-6）
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

  // QOL-6: 受信箱件数が増えたらデスクトップ通知（タブが非表示の時だけ。gw.notify がオン + 許可済み時のみ）
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
        nodes={nodes}
        runWaitItems={runWaitItems}
        onSelect={selectNode}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        <PageList
          folders={folders}
          allNodes={nodes}
          pageId={pageId}
          latestRuns={latestRuns ?? {}}
          onSelectPage={(id) => {
            setPageId(id);
            setSelectedId(id);
          }}
          onMutated={handleMutated}
        />
        <GraphView
          nodes={pageNodes}
          pageNode={pageNode}
          selectedId={selectedId}
          threadMeta={threadMeta}
          onSelect={selectNode}
          onMutated={handleMutated}
          onSelectionCountChange={setSelectionCount}
        />
        {selectedNode && (
          <NodePanel
            key={selectedNode.id}
            node={selectedNode}
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
