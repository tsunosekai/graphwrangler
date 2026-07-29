import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "../lib/api";
import { layoutGraph, structureSignature, type Pos } from "../lib/layout";
import type { Node } from "../types";
import { NodeCard, type NodeCardData } from "./NodeCard";

const nodeTypes = { task: NodeCard };

interface Props {
  /** 表示するページ（フォルダ）のメンバーだけが渡される */
  nodes: Node[];
  /** ページ自身のノード（パンくず表示・新規ノードの所属先） */
  pageNode: Node | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMutated: () => void;
}

function GraphViewInner({ nodes, pageNode, selectedId, onSelect, onMutated }: Props) {
  const positionsRef = useRef<Map<string, Pos>>(new Map());
  // 紐を空中に放して作ったノードの「落とした位置」。次のレイアウト再計算時に適用して消す
  const overridesRef = useRef<Map<string, Pos>>(new Map());
  const sigRef = useRef<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rfNodes, setRfNodes] = useState<RFNode<NodeCardData>[]>([]);
  const { fitView, screenToFlowPosition } = useReactFlow();

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
    const sig = `${pageNode?.id ?? ""}#${structureSignature(nodes)}`;
    const pageChanged = sig.split("#")[0] !== sigRef.current.split("#")[0];
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      positionsRef.current = layoutGraph(nodes).positions;
      // 紐から作ったノードは自動レイアウトより「落とした位置」を優先する
      for (const [id, pos] of overridesRef.current) {
        if (nodes.some((n) => n.id === id)) {
          positionsRef.current.set(id, pos);
          overridesRef.current.delete(id);
        }
      }
      if (pageChanged) {
        // ページ切替時は全体が見える位置へ
        requestAnimationFrame(() => fitView({ padding: 0.2, duration: 200 }));
      }
    }
    setRfNodes(
      nodes.map((n) => ({
        id: n.id,
        type: "task" as const,
        position: positionsRef.current.get(n.id) ?? { x: 0, y: 0 },
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
      })),
    );
  }, [nodes, pageNode, selectedId, editingId, onSelect, commitTitle, fitView]);

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
      const created = await api.addNode({
        title: "",
        parents: parentId ? [parentId] : [],
        group: pageNode?.id ?? null,
      });
      onMutated();
      onSelect(created.id);
      setEditingId(created.id);
    },
    [pageNode, onMutated, onSelect],
  );

  // Houdini と同じ: 紐を何もないところに放したら、その位置にノードを作って接続する
  const handleConnectEnd = useCallback(
    (
      event: MouseEvent | TouchEvent,
      connectionState: {
        isValid: boolean | null;
        fromNode: { id: string } | null;
        fromHandle: { type: string | null } | null;
      },
    ) => {
      if (connectionState.isValid) return; // ノード上で放した→通常の onConnect に任せる
      const from = connectionState.fromNode;
      if (!from) return;
      const isTouch = "changedTouches" in event;
      const cx = isTouch ? event.changedTouches[0].clientX : event.clientX;
      const cy = isTouch ? event.changedTouches[0].clientY : event.clientY;
      const pos = screenToFlowPosition({ x: cx, y: cy });
      const fromType = connectionState.fromHandle?.type ?? "source";
      void (async () => {
        if (fromType === "source") {
          // 出力から空中へ → 子（後続）ノードを落とした位置に作る
          const created = await api.addNode({
            title: "",
            parents: [from.id],
            group: pageNode?.id ?? null,
          });
          overridesRef.current.set(created.id, { x: pos.x - 110, y: pos.y - 16 });
          onMutated();
          onSelect(created.id);
          setEditingId(created.id);
        } else {
          // 入力から空中へ → 親（先行）ノードを作り、自分の parents に足す
          const cur = nodes.find((n) => n.id === from.id);
          const created = await api.addNode({ title: "", parents: [], group: pageNode?.id ?? null });
          await api.patchNode(from.id, { parents: [...(cur?.parents ?? []), created.id] });
          overridesRef.current.set(created.id, { x: pos.x - 110, y: pos.y - 16 });
          onMutated();
          onSelect(created.id);
          setEditingId(created.id);
        }
      })();
    },
    [nodes, pageNode, onMutated, onSelect, screenToFlowPosition],
  );

  // 自動整列: 手動ドラッグ位置を破棄して dagre レイアウトへ戻す
  const realign = useCallback(() => {
    positionsRef.current = layoutGraph(nodes).positions;
    setRfNodes((prev) =>
      prev.map((rn) => ({ ...rn, position: positionsRef.current.get(rn.id) ?? rn.position })),
    );
    requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 }));
  }, [nodes, fitView]);

  // 選択中ノードがこのページのタスクなら、その後続として作る
  const selectedInPage = selectedId && nodes.some((n) => n.id === selectedId) ? selectedId : null;

  return (
    <div className="graph-pane">
      <div className="graph-toolbar">
        {pageNode && (
          <button
            type="button"
            className="page-crumb"
            title="ゴールの詳細を開く"
            onClick={() => onSelect(pageNode.id)}
          >
            {pageNode.title || "（無題）"}
          </button>
        )}
        <button type="button" onClick={() => createNode(selectedInPage)}>
          + ノード
        </button>
        <button type="button" title="dagre で並べ直す" onClick={realign}>
          整列
        </button>
      </div>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
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
