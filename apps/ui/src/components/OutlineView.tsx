import { useMemo, useState } from "react";
import { buildOutline } from "../lib/tree";
import type { Node } from "../types";
import { OutlineRow } from "./OutlineRow";

interface Props {
  nodes: Node[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMutated: () => void;
}

export function OutlineView({ nodes, selectedId, onSelect, onMutated }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const tree = useMemo(() => buildOutline(nodes), [nodes]);

  return (
    <div className="outline-pane">
      <div className="pane-header">アウトライン</div>
      <div className="outline-body">
        {tree.map((entry) => (
          <OutlineRow
            key={entry.node.id}
            entry={entry}
            depth={0}
            allNodes={nodes}
            selectedId={selectedId}
            editingId={editingId}
            onSelect={onSelect}
            onStartEdit={setEditingId}
            onMutated={onMutated}
          />
        ))}
        {tree.length === 0 && <div className="outline-empty">ノードがありません</div>}
      </div>
    </div>
  );
}
