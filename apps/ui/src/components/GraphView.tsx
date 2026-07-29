import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
import { layoutGraph, structureSignature, type Pos, type Size } from "../lib/layout";
import type { Node } from "../types";
import { NodeCard, type NodeCardData } from "./NodeCard";
import { GroupBox, type GroupBoxData } from "./GroupBox";

const nodeTypes = { task: NodeCard, group: GroupBox };

interface Props {
  nodes: Node[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMutated: () => void;
}

function GraphViewInner({ nodes, selectedId, onSelect, onMutated }: Props) {
  const positionsRef = useRef<Map<string, Pos>>(new Map());
  const groupSizesRef = useRef<Map<string, Size>>(new Map());
  const sigRef = useRef<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rfNodes, setRfNodes] = useState<RFNode<NodeCardData | GroupBoxData>[]>([]);

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
      const { positions, groupSizes } = layoutGraph(nodes);
      positionsRef.current = positions;
      groupSizesRef.current = groupSizes;
    }
    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    const isGroup = (id: string) => groupSizesRef.current.has(id);
    // React Flow は親（グループ）ノードが子より先に並んでいる必要がある
    const sorted = [...nodes].sort((a, b) => Number(isGroup(b.id)) - Number(isGroup(a.id)));
    setRfNodes(
      sorted.map((n) => {
        const size = groupSizesRef.current.get(n.id);
        const common = {
          id: n.id,
          position: positionsRef.current.get(n.id) ?? { x: 0, y: 0 },
          ...(n.group && byId.has(n.group) ? { parentId: n.group } : {}),
        };
        if (size) {
          return {
            ...common,
            type: "group" as const,
            style: { width: size.width, height: size.height },
            draggable: true,
            data: {
              node: n,
              selected: n.id === selectedId,
              onSelect: (id: string) => onSelect(id),
            } satisfies GroupBoxData,
          };
        }
        return {
          ...common,
          type: "task" as const,
          draggable: true,
          data: {
            node: n,
            selected: n.id === selectedId,
            editing: n.id === editingId,
            onSelect: (id: string) => onSelect(id),
            onDoubleClick: (id: string) => setEditingId(id),
            onCommitTitle: commitTitle,
            onCancelEdit: () => setEditingId(null),
          } satisfies NodeCardData,
        };
      }),
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

  const handleNodesChange = useCallback(
    (changes: NodeChange<RFNode<NodeCardData | GroupBoxData>>[]) => {
      for (const c of changes) {
        if (c.type === "position" && c.position) {
          positionsRef.current.set(c.id, c.position);
        }
      }
      setRfNodes((nds) => applyNodeChanges(changes, nds));
    },
    [],
  );

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
    async (contextId: string | null) => {
      // 選択中がグループならその中に、タスクなら同じグループ内の子として作る
      const ctx = contextId ? nodes.find((n) => n.id === contextId) : null;
      const isGroup = ctx ? nodes.some((n) => n.group === ctx.id) || ctx.kind === "goal" : false;
      const created = await api.addNode({
        title: "",
        parents: ctx && !isGroup ? [ctx.id] : [],
        group: ctx ? (isGroup ? ctx.id : (ctx.group ?? null)) : null,
      });
      onMutated();
      onSelect(created.id);
      setEditingId(created.id);
    },
    [nodes, onMutated, onSelect],
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
