// 左レールのページ一覧。ゴール/ルーティーン（フォルダ）1つ = 1ページ（desk の左レール方式）。
// 「プロジェクト」節（トリガーを持たないページ）と「ルーティーン」節（トリガーを持つページ）に
// ビュー的に分ける（本人指定 2026-07-31）。ルーティーン化はトリガーを置く/外すだけの1操作で、
// 節をまたぐのはその副作用として自然に起きる（design.md 3.8: 「プロジェクト/ルーティーンは
// トリガーの有無の別名」）。
// ラン子行（2026-08-08）: ページ行の下にそのページのランをぶら下げる。
// ラン一覧の取得は App 側でまとめてポーリングする（TopBar のラン待ち統合と共有し、
// ページ数ぶんの N+1 取得を1箇所に集約するため。旧: このコンポーネント内で自前ポーリングしていた）。
//
// このファイルが持つのは**レールの骨格**だけ——節の見出し（＋人フィルタ・フォルダ追加・
// レール開閉）と、そこへ棚とページ行を流し込む配置。中身は components/pagelist/ に分けてある:
// - sections.ts       節（プロジェクト/ルーティーン/アーカイブ）と棚の仕分け・並び
// - PersonFilter.tsx  人フィルタ（選択値の正規化 + 絞り込み述語 + セレクタ）
// - usePageActions.ts 行への操作（並べ替えの書き戻し・棚/ページ/ランの作成・改名・削除…）
// - PageRow.tsx       ページ行1本（見た目 + 右クリックメニュー）
// - RunRows.tsx       ページ行の下のラン子行
// - FolderRow.tsx     棚（フォルダ）1行
// - dots.tsx          行のドット（ちょぼ）の導出と描画
//
// 整理（2026-08-05 本人要望「フォルダ機能と手動並べ替え」）:
// - フォルダ = kind=folder のノード。ページを束ねるだけで、グラフ・実行・ランには
//   関与しない。ページの所属は group ではなく folder フィールド（design.md 3.1）
// - 並びは order（数値）。掴んで（⠿）動かすたびに、動いた入れ物のぶんだけ 0..n-1 へ
//   詰め直す（差分だけ patch する。lib/rail.ts）
// - ドラッグの仕掛け（掴む・運ぶ・落とし先の判定）は hooks/useRailDnd.ts
// - 行ごとの派生値（配下ノード・未読キー）は hooks/... ではなく lib/railIndex.ts の索引から引く。
//   行ごとに allNodes / threadMeta を舐め直すとページ数ぶん掛け算になるため
import { useMemo, useState } from "react";
import { CalendarDays, FolderPlus, PanelLeft, PanelLeftClose } from "lucide-react";
import { focusGoalCapture } from "../lib/capture";
import { HINT_TEXT } from "../lib/hints";
import { useIdSetPref } from "../hooks/useIdSetPref";
import { ROOT_ROW, useRailDnd } from "../hooks/useRailDnd";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { buildRailIndex } from "../lib/railIndex";
import { useTeam } from "../lib/team";
import { cn } from "../lib/utils";
import type { Node, Run } from "../types";
import { Button } from "./ui/button";
import { Hint } from "./Hint";
import { FolderRow } from "./pagelist/FolderRow";
import { RoutineCalendarDialog } from "./RoutineCalendar";
import { PageRow } from "./pagelist/PageRow";
import { PersonFilter, usePersonFilter } from "./pagelist/PersonFilter";
import { buildRailSections } from "./pagelist/sections";
import { usePageActions } from "./pagelist/usePageActions";

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
  /** ラン一覧（App が5秒ごとに引く /runs/summary）の取り直し。ラン作成・ラン名の変更・
   *  キャンセルの直後に呼ぶ（ノード側の onMutated ではランは更新されない） */
  onRunsMutated: () => void;
}

const CLOSED_KEY = "gw.railFolderClosed";
/** ラン子行を開いているページ（既定は畳み=最新1本だけ）。UI状態なので localStorage */
const RUNS_OPEN_KEY = "gw.railRunsOpen";

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
  // 行の材料（配下ノード・未読キー）を引く索引。ページ行ごとに allNodes / threadMeta を
  // 舐め直すと「ページ数 × 全ノード数 × キー数」になるので、1回だけ作って全行で使い回す
  const rail = useMemo(() => buildRailIndex(allNodes, threadMeta), [allNodes, threadMeta]);
  // チーム化（2026-08-04）: 人フィルタ。ロスターが2人未満なら出さない（degrade 原則）
  const { enabled: teamEnabled } = useTeam();
  const filter = usePersonFilter(rail.membersOf);
  // 節（プロジェクト/ルーティーン/アーカイブ）と棚の仕分け。人フィルタは節の中身にだけ効く
  const sections = useMemo(
    () => buildRailSections(folders, folderNodes, rail.membersOf, filter.byPerson),
    [folders, folderNodes, rail, filter.byPerson],
  );
  const actions = usePageActions({
    allNodes,
    pageRuns,
    threadMeta,
    rail,
    sections,
    onMutated,
    onViewed,
    onRunsMutated,
    onSelectRun,
  });
  // ---- ドラッグ（掴んで並べ替え・フォルダへ入れる。仕掛けは hooks/useRailDnd.ts） ----
  const dnd = useRailDnd(actions.applyDrop);

  // アーカイブ節（done/dropped なゴール）は既定で閉じておく
  const [archiveOpen, setArchiveOpen] = useState(false);
  // ルーティーンの予定カレンダー（2026-08-12 本人要望）。ルーティーン節ヘッダの📅から開く
  const [calendarOpen, setCalendarOpen] = useState(false);
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
  // 折り畳み状態（localStorage。UI状態なので正データには混ぜない）
  const [closedFolders, toggleFolder] = useIdSetPref(CLOSED_KEY);
  // ラン子行の開閉（開いているページの id 集合。既定は畳み=最新1本だけ）
  const [openRunPages, toggleRuns] = useIdSetPref(RUNS_OPEN_KEY);

  // 作成は「ヘッダーのゴール捕獲欄」に一本化した（2026-08-01 本人指示。docs/design.md 4章 ②）。
  // ここの「＋」は無題ノードを作らず、その入力欄へフォーカスを渡すだけにする——
  // 入口が2つあると「無題のゴール」が量産されるため
  const addGoal = () => focusGoalCapture();

  const renderRow = (f: Node, archived: boolean, indented = false) => (
    <PageRow
      key={f.id}
      f={f}
      archived={archived}
      indented={indented}
      selected={pageId === f.id}
      rail={rail}
      sections={sections}
      threadMeta={threadMeta}
      reads={reads}
      runs={pageRuns[f.id] ?? []}
      selectedRunId={selectedRunId}
      runsOpen={openRunPages.has(f.id)}
      onToggleRuns={() => toggleRuns(f.id)}
      dnd={dnd}
      actions={actions}
      onSelectPage={onSelectPage}
      onSelectRun={onSelectRun}
    />
  );

  /** 棚1つと、その中のページ行。人フィルタ中は中身が全部隠れた棚を畳んで出さない
   *  （絞り込みの意味が薄れるため） */
  const renderShelves = (section: "project" | "routine") =>
    sections
      .shelvesIn(section)
      .filter((f) => filter.value === "all" || sections.inFolder(f.id).length > 0)
      .map((f) => {
        const children = sections.inFolder(f.id);
        return (
          <FolderRow
            key={f.id}
            f={f}
            open={!closedFolders.has(f.id)}
            onToggle={() => toggleFolder(f.id)}
            count={children.length}
            dnd={dnd}
            actions={actions}
          >
            {children.map((c) => renderRow(c, false, true))}
          </FolderRow>
        );
      });

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
            dnd.dropClass(ROOT_ROW.project),
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Hint id="page-project" text={HINT_TEXT.pageProject}>
              <span className="flex-shrink-0">プロジェクト</span>
            </Hint>
            {/* 人フィルタ（チーム化 2026-08-04。2026-08-05 見出しの隣へ小さく寄せた——
              幅いっぱいのセレクタは主張が強すぎた）。ルーティーン節にも同じ述語が効く */}
            {teamEnabled && <PersonFilter value={filter.value} onChange={filter.setValue} />}
          </span>
          <span className="flex flex-shrink-0 items-center">
            <Hint
              id="folder-add"
              always="フォルダを追加"
              text="プロジェクトをまとめる棚。行をドラッグして出し入れする"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground"
                onClick={() => void actions.addFolder("project")}
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
        {/* フォルダ（上）→ 直下のプロジェクト（下）の順 */}
        {renderShelves("project")}
        {sections.rootProjects.map((f) => renderRow(f, false))}
        {/* ルーティーン節。プロジェクト節と同じくフォルダ（棚）を持てる（2026-08-08 本人要望）。
          棚が1つでもあれば、ルーティーンが0件でも節ごと出す（＋の導線を残すため） */}
        {(sections.routineFolders.length > 0 || sections.shelvesIn("routine").length > 0) && (
          <>
            <div
              data-rail-row={ROOT_ROW.routine}
              data-rail-kind="root"
              data-rail-section="routine"
              className={cn(
                "flex items-center justify-between gap-1 rounded-sm px-2 pb-2 pt-1 text-xs font-semibold tracking-wide text-text-lo",
                dnd.dropClass(ROOT_ROW.routine),
              )}
            >
              <Hint id="page-routine" text={HINT_TEXT.pageRoutine}>
                <span>ルーティーン</span>
              </Hint>
              <span className="flex flex-shrink-0 items-center">
              <Hint
                id="routine-calendar"
                always="予定カレンダー"
                text="定刻つきルーティーンをカレンダーで見る（毎日以下の細かい頻度は既定で非表示）"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 flex-shrink-0 text-text-lo hover:text-foreground"
                  onClick={() => setCalendarOpen(true)}
                >
                  <CalendarDays className="size-3.5" />
                </Button>
              </Hint>
              <Hint
                id="folder-add"
                always="フォルダを追加"
                text="ルーティーンをまとめる棚。行をドラッグして出し入れする"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 flex-shrink-0 text-text-lo hover:text-foreground"
                  onClick={() => void actions.addFolder("routine")}
                >
                  <FolderPlus className="size-3.5" />
                </Button>
              </Hint>
              </span>
            </div>
            {renderShelves("routine")}
            {sections.rootRoutines.map((f) => renderRow(f, false))}
          </>
        )}
        {sections.archivedFolders.length > 0 && (
          <>
            <Hint
              id="archive"
              text="完了・中止にしたページが入る（ルーティーンも同じ。戻せばトリガーはまたランを作る）"
            >
              <button
                type="button"
                className="mt-1 flex items-center gap-1.5 border-t border-border px-2 py-1.5 text-left text-xs text-text-lo hover:bg-accent/40 hover:text-muted-foreground"
                onClick={() => setArchiveOpen((v) => !v)}
              >
                <span>{archiveOpen ? "▾" : "▸"}</span>
                <span>アーカイブ {sections.archivedFolders.length}</span>
              </button>
            </Hint>
            {archiveOpen && (
              <div className="flex flex-col gap-px">
                {sections.archivedFolders.map((f) => renderRow(f, true))}
              </div>
            )}
          </>
        )}
      </div>
      <RoutineCalendarDialog
        open={calendarOpen}
        onOpenChange={setCalendarOpen}
        allNodes={allNodes}
        pageRuns={pageRuns}
        onOpenPage={(pid) => {
          setCalendarOpen(false);
          onSelectPage(pid);
        }}
      />
    </div>
  );
}
