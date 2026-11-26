// ページ行の下にぶら下がるラン子行（2026-08-08。PageList から切り出し）。
// **開いているときだけ**出す（RUN_ROWS_VISIBLE 行を超えたら子リスト内スクロール）。
// クリックでそのランをグラフに投影する。
// 畳んでいる間の「最新1本の行 + 総本数」は 2026-11-26 に廃止（本人「情報量が多くて疲れる。
// 行の高さが揃ってなくて気持ち悪い」）。開閉ボタンと最新ランのドットは、ページ行のタイトルの
// 行へ移した（PageRow）。
import { Ban, CheckCheck, ExternalLink, Pencil } from "lucide-react";
import { hasUnread } from "../../lib/actions";
import { HINT_TEXT } from "../../lib/hints";
import { isUnreadKey, threadKey } from "../../lib/unread";
import { useTeam } from "../../lib/team";
import { cn } from "../../lib/utils";
import type { Node, Run } from "../../types";
import { Hint } from "../Hint";
import { RunStatusIcon } from "../RunStatusIcon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { MAX_DOTS, runDots } from "./dots";
import { dotEl } from "./rowParts";
import type { PageActions } from "./usePageActions";

/** ラン子行: 開いたとき一度に見せる行数。超えたら子リスト内スクロール（2026-08-08 本人指定「10件以上はスクロール」） */
const RUN_ROWS_VISIBLE = 10;

interface Props {
  page: Node;
  /** そのページのメンバー（未読数の集計に使う。呼び出し側が既に持っているものを渡す） */
  members: Node[];
  /** そのページのラン（新しい順） */
  runs: Run[];
  open: boolean;
  /** そのページの既読キー全部（呼び出し側で1回だけ集める。行ごとに集め直すと
   *  ページ数 × ラン数ぶん全ノードを走ることになる） */
  pageKeys: string[];
  selectedRunId: string | null;
  nodeById: Map<string, Node>;
  threadMeta: Record<string, string>;
  reads: Record<string, string>;
  actions: PageActions;
  onSelectRun: (pageId: string, runId: string) => void;
}

export function RunRows({
  page,
  members,
  runs,
  open,
  pageKeys,
  selectedRunId,
  nodeById,
  threadMeta,
  reads,
  actions,
  onSelectRun,
}: Props) {
  const { me } = useTeam();
  // 未読判定は GraphView（カードの青ドット）と同じ規約: 既読時刻より新しいメッセージがあるか。
  // 会話はランごとに分かれるので（2026-08-08）、キーは lib/unread.ts の threadKey を通す
  const isUnread = (id: string, runId?: string | null) =>
    isUnreadKey(threadKey(id, runId), threadMeta, reads);

  /** ラン子行1本。状態マーク + タイトル + そのランの進捗ドット */
  const renderRunRow = (r: Run) => {
    // このランで未読のノード数。ワークアイテム（トリガーの子孫）だけでなく**ページの全ノード**
    // を見る——「ラン作成」の記録はトリガーのスレッドに載り、トリガーは items に入らないため
    const runUnread = [page.id, ...members.map((n) => n.id)].filter((id) => isUnread(id, r.id)).length;
    const dots = runDots(r, nodeById, me.email);
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
            onClick={() => onSelectRun(page.id, r.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectRun(page.id, r.id);
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
              <Hint id="unread" always={`このランで未読のノード ${runUnread} 件`} text={HINT_TEXT.unread}>
                <span className="flex-shrink-0 rounded-full bg-ai px-1.5 text-[10px] font-semibold leading-4 text-white">
                  {runUnread}
                </span>
              </Hint>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onSelectRun(page.id, r.id)}>
            <ExternalLink className="size-3.5" /> 開く
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void actions.renameRun(r)}>
            <Pencil className="size-3.5" /> 名前を変更
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!hasUnread(runKeys, threadMeta, reads)}
            onSelect={() => actions.markRead(runKeys)}
          >
            <CheckCheck className="size-3.5" /> 既読にする
          </ContextMenuItem>
          {/* 打ち切りは実行中のランにだけ意味がある（済んだランには出さない） */}
          {r.status === "running" && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => void actions.cancelRun(r)}>
                <Ban className="size-3.5" /> キャンセル
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  if (!open || runs.length === 0) return null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-px pl-5",
        // 10行ぶんで打ち止め（1行 ≈ 24px + gap）。それ以上は子リスト内スクロール
        runs.length > RUN_ROWS_VISIBLE && "max-h-[250px] overflow-y-auto",
      )}
    >
      {runs.map(renderRunRow)}
    </div>
  );
}
