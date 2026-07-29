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
    <div className="flex w-[280px] flex-shrink-0 flex-col overflow-hidden border-r border-border bg-muted">
      <div className="border-b border-border px-3 py-2.5 text-xs font-semibold tracking-wide text-muted-foreground">
        アウトライン
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
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
        {tree.length === 0 && <div className="p-3 text-xs text-text-lo">ノードがありません</div>}
      </div>
    </div>
  );
}
