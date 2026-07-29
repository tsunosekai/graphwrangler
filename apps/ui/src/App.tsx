import { useCallback, useState } from "react";
import { GraphView } from "./components/GraphView";
import { NodePanel } from "./components/NodePanel";
import { OutlineView } from "./components/OutlineView";
import { ToastHost } from "./components/ToastHost";
import { TopBar } from "./components/TopBar";
import { api } from "./lib/api";
import { usePolling } from "./hooks/usePolling";

export default function App() {
  const { data, refresh } = usePolling(() => api.getState(), 3000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nodes = data?.nodes ?? [];
  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

  const handleMutated = useCallback(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="app">
      <TopBar nodes={nodes} onSelect={setSelectedId} />
      <div className="app-main">
        <OutlineView nodes={nodes} selectedId={selectedId} onSelect={setSelectedId} onMutated={handleMutated} />
        <GraphView nodes={nodes} selectedId={selectedId} onSelect={setSelectedId} onMutated={handleMutated} />
        {selectedNode && (
          <NodePanel
            key={selectedNode.id}
            node={selectedNode}
            onMutated={handleMutated}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
      <ToastHost />
    </div>
  );
}
