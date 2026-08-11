// 左レールのページ行1本（PageList から切り出し）。行の見た目（状態の丸 / ルーティーンの絵・
// タイトル・関係者バッジ・hover の✎🗑・未読数・ドット列）と、その行の右クリックメニューを持つ。
// 右クリックメニューは「既存操作への近道（第0層）」で、実体は usePageActions の関数
// （＝パネル・台帳・ドラッグと同じ api・同じ確認文）。該当しない項目は disabled にせず
// 出さない（メニューを短く保つ）——例外は「既読にする」で、押しても意味が無いだけなので残す。
import { Archive, ArchiveRestore, CheckCheck, Folder, FolderInput, Pencil, Play, Trash2 } from "lucide-react";
import type { RailDnd } from "../../hooks/useRailDnd";
import { hasUnread } from "../../lib/actions";
import { HINT_TEXT } from "../../lib/hints";
import type { RailIndex } from "../../lib/railIndex";
import { isRoutinePage } from "../../lib/routine";
import { colorOf, displayNameOf, effectiveMembers, initialOf, useTeam } from "../../lib/team";
import { cn } from "../../lib/utils";
import type { Node, Run } from "../../types";
import { Hint } from "../Hint";
import { Icon } from "../Icon";
import { StatusCircle } from "../StatusCircle";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { MAX_DOTS, pageDots } from "./dots";
import { dotEl, RailGrip, ROW_ACTION } from "./rowParts";
import { RunRows } from "./RunRows";
import type { RailSections } from "./sections";
import type { PageActions } from "./usePageActions";

interface Props {
  f: Node;
  archived: boolean;
  /** 棚の中の行（左に一段下げる） */
  indented?: boolean;
  /** いま開いているページか（地色を濃くする） */
  selected: boolean;
  rail: RailIndex;
  sections: RailSections;
  threadMeta: Record<string, string>;
  reads: Record<string, string>;
  /** このページのラン（新しい順） */
  runs: Run[];
  selectedRunId: string | null;
  runsOpen: boolean;
  onToggleRuns: () => void;
  dnd: RailDnd;
  actions: PageActions;
  onSelectPage: (id: string) => void;
  onSelectRun: (pageId: string, runId: string) => void;
}

export function PageRow({
  f,
  archived,
  indented = false,
  selected,
  rail,
  sections,
  threadMeta,
  reads,
  runs,
  selectedRunId,
  runsOpen,
  onToggleRuns,
  dnd,
  actions,
  onSelectPage,
  onSelectRun,
}: Props) {
  const { me, users, enabled: teamEnabled } = useTeam();
  const members = rail.membersOf(f.id);
  const routine = isRoutinePage(f, members);
  // ページ内（ゴール自身 + メンバー）の未読数。数字バッジで行の右端に出す。
  // **テンプレート側の会話 + そのページの全ランぶん**を数える——ランで起きたことも
  // 「このページに新しいことがある」なので、ページ行では拾う（どのランかは下のラン行の
  // バッジが示す。2026-08-08 本人指定「ルーティン自体のバッジはこれで良い / 欄にも出して」）
  const unreadCount = [f.id, ...members.map((n) => n.id)]
    .map((id) => rail.unreadCount(id, reads))
    .reduce((a, b) => a + b, 0);

  // ページ行のドットはテンプレート（メンバーノード）構成。ルーティーンも同じ規則で、
  // ランの進捗は下のラン子行が持つ（2026-08-08 本人確認済みの分担）
  const dots = pageDots(members, me.email);
  const shown = dots.slice(0, MAX_DOTS);
  const rest = dots.length - shown.length;

  // イニシャルバッジは実効関係者（手動 members + 配下ノードからの自動集計。2026-08-04 追修。
  // 手動だけだと配下に担当者が居てもバッジが出ず「誰のページか」が見えない）
  const effMembers = teamEnabled ? effectiveMembers(f, members) : [];

  // ---- 右クリックメニューの材料（2026-08-09） ----
  // ラン作成の対象のトリガー（台帳と同じ created 昇順）。ルーティーン = トリガーを持つページ
  const triggers = routine
    ? members.filter((n) => n.kind === "trigger").sort((a, b) => a.created.localeCompare(b.created))
    : [];
  // 「既読にする」の対象キー（このページの全ノード × テンプレート + 全ラン）。
  // ラン子行のメニューはここからそのランのぶんだけ絞る（RunRows へ渡す）
  const pageKeys = rail.readKeysForPage(f.id);
  const shelves = sections.shelvesIn(routine ? "routine" : "project");
  const currentFolder = sections.folderOf(f);
  const section = routine ? ("routine" as const) : ("project" as const);

  return (
    // 行 + ラン子行をひとつの縦組みで返す（子行は行の外＝兄弟。行の hover やドラッグの
    // 当たり判定に巻き込まないため）。インデントは外側のラッパが持つ
    <div className={cn("flex flex-col gap-px", indented && "ml-3 w-[calc(100%-0.75rem)]")}>
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
            data-rail-section={section}
            className={cn(
              "group flex w-full cursor-pointer flex-col items-stretch gap-0.5 rounded-sm px-2 py-1.5 text-left text-muted-foreground hover:bg-accent/60",
              selected && "bg-accent text-foreground",
              archived && "opacity-70",
              dnd.drag?.id === f.id && "opacity-40",
              dnd.dropClass(f.id),
            )}
            onClick={() => {
              if (dnd.draggedRecently()) return; // ドラッグ直後の click は無視
              onSelectPage(f.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectPage(f.id);
              }
            }}
            {...(!archived ? dnd.rowDragHandlers({ id: f.id, kind: "page", section }) : {})}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {!archived && <RailGrip st={{ id: f.id, kind: "page", section }} dnd={dnd} />}
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
                    void actions.renamePage(f);
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
                    void actions.removePage(f);
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
          <ContextMenuItem onSelect={() => void actions.renamePage(f)}>
            <Pencil className="size-3.5" /> 名前を変更
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!hasUnread(pageKeys, threadMeta, reads)}
            onSelect={() => actions.markRead(pageKeys)}
          >
            <CheckCheck className="size-3.5" /> 既読にする
          </ContextMenuItem>
          {/* ラン作成はルーティーン（トリガーを持つページ）だけ。トリガーが複数あるページでは
              どれをランを作るか選ばせる（カードの▶と同じフォームが出る） */}
          {triggers.length === 1 && (
            <ContextMenuItem onSelect={() => void actions.runPage(f, triggers[0])}>
              <Play className="size-3.5" /> ラン
            </ContextMenuItem>
          )}
          {triggers.length > 1 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Play className="size-3.5" /> ラン
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {triggers.map((t) => (
                  <ContextMenuItem key={t.id} onSelect={() => void actions.runPage(f, t)}>
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
                    onSelect={() => void actions.moveToFolder(f, s.id)}
                  >
                    <Folder className="size-3.5" /> {s.title || "（無題）"}
                  </ContextMenuItem>
                ))}
                {currentFolder !== null && (
                  <>
                    {shelves.length > 0 && <ContextMenuSeparator />}
                    <ContextMenuItem onSelect={() => void actions.moveToFolder(f, null)}>
                      フォルダから出す
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {/* アーカイブは status からの導出（done|dropped = アーカイブ節）。ルーティーンにも
              出す（2026-08-09。以前は「常にアクティブ扱い」で隠していたが、完了にした
              ルーティーンを畳む手段が無くなっていた）。アーカイブするとラン作成も止まる */}
          {archived ? (
            <ContextMenuItem onSelect={() => void actions.setPageArchived(f, false)}>
              <ArchiveRestore className="size-3.5" /> 元に戻す
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => void actions.setPageArchived(f, true)}>
              <Archive className="size-3.5" /> アーカイブする
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => void actions.removePage(f)}>
            <Trash2 className="size-3.5" /> 削除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <RunRows
        page={f}
        members={members}
        runs={runs}
        open={runsOpen}
        onToggle={onToggleRuns}
        pageKeys={pageKeys}
        selectedRunId={selectedRunId}
        nodeById={rail.nodeById}
        threadMeta={threadMeta}
        reads={reads}
        actions={actions}
        onSelectRun={onSelectRun}
      />
    </div>
  );
}
