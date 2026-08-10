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
import { Pencil } from "lucide-react";
import { api } from "../lib/api";
import { renameRunDialog } from "../lib/actions";
import { confirmDialog } from "../lib/dialogs";
import { buildRemoveMessage, computeRemoveImpact, removeImpactWarnings } from "../lib/removal";
import { subscribeOpenShortcuts } from "../lib/palette";
import { pushToast } from "../lib/toast";
import { layoutGraph, structureSignature, type Pos } from "../lib/layout";
import { isRoutinePage } from "../lib/routine";
import { isUnreadKey, threadKey } from "../lib/unread";
import { useIsMobile } from "../hooks/useIsMobile";
import { usePolling } from "../hooks/usePolling";
import { useGraphClipboard } from "../hooks/useGraphClipboard";
import { useGraphShortcuts } from "../hooks/useGraphShortcuts";
import { useMobilePanZoom } from "../hooks/useMobilePanZoom";
import { useNodeMenu } from "../hooks/useNodeMenu";
import type { Node, Run } from "../types";
import { Badge } from "./ui/badge";
import { RunStatusIcon } from "./RunStatusIcon";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { CutEdge, type CutEdgeData } from "./CutEdge";
import { RefEdge, type RefEdgeData } from "./RefEdge";
import { Hint } from "./Hint";
import { LedgerView } from "./LedgerView";
import { NodeCard, type NodeCardData } from "./NodeCard";
import { ShortcutsDialog } from "./ShortcutsDialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "./ui/context-menu";

const nodeTypes = { task: NodeCard };
const edgeTypes = { cut: CutEdge, ref: RefEdge };

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
  /** 既読の即時反映（App の readOverrides。NodePanel / PageList の onViewed と同じもの）。
   *  右クリックメニューの「既読にする」は postReads を投げっぱなしにするので、これが
   *  無いとバッジが消えるのが次のポーリングまで遅れる。台帳（LedgerView）へも渡す */
  onViewed: (key: string, lastTs: string | null) => void;
  /** グラフに投影中のラン（docs/design.md 3.8）。ルーティーンページでない/実行中のランが
   *  無い間は null（App が算出して渡す）。ある間だけテンプレートのカードにその進捗を投影する */
  activeRun: Run | null;
  /** 現在ページの全ラン一覧（新しい順。実行中も終了済みも）。ツールバーのセレクトで
   *  どのランを投影するか切り替える（過去のランも見返せる。2026-08-07 本人要望） */
  pageRuns?: Run[];
  /** null = テンプレート（設計図）を開く / ラン id = そのランのページへ移る */
  onProjectRun?: (runId: string | null) => void;
  /** ランのページを開いているか（2026-08-08 本人指定「ランは個別ページ」）。
   *  ここが非 null のとき nodes/pageNode は**そのランのフォーク**（ラン作成時の中身 + ランの進捗）で、
   *  テンプレートの編集（追加・つなぎ替え・並べ替え・名前変更）はできない。
   *  context はそのランのコンテキスト（docs/design.md 3.15。ツールバーのチップに出す） */
  runView?: { id: string; title: string; status: Run["status"]; context: Record<string, string> } | null;
  /** ランのページからテンプレート（設計図）へ戻る */
  onLeaveRun?: () => void;
  onSelect: (id: string | null) => void;
  /** ユーザーが**キャンバス上でノードを実際にタップ/クリックした**ときだけ呼ばれる。
   *  onSelect は React Flow の selection-change（ポーリング再描画でも再発火する）からも
   *  呼ばれるため、モバイルの「タップでノード詳細ビューへ」の判定にはこちらを使う
   *  （2026-08-02 本人報告「開いて2秒後ぐらいに勝手にノード詳細に行く」の修正） */
  onNodeTap?: (id: string) => void;
  onMutated: () => void;
  /** 選択中ノードの id 一覧（複数選択）。App が一括編集パネル（BulkPanel）の表示に使う */
  onSelectionIdsChange?: (ids: string[]) => void;
  /** 右クリックメニュー「ページへ移動 ▸」の候補。表示中ページと同じ節（プロジェクト /
   *  ルーティーン）の他ページだけを App が算出して渡す——節の判定には全ノードが要るため */
  movePages?: Node[];
}

function GraphViewInner({
  nodes,
  pageNode,
  selectedId,
  threadMeta,
  reads,
  onViewed,
  activeRun,
  pageRuns = [],
  onProjectRun,
  runView = null,
  onLeaveRun,
  onSelect,
  onNodeTap,
  onMutated,
  onSelectionIdsChange,
  movePages = [],
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
  const { fitView, screenToFlowPosition, getNodes } = useReactFlow();
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

  // モバイルの1本指パン + 2本指ピンチズーム（このペインの唯一のパン/ズーム経路。
  // ReactFlow 側の panOnDrag はモバイルでは無効化する——下の props）
  useMobilePanZoom(paneRef, isMobile, MIN_ZOOM, MAX_ZOOM);

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

  // ---- 配線チェック（docs/design.md 3.15）: ルーティーンページの**テンプレート表示**でだけ
  //      GET /pages/:id/wiring を取り、参照矢印（破線）と警告バッジを描く。ランのページでは
  //      描かない（その回の記録に配線検査は要らない）。取得失敗は静かに描かない
  //      （api.getPageWiring が null へ degrade。コンソール警告のみ） ----
  const { data: wiring } = usePolling(
    async () => {
      if (!pageNode || !isRoutine || runView) return null;
      return api.getPageWiring(pageNode.id);
    },
    5000,
    `${pageNode?.id ?? ""}:${isRoutine}:${runView?.id ?? ""}`,
  );
  // ノードid → 警告メッセージ一覧（カードの⚠バッジ用）
  const wiringByNode = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const w of wiring?.warnings ?? []) {
      const list = m.get(w.nodeId) ?? [];
      list.push(w.message);
      m.set(w.nodeId, list);
    }
    return m;
  }, [wiring]);

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
    // 親がトリガー（ラン内にアイテムを持たない=常に「既に作成済み」）の場合は満たしている扱いにする
    const isRunFrontierOf = (n: Node) =>
      !!activeRun &&
      n.parents.every((p) => {
        const st = activeRun.items[p]?.status;
        return st === undefined || st === "done" || st === "skipped";
      });
    setRfNodes(
      nodes.map((n) => {
        // 未読バッジ。既読tsは NodePanel がスレッド表示のたびにサーバへ書き込む。
        // ランのページではそのランの会話の未読だけを見る（テンプレートの会話とは別。2026-08-08）
        const unread = isUnreadKey(threadKey(n.id, runView?.id), threadMeta, reads);
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
            // トリガーはランのアイテムを持たないが、ラン投影中は「作成済み=完了」として描く
            // （2026-07-31 本人指示「トリガーも完了になれるように」。ランが存在する時点で
            // トリガーの仕事=ラン作成は済んでいる）
            runItem: runItem
              ? { runId: activeRun!.id, status: runItem.status, note: runItem.note }
              : activeRun && n.kind === "trigger"
                ? { runId: activeRun.id, status: "done" as const, note: null }
                : null,
            isRunFrontier: isRunFrontierOf(n),
            inRunPage: !!runView,
            // ラン作成フォームのプリフィル: 直近ラン（pageRuns は新しい順）の context（3.15）
            lastRunContext: n.kind === "trigger" ? (pageRuns[0]?.context ?? null) : null,
            // 配線チェックの警告（テンプレート表示のときだけ wiring が取れている）
            wiringWarnings: wiringByNode.get(n.id),
            // ラン作成の確認文で「並行で増える」ことを伝えるため（2026-08-08）。テンプレート表示
            // からしかランを作れなくなったので、投影中のアイテムでは並走を知れない
            runningRunCount: pageRuns.filter((r) => r.status === "running").length,
            unread,
            onSelect: (id: string) => onSelect(id),
            // ランを作ったら生まれたランのページへ移る（2026-08-08 本人指定）
            onRunStarted: (runId: string) => onProjectRun?.(runId),
            // ランのページではタイトル編集させない（記録なので。2026-08-08）
            onDoubleClick: (id: string) => {
              if (!runView) setEditingId(id);
            },
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
    pageRuns,
    runView,
    wiringByNode,
    onProjectRun,
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
    const depEdges: RFEdge[] = nodes.flatMap((n) =>
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
    // 参照矢印（docs/design.md 3.15）: 出力宣言と {x} 参照から自動導出された破線。
    // テンプレート表示のときだけ（ランのページでは wiring 自体を取っていない）。
    // 依存エッジとは別物なので選択・切断はできない（selectable:false + onEdgeClick 対象外）
    const refEdges: RFEdge[] = (runView ? [] : (wiring?.references ?? []))
      .filter((r) => ids.has(r.producerId) && ids.has(r.consumerId))
      .map((r) => {
        const producer = byId.get(r.producerId);
        return {
          id: `ref:${r.producerId}->${r.consumerId}:${r.name}`,
          source: r.producerId,
          target: r.consumerId,
          // decision は枝ハンドルしか持たない（既定ハンドル無し）ため、どれかに載せないと
          // エッジ自体が描かれない。参照は枝を選ばないので先頭の枝に代表で載せる
          ...(producer?.kind === "decision" && producer.branches?.length
            ? { sourceHandle: producer.branches[0].id }
            : {}),
          type: "ref",
          selectable: false,
          focusable: false,
          data: { label: r.name } satisfies RefEdgeData,
        };
      });
    return [...depEdges, ...refEdges];
  }, [nodes, selectedEdgeId, cutEdge, wiring, runView]);

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

  // 画面座標（clientX/Y）の位置にノードを作って即リネーム。ペインのダブルクリック・
  // 右クリックメニューの「ここにノードを作る」・Tab（画面中央）の共通経路
  const createNodeAtScreen = useCallback(
    async (clientX: number, clientY: number) => {
      const pos = screenToFlowPosition({ x: clientX, y: clientY });
      const created = await api.addNode({ title: "", group: pageNode?.id ?? null });
      overridesRef.current.set(created.id, { x: pos.x - 110, y: pos.y - 16 });
      onMutated();
      onSelect(created.id);
      setEditingId(created.id);
    },
    [pageNode, onMutated, onSelect, screenToFlowPosition],
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
      void createNodeAtScreen(e.clientX, e.clientY);
    },
    [createNodeAtScreen],
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

  // Ctrl+C/Ctrl+V/Ctrl+D 用のアプリ内クリップボード（モジュール変数持ち。ページを跨いでも保持する）
  const { hasClipboard, canPaste, copySelection, pasteClipboard, duplicateSelection } =
    useGraphClipboard({
      nodes,
      pageNode,
      getSelectedNodeIds,
      positionsRef,
      overridesRef,
      pendingSelectRef,
      onMutated,
    });

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
    await createNodeAtScreen(cx, cy);
  }, [createNodeAtScreen]);

  // ノードエディタ標準のキーボードショートカット（Houdini/Blender/ComfyUI 準拠）
  useGraphShortcuts({
    nodes,
    selectedEdgeId,
    setSelectedEdgeId,
    setEditingId,
    setShortcutsOpen,
    getSelectedNodeIds,
    applySelection,
    cutEdge,
    runUndo,
    runRedo,
    deleteSelectedNodes,
    copySelection,
    canPaste,
    pasteClipboard,
    duplicateSelection,
    fitSelectionOrAll,
    realign,
    createNode,
    createNodeAtCenter,
    selectedInPage,
  });

  // 右クリックメニュー（第0層＝既存操作への近道）。新しい判断は置かず、上のショートカット
  // 処理・カードのボタン・パネルと同じ関数を呼ぶだけ（項目の実体は useNodeMenu）
  const { contextMenuEnabled, nodeMenu } = useNodeMenu({
    nodes,
    pageNode,
    runView,
    movePages,
    threadMeta,
    reads,
    onViewed,
    onMutated,
    getSelectedNodeIds,
    applySelection,
    setEditingId,
    createNode,
    duplicateSelection,
    deleteSelectedNodes,
    removeLeafFirst,
  });

  // 右クリックした画面座標（ペインの「ここにノードを作る」の作成位置）。Radix は
  // 右クリック位置を渡してくれないので、トリガーの onContextMenu で控えておく
  const paneMenuPointRef = useRef<{ x: number; y: number } | null>(null);

  // メニューの呼び先はカードへ渡す data に載せる。rfNodes を組み立てる effect は
  // この上（既存ハンドラ群の定義より前）にあるので、そこでは載せずにここで足す
  const rfNodesForFlow = useMemo<RFNode<NodeCardData>[]>(
    () =>
      nodeMenu ? rfNodes.map((n) => ({ ...n, data: { ...n.data, menu: nodeMenu } })) : rfNodes,
    [rfNodes, nodeMenu],
  );

  // ---- Fix率チップ: Fix済み（やり方確定=ロック）ノード / 全メンバー。
  //      100% = このページの Fix 完了（スクリプト化率ではない。2026-07-31 本人定義） ----
  const hardening = useMemo(() => {
    const fixed = nodes.filter((n) => n.fixed);
    return { n: fixed.length, m: nodes.length };
  }, [nodes]);

  // ランのページでは台帳（ページ横断の表）は出さない——見ているのはその1本の記録だから
  const showLedger = isRoutine && viewMode === "ledger" && !runView;

  return (
    // isolate: ツールバー（absolute + z-10）のスタッキングをこのペイン内に閉じ込め、
    // 幅が狭いときに右のパネル群（NodePanel/BulkPanel/ChatDrawer）へ被らないようにする
    <div ref={paneRef} className={`graph-pane relative isolate min-w-0 flex-1${realigning ? " realigning" : ""}`}>
      {/* 2段構成（2026-08-08 本人指定「＋ノード以降を二段目に」）: 1段目=どこを見ているか
          （ページ名・グラフ/実行一覧・表示するラン・ラン名変更）、2段目=このページへの操作。
          max-md: 右端も止めて折り返す（モバイルでボタンが画面外へはみ出さないように。2026-08-02） */}
      <div className="absolute left-3 top-3 z-10 flex flex-col items-start gap-2 max-md:right-3">
      <div className="flex items-center gap-2 max-md:flex-wrap">
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
        {isRoutine && !runView && (
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "graph" | "ledger")}>
            <TabsList>
              <TabsTrigger value="graph">グラフ</TabsTrigger>
              <Hint
                id="ledger-tab"
                text="ラン×ノードの進捗表。セルのクリックで完了/待ちを切り替え、下段で各ランのトレースを再生できる"
              >
                <TabsTrigger value="ledger">実行一覧</TabsTrigger>
              </Hint>
            </TabsList>
          </Tabs>
        )}
        {/* ランのページ（2026-08-08 本人指定）: いま見ているのがどのランかを出し、
            テンプレート（設計図）へ戻る導線を置く。ラン同士の移動は左レールのラン一覧から */}
        {runView && (
          <>
            <Hint id="run-page" always={`ラン: ${runView.title}`} text="このページはこのランの記録。グラフ・ノードの中身・会話はすべてこのランのもので、テンプレートとは別物">
              <span className="inline-flex max-w-56 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-sm text-muted-foreground">
                <RunStatusIcon status={runView.status} />
                <span className="min-w-0 truncate">{runView.title}</span>
              </span>
            </Hint>
            <Hint id="leave-run" always="テンプレート（設計図）へ戻る">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => onLeaveRun?.()}
              >
                テンプレートへ
              </Button>
            </Hint>
            {/* ランのコンテキストのチップ（docs/design.md 3.15）: このランに載っている引数。
                ランを作るときの初期値にノードが ##gw / API で書き足していく。全文は native title で開示 */}
            {Object.keys(runView.context).length > 0 && (
              <Hint
                id="run-context"
                always="ランのコンテキスト"
                text="このランに載っている引数（key=value）。ランを作るときの初期値に、実行中のノードが書き足していく"
              >
                <span className="flex max-w-[28rem] flex-wrap items-center gap-1">
                  {Object.entries(runView.context).map(([k, v]) => (
                    <span
                      key={k}
                      className="inline-flex max-w-44 items-center rounded-full border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground"
                      title={`${k}=${v}`}
                    >
                      <span className="truncate">
                        <span className="text-foreground">{k}</span>={v}
                      </span>
                    </span>
                  ))}
                </span>
              </Hint>
            )}
          </>
        )}
        {/* ランの切り替え（このページのラン一覧）。選ぶとそのランのページへ移る */}
        {!showLedger && pageRuns.length > 0 && (
          <Select
            value={activeRun?.id ?? "none"}
            onValueChange={(v) => onProjectRun?.(v === "none" ? null : v)}
          >
            <Hint
              id="run-projection"
              text="このページのラン。選ぶとそのランのページへ移る（グラフ・ノードの中身・会話はそのランのもの）"
            >
              <SelectTrigger className="h-9 max-w-56">
                <SelectValue placeholder="ランを開く…" />
              </SelectTrigger>
            </Hint>
            <SelectContent>
              <SelectItem value="none">テンプレート（設計図）</SelectItem>
              {pageRuns.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {/* 状態の絵は左レールのラン行と共有（RunStatusIcon。2026-08-08 本人指摘
                      「上部セレクタのアイコンも▶になってるからそろえて」） */}
                  <span className="flex min-w-0 items-center gap-1.5">
                    <RunStatusIcon status={r.status} />
                    <span className="min-w-0 truncate">{r.title}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/* 投影中ランの名前を後から編集（並列ラン=ランの区別用ラベル） */}
        {!showLedger && activeRun && (
          <Hint id="run-rename" always="ラン名を変更">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            onClick={() => {
              void (async () => {
                // ダイアログ・no-op 判定は台帳の✎・左レールのラン子行と共通（lib/actions.ts）
                if (await renameRunDialog(activeRun)) onMutated();
              })();
            }}
          >
            {/* アイコンは左レールのフォルダ・ページの「名前を変更」と同じ（2026-08-09 本人指示） */}
            <Pencil className="size-3.5" />
          </Button>
          </Hint>
        )}
      </div>
        {/* 2段目はテンプレート（設計図）への操作。ランのページは「その回の記録」なので、
            ノードの追加・整列・ロックは出さない（2026-08-08 本人指定のフォーク） */}
        {!showLedger && !runView && (
          <div className="flex items-center gap-2 max-md:flex-wrap">
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
                always="ロック済みノード / 全ノード"
                text="このページのノードのうち、やり方が確定（Fix=ロック）した数。100%でこのページの固め切りが完了"
                side="bottom"
              >
                <Badge variant="secondary">
                  ロック {hardening.n}/{hardening.m}
                </Badge>
              </Hint>
            )}
          </div>
        )}
      </div>
      {showLedger && pageNode ? (
        // 左上のツールバー（ページ名 + グラフ/台帳タブ）は absolute でキャンバスに重ねる設計。
        // グラフは下が無限キャンバスなので重ねてよいが、台帳は表なのでツールバーの高さぶん
        // 下げて描く（重ねると「N件のラン」がページ名の下に潜る）
        // bg-background: body の格子（無限キャンバスの地）を隠す。表を読む画面に方眼は要らない
        // （2026-08-08 本人指示）
        <div className="flex h-full flex-col bg-background pt-[52px]">
          <LedgerView
            page={pageNode}
            members={nodes}
            threadMeta={threadMeta}
            reads={reads}
            onViewed={onViewed}
            onMutated={onMutated}
            onRunStarted={(runId) => onProjectRun?.(runId)}
          />
        </div>
      ) : (
        // 空白の右クリックもメニューにする（2026-08-09 本人採用の案B。旧: onPaneContextMenu が
        // その場で無位置のノードを作っていた）。ノード上の右クリックは NodeCard 側の
        // ContextMenuTrigger が stopPropagation するので、ここまでは上がってこない
        <ContextMenu>
          <ContextMenuTrigger
            asChild
            disabled={!contextMenuEnabled}
            onContextMenu={(e) => {
              paneMenuPointRef.current = { x: e.clientX, y: e.clientY };
            }}
          >
            <div className="h-full w-full">
              <ReactFlow
                nodes={rfNodesForFlow}
                edges={rfEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={handleNodesChange}
                // ランのページは「その回の記録」なので、つなぎ替え・ノード生成はさせない（2026-08-08）
                onConnect={runView ? undefined : handleConnect}
                onConnectEnd={runView ? undefined : handleConnectEnd}
                nodesConnectable={!runView}
                onNodeClick={(_, n) => {
                  lastClickedRef.current = n.id;
                  onSelect(n.id);
                  onNodeTap?.(n.id); // 実タップだけ（モバイルのビュー遷移用。selection-change とは区別）
                }}
                // 参照矢印（type="ref"）は選択・切断の対象外（自動導出の表示物。docs/design.md 3.15）
                onEdgeClick={(_, edge) => {
                  if (edge.type === "cut") setSelectedEdgeId(edge.id);
                }}
                onSelectionChange={handleSelectionChange}
                onPaneClick={() => {
                  onSelect(null);
                  onSelectionIdsChange?.([]);
                  setSelectedEdgeId(null);
                }}
                onDoubleClick={runView ? undefined : handlePaneDoubleClick}
                zoomOnDoubleClick={false}
                nodeDragThreshold={4}
                // ノードのラッパーdivにフォーカスを取らせない（2026-08-07 本人報告「タイトル編集中に
                // フォーカスが外れる」の修正）。React Flow 既定ではクリックでラッパーがフォーカスを
                // 取り、タイトル編集の input の autoFocus に勝ってしまう。その状態で打鍵すると
                // 文字がショートカット扱いされ（f=フィット/l=整列/Backspace=ノード削除）、
                // 「編集できない+グラフが勝手に動く」の二重の不具合になっていた。
                // キーボード操作は上の window keydown が一元管理しているので RF の a11y フォーカスは不要
                nodesFocusable={false}
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
            </div>
          </ContextMenuTrigger>
          {/* 閉じたあとトリガー（キャンバス）へフォーカスを戻さない。「ここにノードを作る」で
              開いたタイトル入力からフォーカスを奪い返す事故を防ぐ（NodeCard 側と同じ理由） */}
          <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
            {/* ランのページはテンプレートの編集不可（2026-08-08 のフォーク）なので作成系を出さない */}
            {!runView && (
              <ContextMenuItem
                onSelect={() => {
                  const p = paneMenuPointRef.current;
                  if (p) void createNodeAtScreen(p.x, p.y);
                }}
              >
                ここにノードを作る
              </ContextMenuItem>
            )}
            {!runView && hasClipboard && (
              <ContextMenuItem onSelect={() => void pasteClipboard()}>
                貼り付け
                <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={() => applySelection(nodes.map((n) => n.id))}>
              全選択
              <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={realign}>
              整列
              <ContextMenuShortcut>L</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
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
