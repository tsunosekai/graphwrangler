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
import { api } from "../lib/api";
import { subscribeOpenShortcuts } from "../lib/palette";
import { pushToast } from "../lib/toast";
import { layoutGraph, structureSignature, type Pos } from "../lib/layout";
import { isRoutinePage } from "../lib/routine";
import type { Node } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { CutEdge, type CutEdgeData } from "./CutEdge";
import { LedgerView } from "./LedgerView";
import { NodeCard, type NodeCardData } from "./NodeCard";
import { ShortcutsDialog } from "./ShortcutsDialog";

const nodeTypes = { task: NodeCard };
const edgeTypes = { cut: CutEdge };

// ---- Ctrl+C/Ctrl+V/Ctrl+D 用のアプリ内クリップボード（モジュール変数。ページを跨いでも保持する） ----
interface ClipboardNode {
  origId: string;
  title: string;
  detail: string | null;
  impl: Node["impl"];
  executor: Node["executor"];
  impact: Node["impact"];
  kind: Node["kind"];
  /** kind=decision のときの選択肢定義（コピーで引き継ぐ。他kindではnull。docs/design.md 3.9） */
  branches: Node["branches"];
  /** コピー元選択内で閉じた依存だけを覚える（外部への parents は貼り付け時に捨てる） */
  parentOrigIds: string[];
  /** parentOrigIds のうち親がdecisionのものについて、どの枝から生えるか（親id → 枝id） */
  parentOptions: Node["parentOptions"];
  pos: Pos;
}
let clipboard: ClipboardNode[] = [];

/** 入力欄・ダイアログ・ChatDrawer にフォーカスがある間はショートカットを無効にする */
function isShortcutBlocked(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  if (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  ) {
    return true;
  }
  // radix Dialog(CommandPalette/SetupModal/ShortcutsDialog等)は role="dialog" を持つ
  if (target.closest('[role="dialog"]')) return true;
  // ChatDrawer のルート要素に data-shortcuts-block を付けてある
  if (target.closest("[data-shortcuts-block]")) return true;
  return false;
}

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
  /** 複数選択件数。NodePanel の「他 N件選択中」表示に使う（QOL: 複数選択） */
  onSelectionCountChange?: (count: number) => void;
}

function GraphViewInner({
  nodes,
  pageNode,
  selectedId,
  threadMeta,
  onSelect,
  onMutated,
  onSelectionCountChange,
}: Props) {
  const positionsRef = useRef<Map<string, Pos>>(new Map());
  // 紐を空中に放して作ったノードの「落とした位置」。次のレイアウト再計算時に適用して消す
  const overridesRef = useRef<Map<string, Pos>>(new Map());
  // 貼り付け/複製で作った新規ノード群を、サーバから戻ってきた時点で選択状態にするための予約
  const pendingSelectRef = useRef<Set<string> | null>(null);
  // 直近クリックしたノードid。onSelectionChange の「最後に選択されたノード」推定を補強する
  const lastClickedRef = useRef<string | null>(null);
  const sigRef = useRef<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rfNodes, setRfNodes] = useState<RFNode<NodeCardData>[]>([]);
  // QOL-2: 選択中の依存エッジ（Delete/Backspace か✂ボタンで切断できる）
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const { fitView, screenToFlowPosition, getNodes } = useReactFlow();

  // ヘッダーの⌨ボタンからショートカット一覧を開く（ダイアログ本体はここが持つ）
  useEffect(() => subscribeOpenShortcuts(() => setShortcutsOpen(true)), []);

  // 現在選択中のノードid一覧（React Flow の内部 selected フラグから）
  const getSelectedNodeIds = useCallback(
    () => getNodes().filter((n) => n.selected).map((n) => n.id),
    [getNodes],
  );

  // App への「最後に選択されたノード」+件数の同期（プログラム的な選択変更用。
  // クリック由来は onNodeClick が正確な値を lastClickedRef 経由で運ぶ）
  const reportSelection = useCallback(
    (ids: string[]) => {
      onSelectionCountChange?.(ids.length);
      const primary = ids.length > 0 ? ids[ids.length - 1] : null;
      lastClickedRef.current = primary;
      onSelect(primary);
    },
    [onSelect, onSelectionCountChange],
  );

  // rfNodes の selected フラグをまとめて書き換え、App にも同期する
  // （Ctrl+A/Escape/貼り付け/複製など、React Flow のネイティブ操作を経由しない選択変更で使う）
  const applySelection = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids);
      setRfNodes((prev) =>
        prev.map((n) => (idSet.has(n.id) === !!n.selected ? n : { ...n, selected: idSet.has(n.id) })),
      );
      reportSelection(ids);
    },
    [reportSelection],
  );

  // パネルの✕などで選択が解除された（selectedId=null）ら、React Flow 内部の selected も
  // 消す。残っていると、その後の何気ない操作（ドラッグ開始・ポーリング再描画等）で
  // selection-change が発火した際に「まだ選択中」と解釈されてパネルが勝手に開き直す
  // （2026-07-31 本人報告のバグ）
  useEffect(() => {
    if (selectedId !== null) return;
    lastClickedRef.current = null;
    setRfNodes((prev) =>
      prev.some((n) => n.selected) ? prev.map((n) => (n.selected ? { ...n, selected: false } : n)) : prev,
    );
  }, [selectedId]);

  // React Flow のネイティブ選択（クリック/Shift+クリック/矩形選択）が変わった時。
  // 「最後に選択されたノード」は配列順では分からないため、直近クリックが選択集合に
  // 残っていればそれを優先し、無ければ（矩形選択など）配列末尾で妥協する
  const handleSelectionChange = useCallback(
    ({ nodes: selNodes }: { nodes: RFNode<NodeCardData>[] }) => {
      const ids = selNodes.map((n) => n.id);
      onSelectionCountChange?.(ids.length);
      if (ids.length === 0) return;
      const primary =
        lastClickedRef.current && ids.includes(lastClickedRef.current)
          ? lastClickedRef.current
          : ids[ids.length - 1];
      onSelect(primary);
    },
    [onSelect, onSelectionCountChange],
  );

  // 実測ノードサイズ（React Flow の measured）。整列時に渡すと、ノードの縦幅に
  // 関わらずノード間の間隔が一定になる（本人指定）
  const measuredSizes = useCallback(() => {
    const m = new Map<string, { width: number; height: number }>();
    for (const rn of getNodes()) {
      if (rn.measured?.width && rn.measured?.height) {
        m.set(rn.id, { width: rn.measured.width, height: rn.measured.height });
      }
    }
    return m;
  }, [getNodes]);
  const paneRef = useRef<HTMLDivElement>(null);

  // ビューの幅が**狭くなったとき**だけ即座に fit する（本人指定。広がるときは fit しない
  // — ノードが見切れる方向だけ救済すればよく、広がったときに視点が飛ぶのは煩わしい）
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let prevWidth = el.getBoundingClientRect().width;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? prevWidth;
      const shrank = width < prevWidth - 1;
      prevWidth = width;
      if (!shrank) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fitView({ padding: 0.2, duration: 0 }), 80);
    });
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, [fitView]);

  // ルーティーンページだけ「グラフ / 台帳」の表示切替を持つ（docs/design.md 3.8 新モデル）。
  // 「ルーティーンであること」はページ種別(kind=procedure。非推奨)ではなく、
  // フロー先頭の trigger ノードがメンバーにいるかどうかから導出する（isRoutinePage が判定を一元化）。
  // nodes は既に「このページのメンバー」だけに絞られているので、そのまま members として渡せる
  const isRoutine = pageNode ? isRoutinePage(pageNode, nodes) : false;
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
        positionsRef.current = layoutGraph(nodes, measuredSizes()).positions;
      } else {
        // 既存ノードの現在位置は保持し、新規に現れたノードだけレイアウト結果の位置を使う
        const computed = layoutGraph(nodes, measuredSizes()).positions;
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
        // 前ページの多重選択は引き継がない（NodePanel の「他N件」表示もリセット）
        onSelectionCountChange?.(selectedId ? 1 : 0);
      }
    }
    // 複数選択(rn.selected)はポーリングのたびに rfNodes を作り直しても消えないよう、
    // 直前の React Flow 内部状態から id ベースで引き継ぐ（本人指定）。
    // ただし選択解除中（selectedId=null）は引き継がない——内部ストアへの反映は非同期のため、
    // ✕で閉じた直後の再構築が古い selected を復活させ、後続の操作でパネルが勝手に開き直す
    // （2026-07-31 本人報告・1回目の修正で残った経路）
    const prevSelected =
      selectedId === null
        ? new Set<string>()
        : new Set(getNodes().filter((n) => n.selected).map((n) => n.id));
    // 貼り付け/複製で作った新規ノードが今回のポーリングで初めて出現したら、選択状態にする
    const pending = pendingSelectRef.current;
    let pendingMatched: string[] = [];
    if (pending) {
      pendingMatched = nodes.map((n) => n.id).filter((id) => pending.has(id));
      if (pendingMatched.length > 0) pendingSelectRef.current = null;
    }
    const byIdForFrontier = new Map(nodes.map((n) => [n.id, n] as const));
    const isFrontierOf = (n: Node) =>
      n.parents.every((p) => {
        const st = byIdForFrontier.get(p)?.status;
        return st === "done" || st === "skipped";
      });
    setRfNodes(
      nodes.map((n) => {
        // QOL-7: 未読バッジ。既読tsは NodePanel がスレッド表示のたびに書き込む
        const lastMsgTs = threadMeta[n.id];
        const readTs = lastMsgTs ? localStorage.getItem(`gw.read.${n.id}`) : null;
        const unread = !!lastMsgTs && (!readTs || lastMsgTs > readTs);
        const selected =
          pendingMatched.length > 0 ? pendingMatched.includes(n.id) : prevSelected.has(n.id) || n.id === selectedId;
        return {
          id: n.id,
          type: "task" as const,
          position: positionsRef.current.get(n.id) ?? { x: 0, y: 0 },
          draggable: true,
          selected,
          data: {
            node: n,
            selected: n.id === selectedId,
            editing: n.id === editingId,
            isTemplate: isRoutine,
            isFrontier: isFrontierOf(n),
            unread,
            onSelect: (id: string) => onSelect(id),
            onDoubleClick: (id: string) => setEditingId(id),
            onCommitTitle: commitTitle,
            onCancelEdit: () => setEditingId(null),
          } satisfies NodeCardData,
        };
      }),
    );
    if (pendingMatched.length > 0) reportSelection(pendingMatched);
  }, [
    nodes,
    pageNode,
    selectedId,
    editingId,
    isRoutine,
    threadMeta,
    onSelect,
    commitTitle,
    fitView,
    getNodes,
    reportSelection,
    onSelectionCountChange,
  ]);

  // QOL-2: 依存の切断。子ノードの parents から source を除く（Ctrl+Zで戻せる: undo は既存の操作ログ経由）。
  // source が decision の枝だった場合、parentOptions からも該当エントリを削除する（docs/design.md 3.9）
  const cutEdge = useCallback(
    async (source: string, target: string) => {
      const child = nodes.find((n) => n.id === target);
      if (!child) return;
      const restParentOptions = Object.fromEntries(
        Object.entries(child.parentOptions).filter(([decisionId]) => decisionId !== source),
      );
      await api.patchNode(child.id, {
        parents: child.parents.filter((p) => p !== source),
        parentOptions: restParentOptions,
      });
      setSelectedEdgeId(null);
      onMutated();
      pushToast("依存を切りました（Ctrl+Zで戻せます）", "info");
    },
    [nodes, onMutated],
  );

  const rfEdges: RFEdge[] = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    const ids = new Set(nodes.map((n) => n.id));
    return nodes.flatMap((n) =>
      n.parents
        .filter((p) => ids.has(p))
        .map((p) => {
          const id = `${p}->${n.id}`;
          const parent = byId.get(p);
          // decision の子は必ずどの枝から生えるかを parentOptions に持つ（docs/design.md 3.9）。
          // sourceHandle を合わせないと NodeCard 側の複数ハンドルのどれにも繋がらない
          const branchId = parent?.kind === "decision" ? n.parentOptions[p] : undefined;
          // choice 確定後、選ばれなかった枝のエッジは減光する
          const deemphasize = !!(
            parent?.kind === "decision" &&
            parent.choice &&
            branchId &&
            parent.choice !== branchId
          );
          return {
            id,
            source: p,
            target: n.id,
            ...(branchId ? { sourceHandle: branchId } : {}),
            type: "cut",
            data: {
              selected: id === selectedEdgeId,
              // 枝ラベルはポート下の常設ラベルに一本化（エッジ中点にも出すと短いエッジで二重表示になる）
              deemphasize,
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

  // source が decision の枝ハンドルなら、parents に加えて parentOptions[decisionId]=branchId も
  // 一緒に patch する（docs/design.md 3.9。子側がどの枝から生えるかを持つ形）
  const handleConnect = useCallback(
    async (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      const child = nodes.find((n) => n.id === conn.target);
      if (!child || child.parents.includes(conn.source)) return;
      // trigger は parents を持てない=グラフの起点（docs/design.md 3.4）。NodeCard 側で
      // 入力ハンドル自体を出していないため通常は起きないが、防御としても弾いておく
      if (child.kind === "trigger") {
        pushToast("トリガーノードは他のノードの後続にできません（parents を持てません）");
        return;
      }
      const parent = nodes.find((n) => n.id === conn.source);
      const parents = [...child.parents, conn.source];
      if (parent?.kind === "decision" && conn.sourceHandle) {
        await api.patchNode(child.id, {
          parents,
          parentOptions: { ...child.parentOptions, [conn.source]: conn.sourceHandle },
        });
      } else {
        await api.patchNode(child.id, { parents });
      }
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
        fromHandle: { type: string | null; id?: string | null } | null;
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
      const fromHandleId = connectionState.fromHandle?.id ?? null;
      void (async () => {
        if (fromType === "source") {
          // 出力から空中へ → 子（後続）ノードを落とした位置に作る。
          // from が decision ノードなら、放したハンドルの枝id を parentOptions に持たせる（3.9）
          const fromNode = nodes.find((n) => n.id === from.id);
          const created = await api.addNode({
            title: "",
            parents: [from.id],
            group: pageNode?.id ?? null,
            ...(fromNode?.kind === "decision" && fromHandleId
              ? { parentOptions: { [from.id]: fromHandleId } }
              : {}),
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
      positionsRef.current = layoutGraph(nodes, measuredSizes()).positions;
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

  // 依存の葉（選択集合内で自分を parents に持つノードがいない）から順に削除を試みる。
  // 子持ちで消せないものは api() 側のトーストに任せ、次のパスへ回す。1周で1件も消えなければ打ち切る
  // （ループが自然と葉順に収束するので、事前ソートは行わずAPIエラーに任せる。deleteSelectedNodes と共用）
  const removeLeafFirst = useCallback(async (ids: string[]): Promise<string[]> => {
    let remaining = [...ids];
    const deleted: string[] = [];
    while (remaining.length > 0) {
      let removedAny = false;
      const stillRemaining: string[] = [];
      for (const id of remaining) {
        try {
          await api.removeNode(id);
          deleted.push(id);
          removedAny = true;
        } catch {
          stillRemaining.push(id);
        }
      }
      remaining = stillRemaining;
      if (!removedAny) break;
    }
    return deleted;
  }, []);

  // Delete/Backspace（選択エッジが無い時）: 選択中の全ノードを削除。confirm は無し（undo で戻せるため）
  const deleteSelectedNodes = useCallback(async () => {
    const ids = getSelectedNodeIds();
    if (ids.length === 0) return;
    const deleted = await removeLeafFirst(ids);
    applySelection([]);
    onMutated();
    if (deleted.length > 0) pushToast(`${deleted.length}件削除しました（Ctrl+Zで戻せます）`, "info");
  }, [getSelectedNodeIds, removeLeafFirst, applySelection, onMutated]);

  // Ctrl+C: 選択ノードをモジュール変数のクリップボードへ（thread は持たない。新規ノードとして貼り付ける）
  const copySelection = useCallback(() => {
    const ids = getSelectedNodeIds();
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const entries: ClipboardNode[] = [];
    for (const id of ids) {
      const n = nodes.find((x) => x.id === id);
      if (!n) continue;
      entries.push({
        origId: id,
        title: n.title,
        detail: n.detail,
        impl: n.impl,
        executor: n.executor,
        impact: n.impact,
        kind: n.kind,
        // kind=decision の選択肢定義はそのまま引き継ぐ（無いと貼り付け時にサーバ検証で弾かれる）
        branches: n.branches,
        // 選択内で閉じた依存だけ覚える。外部への parents は貼り付け時に捨てる
        parentOrigIds: n.parents.filter((p) => idSet.has(p)),
        // 同様に、選択内で閉じたdecision親への枝の対応だけ引き継ぐ
        parentOptions: Object.fromEntries(
          Object.entries(n.parentOptions).filter(([decisionId]) => idSet.has(decisionId)),
        ),
        pos: positionsRef.current.get(id) ?? { x: 0, y: 0 },
      });
    }
    clipboard = entries;
    pushToast(`${entries.length}件コピーしました`, "info");
  }, [nodes, getSelectedNodeIds]);

  // Ctrl+V/Ctrl+D 共通: エントリ群を新規ノードとして作り、選択内で閉じた依存だけ張り替える。
  // id はサーバ採番なので、まず全部作ってから旧id→新idマップで parents/parentOptions を patch する
  const materializeClipboard = useCallback(
    async (entries: ClipboardNode[], label: string) => {
      if (entries.length === 0) return;
      const idMap = new Map<string, string>();
      const createdIds: string[] = [];
      for (const entry of entries) {
        const created = await api.addNode({
          title: entry.title,
          detail: entry.detail,
          impl: entry.impl,
          executor: entry.executor,
          impact: entry.impact,
          kind: entry.kind,
          branches: entry.branches,
          group: pageNode?.id ?? null,
          lifecycle: "draft",
          status: "pending",
        });
        idMap.set(entry.origId, created.id);
        createdIds.push(created.id);
        // 元の位置+40pxオフセット。次のレイアウト再計算時に一度だけ適用される（handleConnectEnd と同じ仕組み）
        overridesRef.current.set(created.id, { x: entry.pos.x + 40, y: entry.pos.y + 40 });
      }
      for (const entry of entries) {
        const newParents = entry.parentOrigIds
          .map((pid) => idMap.get(pid))
          .filter((x): x is string => !!x);
        if (newParents.length === 0) continue;
        const newId = idMap.get(entry.origId);
        if (!newId) continue;
        const newParentOptions = Object.fromEntries(
          Object.entries(entry.parentOptions)
            .map(([oldDecisionId, branchId]) => [idMap.get(oldDecisionId), branchId] as const)
            .filter((pair): pair is [string, string] => !!pair[0]),
        );
        await api.patchNode(newId, { parents: newParents, parentOptions: newParentOptions });
      }
      // 作成したノード群がポーリングで出現したら選択する（App の selectedId は1件しか運べないため）
      pendingSelectRef.current = new Set(createdIds);
      onMutated();
      pushToast(`${createdIds.length}件${label}しました（Ctrl+Zで戻せます）`, "info");
    },
    [pageNode, onMutated],
  );

  const pasteClipboard = useCallback(
    () => materializeClipboard(clipboard, "貼り付け"),
    [materializeClipboard],
  );

  // Ctrl+D: Ctrl+C→Ctrl+V 相当を一発で（モジュール変数のクリップボードは書き換えない）
  const duplicateSelection = useCallback(() => {
    const ids = getSelectedNodeIds();
    if (ids.length === 0) return Promise.resolve();
    const idSet = new Set(ids);
    const entries: ClipboardNode[] = ids
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is Node => !!n)
      .map((n) => ({
        origId: n.id,
        title: n.title,
        detail: n.detail,
        impl: n.impl,
        executor: n.executor,
        impact: n.impact,
        kind: n.kind,
        branches: n.branches,
        parentOrigIds: n.parents.filter((p) => idSet.has(p)),
        parentOptions: Object.fromEntries(
          Object.entries(n.parentOptions).filter(([decisionId]) => idSet.has(decisionId)),
        ),
        pos: positionsRef.current.get(n.id) ?? { x: 0, y: 0 },
      }));
    return materializeClipboard(entries, "複製");
  }, [nodes, getSelectedNodeIds, materializeClipboard]);

  // F: 選択ノードがあればそれらにズーム、無ければ全体
  const fitSelectionOrAll = useCallback(() => {
    const ids = getSelectedNodeIds();
    if (ids.length > 0) fitView({ nodes: ids.map((id) => ({ id })), padding: 0.2, duration: 0 });
    else fitView({ padding: 0.2, duration: 0 });
  }, [fitView, getSelectedNodeIds]);

  // 選択中ノードがこのページのタスクなら、その後続として作る（Tab / 「+ ノード」ボタン共通）
  const selectedInPage = selectedId && nodes.some((n) => n.id === selectedId) ? selectedId : null;

  // Tab（選択なし）: 画面中央に新規ノードを作成+即リネーム。QOL-9のダブルクリック作成と同じ仕組み
  const createNodeAtCenter = useCallback(async () => {
    const rect = paneRef.current?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : 0;
    const cy = rect ? rect.top + rect.height / 2 : 0;
    const pos = screenToFlowPosition({ x: cx, y: cy });
    const created = await api.addNode({ title: "", group: pageNode?.id ?? null });
    overridesRef.current.set(created.id, { x: pos.x - 110, y: pos.y - 16 });
    onMutated();
    onSelect(created.id);
    setEditingId(created.id);
  }, [pageNode, onMutated, onSelect, screenToFlowPosition]);

  // ---- ノードエディタ標準のキーボードショートカット（Houdini/Blender/ComfyUI 準拠）。
  //      window で一元管理し、入力欄フォーカス中・ダイアログ/ChatDrawer 内では全て無効にする ----
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isShortcutBlocked(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      const keyLower = key.toLowerCase();

      if (mod && keyLower === "z") {
        e.preventDefault();
        if (e.shiftKey) void runRedo();
        else void runUndo();
        return;
      }
      if (key === "Delete" || key === "Backspace") {
        if (selectedEdgeId) {
          e.preventDefault();
          const [source, target_] = selectedEdgeId.split("->");
          void cutEdge(source, target_);
        } else if (getSelectedNodeIds().length > 0) {
          e.preventDefault();
          void deleteSelectedNodes();
        }
        return;
      }
      if (mod && keyLower === "a") {
        e.preventDefault();
        applySelection(nodes.map((n) => n.id));
        return;
      }
      if (mod && keyLower === "c") {
        if (getSelectedNodeIds().length === 0) return; // 通常のテキストコピーを邪魔しない
        e.preventDefault();
        copySelection();
        return;
      }
      if (mod && keyLower === "v") {
        if (clipboard.length === 0) return;
        e.preventDefault();
        void pasteClipboard();
        return;
      }
      if (mod && keyLower === "d") {
        if (getSelectedNodeIds().length === 0) return;
        e.preventDefault();
        void duplicateSelection();
        return;
      }
      if (!mod && keyLower === "f") {
        e.preventDefault();
        fitSelectionOrAll();
        return;
      }
      if (!mod && keyLower === "l") {
        e.preventDefault();
        realign();
        return;
      }
      if (key === "F2") {
        const ids = getSelectedNodeIds();
        if (ids.length === 1) {
          e.preventDefault();
          setEditingId(ids[0]);
        }
        return;
      }
      if (key === "Tab") {
        e.preventDefault();
        if (selectedInPage) void createNode(selectedInPage);
        else void createNodeAtCenter();
        return;
      }
      if (key === "Escape") {
        applySelection([]);
        setSelectedEdgeId(null);
        return;
      }
      if (key === "?" || (e.shiftKey && key === "/")) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    selectedEdgeId,
    cutEdge,
    runUndo,
    runRedo,
    nodes,
    applySelection,
    getSelectedNodeIds,
    deleteSelectedNodes,
    copySelection,
    pasteClipboard,
    duplicateSelection,
    fitSelectionOrAll,
    realign,
    createNode,
    createNodeAtCenter,
    selectedInPage,
  ]);

  // ---- Fix率チップ: Fix済み（やり方確定=ロック）ノード / 全メンバー。
  //      100% = このページの Fix 完了（スクリプト化率ではない。2026-07-31 本人定義） ----
  const hardening = useMemo(() => {
    const fixed = nodes.filter((n) => n.fixed);
    return { n: fixed.length, m: nodes.length };
  }, [nodes]);

  const showLedger = isRoutine && viewMode === "ledger";

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
        {isRoutine && (
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
            {/* 「元に戻す」「ショートカット一覧」ボタンはヘッダー（TopBar）へ移動
                （2026-07-31 本人指示）。Ctrl+Z / "?" キーとダイアログ本体は引き続きここが持つ */}
            {hardening.m > 0 && (
              <Badge variant="secondary" title="確定メンバーのうちスクリプト化済みの割合">
                Fix {hardening.n}/{hardening.m}
              </Badge>
            )}
          </>
        )}
      </div>
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
          onNodeClick={(_, n) => {
            lastClickedRef.current = n.id;
            onSelect(n.id);
          }}
          onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)}
          onSelectionChange={handleSelectionChange}
          onPaneClick={() => {
            onSelect(null);
            onSelectionCountChange?.(0);
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
          // 複数選択: クリック/Shift+クリック/Ctrl+クリックで追加選択、Shift+ドラッグで矩形選択。
          // パン(素のドラッグ)は既定のまま邪魔しない
          selectionKeyCode="Shift"
          multiSelectionKeyCode={["Shift", "Control", "Meta"]}
          fitView
        >
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
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
