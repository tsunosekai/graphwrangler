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
import { confirmDialog, promptDialog } from "../lib/dialogs";
import { buildRemoveMessage, computeRemoveImpact, removeImpactWarnings } from "../lib/removal";
import { subscribeOpenShortcuts } from "../lib/palette";
import { pushToast } from "../lib/toast";
import { layoutGraph, structureSignature, type Pos } from "../lib/layout";
import { isRoutinePage } from "../lib/routine";
import { useIsMobile } from "../hooks/useIsMobile";
import type { Node, Run } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { CutEdge, type CutEdgeData } from "./CutEdge";
import { Hint } from "./Hint";
import { LedgerView } from "./LedgerView";
import { NodeCard, type NodeCardData } from "./NodeCard";
import { ShortcutsDialog } from "./ShortcutsDialog";

const nodeTypes = { task: NodeCard };
const edgeTypes = { cut: CutEdge };

// ズームの下限・上限。ReactFlow の props とモバイルの自前ピンチズームで同じ値を使う
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2;

// フィット時の余白。ノード矩形の外側に付く装飾（左右のポート・🔒・＋・ラン名バッジ）も
// 画面内に収まるように広めに取る（2026-08-02 本人要望「ノードの周りにある要素も収まるように」）。
// 自前の fitView 呼び出し（整列・Fキー・ページ切替）と、ReactFlow 側のフィット
// （初期表示の fitView prop・Controls のフィットボタン）の両方がこの値を使い、
// どこから合わせても同じ収まり方になる（2026-08-03 本人報告「合わせ方がズレている」の修正）
const FIT_PADDING = 0.3;
const FIT_VIEW_OPTIONS = { padding: FIT_PADDING };

// ---- Ctrl+C/Ctrl+V/Ctrl+D 用のアプリ内クリップボード（モジュール変数。ページを跨いでも保持する） ----
interface ClipboardNode {
  origId: string;
  title: string;
  detail: string | null;
  impl: Node["impl"];
  executor: Node["executor"];
  approval: Node["approval"];
  autonomy: Node["autonomy"];
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
  /** ノードid → 最終メッセージ時刻。未読ドットの判定に使う */
  threadMeta: Record<string, string>;
  /** ノードid → 既読時刻（サーバ持ち。2026-08-02 localStorage から移行＝端末間で一致） */
  reads: Record<string, string>;
  /** グラフに投影中のラン（docs/design.md 3.8）。ルーティーンページでない/実行中のランが
   *  無い間は null（App が算出して渡す）。ある間だけテンプレートのカードにその進捗を投影する */
  activeRun: Run | null;
  /** 現在ページの実行中ラン一覧（新しい順）。2本以上並走しているとき（パラレルワールド）、
   *  ツールバーのセレクトでどの世界線を投影するか切り替える */
  runningRuns?: Run[];
  onProjectRun?: (runId: string) => void;
  onSelect: (id: string | null) => void;
  /** ユーザーが**キャンバス上でノードを実際にタップ/クリックした**ときだけ呼ばれる。
   *  onSelect は React Flow の selection-change（ポーリング再描画でも再発火する）からも
   *  呼ばれるため、モバイルの「タップでノード詳細ビューへ」の判定にはこちらを使う
   *  （2026-08-02 本人報告「開いて2秒後ぐらいに勝手にノード詳細に行く」の修正） */
  onNodeTap?: (id: string) => void;
  onMutated: () => void;
  /** 選択中ノードの id 一覧（複数選択）。App が一括編集パネル（BulkPanel）の表示に使う */
  onSelectionIdsChange?: (ids: string[]) => void;
}

function GraphViewInner({
  nodes,
  pageNode,
  selectedId,
  threadMeta,
  reads,
  activeRun,
  runningRuns = [],
  onProjectRun,
  onSelect,
  onNodeTap,
  onMutated,
  onSelectionIdsChange,
}: Props) {
  const positionsRef = useRef<Map<string, Pos>>(new Map());
  // 紐を空中に放して作ったノードの「落とした位置」。次のレイアウト再計算時に適用して消す
  const overridesRef = useRef<Map<string, Pos>>(new Map());
  // 貼り付け/複製で作った新規ノード群を、サーバから戻ってきた時点で選択状態にするための予約
  const pendingSelectRef = useRef<Set<string> | null>(null);
  // 直近クリックしたノードid。onSelectionChange の「最後に選択されたノード」推定を補強する
  const lastClickedRef = useRef<string | null>(null);
  /** 直近に App へ報告した選択 id 一覧。App 側の selectedId がこれに含まれない＝
   *  グラフ以外（レールのプロジェクト選択・パネルの✕など）から選択が変えられた、の判定に使う */
  const reportedIdsRef = useRef<string[]>([]);
  const sigRef = useRef<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rfNodes, setRfNodes] = useState<RFNode<NodeCardData>[]>([]);
  // 選択中の依存エッジ（Delete/Backspace か✂ボタンで切断できる）
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const { fitView, screenToFlowPosition, getNodes, getViewport, setViewport } = useReactFlow();
  const isMobile = useIsMobile();

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
      reportedIdsRef.current = ids;
      onSelectionIdsChange?.(ids);
      const primary = ids.length > 0 ? ids[ids.length - 1] : null;
      lastClickedRef.current = primary;
      onSelect(primary);
    },
    [onSelect, onSelectionIdsChange],
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
      // 表示中ページに実在するノードだけを選択として扱う。ページ切替の瞬間、React Flow は
      // 旧ページの選択ノードを含んだまま selection-change を発火することがあり、それを
      // onSelect に流すと selectNode が旧ノードのページへ引き戻す（「一覧からBを開いたのに
      // Aのノード詳細に戻される」ねじれ。2026-08-02 本人報告）
      const valid = new Set(nodes.map((n) => n.id));
      const ids = selNodes.map((n) => n.id).filter((id) => valid.has(id));
      // **購読の張り直しによるエコーを無視する**（2026-08-02 実測で特定）。React Flow の
      // onSelectionChange はコールバックの identity が変わるだけでも現在の選択をそのまま
      // 呼び返す。App の selectNode は selectedId に依存して作り直されるため、
      // 「レールやツールバーからゴールを選ぶ → selectedId が変わる → 購読が張り直される →
      // まだ選択中の**古いノード**が呼び返される → 選択が巻き戻る」という循環になっていた
      // （プロジェクト詳細が開けない・✕で閉じてもすぐ開き直す、の実体）。
      // 直前に報告した集合と同じなら「新しい選択操作ではない」ので何もしない
      const prevReported = reportedIdsRef.current;
      if (ids.length === prevReported.length && ids.every((id, i) => id === prevReported[i])) return;
      reportedIdsRef.current = ids;
      onSelectionIdsChange?.(ids);
      if (ids.length === 0) return;
      const primary =
        lastClickedRef.current && ids.includes(lastClickedRef.current)
          ? lastClickedRef.current
          : ids[ids.length - 1];
      onSelect(primary);
    },
    [nodes, onSelect, onSelectionIdsChange],
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

  // モバイルの1本指パン: React Flow 標準は「画面ピクセル基準」のパンで、拡大中は
  // スワイプしてもコンテンツがほとんど進まない。ズームに比例して速くする
  // （1スワイプ＝同じコンテンツ距離。縮小時は等速のまま＝clamp min 1）ことで、
  // 拡大倍率に関わらず感覚的に同じだけ動く（2026-08-02 本人要望）。
  // ReactFlow 側の panOnDrag はモバイルでは無効化し（下の props）、ここが唯一のパン経路。
  // **2本指ピンチズームもここが唯一の経路**（2026-08-02 修正）。panOnDrag={false} にすると
  // @xyflow/system の zoom filter が `!panOnDrag && event.type === 'touchstart'` で
  // touchstart を丸ごと捨てるため、zoomOnPinch が既定 true でも d3-zoom がジェスチャを
  // 開始できずピンチが死ぬ。自前パンを持った時点でピンチも自前で持つしかない。
  // ノード/エッジ/ボタン上のタッチはノードドラッグ等の邪魔をしないよう素通しする
  // （ただしピンチは指がノードに乗っていても効かせる——密なグラフで拾えないと使えないため。
  //   ノードをドラッグ中だけは横取りしない）
  useEffect(() => {
    if (!isMobile) return;
    const el = paneRef.current;
    if (!el) return;
    let last: { x: number; y: number } | null = null;
    let pinch: { dist: number; cx: number; cy: number } | null = null;
    const pannable = (t: EventTarget | null) => {
      const target = t as HTMLElement | null;
      if (!target?.closest) return false;
      if (target.closest(".react-flow__node,.react-flow__edge,.react-flow__controls,button,input,textarea,select")) return false;
      return !!target.closest(".react-flow__pane");
    };
    const gap = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a: Touch, b: Touch) => ({ cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 });
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2 && !el.querySelector(".react-flow__node.dragging")) {
        last = null;
        pinch = { dist: gap(e.touches[0], e.touches[1]), ...mid(e.touches[0], e.touches[1]) };
        return;
      }
      pinch = null;
      if (e.touches.length !== 1 || !pannable(e.target)) {
        last = null;
        return;
      }
      last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        const dist = gap(a, b);
        const { cx, cy } = mid(a, b);
        if (pinch.dist > 0) {
          const rect = el.getBoundingClientRect();
          const vp = getViewport();
          const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (vp.zoom * dist) / pinch.dist));
          // 直前の指の中心にあったグラフ上の点を、新しい指の中心へ置き直す。
          // これで「指の間が拡大の焦点」になり、2本指のまま動かせばパンにもなる
          const gx = (pinch.cx - rect.left - vp.x) / vp.zoom;
          const gy = (pinch.cy - rect.top - vp.y) / vp.zoom;
          setViewport({ x: cx - rect.left - gx * zoom, y: cy - rect.top - gy * zoom, zoom });
        }
        pinch = { dist, cx, cy };
        e.preventDefault(); // ブラウザのページズームを止める
        return;
      }
      if (!last || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - last.x;
      const dy = t.clientY - last.y;
      last = { x: t.clientX, y: t.clientY };
      const vp = getViewport();
      const f = Math.max(1, vp.zoom);
      setViewport({ x: vp.x + dx * f, y: vp.y + dy * f, zoom: vp.zoom });
      e.preventDefault(); // ブラウザのスクロール/バウンスを止める
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
      // ピンチ→1本指に減ったら、残った指でそのままパンを続けられるよう基準を取り直す
      last =
        e.touches.length === 1 && pannable(e.touches[0].target)
          ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
          : null;
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [isMobile, getViewport, setViewport]);

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
      // 非表示（幅0）→表示への復帰もフィット対象（モバイルのタブ切替で「グラフを開いた
      // とき」に全体が見えるように。2026-08-02 本人要望）
      const revealed = prevWidth < 5 && width >= 5;
      prevWidth = width;
      if (!shrank && !revealed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fitView({ padding: FIT_PADDING, duration: 0 }), 80);
    });
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, [fitView]);

  // ルーティーンページだけ「グラフ / 台帳」の表示切替を持つ（docs/design.md 3.8）。
  // 「ルーティーンであること」は trigger ノードがメンバーにいるかどうかから導出する
  // （isRoutinePage が判定を一元化）。
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
        // ページ切替時だけ全体を再レイアウト（それ以外はドラッグ位置を保持する）
        positionsRef.current = layoutGraph(nodes, measuredSizes());
      } else {
        // 既存ノードの現在位置は保持し、新規に現れたノードだけレイアウト結果の位置を使う
        // （現在位置を渡し、新規ノードの置き場所も既存の左右関係に沿わせる）
        const computed = layoutGraph(nodes, measuredSizes(), positionsRef.current);
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
        requestAnimationFrame(() => fitView({ padding: FIT_PADDING, duration: 0 }));
        // 前ページの多重選択は引き継がない
        onSelectionIdsChange?.(selectedId ? [selectedId] : []);
      }
    }
    // 複数選択(rn.selected)はポーリングのたびに rfNodes を作り直しても消えないよう、
    // 直前の React Flow 内部状態から id ベースで引き継ぐ（本人指定）。
    // ただし選択解除中（selectedId=null）は引き継がない——内部ストアへの反映は非同期のため、
    // ✕で閉じた直後の再構築が古い selected を復活させ、後続の操作でパネルが勝手に開き直す
    // （2026-07-31 本人報告・1回目の修正で残った経路）
    // App 側から選択が変えられた（レールでプロジェクトを選んだ・✕で閉じた等、
    // グラフが報告していない id になった）ときも引き継がない。引き継ぐと React Flow が
    // 「まだ前のノードが選択中」と selection-change で言い直し、プロジェクト詳細が一瞬で
    // ノード詳細に戻る／✕で閉じてもすぐ開き直す（2026-08-02 本人報告）
    const fromOutside = selectedId !== null && !reportedIdsRef.current.includes(selectedId);
    const prevSelected =
      selectedId === null || fromOutside
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
    // ラン内フロンティア（docs/design.md 3.8 投影）: 親の「ランのアイテム」が全部 done|skipped か。
    // 親がトリガー（ラン内にアイテムを持たない=常に「既に発火済み」）の場合は満たしている扱いにする
    const isRunFrontierOf = (n: Node) =>
      !!activeRun &&
      n.parents.every((p) => {
        const st = activeRun.items[p]?.status;
        return st === undefined || st === "done" || st === "skipped";
      });
    setRfNodes(
      nodes.map((n) => {
        // 未読バッジ。既読tsは NodePanel がスレッド表示のたびにサーバへ書き込む
        const lastMsgTs = threadMeta[n.id];
        const readTs = reads[n.id] ?? null;
        const unread = !!lastMsgTs && (!readTs || lastMsgTs > readTs);
        const selected =
          pendingMatched.length > 0 ? pendingMatched.includes(n.id) : prevSelected.has(n.id) || n.id === selectedId;
        // アクティブなランのワークアイテム（あれば）。テンプレートのカードへの投影に使う
        const runItem = activeRun?.items[n.id];
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
            // トリガーはランのアイテムを持たないが、ラン投影中は「発火済み=完了」として描く
            // （2026-07-31 本人指示「トリガーも完了になれるように」。ランが存在する時点で
            // トリガーの仕事=発火は済んでいる）
            runItem: runItem
              ? { runId: activeRun!.id, status: runItem.status, note: runItem.note }
              : activeRun && n.kind === "trigger"
                ? { runId: activeRun.id, status: "done" as const, note: null }
                : null,
            isRunFrontier: isRunFrontierOf(n),
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
    reads,
    activeRun,
    onSelect,
    commitTitle,
    fitView,
    getNodes,
    reportSelection,
    onSelectionIdsChange,
  ]);

  // 依存の切断。子ノードの parents から source を除く（Ctrl+Zで戻せる: undo は既存の操作ログ経由）。
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

  // ペイン空白部のダブルクリックでその位置にノードを作成+リネームモードへ
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
      // 現在位置を渡して、整列前の左右関係を保ったまま並べ直す（2026-08-03 本人指示）
      positionsRef.current = layoutGraph(nodes, measuredSizes(), positionsRef.current);
      setRfNodes((prev) =>
        prev.map((rn) => ({ ...rn, position: positionsRef.current.get(rn.id) ?? rn.position })),
      );
      fitView({ padding: FIT_PADDING, duration: 300 });
      setTimeout(() => setRealigning(false), 400);
    });
  }, [nodes, fitView]);

  // ---- 元に戻す/やり直す（操作ログの補償追記） ----
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
  // force 付きなので基本1周で全部消える。ページ（goal）削除の巻き添えで既に消えたものは
  // 404 で次パスへ回り、1周で1件も消えなければ打ち切る（deleteSelectedNodes と共用）
  const removeLeafFirst = useCallback(async (ids: string[]): Promise<string[]> => {
    let remaining = [...ids];
    const deleted: string[] = [];
    while (remaining.length > 0) {
      let removedAny = false;
      const stillRemaining: string[] = [];
      for (const id of remaining) {
        try {
          await api.removeNode(id, { force: true });
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

  // Delete/Backspace（選択エッジが無い時）: 選択中の全ノードを削除。普通の削除は confirm 無し
  // （undo で戻せるため）。ロック・巻き添え・切り離しがあるときだけモーダルで確認する
  // （2026-08-01 本人指摘「消せないのは違う。ロックはモーダルで確認」。巻き添えの計算には
  // ページ外の全ノードが要るため /api/state を取り直す）
  const deleteSelectedNodes = useCallback(async () => {
    const ids = getSelectedNodeIds();
    if (ids.length === 0) return;
    let warnings: string[] = [];
    try {
      const state = await api.getState();
      warnings = removeImpactWarnings(computeRemoveImpact(ids, state.nodes));
    } catch {
      // 状態の取り直しに失敗しても削除自体は進める（api() 側でトースト表示済み）
    }
    if (warnings.length > 0) {
      const ok = await confirmDialog(
        buildRemoveMessage(
          `選択中の ${ids.length} 件を削除しますか？（Ctrl+Z で戻せます）`,
          warnings,
        ),
        { danger: true, confirmLabel: "削除" },
      );
      if (!ok) return;
    }
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
        approval: n.approval,
        autonomy: n.autonomy,
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
          approval: entry.approval,
          autonomy: entry.autonomy,
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
        approval: n.approval,
        autonomy: n.autonomy,
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
    if (ids.length > 0) fitView({ nodes: ids.map((id) => ({ id })), padding: FIT_PADDING, duration: 0 });
    else fitView({ padding: FIT_PADDING, duration: 0 });
  }, [fitView, getSelectedNodeIds]);

  // 選択中ノードがこのページのタスクなら、その後続として作る（Tab / 「+ ノード」ボタン共通）
  const selectedInPage = selectedId && nodes.some((n) => n.id === selectedId) ? selectedId : null;

  // Tab（選択なし）: 画面中央に新規ノードを作成+即リネーム。ダブルクリック作成と同じ仕組み
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
        // テキストを範囲選択しているときも奪わない（2026-08-07 本人報告「ctrl+c でテキストを
        // コピーできない」）。チャット欄やパネルの文をマウス選択してもフォーカスは body に
        // 残るため isShortcutBlocked では拾えない——選択の有無で判定する
        const textSel = window.getSelection();
        if (textSel && !textSel.isCollapsed && textSel.toString()) return;
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
        // Fix済み（やり方確定）のノードはF2でのタイトル編集も開始しない
        // （docs/design.md 3.5 実効化。NodeCard のダブルクリック編集と同じガード）
        if (ids.length === 1 && !nodes.find((n) => n.id === ids[0])?.fixed) {
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
    // isolate: ツールバー（absolute + z-10）のスタッキングをこのペイン内に閉じ込め、
    // 幅が狭いときに右のパネル群（NodePanel/BulkPanel/ChatDrawer）へ被らないようにする
    <div ref={paneRef} className={`graph-pane relative isolate min-w-0 flex-1${realigning ? " realigning" : ""}`}>
      {/* max-md: 右端も止めて折り返す（モバイルでボタンが画面外へはみ出さないように。2026-08-02） */}
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2 max-md:right-3 max-md:flex-wrap">
        {pageNode && (
          <Hint id="page-open" text="ページ自身の詳細（関係者・削除・ページとの会話）を開く">
            <Button
              type="button"
              variant="ghost"
              className="font-semibold text-muted-foreground hover:text-foreground"
              onClick={() => onSelect(pageNode.id)}
            >
              {pageNode.title || "（無題）"}
            </Button>
          </Hint>
        )}
        {isRoutine && (
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "graph" | "ledger")}>
            <TabsList>
              <TabsTrigger value="graph">グラフ</TabsTrigger>
              <Hint
                id="ledger-tab"
                text="ラン×ノードの進捗表。セルのクリックで完了/待ちを切り替え、下段で各ランのトレースを再生できる"
              >
                <TabsTrigger value="ledger">台帳</TabsTrigger>
              </Hint>
            </TabsList>
          </Tabs>
        )}
        {/* 並列ラン（パラレルワールド）の世界線切替: 2本以上並走中はどのランを投影するか選ぶ。
            1本だけのときも「今どのランを見ているか」が分かるようタイトルを出す */}
        {!showLedger && runningRuns.length > 1 && activeRun && (
          <Select value={activeRun.id} onValueChange={(v) => onProjectRun?.(v)}>
            <Hint
              id="run-projection"
              text="ランが並走中。どのランの進捗をグラフに投影するか選ぶ（カードの操作も選んだランに記録される）"
            >
              <SelectTrigger className="h-9 max-w-56">
                <SelectValue />
              </SelectTrigger>
            </Hint>
            <SelectContent>
              {runningRuns.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {!showLedger && runningRuns.length === 1 && activeRun && (
          <Hint
            id="run-projection"
            always="投影中の実行中ラン"
            text="このランの進捗を各カードに重ねて表示中。カードの着手/完了もこのランに記録される（テンプレート自体は進捗を持たない）"
            side="bottom"
          >
            <Badge variant="secondary">▶ {activeRun.title}</Badge>
          </Hint>
        )}
        {/* 投影中ランの名前を後から編集（並列ラン=世界線の区別用ラベル） */}
        {!showLedger && activeRun && (
          <Hint id="run-rename" always="ラン名を変更">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            onClick={() => {
              void (async () => {
                const title = await promptDialog("ランの名前", {
                  defaultValue: activeRun.title,
                  confirmLabel: "変更",
                });
                if (title === null) return;
                const trimmed = title.trim();
                if (!trimmed || trimmed === activeRun.title) return;
                await api.renameRun(activeRun.id, trimmed);
                onMutated();
              })();
            }}
          >
            ✎
          </Button>
          </Hint>
        )}
        {!showLedger && (
          <>
            <Hint id="add-node" text="このページに新しいノードを作る（ノードを選択中ならその後続としてつながる）">
              <Button type="button" variant="outline" onClick={() => createNode(selectedInPage)}>
                + ノード
              </Button>
            </Hint>
            <Hint id="realign" text="dagre で自動配置し直す（手で並べた位置は整い直される）">
              <Button type="button" variant="outline" onClick={realign}>
                整列
              </Button>
            </Hint>
            {/* 「元に戻す」「ショートカット一覧」ボタンはヘッダー（TopBar）へ移動
                （2026-07-31 本人指示）。Ctrl+Z / "?" キーとダイアログ本体は引き続きここが持つ */}
            {hardening.m > 0 && (
              <Hint
                id="fix-ratio"
                always="Fix済みノード / 全ノード"
                text="このページのノードのうち、やり方が確定（Fix=ロック）した数。100%でこのページの固め切りが完了"
                side="bottom"
              >
                <Badge variant="secondary">
                  Fix {hardening.n}/{hardening.m}
                </Badge>
              </Hint>
            )}
          </>
        )}
      </div>
      {showLedger && pageNode ? (
        // 左上のツールバー（ページ名 + グラフ/台帳タブ）は absolute でキャンバスに重ねる設計。
        // グラフは下が無限キャンバスなので重ねてよいが、台帳は表なのでツールバーの高さぶん
        // 下げて描く（重ねると「N件のラン」がページ名の下に潜る）
        <div className="flex h-full flex-col pt-[52px]">
          <LedgerView page={pageNode} members={nodes} onMutated={onMutated} />
        </div>
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
            onNodeTap?.(n.id); // 実タップだけ（モバイルのビュー遷移用。selection-change とは区別）
          }}
          onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)}
          onSelectionChange={handleSelectionChange}
          onPaneClick={() => {
            onSelect(null);
            onSelectionIdsChange?.([]);
            setSelectedEdgeId(null);
          }}
          onDoubleClick={handlePaneDoubleClick}
          zoomOnDoubleClick={false}
          nodeDragThreshold={4}
          // ノードのラッパーdivにフォーカスを取らせない（2026-08-07 本人報告「タイトル編集中に
          // フォーカスが外れる」の修正）。React Flow 既定ではクリックでラッパーがフォーカスを
          // 取り、タイトル編集の input の autoFocus に勝ってしまう。その状態で打鍵すると
          // 文字がショートカット扱いされ（f=フィット/l=整列/Backspace=ノード削除）、
          // 「編集できない+グラフが勝手に動く」の二重の不具合になっていた。
          // キーボード操作は上の window keydown が一元管理しているので RF の a11y フォーカスは不要
          nodesFocusable={false}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            createNode(null);
          }}
          proOptions={{ hideAttribution: true }}
          // 複数選択: クリック/Shift+クリック/Ctrl+クリックで追加選択、Shift+ドラッグで矩形選択。
          // パン(素のドラッグ)は既定のまま邪魔しない
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          // モバイルは panOnDrag=false（パンもピンチも上の自前タッチ処理が持つ）
          panOnDrag={!isMobile}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={["Shift", "Control", "Meta"]}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
        >
          <Controls showInteractive={false} fitViewOptions={FIT_VIEW_OPTIONS} />
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
