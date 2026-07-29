import { useCallback, useMemo, useState } from "react";
import { ChatDrawer } from "./components/ChatDrawer";
import { GraphView } from "./components/GraphView";
import { NodePanel } from "./components/NodePanel";
import { PageList } from "./components/PageList";
import { ToastHost } from "./components/ToastHost";
import { TopBar } from "./components/TopBar";
import { api } from "./lib/api";
import { usePolling } from "./hooks/usePolling";

export default function App() {
  const { data, refresh } = usePolling(() => api.getState(), 3000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageIdRaw, setPageId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const nodes = useMemo(() => data?.nodes ?? [], [data]);

  // ページ = フォルダ（kind=goal、またはメンバーを持つノード）。zinsei desk の左レール方式
  const folders = useMemo(() => {
    const hasMembers = new Set(nodes.map((n) => n.group).filter(Boolean) as string[]);
    return nodes.filter((n) => n.kind === "goal" || hasMembers.has(n.id));
  }, [nodes]);

  const pageId = pageIdRaw ?? folders[0]?.id ?? null;
  const pageNode = folders.find((f) => f.id === pageId) ?? null;
  const pageNodes = useMemo(() => nodes.filter((n) => n.group === pageId), [nodes, pageId]);

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

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
    <div className="app">
      <TopBar nodes={nodes} onSelect={selectNode} chatOpen={chatOpen} onToggleChat={() => setChatOpen((v) => !v)} />
      <div className="app-main">
        <PageList
          folders={folders}
          allNodes={nodes}
          pageId={pageId}
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
          onSelect={selectNode}
          onMutated={handleMutated}
        />
        {selectedNode && (
          <NodePanel
            key={selectedNode.id}
            node={selectedNode}
            onMutated={handleMutated}
            onClose={() => setSelectedId(null)}
          />
        )}
        {chatOpen && (
          <ChatDrawer
            pageId={pageId}
            pageTitle={pageNode?.title ?? null}
            onMutated={handleMutated}
            onClose={() => setChatOpen(false)}
          />
        )}
      </div>
      <ToastHost />
    </div>
  );
}
