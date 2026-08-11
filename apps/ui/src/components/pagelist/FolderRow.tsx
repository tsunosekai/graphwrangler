// 左レールの棚（kind=folder）1行（PageList から切り出し）。開閉と、中のページ（children）の
// 入れ物。棚はページを束ねるだけでグラフ・実行・ランには関与しない（docs/design.md 3.1）。
// 右クリックは行の✎🗑と同じ操作を出すだけ（ボタンは残す。2026-08-09）。
import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, Pencil, Trash2 } from "lucide-react";
import type { RailDnd } from "../../hooks/useRailDnd";
import { cn } from "../../lib/utils";
import type { Node } from "../../types";
import { Hint } from "../Hint";
import { Button } from "../ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu";
import { RailGrip, ROW_ACTION } from "./rowParts";
import { shelfSectionOf } from "./sections";
import type { PageActions } from "./usePageActions";

interface Props {
  f: Node;
  open: boolean;
  onToggle: () => void;
  /** 中のページ数（畳んでいるときだけ数字で出す） */
  count: number;
  dnd: RailDnd;
  actions: PageActions;
  /** 中のページ行（open のときだけ描く） */
  children: ReactNode;
}

export function FolderRow({ f, open, onToggle, count, dnd, actions, children }: Props) {
  const section = shelfSectionOf(f);
  return (
    <div className="flex flex-col gap-px">
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
              dnd.drag?.id === f.id && "opacity-40",
              dnd.dropClass(f.id),
            )}
            onClick={() => {
              if (dnd.draggedRecently()) return;
              onToggle();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle();
              }
            }}
            {...dnd.rowDragHandlers({ id: f.id, kind: "folder", section })}
          >
            <RailGrip st={{ id: f.id, kind: "folder", section }} dnd={dnd} />
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
                  void actions.renameFolder(f);
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
                  void actions.removeFolder(f);
                }}
              >
                <Trash2 className="size-3" />
              </Button>
            </Hint>
            {/* 数（中のページ数）は行の一番右（2026-08-09 本人指示「数字は必ず一番右」）。
                hover で出る ✎🗑 は opacity で消しているだけ＝場所は取り続けるので、
                数字を左に置くと右端から浮いて見える */}
            {!open && count > 0 && <span className="flex-shrink-0 text-[10px] text-text-lo">{count}</span>}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void actions.renameFolder(f)}>
            <Pencil className="size-3.5" /> 名前を変更
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => void actions.removeFolder(f)}>
            <Trash2 className="size-3.5" /> 削除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open && children}
    </div>
  );
}
