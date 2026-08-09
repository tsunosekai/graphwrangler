// 左レールのページ一覧。ゴール/ルーティーン（フォルダ）1つ = 1ページ（desk の左レール方式）。
// 「プロジェクト」節（トリガーを持たないページ）と「ルーティーン」節（トリガーを持つページ）に
// ビュー的に分ける（本人指定 2026-07-31）。ルーティーン化はトリガーを置く/外すだけの1操作で、
// 節をまたぐのはその副作用として自然に起きる（design.md 3.8: 「プロジェクト/ルーティーンは
// トリガーの有無の別名」）。
// タイトル下のドット（ちょぼ）はページ内ノードの内訳（ノード1つ=点1つ）。色ルールは
// 2026-08-08 本人指定で明確化: 色は常に担当(executor)の色、唯一の例外が「あなたの番」= 橙。
// 終わったノード（完了・中止・スキップ）は色を変えず**薄く**する。プロジェクトも
// ルーティーンも同じ規則（ルーティーン行はテンプレート構成を出し、進捗はラン子行が持つ）。
// ラン子行（2026-08-08）: ページ行の下にそのページのランをぶら下げる。畳み時は最新1本 +
// 「+n」、開くと全部（10行を超えたら子リスト内スクロール）。クリックでそのランをグラフに投影。
// ラン一覧の取得は App 側でまとめてポーリングする（TopBar のラン待ち統合と共有し、
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
  Archive,
  ArchiveRestore,
  Ban,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Folder,
  FolderInput,
  FolderPlus,
  GripVertical,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import {
  cancelRunWithConfirm,
  hasUnread,
  markKeysRead,
  readKeysForPage,
  renameRunDialog,
} from "../lib/actions";
import { api } from "../lib/api";
import { focusGoalCapture } from "../lib/capture";
import { confirmDialog, promptDialog } from "../lib/dialogs";
import { fireTrigger } from "../lib/fire";
import { HINT_TEXT } from "../lib/hints";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { moveWithin, railPatches, sortRail } from "../lib/rail";
import { buildRemoveMessage, computeRemoveImpact, removeImpactWarnings } from "../lib/removal";
import { isRoutinePage } from "../lib/routine";
import { isUnreadKey, threadKey, unreadCountForNode } from "../lib/unread";
import { colorOf, displayNameOf, effectiveMembers, initialOf, sameEmail, turnIsMine, useTeam } from "../lib/team";
import { cn } from "../lib/utils";
import type { Node, Run, Status } from "../types";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Hint } from "./Hint";
import { Icon } from "./Icon";
import { RunStatusIcon } from "./RunStatusIcon";
import { StatusCircle } from "./StatusCircle";

interface Props {
  folders: Node[];
  /** 整理用フォルダ（kind=folder）。ページではないので folders とは別に受ける（2026-08-05） */
  folderNodes: Node[];
  allNodes: Node[];
  pageId: string | null;
  /** ノードid → 最終メッセージ時刻。ページ行の未読数バッジに使う（本人指定 2026-07-31:
   *  「未読は数字でプロジェクトに、あなたの番はドットに」） */
  threadMeta: Record<string, string>;
  /** ノードid → 既読時刻（サーバ持ち。2026-08-02 localStorage から移行＝端末間で一致） */
  reads: Record<string, string>;
  /** ページ id → ラン一覧（新しい順。App 側でポーリング済み）。ラン子行とその進捗ドットに使う */
  pageRuns: Record<string, Run[]>;
  /** いまグラフに出しているラン。その子行の地色を濃くする（ページ行の選択と同じ流儀。2026-08-08） */
  selectedRunId: string | null;
  /** モバイル（一覧ビューが画面を専有）では畳み状態を無視して常に展開表示する
   *  （2026-08-02 モバイル4ビュー化。畳む/開くはデスクトップのレール専用の概念） */
  forceExpanded?: boolean;
  onSelectPage: (id: string) => void;
  /** ラン子行のクリック → そのページへ切り替えて該当ランをグラフに投影する（2026-08-08） */
  onSelectRun: (pageId: string, runId: string) => void;
  /** フォルダ操作・並べ替えを打った直後の再取得（ポーリング待ちの3秒を出さない） */
  onMutated: () => void;
  /** 既読の即時反映（App の readOverrides。NodePanel の onViewed と同じもの）。
   *  既読の送信（postReads）は投げっぱなしなので、これを呼ばないと右クリックの
   *  「既読にする」でバッジが消えるのが次のポーリングまで遅れる */
  onViewed: (key: string, lastTs: string | null) => void;
  /** ラン一覧（App が5秒ごとに引く /runs/summary）の取り直し。発火・ラン名の変更・
   *  キャンセルの直後に呼ぶ（ノード側の onMutated ではランは更新されない） */
  onRunsMutated: () => void;
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

/** ドットの「席」（並び順の判定用）。決着済みは末尾へ沈める */
type Seat = "attention" | "human" | "ai" | "script" | "done";
function seatOf(status: Status, executor: Node["executor"]): Seat {
  if (status === "done" || status === "dropped" || status === "skipped") return "done";
  if (status === "waiting") return "attention";
  return executor;
}
/** 点の色は常に担当(executor)の色。唯一の例外が「あなたの番」= 橙（--attention。
 *  カード右肩の橙点と同じ）。終わったノードは色を塗り替えず、薄く（isSettled → opacity）する
 *  （2026-08-08 本人指定の色ルール明確化。旧: done/dropped 専用の沈み色に塗り替えていて、
 *  何の担当だったかが点から消えていた） */
function seatColor(status: Status, executor: Node["executor"]): string {
  if (status === "waiting") return "var(--attention)";
  return executor === "human" ? "var(--human)" : executor === "ai" ? "var(--ai)" : "var(--script)";
}
const isSettled = (st: Status) => st === "done" || st === "dropped" || st === "skipped";
// 目に入るべき順: あなたの番 → 人間の席 → AI → スクリプト → 完了系
const SEAT_ORDER: Seat[] = ["attention", "human", "ai", "script", "done"];
const MAX_DOTS = 16;
/** ラン子行: 開いたとき一度に見せる行数。超えたら子リスト内スクロール（2026-08-08 本人指定「10件以上はスクロール」） */
const RUN_ROWS_VISIBLE = 10;
/** 行の操作アイコン（✎🗑）の出し方。常時表示だとレールがごちゃついて名前が読みにくいので、
 *  マウスの hover とキーボードフォーカスのときだけ出す（2026-08-09 本人指示）。
 *  タッチ環境では hover が無いので出さない——長押しの右クリックメニューが同じ操作を持つ。
 *  行側に `group` が要る */
const ROW_ACTION =
  "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:hidden";
/** ドットの共通ヒント文。色ルールの正文はここ */
const DOTS_HINT =
  "ノード1つ=点1つ。色は担当の色（黄緑=人間 青=AI 灰=スクリプト）で、橙=あなたの番だけ例外。薄い点=完了・中止・スキップ";

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
/** ラン子行を開いているページ（既定は畳み=最新1本だけ）。UI状態なので localStorage */
const RUNS_OPEN_KEY = "gw.railRunsOpen";
function loadIdSet(key: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
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
  pageRuns,
  selectedRunId,
  forceExpanded,
  onSelectPage,
  onSelectRun,
  onMutated,
  onViewed,
  onRunsMutated,
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

  // 未読判定は GraphView（カードの青ドット）と同じ規約: 既読時刻より新しいメッセージがあるか。
  // 会話はランごとに分かれるので（2026-08-08）、キーは lib/unread.ts の threadKey を通す
  const isUnread = (id: string, runId?: string | null) =>
    isUnreadKey(threadKey(id, runId), threadMeta, reads);

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
  /** 棚がどちらの節のものか。null = プロジェクト節（既存フォルダの互換。2026-08-08） */
  const shelfSection = (f: Node): Section => (f.folderSection === "routine" ? "routine" : "project");
  const shelvesIn = (section: Section) => folderList.filter((f) => shelfSection(f) === section);
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
  /** 表示用: 節の直下にあるページ / 棚 id → その中のページ（2026-08-08 ルーティーンにも対応） */
  const rootProjects = projectFolders.filter((f) => folderOf(f) === null);
  const rootRoutines = routineFolders.filter((f) => folderOf(f) === null);
  const inFolder = (folderId: string) =>
    [...projectFolders, ...routineFolders].filter((f) => folderOf(f) === folderId);

  /** 並べ替えの計算対象は**絞り込み前の全ページ**にする（フィルタで隠れている行の
   *  相対順序を壊さないため）。アーカイブ済みも同じ入れ物として一緒に数える */
  const pageIdsIn = (section: Section, folderId: string | null): string[] =>
    sortRail(folders.filter((f) => sectionOf(f) === section && folderOf(f) === folderId)).map((f) => f.id);

  // 折り畳み状態（localStorage。UI状態なので正データには混ぜない）
  const [closedFolders, setClosedFolders] = useState<Set<string>>(() => loadIdSet(CLOSED_KEY));
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
  // ラン子行の開閉（開いているページの id 集合。既定は畳み=最新1本だけ）
  const [openRunPages, setOpenRunPages] = useState<Set<string>>(() => loadIdSet(RUNS_OPEN_KEY));
  const toggleRuns = (id: string) =>
    setOpenRunPages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(RUNS_OPEN_KEY, JSON.stringify([...next]));
      } catch {
        // 無視
      }
      return next;
    });

  // ---- ドラッグ（掴んで並べ替え・フォルダへ入れる） ----
  const dragRef = useRef<DragState | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  const draggedAtRef = useRef(0);
  /** 行ドラッグの「押しただけ」状態（まだ掴んでいない）。少し動いたら掴みに昇格する */
  const pressRef = useRef<{ st: DragState; x: number; y: number } | null>(null);
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
      // 棚同士の並べ替えは同じ節の中だけ（2026-08-08。節をまたぐ移動はさせない）
      return kind === "folder" && section === st.section ? { id, kind, section, pos } : null;
    }
    if (kind === "folder") {
      // 棚へ入れられるのは同じ節のページだけ（プロジェクトをルーティーン棚へ入れない）
      return section === st.section ? { id, kind, section, pos: "into" } : null;
    }
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
      // 棚同士の並べ替え（resolveDrop が同じ節の棚行 + before|after だけを通す）
      const ordered = moveWithin(
        shelvesIn(st.section).map((f) => f.id),
        st.id,
        target.id,
        target.pos === "before" ? "before" : "after",
      );
      await applyOrder(ordered);
      return;
    }
    // ページ: 行き先の入れ物（棚 / 節の直下）を決める。節は落とし先の節（＝掴んだページと同じ）
    const section: Section = target.section;
    const targetNode = target.kind === "page" ? (nodeById.get(target.id) ?? null) : null;
    const folderId =
      target.kind === "folder" ? target.id : targetNode ? folderOf(targetNode) : null;
    const siblings = pageIdsIn(section, folderId).filter((id) => id !== st.id);
    const ordered =
      target.kind === "page"
        ? moveWithin([...siblings, st.id], st.id, target.id, target.pos === "before" ? "before" : "after")
        : [...siblings, st.id];
    await applyOrder(ordered, folderId);
  };

  // ---- フォルダの作成・リネーム・削除 ----
  const addFolder = async (section: Section) => {
    const name = await promptDialog(
      section === "routine" ? "新しいルーティーンのフォルダ名" : "新しいフォルダの名前",
      { placeholder: section === "routine" ? "例: 定期レポート" : "例: 受託", confirmLabel: "作成" },
    );
    if (name === null || !name.trim()) return;
    try {
      await api.addNode({
        title: name.trim(),
        kind: "folder",
        // null = プロジェクト節（既存データと同じ意味）。ルーティーン棚だけ明示する
        folderSection: section === "routine" ? "routine" : null,
        order: shelvesIn(section).length,
      });
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
        ? `フォルダ「${f.title || "（無題）"}」を削除しますか？\n中の ${count} 件は消えず、直下へ出ます。`
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

  // ---- 右クリックメニューの操作（2026-08-09） ----
  // メニューは「既存操作への近道（第0層）」。ここで新しい概念は作らず、パネル・台帳・
  // ドラッグでできることと**同じ api・同じ確認文**を呼ぶだけにする。
  // 該当しない項目は disabled にせず出さない（メニューを短く保つ）——例外は
  // 「既読にする」で、押しても意味が無いだけなので disabled で残す

  /** ページ名の変更。フォルダ行の✎（renameFolder）と同じ流儀 */
  const renamePage = async (f: Node) => {
    const name = await promptDialog(isRoutinePage(f, allNodes) ? "ルーティーン名" : "プロジェクト名", {
      defaultValue: f.title,
      confirmLabel: "変更",
    });
    if (name === null || !name.trim() || name.trim() === f.title) return;
    try {
      await api.patchNode(f.id, { title: name.trim() });
      onMutated();
    } catch {
      // api 側でトースト済み
    }
  };

  /** 指定キーを既読にする（サーバへ送る + ローカル上書きで即バッジを消す） */
  const markRead = (keys: string[]) => {
    markKeysRead(keys, threadMeta, onViewed);
  };

  /** メニューの「フォルダへ移動」。ドラッグで棚へ落としたのと同じ結果（folder + order）に
   *  なるよう、落とし先の末尾へ置く applyDrop と同じ計算を通す */
  const moveToFolder = async (f: Node, folderId: string | null) => {
    const siblings = pageIdsIn(sectionOf(f), folderId).filter((id) => id !== f.id);
    await applyOrder([...siblings, f.id], folderId);
  };

  /** アーカイブ（節の出し入れ）。専用APIは無く status からの導出なので patch で切り替える */
  const setPageArchived = async (f: Node, archived: boolean) => {
    try {
      await api.patchNode(f.id, { status: archived ? "done" : "pending" });
      onMutated();
    } catch {
      // api 側でトースト済み
    }
  };

  /** ページの削除。メンバーの巻き添えはサーバ（force）が面倒を見るので、こちらは
   *  NodePanel の削除と同じ警告（removeImpactWarnings）を出すだけにする */
  const removePage = async (f: Node) => {
    const impact = computeRemoveImpact([f.id], allNodes);
    const ok = await confirmDialog(
      buildRemoveMessage(
        `「${f.title || "（無題）"}」を削除しますか？（Ctrl+Z で戻せます）`,
        removeImpactWarnings(impact),
      ),
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

  /** 発火（ルーティーンページのトリガー）。フォームと確認文は lib/fire.ts に集約してあり、
   *  カードの▶と同じものが出る。生まれたランのページへはラン子行クリックと同じ経路で移る */
  const firingRef = useRef(false);
  const firePage = async (f: Node, trigger: Node) => {
    if (firingRef.current) return; // 連打の幽霊ラン防止（カードの▶の firing と同じ役目）
    firingRef.current = true;
    try {
      const runs = pageRuns[f.id] ?? [];
      const run = await fireTrigger(trigger, {
        runningRunCount: runs.filter((r) => r.status === "running").length,
        lastRunContext: runs[0]?.context ?? null,
      });
      if (!run) return;
      onMutated();
      onRunsMutated(); // 生まれたばかりのランは一覧にまだ載っていない
      onSelectRun(f.id, run.id);
    } finally {
      firingRef.current = false;
    }
  };

  /** ラン名の変更。台帳（LedgerView）の✎・グラフ上部の✎と同じダイアログ・同じ api */
  const renameRun = async (r: Run) => {
    if (!(await renameRunDialog(r))) return;
    onRunsMutated();
    onMutated();
  };

  /** ランの打ち切り。今は台帳タブでしかできない操作の近道（確認文も台帳と同じ） */
  const cancelRun = async (r: Run) => {
    if (!(await cancelRunWithConfirm(r))) return;
    onRunsMutated();
    onMutated();
  };

  /** 落とし先の見せ方: 前後は行の縁に線、中へはフォルダ行を縁取る。
   *  線は inset の box-shadow ではなく絶対配置の擬似要素で描く——box-shadow は行の角丸
   *  （rounded-sm）に沿って端が丸まり、まっすぐな横線に見えないため（2026-08-06 本人指摘）。
   *  擬似要素は overflow-hidden が無い限り角丸に切られないので、端まで直線で出る */
  const dropClass = (id: string) => {
    if (drop?.id !== id) return undefined;
    if (drop.pos === "into") return "ring-1 ring-ai";
    return cn(
      "relative before:pointer-events-none before:absolute before:inset-x-0 before:h-0.5 before:bg-ai before:content-['']",
      // 行と行の隙間（gap-px）の中央に置き、どちらの行の線か迷わないようにする
      drop.pos === "before" ? "before:-top-px" : "before:-bottom-px",
    );
  };

  /** 行そのものを掴んでドラッグするためのハンドラ（2026-08-08 本人要望「持ち手アイコンを
   *  消して普通にドラッグ」）。クリック=選択と共存させるため、押しただけでは掴まず
   *  5px 動いたら掴みに昇格する。マウス限定——タッチはスクロールと取り合いになる
   *  （touch-action を行全体に切ると一覧が撫でられなくなる）ため、粗いポインタ環境では
   *  従来の取っ手（⠿）を残してそちらで掴む */
  const rowDragHandlers = (st: DragState) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      e.preventDefault(); // ドラッグ中に行のテキストが選択されるのを防ぐ（click はこれでも発火する）
      pressRef.current = { st, x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const press = pressRef.current;
      if (press && !dragRef.current) {
        if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) < 5) return;
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          // 無視（掴み自体は続行）
        }
        dragRef.current = press.st;
        setDrag(press.st);
        return;
      }
      moveDrag(e);
    },
    onPointerUp: (e: React.PointerEvent) => {
      pressRef.current = null;
      endDrag(e);
    },
  });

  /** 掴む取っ手（⠿）。タッチ（粗いポインタ）専用の入口として残す——マウスは行ごと掴める */
  const gripFor = (st: DragState) => (
    <span
      className="hidden size-3.5 flex-shrink-0 cursor-grab touch-none items-center justify-center text-text-lo/60 hover:text-muted-foreground [@media(pointer:coarse)]:flex"
      onPointerDown={(e) => beginDrag(e, st)}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onClick={(e) => e.stopPropagation()}
    >
      <GripVertical className="size-3.5" />
    </span>
  );

  /** ドット1粒。dim = 終わったノード（色は担当色のまま薄くする） */
  interface Dot {
    key: string;
    title: string;
    color: string;
    dim: boolean;
  }
  const dotEl = (d: Dot) => (
    <Hint key={d.key} id="seat-dots" always={d.title} text={DOTS_HINT}>
      <i
        className={cn("size-[5px] flex-shrink-0 rounded-full", d.dim && "opacity-35")}
        style={{ background: d.color }}
      />
    </Hint>
  );

  // 質問が開いている（pendingRequest あり）ノードは status が何であれ「あなたの番」扱い
  // （NodeCard の visualStatus と同じ保険）。ただし assignee が他人なら waiting（橙）に
  // 昇格させず、素の status のまま担当の席色で描く（チーム化 2026-08-04: 他人の番は橙にしない。
  // waiting はノードの保存値には無い導出値なので、昇格しなければ橙にはならない）
  const effStatus = (n: Node): Status =>
    n.pendingRequest && turnIsMine(n.assignee, me.email) ? "waiting" : n.status;

  /** ラン1本ぶんの進捗ドット。ワークアイテムはテンプレート自身の status を持たないため、
   *  担当色はテンプレートノード（allNodes 内の同id）の executor を引く。テンプレートが
   *  見当たらない（削除済み等）場合は script 扱いにフォールバックする */
  const runDotsOf = (run: Run): Dot[] =>
    Object.entries(run.items)
      .map(([nodeId, item]) => {
        const tmpl = allNodes.find((n) => n.id === nodeId);
        const executor = tmpl?.executor ?? ("script" as const);
        // 他人の番（テンプレートの assignee が他人）の waiting は橙にしない（effStatus と同じ原則）
        const st: Status =
          item.status === "waiting" && !turnIsMine(tmpl?.assignee ?? null, me.email)
            ? "pending"
            : item.status;
        return {
          key: nodeId,
          st,
          executor,
          title: `${tmpl?.title || "（無題）"} — ${EXEC_JA[executor]}の席 / ${STATUS_JA[item.status]}`,
        };
      })
      .sort(
        (a, b) => SEAT_ORDER.indexOf(seatOf(a.st, a.executor)) - SEAT_ORDER.indexOf(seatOf(b.st, b.executor)),
      )
      .map(({ key, st, executor, title }) => ({
        key,
        title,
        color: seatColor(st, executor),
        dim: isSettled(st),
      }));

  /** ラン子行1本。状態マーク + タイトル + そのランの進捗ドット。trailing は畳み時の「+n」。
   *  pageKeys = そのページの既読キー全部（呼び出し側で1回だけ集める。行ごとに集め直すと
   *  ページ数 × ラン数ぶん全ノードを走ることになる） */
  const renderRunRow = (f: Node, r: Run, pageKeys: string[]) => {
    // このランで未読のノード数。ワークアイテム（トリガーの子孫）だけでなく**ページの全ノード**
    // を見る——「発火」の記録はトリガーのスレッドに載り、トリガーは items に入らないため
    const runUnread = [f.id, ...allNodes.filter((n) => n.group === f.id).map((n) => n.id)].filter(
      (id) => isUnread(id, r.id),
    ).length;
    const dots = runDotsOf(r);
    const shown = dots.slice(0, MAX_DOTS);
    const rest = dots.length - shown.length;
    // 右クリックの「既読にする」が扱うのは**このラン**のキーだけ（"<ノードid>@<ランid>"）
    const runKeys = pageKeys.filter((k) => k.endsWith(`@${r.id}`));
    return (
      <ContextMenu key={r.id}>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs text-text-lo hover:bg-accent/60 hover:text-muted-foreground",
              // 表示中のランはページ行と同じ流儀で地色を濃くする（2026-08-08 本人要望）
              selectedRunId === r.id && "bg-accent text-foreground",
            )}
            onClick={() => onSelectRun(f.id, r.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectRun(f.id, r.id);
              }
            }}
          >
            {/* 状態の絵はグラフ上部のラン選択セレクタと共有（RunStatusIcon） */}
            <RunStatusIcon status={r.status} />
            <span className="min-w-0 flex-1 truncate" title={r.title}>
              {r.title}
            </span>
            <span className="flex max-w-[45%] flex-shrink-0 flex-wrap items-center justify-end gap-[3px]">
              {shown.map(dotEl)}
              {rest > 0 && <span className="font-mono text-[10px] text-text-lo">+{rest}</span>}
            </span>
            {/* そのランの未読数（2026-08-08 本人要望「欄にもバッジを出して」）。
                ページ行のバッジは「このページのどこか」、こちらは「どのランか」を示す */}
            {runUnread > 0 && (
              <Hint
                id="unread"
                always={`このランで未読のノード ${runUnread} 件`}
                text={HINT_TEXT.unread}
              >
                <span className="flex-shrink-0 rounded-full bg-ai px-1.5 text-[10px] font-semibold leading-4 text-white">
                  {runUnread}
                </span>
              </Hint>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onSelectRun(f.id, r.id)}>
            <ExternalLink className="size-3.5" /> 開く
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void renameRun(r)}>
            <Pencil className="size-3.5" /> 名前を変更
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!hasUnread(runKeys, threadMeta, reads)}
            onSelect={() => markRead(runKeys)}
          >
            <CheckCheck className="size-3.5" /> 既読にする
          </ContextMenuItem>
          {/* 打ち切りは実行中のランにだけ意味がある（済んだランには出さない） */}
          {r.status === "running" && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => void cancelRun(r)}>
                <Ban className="size-3.5" /> キャンセル
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  /** ページ行の下のラン子行ブロック。畳み時は最新1本だけ、開くと全部
   *  （RUN_ROWS_VISIBLE 行を超えたら子リスト内スクロール。本人指定 2026-08-08）。
   *  開閉はフォルダ行と同じ絵（chevron + フォルダ。ただし小さめ）で、行の**前**に置く
   *  （2026-08-08 本人指定。旧: 行末の「+n」ボタンで開いていた） */
  const runsBlock = (f: Node, pageKeys: string[]) => {
    const runsAll = pageRuns[f.id] ?? [];
    if (runsAll.length === 0) return null;
    const open = openRunPages.has(f.id);
    const rows = open ? runsAll : runsAll.slice(0, 1);
    return (
      <div className="flex items-start gap-0.5 pl-3">
        <Hint
          id="runs-toggle"
          always={open ? "ランを畳む" : `ラン ${runsAll.length} 本を表示`}
          text="このページのラン。クリックしたランの進捗がグラフに出る"
        >
          <button
            type="button"
            className="mt-1 flex flex-shrink-0 items-center rounded-sm text-text-lo hover:text-foreground"
            onClick={() => toggleRuns(f.id)}
          >
            {open ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
          </button>
        </Hint>
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col gap-px",
            // 10行ぶんで打ち止め（1行 ≈ 24px + gap）。それ以上は子リスト内スクロール
            open && runsAll.length > RUN_ROWS_VISIBLE && "max-h-[250px] overflow-y-auto",
          )}
        >
          {rows.map((r) => renderRunRow(f, r, pageKeys))}
        </div>
        {/* 畳んでいる間の総本数。▸ の横ではなくブロックの一番右に出す
            （2026-08-09 本人指示「数字は必ず一番右」）。展開中は行数で分かるので出さない */}
        {!open && runsAll.length > 1 && (
          <span className="mt-1 flex-shrink-0 text-[10px] leading-none text-text-lo">
            {runsAll.length}
          </span>
        )}
      </div>
    );
  };

  const renderRow = (f: Node, archived: boolean, indented = false) => {
    const routine = isRoutinePage(f, allNodes);
    // ページ内（ゴール自身 + メンバー）の未読数。数字バッジで行の右端に出す。
    // **テンプレート側の会話 + そのページの全ランぶん**を数える——ランで起きたことも
    // 「このページに新しいことがある」なので、ページ行では拾う（どのランかは下のラン行の
    // バッジが示す。2026-08-08 本人指定「ルーティン自体のバッジはこれで良い / 欄にも出して」）
    const unreadCount = [f.id, ...allNodes.filter((n) => n.group === f.id).map((n) => n.id)]
      .map((id) => unreadCountForNode(id, threadMeta, reads))
      .reduce((a, b) => a + b, 0);

    // ページ行のドットはテンプレート（メンバーノード）構成。ルーティーンも同じ規則で、
    // ランの進捗は下のラン子行が持つ（2026-08-08 本人確認済みの分担）
    const dots: Dot[] = allNodes
      .filter((n) => n.group === f.id)
      .slice()
      .sort(
        (a, b) =>
          SEAT_ORDER.indexOf(seatOf(effStatus(a), a.executor)) -
          SEAT_ORDER.indexOf(seatOf(effStatus(b), b.executor)),
      )
      .map((m) => ({
        key: m.id,
        title: `${m.title || "（無題）"} — ${EXEC_JA[m.executor]}の席 / ${STATUS_JA[effStatus(m)]}`,
        color: seatColor(effStatus(m), m.executor),
        dim: isSettled(effStatus(m)),
      }));
    const shown = dots.slice(0, MAX_DOTS);
    const rest = dots.length - shown.length;

    // イニシャルバッジは実効関係者（手動 members + 配下ノードからの自動集計。2026-08-04 追修。
    // 手動だけだと配下に担当者が居てもバッジが出ず「誰のページか」が見えない）
    const effMembers = teamEnabled ? effectiveMembers(f, allNodes) : [];

    // ---- 右クリックメニューの材料（2026-08-09） ----
    // 発火先のトリガー（台帳と同じ created 昇順）。ルーティーン = トリガーを持つページ
    const triggers = routine
      ? allNodes
          .filter((n) => n.group === f.id && n.kind === "trigger")
          .sort((a, b) => a.created.localeCompare(b.created))
      : [];
    // 「既読にする」の対象キー（このページの全ノード × テンプレート + 全ラン）。
    // ラン子行のメニューはここからそのランのぶんだけ絞る（runsBlock へ渡す）
    const pageKeys = readKeysForPage(f.id, allNodes, threadMeta);
    const shelves = shelvesIn(routine ? "routine" : "project");
    const currentFolder = folderOf(f);

    return (
      // 行 + ラン子行をひとつの縦組みで返す（子行は行の外＝兄弟。行の hover やドラッグの
      // 当たり判定に巻き込まないため）。インデントは外側のラッパが持つ
      <div key={f.id} className={cn("flex flex-col gap-px", indented && "ml-3 w-[calc(100%-0.75rem)]")}>
      {/* 行自体は button でなく div[role=button]（行の中に本物の <button> を置いても
          入れ子にならないように。2026-08-04）。Enter/Space の選択も維持する。
          行全体が掴める（rowDragHandlers。2026-08-08 取っ手アイコン廃止）。
          右クリックのメニューは asChild で**この行そのもの**をトリガーにする（2026-08-09）
          ——ラッパ要素を挟むと data-rail-* の当たり判定（ドラッグの落とし先解決）が変わる */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
      <div
        role="button"
        tabIndex={0}
        data-rail-row={f.id}
        data-rail-kind="page"
        data-rail-section={routine ? "routine" : "project"}
        className={cn(
          "group flex w-full cursor-pointer flex-col items-stretch gap-0.5 rounded-sm px-2 py-1.5 text-left text-muted-foreground hover:bg-accent/60",
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
        {...(!archived
          ? rowDragHandlers({ id: f.id, kind: "page", section: routine ? "routine" : "project" })
          : {})}
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
          {/* 実行中ラン数の「▶ n」バッジは廃止（2026-08-08 本人指示）。ランはこの行の下の
              ラン子行として出し、隠れている本数はドット列の隣の「+n」が示す */}
          {/* ページ詳細への⚙は廃止（2026-08-06 本人指示「要らない」）。行のクリック自体が
              ページ選択と同時にページ自身のノードを選ぶ（App の onSelectPage）ので、
              タイトル編集・関係者・削除へはそのまま NodePanel が開く。グラフ左上のページ名
              ボタンも同じ入口として残っている。
              名前の変更と削除だけは hover で出す（2026-08-09 本人指示）——右クリックの
              メニューにも同じ2つが載っているが、そちらは見えない導線なので手掛かりを残す */}
          <Hint id="page-rename" always="ページ名を変更">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("size-5 flex-shrink-0 text-text-lo hover:text-foreground", ROW_ACTION)}
              onClick={(e) => {
                e.stopPropagation();
                void renamePage(f);
              }}
            >
              <Pencil className="size-3" />
            </Button>
          </Hint>
          <Hint id="page-remove" always="ページを削除" text="中のノードも一緒に消える">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("size-5 flex-shrink-0 text-text-lo hover:text-destructive", ROW_ACTION)}
              onClick={(e) => {
                e.stopPropagation();
                void removePage(f);
              }}
            >
              <Trash2 className="size-3" />
            </Button>
          </Hint>
          {/* 未読数も行の一番右（2026-08-09 本人指示「数字は必ず一番右」）。
              hover で出る ✎🗑 より右に置かないと、hover のたびに右端から浮いて見える */}
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
        </span>
        {dots.length > 0 && (
          <span className="flex flex-wrap items-center gap-[3px] pl-5">
            {shown.map(dotEl)}
            {rest > 0 && <span className="font-mono text-xs text-text-lo">+{rest}</span>}
          </span>
        )}
      </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void renamePage(f)}>
            <Pencil className="size-3.5" /> 名前を変更
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!hasUnread(pageKeys, threadMeta, reads)}
            onSelect={() => markRead(pageKeys)}
          >
            <CheckCheck className="size-3.5" /> 既読にする
          </ContextMenuItem>
          {/* 発火はルーティーン（トリガーを持つページ）だけ。トリガーが複数あるページでは
              どれを発火するか選ばせる（カードの▶と同じフォームが出る） */}
          {triggers.length === 1 && (
            <ContextMenuItem onSelect={() => void firePage(f, triggers[0])}>
              <Play className="size-3.5" /> 発火
            </ContextMenuItem>
          )}
          {triggers.length > 1 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Play className="size-3.5" /> 発火
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {triggers.map((t) => (
                  <ContextMenuItem key={t.id} onSelect={() => void firePage(f, t)}>
                    {t.title || "（無題）"}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {/* フォルダ（棚）への出し入れ。今はドラッグだけの操作で、マウスでは取っ手が
              隠れていて見つけにくい。棚が1つも無いアーカイブ行では出さない */}
          {!archived && (shelves.length > 0 || currentFolder !== null) && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <FolderInput className="size-3.5" /> フォルダへ移動
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {shelves.map((s) => (
                  <ContextMenuItem
                    key={s.id}
                    disabled={currentFolder === s.id}
                    onSelect={() => void moveToFolder(f, s.id)}
                  >
                    <Folder className="size-3.5" /> {s.title || "（無題）"}
                  </ContextMenuItem>
                ))}
                {currentFolder !== null && (
                  <>
                    {shelves.length > 0 && <ContextMenuSeparator />}
                    <ContextMenuItem onSelect={() => void moveToFolder(f, null)}>
                      フォルダから出す
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {/* アーカイブは status からの導出（done|dropped = アーカイブ節）。ルーティーンは
              常にアクティブ扱いでアーカイブ節に来ないので出さない */}
          {!routine &&
            (archived ? (
              <ContextMenuItem onSelect={() => void setPageArchived(f, false)}>
                <ArchiveRestore className="size-3.5" /> 元に戻す
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onSelect={() => void setPageArchived(f, true)}>
                <Archive className="size-3.5" /> アーカイブする
              </ContextMenuItem>
            ))}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => void removePage(f)}>
            <Trash2 className="size-3.5" /> 削除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {runsBlock(f, pageKeys)}
      </div>
    );
  };

  const renderFolder = (f: Node) => {
    const children = inFolder(f.id);
    const open = !closedFolders.has(f.id);
    const section = shelfSection(f);
    return (
      <div key={f.id} className="flex flex-col gap-px">
        {/* 右クリックは行の✎🗑と同じ操作を出すだけ（ボタンは残す。2026-08-09） */}
        <ContextMenu>
        <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          data-rail-row={f.id}
          data-rail-kind="folder"
          data-rail-section={section}
          className={cn(
            "group flex w-full cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 text-left text-muted-foreground hover:bg-accent/60",
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
          {...rowDragHandlers({ id: f.id, kind: "folder", section })}
        >
          {gripFor({ id: f.id, kind: "folder", section })}
          {open ? (
            <ChevronDown className="size-3.5 flex-shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 flex-shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">{f.title || "（無題）"}</span>
          <Hint id="folder-rename" always="フォルダ名を変更">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("size-5 flex-shrink-0 text-text-lo hover:text-foreground", ROW_ACTION)}
              onClick={(e) => {
                e.stopPropagation();
                void renameFolder(f);
              }}
            >
              <Pencil className="size-3" />
            </Button>
          </Hint>
          <Hint id="folder-remove" always="フォルダを削除" text="中のページは消えず、直下へ出る">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("size-5 flex-shrink-0 text-text-lo hover:text-destructive", ROW_ACTION)}
              onClick={(e) => {
                e.stopPropagation();
                void removeFolder(f);
              }}
            >
              <Trash2 className="size-3" />
            </Button>
          </Hint>
          {/* 数（中のページ数）は行の一番右（2026-08-09 本人指示「数字は必ず一番右」）。
              hover で出る ✎🗑 は opacity で消しているだけ＝場所は取り続けるので、
              数字を左に置くと右端から浮いて見える */}
          {!open && children.length > 0 && (
            <span className="flex-shrink-0 text-[10px] text-text-lo">{children.length}</span>
          )}
        </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void renameFolder(f)}>
            <Pencil className="size-3.5" /> 名前を変更
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => void removeFolder(f)}>
            <Trash2 className="size-3.5" /> 削除
          </ContextMenuItem>
        </ContextMenuContent>
        </ContextMenu>
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
      // data-mobile-panel: モバイル（<768px）では全画面オーバーレイになる（index.css）
      // スクロールはルートでなく内側ラッパが持つ（2026-08-07 本人要望「リサイズの当たり判定を
      // 両サイドに」——ルートに overflow があるとハンドルの外側半分が切られる）
      data-mobile-panel="left"
      className="relative flex flex-shrink-0 flex-col border-r border-border bg-muted"
      style={{ width }}
    >
      <div className="resize-handle resize-handle-right" onPointerDown={(e) => startResize(e, 1)} />
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto overflow-x-hidden p-1.5">
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
                text="実効関係者（担当者・関係者・作成者の集計）でページを絞り込む。関係者なし=誰も付いていないページだけ"
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
                <SelectItem value="none">関係者なし</SelectItem>
              </SelectContent>
            </Select>
          )}
        </span>
        <span className="flex flex-shrink-0 items-center">
          <Hint id="folder-add" always="フォルダを追加" text="プロジェクトをまとめる棚。行をドラッグして出し入れする">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground"
              onClick={() => void addFolder("project")}
            >
              <FolderPlus className="size-3.5" />
            </Button>
          </Hint>
          <Hint
            id="add-goal"
            always="プロジェクトを追加"
            text="ヘッダーの入力欄へ移動する。やりたいことを書いて Enter で新しいプロジェクトができる"
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
      {shelvesIn("project")
        .filter((f) => personFilterValue === "all" || inFolder(f.id).length > 0)
        .map((f) => renderFolder(f))}
      {rootProjects.map((f) => renderRow(f, false))}
      {/* ルーティーン節。プロジェクト節と同じくフォルダ（棚）を持てる（2026-08-08 本人要望）。
          棚が1つでもあれば、ルーティーンが0件でも節ごと出す（＋の導線を残すため） */}
      {(routineFolders.length > 0 || shelvesIn("routine").length > 0) && (
        <>
          <div
            data-rail-row={ROOT_ROW.routine}
            data-rail-kind="root"
            data-rail-section="routine"
            className={cn(
              "flex items-center justify-between gap-1 rounded-sm px-2 pb-2 pt-1 text-xs font-semibold tracking-wide text-text-lo",
              dropClass(ROOT_ROW.routine),
            )}
          >
            <Hint id="page-routine" text={HINT_TEXT.pageRoutine}>
              <span>ルーティーン</span>
            </Hint>
            <Hint id="folder-add" always="フォルダを追加" text="ルーティーンをまとめる棚。行をドラッグして出し入れする">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-5 flex-shrink-0 text-text-lo hover:text-foreground"
                onClick={() => void addFolder("routine")}
              >
                <FolderPlus className="size-3.5" />
              </Button>
            </Hint>
          </div>
          {shelvesIn("routine")
            .filter((f) => personFilterValue === "all" || inFolder(f.id).length > 0)
            .map((f) => renderFolder(f))}
          {rootRoutines.map((f) => renderRow(f, false))}
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
    </div>
  );
}
