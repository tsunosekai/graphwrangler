// 左レールのページ一覧。ゴール/ルーティーン（フォルダ）1つ = 1ページ（desk の左レール方式）。
// 「プロジェクト」節（トリガーを持たないページ）と「ルーティーン」節（トリガーを持つページ）に
// ビュー的に分ける（本人指定 2026-07-31）。ルーティーン化はトリガーを置く/外すだけの1操作で、
// 節をまたぐのはその副作用として自然に起きる（design.md 3.8: 「プロジェクト/ルーティーンは
// トリガーの有無の別名」）。
// タイトル下のちょぼは zinsei desk と同じ「ball（いま誰の席か）」内訳（本人指定）:
// done/dropped/skipped は暗く沈め、それ以外は担当(executor)の色で誰の手番かを見せる。
// ルーティーン行は最新ランのワークアイテム内訳（テンプレート自身は status を持たないため、
// 担当色はテンプレートノードの executor を allNodes から引く）。
// 最新ランの取得は App 側でまとめてポーリングする（受信箱のラン待ち統合と共有し、
// ページ数ぶんの N+1 取得を1箇所に集約するため。旧: このコンポーネント内で自前ポーリングしていた）。
//
// 整理（2026-08-05 本人要望「フォルダ機能と手動並べ替え」）:
// - フォルダ = kind=folder のノード。ページを束ねるだけの棚で、グラフ・実行・ランには
//   関与しない。ページの所属は group ではなく folder フィールド（design.md 3.1）
// - 並びは order（数値）。掴んで（⠿）動かすたびに、動いた入れ物のぶんだけ 0..n-1 へ
//   詰め直す（差分だけ patch する。lib/rail.ts）
// - ドラッグはマウスもタッチも pointer events 1本で扱う（モバイルでも並べ替えられる）
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  GripVertical,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Settings2,
  Trash2,
} from "lucide-react";
import { api } from "../lib/api";
import { focusGoalCapture } from "../lib/capture";
import { confirmDialog, promptDialog } from "../lib/dialogs";
import { HINT_TEXT } from "../lib/hints";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { moveWithin, railPatches, sortRail } from "../lib/rail";
import { isRoutinePage } from "../lib/routine";
import { colorOf, displayNameOf, effectiveMembers, initialOf, sameEmail, turnIsMine, useTeam } from "../lib/team";
import { cn } from "../lib/utils";
import type { Node, Run, Status } from "../types";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Hint } from "./Hint";
import { Icon } from "./Icon";
import { StatusCircle } from "./StatusCircle";

interface Props {
  folders: Node[];
  /** 整理用フォルダ（kind=folder）。ページではないので folders とは別に受ける（2026-08-05） */
  folderNodes: Node[];
  allNodes: Node[];
  pageId: string | null;
  /** ノードid → 最終メッセージ時刻。ページ行の未読数バッジに使う（本人指定 2026-07-31:
   *  「未読は数字でプロジェクトに、あなたの番はちょぼに」） */
  threadMeta: Record<string, string>;
  /** ノードid → 既読時刻（サーバ持ち。2026-08-02 localStorage から移行＝端末間で一致） */
  reads: Record<string, string>;
  /** ページ id → 最新ラン（App 側でポーリング済み） */
  latestRuns: Record<string, Run | null>;
  /** ページ id → 実行中ラン数（並走中の世界線の数。0は非表示） */
  runningCounts: Record<string, number>;
  /** モバイル（一覧ビューが画面を専有）では畳み状態を無視して常に展開表示する
   *  （2026-08-02 モバイル4ビュー化。畳む/開くはデスクトップのレール専用の概念） */
  forceExpanded?: boolean;
  onSelectPage: (id: string) => void;
  /** 行の⚙からページ自身のノード詳細を開く（タイトル編集・関係者・削除の導線。
   *  goal ノードはグラフに描画されないため、ここが NodePanel への唯一の入口。2026-08-04） */
  onOpenPageNode: (id: string) => void;
  /** フォルダ操作・並べ替えを打った直後の再取得（ポーリング待ちの3秒を出さない） */
  onMutated: () => void;
}

const EXEC_JA: Record<Node["executor"], string> = { human: "人間", ai: "AI", script: "スクリプト" };
const STATUS_JA: Record<Status, string> = {
  unplanned: "未計画",
  pending: "待ち",
  running: "進行中",
  waiting: "回答待ち",
  done: "完了",
  dropped: "中止",
  skipped: "スキップ",
};

/** ちょぼの「席」= ball の所在。done/dropped/skipped は決着済みなので担当色でなく沈めた色にする。
 *  waiting（あなたの番）はカード右肩の橙点と同じ --attention 色で出す（人間の黄に畳むと
 *  普通の人間タスクと見分けが付かない。2026-07-31 本人指摘） */
type Seat = "attention" | "human" | "ai" | "script" | "done";
function seatOf(status: Status, executor: Node["executor"]): Seat {
  if (status === "done" || status === "dropped" || status === "skipped") return "done";
  if (status === "waiting") return "attention";
  return executor;
}
function seatColor(status: Status, executor: Node["executor"]): string {
  if (status === "done") return "var(--done)";
  if (status === "dropped" || status === "skipped") return "var(--dropped)";
  if (status === "waiting") return "var(--attention)";
  return executor === "human" ? "var(--human)" : executor === "ai" ? "var(--ai)" : "var(--script)";
}
// 目に入るべき順: あなたの番 → 人間の席 → AI → スクリプト → 完了系
const SEAT_ORDER: Seat[] = ["attention", "human", "ai", "script", "done"];
const MAX_DOTS = 16;

// ---- ドラッグ（フォルダ分け + 手動並べ替え。2026-08-05） ----
/** 節。フォルダはプロジェクト節の中だけの概念で、ルーティーンは節内の並べ替えのみ */
type Section = "project" | "routine";
/** 掴んでいるもの */
interface DragState {
  id: string;
  kind: "page" | "folder";
  section: Section;
}
/** 落とし先。into = フォルダの中／節の末尾、before|after = その行の前後 */
interface DropTarget {
  id: string;
  kind: "page" | "folder" | "root";
  section: Section;
  pos: "before" | "after" | "into";
}
/** 節見出し（＝その節の直下・末尾）を指す擬似 id */
const ROOT_ROW: Record<Section, string> = { project: "__root__", routine: "__routine__" };

const CLOSED_KEY = "gw.railFolderClosed";
function loadClosedFolders(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function PageList({
  folders,
  folderNodes,
  allNodes,
  pageId,
  threadMeta,
  reads,
  latestRuns,
  runningCounts,
  forceExpanded,
  onSelectPage,
  onOpenPageNode,
  onMutated,
}: Props) {
  const [width, startResize] = useResizableWidth("railW", 224, 160, 400);
  // チーム化（2026-08-04）: 人フィルタとイニシャルバッジ。ロスターが2人未満なら出さない
  const { me, users, enabled: teamEnabled } = useTeam();
  // 人フィルタ: "all"（全員）/ "me"（自分。ログイン中のみ）/ "none"（帰属なし）/
  // メールアドレス。リロード跨ぎで保持
  const [personFilter, setPersonFilterRaw] = useState<string>(
    () => localStorage.getItem("gw.pageFilter") ?? "all",
  );
  const setPersonFilter = (v: string) => {
    setPersonFilterRaw(v);
    try {
      localStorage.setItem("gw.pageFilter", v);
    } catch {
      // 無視（永続化は補助機能）
    }
  };
  // 保存値の正規化: 未ログインで "me" が残っていた・ロスターから消えたメールだった、は
  // 「全員」に倒す（Select の表示と絞り込みの両方がこれを使う）。"none"（帰属なし）は有効値
  const personFilterValue =
    personFilter === "me"
      ? me.email
        ? "me"
        : "all"
      : personFilter === "all" ||
          personFilter === "none" ||
          users.some((u) => !u.disabled && sameEmail(u.email, personFilter))
        ? personFilter
        : "all";
  // ページの絞り込み述語（チーム化 2026-08-04）。判定は実効関係者
  // （手動 members ∪ 作成者 ∪ 配下ノードの担当・関係者・作成者。lib/team.ts の effectiveMembers）:
  // - 全員（またはロスター2人未満）: 絞り込みなし
  // - 人: その人が実効関係者に居るページだけ（厳格。実効関係者が空のページは出さない——
  //   当初は全滅防止で「空は常に表示」の救済を入れていたが、「担当が付いていないのに
  //   フィルタをすり抜けて出てくる」と逆の不満になった。2026-08-04 実機指摘で撤回）
  // - 帰属なし: 実効関係者が空のページだけ。救済の代替で、チーム化前の既存データに
  //   帰属を付けて回る作業や拾い漏れの発見に使う
  const byPerson = (f: Node): boolean => {
    if (!teamEnabled || personFilterValue === "all") return true;
    const eff = effectiveMembers(f, allNodes);
    if (personFilterValue === "none") return eff.length === 0;
    const email = personFilterValue === "me" ? me.email : personFilterValue;
    return !!email && eff.some((m) => sameEmail(m, email));
  };
  // アーカイブ節（done/dropped なゴール）は既定で閉じておく
  const [archiveOpen, setArchiveOpen] = useState(false);
  // レール自体の開閉（2026-07-31 本人要望）。閉じると細い縦帯だけ残す
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem("gw.railOpen") !== "0");
  const toggleRail = () =>
    setRailOpen((v) => {
      try {
        localStorage.setItem("gw.railOpen", v ? "0" : "1");
      } catch {
        // 無視
      }
      return !v;
    });

  // 未読判定は GraphView（カードの青ドット）と同じ規約: 既読時刻より新しいメッセージがあるか
  const isUnread = (id: string) => {
    const last = threadMeta[id];
    if (!last) return false;
    const read = reads[id];
    return !read || last > read;
  };

  // 作成は「ヘッダーのゴール捕獲欄」に一本化した（2026-08-01 本人指示。docs/design.md 4章 ②）。
  // ここの「＋」は無題ノードを作らず、その入力欄へフォーカスを渡すだけにする——
  // 入口が2つあると「無題のゴール」が量産されるため
  const addGoal = () => focusGoalCapture();

  // ルーティーンは対象外（常にアクティブ扱い）。goal 等の status が done|dropped のものだけ
  // アーカイブへ回す
  const activeFolders = folders.filter(
    (f) => isRoutinePage(f, allNodes) || (f.status !== "done" && f.status !== "dropped"),
  );
  const archivedFolders = sortRail(
    folders.filter((f) => !isRoutinePage(f, allNodes) && (f.status === "done" || f.status === "dropped")),
  );

  // ---- 並び・フォルダ分け ----
  const nodeById = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);
  const folderList = useMemo(() => sortRail(folderNodes), [folderNodes]);
  const folderIds = useMemo(() => new Set(folderNodes.map((f) => f.id)), [folderNodes]);
  /** ページの所属フォルダ（消えたフォルダを指していたら直下扱いにする） */
  const folderOf = (f: Node): string | null =>
    f.folder && folderIds.has(f.folder) ? f.folder : null;
  const sectionOf = (f: Node): Section => (isRoutinePage(f, allNodes) ? "routine" : "project");

  // プロジェクト（トリガー無し）/ ルーティーン（トリガー有り）のビュー的な分類（本人指定）。
  // 人フィルタ中はプロジェクト節・ルーティーン節の両方に同じ述語（上の byPerson）を適用する
  // （チーム化 2026-08-04）
  const projectFolders = sortRail(
    activeFolders.filter((f) => sectionOf(f) === "project" && byPerson(f)),
  );
  const routineFolders = sortRail(
    activeFolders.filter((f) => sectionOf(f) === "routine" && byPerson(f)),
  );
  /** 表示用: 直下のプロジェクト / フォルダ id → その中のプロジェクト */
  const rootProjects = projectFolders.filter((f) => folderOf(f) === null);
  const inFolder = (folderId: string) => projectFolders.filter((f) => folderOf(f) === folderId);

  /** 並べ替えの計算対象は**絞り込み前の全ページ**にする（フィルタで隠れている行の
   *  相対順序を壊さないため）。アーカイブ済みも同じ入れ物として一緒に数える */
  const pageIdsIn = (section: Section, folderId: string | null): string[] =>
    sortRail(
      folders.filter((f) => sectionOf(f) === section && (section === "project" ? folderOf(f) === folderId : true)),
    ).map((f) => f.id);

  // 折り畳み状態（localStorage。UI状態なので正データには混ぜない）
  const [closedFolders, setClosedFolders] = useState<Set<string>>(loadClosedFolders);
  const toggleFolder = (id: string) =>
    setClosedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
      } catch {
        // 無視
      }
      return next;
    });

  // ---- ドラッグ（掴んで並べ替え・フォルダへ入れる） ----
  const dragRef = useRef<DragState | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  const draggedAtRef = useRef(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  /** 座標の下にある行を読んで落とし先を決める（要素の data-rail-* 属性が正）。
   *  ページ: フォルダ行の上=中へ / 同じ節のページ行の上下半分=その前後。
   *  フォルダ: フォルダ行の前後だけ（フォルダの入れ子はUIでは扱わない） */
  const resolveDrop = (x: number, y: number, st: DragState): DropTarget | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(
      "[data-rail-row]",
    );
    if (!el) return null;
    const id = el.dataset.railRow!;
    const kind = el.dataset.railKind as DropTarget["kind"];
    const section = el.dataset.railSection as Section;
    if (id === st.id) return null;
    if (kind === "root") {
      if (st.kind === "folder") return null; // フォルダは節をまたがない
      return { id, kind, section, pos: "into" };
    }
    const rect = el.getBoundingClientRect();
    const pos: "before" | "after" = y < rect.top + rect.height / 2 ? "before" : "after";
    if (st.kind === "folder") {
      return kind === "folder" ? { id, kind, section, pos } : null;
    }
    if (kind === "folder") return { id, kind, section, pos: "into" };
    if (section !== st.section) return null; // プロジェクトとルーティーンは行き来させない
    return { id, kind, section, pos };
  };

  const beginDrag = (e: React.PointerEvent, st: DragState) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      // 取っ手の外へ出ても pointermove/up を取りこぼさないための捕捉。
      // 捕捉できない環境（既にポインタが離れている等）でも掴み自体は続行する
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 無視
    }
    dragRef.current = st;
    setDrag(st);
  };
  const moveDrag = (e: React.PointerEvent) => {
    const st = dragRef.current;
    if (!st) return;
    const target = resolveDrop(e.clientX, e.clientY, st);
    dropRef.current = target;
    setDrop(target);
  };
  const endDrag = (e: React.PointerEvent) => {
    const st = dragRef.current;
    const target = dropRef.current;
    dragRef.current = null;
    dropRef.current = null;
    setDrag(null);
    setDrop(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // 既に外れている場合は無視
    }
    if (!st) return;
    draggedAtRef.current = Date.now(); // 直後の click でページを開かないための印
    if (target) void applyDrop(st, target);
  };
  // ドラッグ中は画面外へ出た pointerup も拾う（掴んだまま離しても状態が残らないように）
  useEffect(() => {
    if (!drag) return;
    const cancel = () => {
      dragRef.current = null;
      dropRef.current = null;
      setDrag(null);
      setDrop(null);
    };
    window.addEventListener("pointercancel", cancel);
    return () => window.removeEventListener("pointercancel", cancel);
  }, [drag]);

  /** 落とした結果の並びを order（と必要なら folder）へ書き戻す。変わった行だけ patch する */
  const applyOrder = async (orderedIds: string[], folder?: string | null) => {
    const patches = railPatches(orderedIds, nodeById, folder);
    if (patches.length === 0) return;
    for (const p of patches) {
      try {
        await api.patchNode(p.id, p.patch);
      } catch {
        break; // エラーは api 側でトースト済み。中途半端な連打は避けて止める
      }
    }
    onMutated();
  };

  const applyDrop = async (st: DragState, target: DropTarget) => {
    if (st.kind === "folder") {
      // フォルダ同士の並べ替え（resolveDrop がフォルダ行 + before|after だけを通す）
      const ordered = moveWithin(
        folderList.map((f) => f.id),
        st.id,
        target.id,
        target.pos === "before" ? "before" : "after",
      );
      await applyOrder(ordered);
      return;
    }
    // ページ: 行き先の入れ物（フォルダ / 節の直下）を決める
    const section: Section = target.kind === "folder" ? "project" : target.section;
    const targetNode = target.kind === "page" ? (nodeById.get(target.id) ?? null) : null;
    const folderId =
      target.kind === "folder"
        ? target.id
        : section === "project" && targetNode
          ? folderOf(targetNode)
          : null;
    const siblings = pageIdsIn(section, folderId).filter((id) => id !== st.id);
    const ordered =
      target.kind === "page"
        ? moveWithin([...siblings, st.id], st.id, target.id, target.pos === "before" ? "before" : "after")
        : [...siblings, st.id];
    await applyOrder(ordered, section === "project" ? folderId : null);
  };

  // ---- フォルダの作成・リネーム・削除 ----
  const addFolder = async () => {
    const name = await promptDialog("新しいフォルダの名前", { placeholder: "例: 受託", confirmLabel: "作成" });
    if (name === null || !name.trim()) return;
    try {
      await api.addNode({ title: name.trim(), kind: "folder", order: folderList.length });
      onMutated();
    } catch {
      // api 側でトースト済み
    }
  };
  const renameFolder = async (f: Node) => {
    const name = await promptDialog("フォルダ名", { defaultValue: f.title, confirmLabel: "変更" });
    if (name === null || !name.trim() || name.trim() === f.title) return;
    try {
      await api.patchNode(f.id, { title: name.trim() });
      onMutated();
    } catch {
      // api 側でトースト済み
    }
  };
  const removeFolder = async (f: Node) => {
    const count = inFolder(f.id).length;
    const ok = await confirmDialog(
      count > 0
        ? `フォルダ「${f.title || "（無題）"}」を削除しますか？\n中の ${count} 件のプロジェクトは消えず、直下へ出ます。`
        : `フォルダ「${f.title || "（無題）"}」を削除しますか？`,
      { danger: true, confirmLabel: "削除" },
    );
    if (!ok) return;
    try {
      await api.removeNode(f.id, { force: true });
      onMutated();
    } catch {
      // api 側でトースト済み
    }
  };

  /** 落とし先の見せ方: 前後は行の内側に線、中へはフォルダ行を縁取る */
  const dropClass = (id: string) =>
    drop?.id !== id
      ? undefined
      : drop.pos === "into"
        ? "ring-1 ring-ai"
        : drop.pos === "before"
          ? "shadow-[inset_0_2px_0_0_var(--ai)]"
          : "shadow-[inset_0_-2px_0_0_var(--ai)]";

  /** 掴む取っ手（⠿）。マウスもタッチも同じ pointer events で扱う */
  const gripFor = (st: DragState) => (
    <span
      className="flex size-3.5 flex-shrink-0 cursor-grab touch-none items-center justify-center text-text-lo/60 hover:text-muted-foreground"
      onPointerDown={(e) => beginDrag(e, st)}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onClick={(e) => e.stopPropagation()}
    >
      <GripVertical className="size-3.5" />
    </span>
  );

  const renderRow = (f: Node, archived: boolean, indented = false) => {
    const routine = isRoutinePage(f, allNodes);
    const latestRun = latestRuns?.[f.id] ?? null;
    // ページ内（ゴール自身 + メンバー）の未読ノード数。数字バッジで行の右端に出す
    const unreadCount = [f.id, ...allNodes.filter((n) => n.group === f.id).map((n) => n.id)].filter(
      isUnread,
    ).length;

    // 質問が開いている（pendingRequest あり）ノードは status が何であれ「あなたの番」扱い
    // （NodeCard の visualStatus と同じ保険）。ただし assignee が他人なら waiting（橙）に
    // 昇格させず、素の status のまま担当の席色で描く（チーム化 2026-08-04: 他人の番は橙にしない）
    const effStatus = (n: Node): Status =>
      n.pendingRequest && turnIsMine(n.assignee, me.email) ? "waiting" : n.status;
    const memberDots = !routine
      ? allNodes
          .filter((n) => n.group === f.id)
          .slice()
          .sort((a, b) => SEAT_ORDER.indexOf(seatOf(effStatus(a), a.executor)) - SEAT_ORDER.indexOf(seatOf(effStatus(b), b.executor)))
          .map((m) => ({
            key: m.id,
            title: `${m.title || "（無題）"} — ${EXEC_JA[m.executor]}の席 / ${STATUS_JA[effStatus(m)]}`,
            color: seatColor(effStatus(m), m.executor),
          }))
      : [];

    // ランのワークアイテムはテンプレート自身の status を持たないため、担当色はテンプレートノード
    // （allNodes 内の同id）の executor を引く。テンプレートが見当たらない（削除済み等）場合は
    // script 扱いにフォールバックする
    const runDots =
      routine && latestRun
        ? Object.entries(latestRun.items)
            .map(([nodeId, item]) => {
              const tmpl = allNodes.find((n) => n.id === nodeId);
              const executor = tmpl?.executor ?? ("script" as const);
              // 他人の番（テンプレートの assignee が他人）の waiting は橙にせず、
              // pending 相当=担当の席色に落とす（チーム化 2026-08-04。effStatus と同じ原則）
              const st: Status =
                item.status === "waiting" && !turnIsMine(tmpl?.assignee ?? null, me.email)
                  ? "pending"
                  : item.status;
              return {
                key: nodeId,
                st,
                executor,
                title: `${EXEC_JA[executor]}の席 / ${STATUS_JA[item.status]}`,
              };
            })
            .sort(
              (a, b) => SEAT_ORDER.indexOf(seatOf(a.st, a.executor)) - SEAT_ORDER.indexOf(seatOf(b.st, b.executor)),
            )
            .map(({ key, st, executor, title }) => ({
              key,
              title,
              color: seatColor(st, executor),
            }))
        : [];

    const dots = routine ? runDots : memberDots;
    const shown = dots.slice(0, MAX_DOTS);
    const rest = dots.length - shown.length;

    // イニシャルバッジは実効関係者（手動 members + 配下ノードからの自動集計。2026-08-04 追修。
    // 手動だけだと配下に担当者が居てもバッジが出ず「誰のページか」が見えない）
    const effMembers = teamEnabled ? effectiveMembers(f, allNodes) : [];

    return (
      // 行の中に⚙ボタン（本物の <button>）を置くため、行自体は button でなく div[role=button]
      // にする（button の入れ子は不正HTML。2026-08-04 追修）。Enter/Space の選択も維持する
      <div
        key={f.id}
        role="button"
        tabIndex={0}
        data-rail-row={f.id}
        data-rail-kind="page"
        data-rail-section={routine ? "routine" : "project"}
        className={cn(
          "flex w-full cursor-pointer flex-col items-stretch gap-0.5 rounded-sm px-2 py-1.5 text-left text-muted-foreground hover:bg-accent/60",
          indented && "ml-3 w-[calc(100%-0.75rem)]",
          pageId === f.id && "bg-accent text-foreground",
          archived && "opacity-70",
          drag?.id === f.id && "opacity-40",
          dropClass(f.id),
        )}
        onClick={() => {
          if (Date.now() - draggedAtRef.current < 300) return; // ドラッグ直後の click は無視
          onSelectPage(f.id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelectPage(f.id);
          }
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {!archived && gripFor({ id: f.id, kind: "page", section: routine ? "routine" : "project" })}
          {routine ? (
            <Hint id="page-routine" always="ルーティーンページ" text={HINT_TEXT.pageRoutine}>
              <span className="inline-flex size-3 flex-shrink-0 text-muted-foreground">
                <Icon name="repeat" size={12} />
              </span>
            </Hint>
          ) : (
            <StatusCircle status={f.status} size={12} />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">{f.title || "（無題）"}</span>
          {/* 関係者のイニシャルバッジ（チーム化 2026-08-04）: 実効関係者を最大3人 + “+n”。
              小さく控えめに */}
          {effMembers.length > 0 && (
            <span
              className="flex flex-shrink-0 items-center -space-x-1"
              title={`関係者: ${effMembers.map((m) => displayNameOf(m, users)).join("、")}`}
            >
              {effMembers.slice(0, 3).map((m) => (
                // 地色はユーザーの決定的カラー（colorOf）。border-background は重なり
                // （-space-x-1）の切れ目用
                <span
                  key={m}
                  className="inline-flex size-3.5 items-center justify-center rounded-full border border-background text-[8px] font-semibold leading-none text-white"
                  style={{ background: colorOf(m) }}
                >
                  {initialOf(m, users)}
                </span>
              ))}
              {effMembers.length > 3 && (
                <span className="pl-1.5 text-[9px] text-text-lo">+{effMembers.length - 3}</span>
              )}
            </span>
          )}
          {/* 実行中のラン数（並走中の世界線）。1本でも「回っている」ことが分かるように出す */}
          {routine && (runningCounts[f.id] ?? 0) > 0 && (
            <Hint
              id="running-runs"
              always={`実行中のラン ${runningCounts[f.id]} 本`}
              text="並走中のラン（世界線）の数。グラフ上部のセレクタで投影するランを切り替えられる"
            >
              <span className="flex-shrink-0 rounded border border-ai/40 px-1 text-[10px] leading-4 text-ai">
                ▶ {runningCounts[f.id]}
              </span>
            </Hint>
          )}
          {unreadCount > 0 && (
            <Hint
              id="unread"
              always={`未読メッセージのあるノード ${unreadCount} 件`}
              text={HINT_TEXT.unread}
            >
              <span className="flex-shrink-0 rounded-full bg-ai px-1.5 text-[10px] font-semibold leading-4 text-white">
                {unreadCount}
              </span>
            </Hint>
          )}
          {/* ページ自身のノード詳細（タイトル編集・関係者・削除）への導線（2026-08-04 追修）。
              goal ノードはグラフに描画されないため、この⚙が NodePanel を開く唯一の入口。
              モバイルでも押せるよう hover 表示にはしない（常時表示・控えめな色） */}
          <Hint
            id="page-open"
            always="ページの詳細を開く"
            text="タイトル編集・関係者・削除・ページ自体との会話はここから"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-5 flex-shrink-0 text-text-lo hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onOpenPageNode(f.id);
              }}
            >
              <Settings2 className="size-3.5" />
            </Button>
          </Hint>
        </span>
        {dots.length > 0 && (
          <span className="flex flex-wrap items-center gap-[3px] pl-5">
            {shown.map((d) => (
              <Hint
                key={d.key}
                id="seat-dots"
                always={d.title}
                text="ページ内ノードの手番の内訳（ノード1つ=点1つ）。色はいま動くべき席=担当の色で、橙=あなたの番、沈んだ色=完了・中止・スキップ"
              >
                <i
                  className="size-[5px] flex-shrink-0 rounded-full"
                  style={{ background: d.color }}
                />
              </Hint>
            ))}
            {rest > 0 && <span className="font-mono text-xs text-text-lo">+{rest}</span>}
          </span>
        )}
      </div>
    );
  };

  const renderFolder = (f: Node) => {
    const children = inFolder(f.id);
    const open = !closedFolders.has(f.id);
    return (
      <div key={f.id} className="flex flex-col gap-px">
        <div
          role="button"
          tabIndex={0}
          data-rail-row={f.id}
          data-rail-kind="folder"
          data-rail-section="project"
          className={cn(
            "flex w-full cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 text-left text-muted-foreground hover:bg-accent/60",
            drag?.id === f.id && "opacity-40",
            dropClass(f.id),
          )}
          onClick={() => {
            if (Date.now() - draggedAtRef.current < 300) return;
            toggleFolder(f.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleFolder(f.id);
            }
          }}
        >
          {gripFor({ id: f.id, kind: "folder", section: "project" })}
          {open ? (
            <ChevronDown className="size-3.5 flex-shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 flex-shrink-0" />
          )}
          <Folder className="size-3.5 flex-shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm">{f.title || "（無題）"}</span>
          {!open && children.length > 0 && (
            <span className="flex-shrink-0 text-[10px] text-text-lo">{children.length}</span>
          )}
          <Hint id="folder-rename" always="フォルダ名を変更">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-5 flex-shrink-0 text-text-lo hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                void renameFolder(f);
              }}
            >
              <Pencil className="size-3" />
            </Button>
          </Hint>
          <Hint id="folder-remove" always="フォルダを削除" text="中のプロジェクトは消えず、直下へ出る">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-5 flex-shrink-0 text-text-lo hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                void removeFolder(f);
              }}
            >
              <Trash2 className="size-3" />
            </Button>
          </Hint>
        </div>
        {open && children.map((c) => renderRow(c, false, true))}
      </div>
    );
  };

  if (!railOpen && !forceExpanded) {
    return (
      <div className="flex flex-shrink-0 flex-col items-center border-r border-border bg-muted py-1.5">
        <Hint id="rail-toggle" always="プロジェクト一覧を開く">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            onClick={toggleRail}
          >
            <PanelLeft className="size-4" />
          </Button>
        </Hint>
      </div>
    );
  }

  return (
    <div
      // overflow-x-hidden: リサイズハンドル（right:-3px）等のはみ出しが微小な横スクロールを
      // 生む不具合の抑止（2026-07-31 本人報告）
      // data-mobile-panel: モバイル（<768px）では全画面オーバーレイになる（index.css）
      data-mobile-panel="left"
      className="relative flex flex-shrink-0 flex-col gap-px overflow-y-auto overflow-x-hidden border-r border-border bg-muted p-1.5"
      style={{ width }}
    >
      <div className="resize-handle resize-handle-right" onPointerDown={(e) => startResize(e, 1)} />
      {/* プロジェクト節: トリガー無しのページ。「＋」はここに1個だけ（ルーティーン化はトリガーを
          置けば自動でルーティーン節へ移る、という体験に任せる。本人指定）。
          見出しは0件でも常に出す — 消すと「＋」の導線が無くなるコールドスタート問題があるため
          （その「＋」自体は作成せず、ヘッダーのゴール捕獲欄へ案内する）。
          見出し行はドラッグの落とし先（＝フォルダから出して直下の末尾へ）も兼ねる */}
      <div
        data-rail-row={ROOT_ROW.project}
        data-rail-kind="root"
        data-rail-section="project"
        className={cn(
          "flex items-center justify-between gap-1 rounded-sm px-2 pb-2 pt-1 text-xs font-semibold tracking-wide text-text-lo",
          dropClass(ROOT_ROW.project),
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Hint id="page-project" text={HINT_TEXT.pageProject}>
            <span className="flex-shrink-0">プロジェクト</span>
          </Hint>
          {/* 人フィルタ（チーム化 2026-08-04。2026-08-05 見出しの隣へ小さく寄せた——
              幅いっぱいのセレクタは主張が強すぎた）。ルーティーン節にも同じ述語が効く。
              ロスターが2人未満の運用では出さない（degrade 原則） */}
          {teamEnabled && (
            <Select value={personFilterValue} onValueChange={setPersonFilter}>
              <Hint
                id="person-filter"
                text="実効関係者（担当者・関係者・作成者の集計）でページを絞り込む。帰属なし=誰も付いていないページだけ"
              >
                <SelectTrigger
                  size="sm"
                  className="h-5 w-auto max-w-24 gap-0.5 border-transparent bg-transparent px-1 py-0 text-[11px] font-normal shadow-none hover:bg-accent/60 [&_svg]:size-3"
                >
                  <SelectValue />
                </SelectTrigger>
              </Hint>
              <SelectContent>
                <SelectItem value="all">全員</SelectItem>
                {me.email && <SelectItem value="me">自分</SelectItem>}
                {/* 無効化ユーザーは選択肢から除外（2026-08-04 アカウント管理）。保存値に
                    無効化済みメールが残っていた場合は上の正規化が「全員」に倒す */}
                {users
                  .filter((u) => !u.disabled && !sameEmail(u.email, me.email))
                  .map((u) => (
                    <SelectItem key={u.email} value={u.email}>
                      {displayNameOf(u.email, users)}
                    </SelectItem>
                  ))}
                {/* 帰属なし = 実効関係者が空のページだけ。人フィルタは厳格絞り込みなので、
                    帰属未記入の既存データはここで見つけて付けて回る（2026-08-04 追修） */}
                <SelectItem value="none">帰属なし</SelectItem>
              </SelectContent>
            </Select>
          )}
        </span>
        <span className="flex flex-shrink-0 items-center">
          <Hint id="folder-add" always="フォルダを追加" text="プロジェクトをまとめる棚。掴んで（⠿）出し入れする">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground"
              onClick={() => void addFolder()}
            >
              <FolderPlus className="size-3.5" />
            </Button>
          </Hint>
          <Hint
            id="add-goal"
            always="ゴールを追加"
            text="ヘッダーの入力欄へ移動する。ゴールを書いて Enter で新しいプロジェクトができる"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground"
              onClick={addGoal}
            >
              ＋
            </Button>
          </Hint>
          <Hint id="rail-toggle" always="プロジェクト一覧を閉じる">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground"
              onClick={toggleRail}
            >
              <PanelLeftClose className="size-3.5" />
            </Button>
          </Hint>
        </span>
      </div>
      {/* フォルダ（上）→ 直下のプロジェクト（下）の順。人フィルタ中は中身が全部隠れた
          フォルダを畳んで出さない（絞り込みの意味が薄れるため） */}
      {folderList
        .filter((f) => personFilterValue === "all" || inFolder(f.id).length > 0)
        .map((f) => renderFolder(f))}
      {rootProjects.map((f) => renderRow(f, false))}
      {routineFolders.length > 0 && (
        <>
          <div
            data-rail-row={ROOT_ROW.routine}
            data-rail-kind="root"
            data-rail-section="routine"
            className={cn(
              "flex items-center justify-between rounded-sm px-2 pb-2 pt-1 text-xs font-semibold tracking-wide text-text-lo",
              dropClass(ROOT_ROW.routine),
            )}
          >
            <Hint id="page-routine" text={HINT_TEXT.pageRoutine}>
              <span>ルーティーン</span>
            </Hint>
          </div>
          {routineFolders.map((f) => renderRow(f, false))}
        </>
      )}
      {archivedFolders.length > 0 && (
        <>
          <Hint
            id="archive"
            text="完了・中止になったプロジェクトが入る（ルーティーンは常にアクティブ扱いでここには来ない）"
          >
            <button
              type="button"
              className="mt-1 flex items-center gap-1.5 border-t border-border px-2 py-1.5 text-left text-xs text-text-lo hover:bg-accent/40 hover:text-muted-foreground"
              onClick={() => setArchiveOpen((v) => !v)}
            >
              <span>{archiveOpen ? "▾" : "▸"}</span>
              <span>アーカイブ {archivedFolders.length}</span>
            </button>
          </Hint>
          {archiveOpen && (
            <div className="flex flex-col gap-px">{archivedFolders.map((f) => renderRow(f, true))}</div>
          )}
        </>
      )}
    </div>
  );
}
