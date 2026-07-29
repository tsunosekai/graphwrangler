import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
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
import { Undo2 } from "lucide-react";
import { api } from "../lib/api";
import { pushToast } from "../lib/toast";
import { layoutGraph, structureSignature, type Pos } from "../lib/layout";
import type { Node } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { CutEdge, type CutEdgeData } from "./CutEdge";
import { LedgerView } from "./LedgerView";
import { NodeCard, type NodeCardData } from "./NodeCard";

const nodeTypes = { task: NodeCard };
const edgeTypes = { cut: CutEdge };

interface Props {
  /** 表示するページ（フォルダ）のメンバーだけが渡される */
  nodes: Node[];
  /** ページ自身のノード（パンくず表示・新規ノードの所属先） */
  pageNode: Node | null;
  selectedId: string | null;
  /** ノードid → 最終メッセージ時刻。未読ドット(QOL-7)の判定に使う */
  threadMeta: Record<string, string>;
  onSelect: (id: string | null) => void;
  onMutated: () => void;
}

function GraphViewInner({ nodes, pageNode, selectedId, threadMeta, onSelect, onMutated }: Props) {
  const positionsRef = useRef<Map<string, Pos>>(new Map());
  // 紐を空中に放して作ったノードの「落とした位置」。次のレイアウト再計算時に適用して消す
  const overridesRef = useRef<Map<string, Pos>>(new Map());
  const sigRef = useRef<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rfNodes, setRfNodes] = useState<RFNode<NodeCardData>[]>([]);
  // QOL-2: 選択中の依存エッジ（Delete/Backspace か✂ボタンで切断できる）
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const { fitView, screenToFlowPosition } = useReactFlow();
  const paneRef = useRef<HTMLDivElement>(null);

  // ビューの幅が変わったとき（パネル開閉・リサイズ）も即座に fit する（本人指定「パチッと」）。
  // 初回発火は fit 済みなのでスキップし、以後は 80ms デバウンスで追従する
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fitView({ padding: 0.2, duration: 0 }), 80);
    });
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, [fitView]);

  // 手順ページ（kind=procedure）だけ「グラフ / 台帳」の表示切替を持つ（docs/design.md 3.8）
  const isProcedure = pageNode?.kind === "procedure";
  const [viewMode, setViewMode] = useState<"graph" | "ledger">("graph");

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
      if (pageChanged) {
        // ページ切替時だけ全体を再レイアウト（B-11: それ以外はドラッグ位置を保持する）
        positionsRef.current = layoutGraph(nodes).positions;
      } else {
        // 既存ノードの現在位置は保持し、新規に現れたノードだけレイアウト結果の位置を使う
        const computed = layoutGraph(nodes).positions;
        for (const n of nodes) {
          if (!positionsRef.current.has(n.id)) {
            const pos = computed.get(n.id);
            if (pos) positionsRef.current.set(n.id, pos);
          }
        }
        // 消えたノードの位置は掃除する（メモリリーク防止）
        const ids = new Set(nodes.map((n) => n.id));
        for (const id of [...positionsRef.current.keys()]) {
          if (!ids.has(id)) positionsRef.current.delete(id);
        }
      }
      // 紐から作ったノードは自動レイアウトより「落とした位置」を優先する
      for (const [id, pos] of overridesRef.current) {
        if (nodes.some((n) => n.id === id)) {
          positionsRef.current.set(id, pos);
          overridesRef.current.delete(id);
        }
      }
      if (pageChanged) {
        // ページ切替時は全体が見える位置へ。「にゅっ」と動かさず即座に（本人指定）
        requestAnimationFrame(() => fitView({ padding: 0.2, duration: 0 }));
      }
    }
    setRfNodes(
      nodes.map((n) => {
        // QOL-7: 未読バッジ。既読tsは NodePanel がスレッド表示のたびに書き込む
        const lastMsgTs = threadMeta[n.id];
        const readTs = lastMsgTs ? localStorage.getItem(`gw.read.${n.id}`) : null;
        const unread = !!lastMsgTs && (!readTs || lastMsgTs > readTs);
        return {
          id: n.id,
          type: "task" as const,
          position: positionsRef.current.get(n.id) ?? { x: 0, y: 0 },
          draggable: true,
          data: {
            node: n,
            selected: n.id === selectedId,
            editing: n.id === editingId,
            isTemplate: isProcedure,
            unread,
            onSelect: (id: string) => onSelect(id),
            onDoubleClick: (id: string) => setEditingId(id),
            onCommitTitle: commitTitle,
            onCancelEdit: () => setEditingId(null),
          } satisfies NodeCardData,
        };
      }),
    );
  }, [nodes, pageNode, selectedId, editingId, isProcedure, threadMeta, onSelect, commitTitle, fitView]);

  // QOL-2: 依存の切断。子ノードの parents から source を除く（Ctrl+Zで戻せる: undo は既存の操作ログ経由）
  const cutEdge = useCallback(
    async (source: string, target: string) => {
      const child = nodes.find((n) => n.id === target);
      if (!child) return;
      await api.patchNode(child.id, { parents: child.parents.filter((p) => p !== source) });
      setSelectedEdgeId(null);
      onMutated();
      pushToast("依存を切りました（Ctrl+Zで戻せます）", "info");
    },
    [nodes, onMutated],
  );

  const rfEdges: RFEdge[] = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return nodes.flatMap((n) =>
      n.parents
        .filter((p) => ids.has(p))
        .map((p) => {
          const id = `${p}->${n.id}`;
          return {
            id,
            source: p,
            target: n.id,
            type: "cut",
            data: {
              selected: id === selectedEdgeId,
              onCut: () => cutEdge(p, n.id),
            } satisfies CutEdgeData,
          };
        }),
    );
  }, [nodes, selectedEdgeId, cutEdge]);

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

  // QOL-9: ペイン空白部のダブルクリックでその位置にノードを作成+リネームモードへ
  // （React Flow の onPaneClick とは別に、ラッパー div へ渡る素の onDoubleClick を使う。
  //  ノード/エッジ/コントロール上のダブルクリックはここでは無視する）
  const handlePaneDoubleClick = useCallback(
    (e: ReactMouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__panel")) {
        return;
      }
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      void (async () => {
        const created = await api.addNode({ title: "", group: pageNode?.id ?? null });
        overridesRef.current.set(created.id, { x: pos.x - 110, y: pos.y - 16 });
        onMutated();
        onSelect(created.id);
        setEditingId(created.id);
      })();
    },
    [pageNode, onMutated, onSelect, screenToFlowPosition],
  );

  // 自動整列: 手動ドラッグ位置を破棄して dagre レイアウトへ戻す。
  // このときだけノード移動に transition を効かせて「にゅっ」と動かす（本人指定。
  // .realigning クラス経由で CSS が .react-flow__node に transform 遷移を付ける）
  const [realigning, setRealigning] = useState(false);
  const realign = useCallback(() => {
    setRealigning(true);
    // クラスが付いた次フレームで位置を更新しないと transition が効かない
    requestAnimationFrame(() => {
      positionsRef.current = layoutGraph(nodes).positions;
      setRfNodes((prev) =>
        prev.map((rn) => ({ ...rn, position: positionsRef.current.get(rn.id) ?? rn.position })),
      );
      fitView({ padding: 0.2, duration: 300 });
      setTimeout(() => setRealigning(false), 400);
    });
  }, [nodes, fitView]);

  // ---- B-8: 元に戻す/やり直す（操作ログの補償追記） ----
  const runUndo = useCallback(async () => {
    try {
      await api.undo();
      pushToast("元に戻しました", "info");
      onMutated();
    } catch {
      // api() 側で既にエラートースト表示済み
    }
  }, [onMutated]);

  const runRedo = useCallback(async () => {
    try {
      await api.redo();
      pushToast("やり直しました", "info");
      onMutated();
    } catch {
      // api() 側で既にエラートースト表示済み
    }
  }, [onMutated]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isEditable) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) void runRedo();
      else void runUndo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runUndo, runRedo]);

  // QOL-2: 選択中の依存エッジを Delete/Backspace で切断（入力欄フォーカス時は無効）
  useEffect(() => {
    if (!selectedEdgeId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isEditable) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      e.preventDefault();
      const [source, target_] = selectedEdgeId.split("->");
      void cutEdge(source, target_);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedEdgeId, cutEdge]);

  // ---- A-1: 下書き承認バー（draft ノードを確定/破棄） ----
  const draftNodes = useMemo(() => nodes.filter((n) => n.lifecycle === "draft"), [nodes]);

  const confirmDrafts = useCallback(async () => {
    for (const n of draftNodes) {
      await api.patchNode(n.id, { lifecycle: "committed" });
    }
    onMutated();
  }, [draftNodes, onMutated]);

  const discardDrafts = useCallback(async () => {
    if (draftNodes.length === 0) return;
    if (!window.confirm(`下書き ${draftNodes.length} 件を破棄しますか？`)) return;
    // 依存の葉（子を持たないノード）から順に削除する。子持ちで消せないものはトースト表示済みなので
    // 次のパスへ回し、1周で1件も消えなくなったら打ち切る（循環や draft 外の子が残っているケース）
    let remaining = draftNodes.map((n) => n.id);
    while (remaining.length > 0) {
      let removedAny = false;
      const stillRemaining: string[] = [];
      for (const id of remaining) {
        try {
          await api.removeNode(id);
          removedAny = true;
        } catch {
          stillRemaining.push(id);
        }
      }
      remaining = stillRemaining;
      if (!removedAny) break;
    }
    onMutated();
  }, [draftNodes, onMutated]);

  // ---- A-5: 硬化率チップ（committed メンバーのうち impl=script の割合） ----
  const hardening = useMemo(() => {
    const committed = nodes.filter((n) => n.lifecycle === "committed");
    const hardened = committed.filter((n) => n.impl?.type === "script");
    return { n: hardened.length, m: committed.length };
  }, [nodes]);

  // 選択中ノードがこのページのタスクなら、その後続として作る
  const selectedInPage = selectedId && nodes.some((n) => n.id === selectedId) ? selectedId : null;

  const showLedger = isProcedure && viewMode === "ledger";

  return (
    <div ref={paneRef} className={`graph-pane relative min-w-0 flex-1${realigning ? " realigning" : ""}`}>
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
        {pageNode && (
          <Button
            type="button"
            variant="ghost"
            className="font-semibold text-muted-foreground hover:text-foreground"
            title="ゴールの詳細を開く"
            onClick={() => onSelect(pageNode.id)}
          >
            {pageNode.title || "（無題）"}
          </Button>
        )}
        {isProcedure && (
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "graph" | "ledger")}>
            <TabsList>
              <TabsTrigger value="graph">グラフ</TabsTrigger>
              <TabsTrigger value="ledger">台帳</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {!showLedger && (
          <>
            <Button type="button" variant="outline" onClick={() => createNode(selectedInPage)}>
              + ノード
            </Button>
            <Button type="button" variant="outline" title="dagre で並べ直す" onClick={realign}>
              整列
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" onClick={runUndo}>
                  <Undo2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>元に戻す (Ctrl+Z)</TooltipContent>
            </Tooltip>
            {hardening.m > 0 && (
              <Badge variant="secondary" title="確定メンバーのうちスクリプト化済みの割合">
                硬化 {hardening.n}/{hardening.m}
              </Badge>
            )}
          </>
        )}
      </div>
      {!showLedger && draftNodes.length > 0 && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-md border border-dashed border-border-strong bg-card px-3 py-2 text-sm">
          <span className="text-muted-foreground">下書き {draftNodes.length}件</span>
          <Button type="button" size="sm" className="border-ok/40 text-ok" variant="outline" onClick={confirmDrafts}>
            すべて確定
          </Button>
          <Button
            type="button"
            size="sm"
            className="border-destructive/40 text-destructive"
            variant="outline"
            onClick={discardDrafts}
          >
            破棄
          </Button>
        </div>
      )}
      {showLedger && pageNode ? (
        <LedgerView procedure={pageNode} members={nodes} onMutated={onMutated} />
      ) : (
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onConnect={handleConnect}
          onConnectEnd={handleConnectEnd}
          onNodeClick={(_, n) => onSelect(n.id)}
          onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)}
          onPaneClick={() => {
            onSelect(null);
            setSelectedEdgeId(null);
          }}
          onDoubleClick={handlePaneDoubleClick}
          zoomOnDoubleClick={false}
          nodeDragThreshold={4}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            createNode(null);
          }}
          proOptions={{ hideAttribution: true }}
          fitView
        >
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
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
