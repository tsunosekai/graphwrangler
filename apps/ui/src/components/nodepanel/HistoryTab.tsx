// 履歴タブは GraphWrangler AI（ChatDrawer）と同じ「セッションカード一覧 → クリックで
// 中身」の動線（2026-08-04 本人指示「Task AI の履歴の仕組み（＆UI）を揃えて」。
// それまではベタ流し + 区切り行だった）。スレッドが正史なので中身は読み取り専用で
// 開く（GraphWrangler AI は読み込んで続きを話せるが、こちらの「続き」は会話タブ＝
// 今のセッションの役割）
import { ChevronLeft } from "lucide-react";
import type { MaterializedMessage } from "../../types";
import { Button } from "../ui/button";
import { Thread } from "../Thread";
import { firstHumanPreview, type PastSession } from "./messageFilters";

interface Props {
  nodeId: string;
  /** 今の会話（最後の「新しい会話」区切り以降の会話メッセージ） */
  currentTalk: MaterializedMessage[];
  pastSessions: PastSession[];
  /** 開いている過去セッション（chatBreak メッセージの id。null = 一覧） */
  openedSessionId: string | null;
  onOpenSession: (id: string | null) => void;
  /** 「今の会話」カードのクリック（会話タブへ切り替える） */
  onShowTalk: () => void;
  onMutated: () => void;
}

export function HistoryTab({
  nodeId,
  currentTalk,
  pastSessions,
  openedSessionId,
  onOpenSession,
  onShowTalk,
  onMutated,
}: Props) {
  const openedSession = pastSessions.find((s) => s.id === openedSessionId) ?? null;

  return openedSession ? (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => onOpenSession(null)}
        >
          <ChevronLeft className="size-3.5" /> 履歴一覧
        </Button>
        <span className="text-xs text-muted-foreground">
          {new Date(openedSession.ts).toLocaleString("ja-JP")} ・ {openedSession.messages.length}件
        </span>
      </div>
      <Thread
        nodeId={nodeId}
        messages={openedSession.messages}
        aiBusy={false}
        showReplyBox={false}
        onMutated={onMutated}
      />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
      {/* 今の会話は一覧の先頭（GraphWrangler AI と同じ）。クリックで会話タブへ */}
      {currentTalk.length > 0 && (
        <button
          type="button"
          className="flex flex-shrink-0 flex-col gap-0.5 rounded-md border border-ai/40 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
          onClick={onShowTalk}
        >
          <span className="text-xs text-ai">今の会話 ・ {currentTalk.length}件（保存済み）</span>
          <span className="truncate">{firstHumanPreview(currentTalk)}</span>
        </button>
      )}
      {pastSessions.length === 0 && currentTalk.length === 0 && (
        <div className="p-2 text-sm text-muted-foreground">まだありません</div>
      )}
      {[...pastSessions].reverse().map((s) => (
        <button
          key={s.id}
          type="button"
          className="flex flex-shrink-0 flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
          onClick={() => onOpenSession(s.id)}
        >
          <span className="text-xs text-muted-foreground">
            {new Date(s.ts).toLocaleString("ja-JP")} ・ {s.messages.length}件
          </span>
          <span className="truncate">{firstHumanPreview(s.messages)}</span>
        </button>
      ))}
    </div>
  );
}
