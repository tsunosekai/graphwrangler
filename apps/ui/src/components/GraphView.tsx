import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "../lib/api";
import { layoutPositions, structureSignature, type Pos } from "../lib/layout";
import type { Node } from "../types";
import { NodeCard, type NodeCardData } from "./NodeCard";

const nodeTypes = { task: NodeCard };

interface Props {
  nodes: Node[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMutated: () => void;
}

function GraphViewInner({ nodes, selectedId, onSelect, onMutated }: Props) {
  const positionsRef = useRef<Map<string, Pos>>(new Map());
  const sigRef = useRef<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rfNodes, setRfNodes] = useState<RFNode<NodeCardData>[]>([]);

  const commitTitle = useCallback(
    async (id: string, title: string) => {
      setEditingId(null);
      const trimmed = title.trim();
      if (!trimmed) return; // 空タイトルは無視して元のタイトルを維持
      await api.patchNode(id, { title: trimmed });
      onMutated();
    },
    [onMutated],
  );

  useEffect(() => {
    const sig = structureSignature(nodes);
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      positionsRef.current = layoutPositions(nodes);
    }
    setRfNodes(
      nodes.map((n) => ({
        id: n.id,
        type: "task",
        position: positionsRef.current.get(n.id) ?? { x: 0, y: 0 },
        data: {
          node: n,
          selected: n.id === selectedId,
          editing: n.id === editingId,
          onSelect: (id: string) => onSelect(id),
          onDoubleClick: (id: string) => setEditingId(id),
          onCommitTitle: commitTitle,
          onCancelEdit: () => setEditingId(null),
        },
        draggable: true,
      })),
    );
  }, [nodes, selectedId, editingId, onSelect, commitTitle]);

  const rfEdges: RFEdge[] = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return nodes.flatMap((n) =>
      n.parents
        .filter((p) => ids.has(p))
        .map((p) => ({ id: `${p}->${n.id}`, source: p, target: n.id })),
    );
  }, [nodes]);

  const handleNodesChange = useCallback((changes: NodeChange<RFNode<NodeCardData>>[]) => {
    for (const c of changes) {
      if (c.type === "position" && c.position) {
        positionsRef.current.set(c.id, c.position);
      }
    }
    setRfNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const handleConnect = useCallback(
    async (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      const child = nodes.find((n) => n.id === conn.target);
      if (!child || child.parents.includes(conn.source)) return;
      await api.patchNode(child.id, { parents: [...child.parents, conn.source] });
      onMutated();
    },
    [nodes, onMutated],
  );

  const createNode = useCallback(
    async (parentId: string | null) => {
      const created = await api.addNode({ title: "", parents: parentId ? [parentId] : [] });
      onMutated();
      onSelect(created.id);
      setEditingId(created.id);
    },
    [onMutated, onSelect],
  );

  return (
    <div className="graph-pane">
      <div className="graph-toolbar">
        <button type="button" onClick={() => createNode(selectedId)}>
          + ノード
        </button>
      </div>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onConnect={handleConnect}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        nodeDragThreshold={4}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          createNode(null);
        }}
        proOptions={{ hideAttribution: true }}
        fitView
      >
        <Background gap={36} color="rgba(255,255,255,.06)" />
        <Controls />
      </ReactFlow>
    </div>
  );
}

export function GraphView(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphViewInner {...props} />
    </ReactFlowProvider>
  );
}
