// ルーティーンページの第3の投影: 台帳ビュー（docs/design.md 3.8）。
// 列=テンプレートノード（トポロジカル順）、行=ラン（新しい順）、セル=ワークアイテムの状態。
// テキスト・グラフ・表は同一データへの3つの投影という位置づけなので、変更はすべて
// サーバAPI（/api/runs/...）へ委ね、このコンポーネントは表示とトグルだけを持つ。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { usePolling } from "../hooks/usePolling";
import { pushToast } from "../lib/toast";
import { cn } from "../lib/utils";
import type { Node, RunItem, RunItemStatus, RunStatus, Status, TraceEvent } from "../types";
import { Button } from "./ui/button";
import { Icon } from "./Icon";
import { StatusCircle } from "./StatusCircle";

interface Props {
  procedure: Node;
  /** このルーティーンページの全メンバー（テンプレートノード。draft含む） */
  members: Node[];
  onMutated: () => void;
}

// ラン自体の status は Status に無い値("cancelled")を持つので StatusCircle 用に変換する
const RUN_STATUS_TO_DISPLAY: Record<RunStatus, Status> = {
  running: "running",
  done: "done",
  cancelled: "dropped",
};

const AUTHOR_ICON: Record<string, "user" | "cpu" | "gear"> = {
  human: "user",
  agent: "cpu",
  system: "gear",
};

function truncateTitle(title: string): string {
  const t = title || "（無題）";
  return t.length > 8 ? `${t.slice(0, 8)}…` : t;
}

/** parents を辿った層順（トポロジカル順）。同層は order → created */
function topoOrder(members: Node[]): Node[] {
  const idSet = new Set(members.map((n) => n.id));
  const byId = new Map(members.map((n) => [n.id, n] as const));
  const layer = new Map<string, number>();
  const visiting = new Set<string>();

  const calc = (id: string): number => {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // 循環防御（本来エンジンが禁止しているはず）
    visiting.add(id);
    const n = byId.get(id);
    const parentLayers = (n?.parents ?? []).filter((p) => idSet.has(p)).map(calc);
    const l = parentLayers.length > 0 ? Math.max(...parentLayers) + 1 : 0;
    layer.set(id, l);
    visiting.delete(id);
    return l;
  };
  for (const n of members) calc(n.id);

  return members.slice().sort((a, b) => {
    const la = layer.get(a.id) ?? 0;
    const lb = layer.get(b.id) ?? 0;
    if (la !== lb) return la - lb;
    const oa = a.order ?? Number.MAX_SAFE_INTEGER;
    const ob = b.order ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a.created < b.created ? -1 : a.created > b.created ? 1 : 0;
  });
}

// decision テンプレートのセル: choice が確定していれば選んだ枝の label を極小表示する
// （docs/design.md 3.9。台帳ビューではラン毎にどの枝を通ったかが見える）
function renderCell(item: RunItem | undefined, col: Node) {
  if (!item || item.status === "skipped") {
    return <span className="text-text-lo">—</span>;
  }
  const choiceLabel =
    col.kind === "decision" && item.choice
      ? (col.branches?.find((b) => b.id === item.choice)?.label ?? item.choice)
      : null;
  return (
    <span className="inline-flex items-center justify-center gap-1">
      <StatusCircle status={item.status} size={13} />
      {choiceLabel && <span className="text-[10px] text-muted-foreground">{choiceLabel}</span>}
    </span>
  );
}

export function LedgerView({ procedure, members, onMutated }: Props) {
  const columns = useMemo(() => topoOrder(members), [members]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // B-11: トレース再生（1.1秒間隔でイベント行を順にハイライト+スクロール）
  const [replayIndex, setReplayIndex] = useState(-1);
  const [replaying, setReplaying] = useState(false);
  const traceBodyRef = useRef<HTMLDivElement>(null);

  const { data: runsData, refresh: refreshRuns } = usePolling(
    () => api.listRuns(procedure.id),
    5000,
  );
  const runs = runsData?.runs ?? [];
  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;

  const { data: traceData, refresh: refreshTrace } = usePolling(
    () =>
      selectedRunId
        ? api.getRunTrace(selectedRunId)
        : Promise.resolve<{ events: TraceEvent[] }>({ events: [] }),
    5000,
  );
  const events = traceData?.events ?? [];

  // ラン選択が変わったら即座にトレースを取り直す（次の5秒ポーリングを待たない）
  useEffect(() => {
    refreshTrace();
  }, [selectedRunId, refreshTrace]);

  // ラン選択が変わったら再生状態をリセットする
  useEffect(() => {
    setReplaying(false);
    setReplayIndex(-1);
  }, [selectedRunId]);

  // 再生中: 1.1秒間隔で次のイベントへ進む。末尾に達したら止める
  useEffect(() => {
    if (!replaying) return;
    if (events.length === 0) {
      setReplaying(false);
      return;
    }
    const timer = window.setInterval(() => {
      setReplayIndex((i) => {
        const next = i + 1;
        if (next >= events.length) {
          setReplaying(false);
          return i;
        }
        return next;
      });
    }, 1100);
    return () => window.clearInterval(timer);
  }, [replaying, events.length]);

  // ハイライトされた行をトレース欄内でスクロール表示する
  useEffect(() => {
    if (replayIndex < 0) return;
    const ev = events[replayIndex];
    if (!ev) return;
    const el = traceBodyRef.current?.querySelector(`[data-trace-id="${ev.id}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [replayIndex, events]);

  const toggleReplay = useCallback(() => {
    if (replaying) {
      setReplaying(false);
      return;
    }
    if (events.length === 0) return;
    setReplayIndex(0);
    setReplaying(true);
  }, [replaying, events.length]);

  // 発火先: メンバー中のトリガーノード（created昇順で最初の1件。docs/design.md 3.8 新モデル）。
  // トリガーが無い旧 kind=procedure ページは互換エイリアス(createRun)にフォールバックする
  // （サーバ側 POST /api/procedures/:id/runs が同じ優先順位で解決するので実質同じ挙動）
  const triggerNode = useMemo(
    () =>
      members
        .filter((m) => m.kind === "trigger")
        .sort((a, b) => a.created.localeCompare(b.created))[0] ?? null,
    [members],
  );

  const startRun = useCallback(async () => {
    setStarting(true);
    try {
      const run = triggerNode ? await api.fireTrigger(triggerNode.id) : await api.createRun(procedure.id, {});
      await refreshRuns();
      setSelectedRunId(run.id);
      onMutated();
      pushToast("ランを開始しました", "info");
    } finally {
      setStarting(false);
    }
  }, [triggerNode, procedure.id, refreshRuns, onMutated]);

  const cancelSelected = useCallback(async () => {
    if (!selectedRunId) return;
    await api.cancelRun(selectedRunId);
    await refreshRuns();
    onMutated();
  }, [selectedRunId, refreshRuns, onMutated]);

  const toggleCell = useCallback(
    async (runId: string, nodeId: string, current: RunItemStatus) => {
      if (current !== "pending" && current !== "done") return;
      const next: RunItemStatus = current === "pending" ? "done" : "pending";
      await api.patchRunItem(runId, nodeId, { status: next });
      await refreshRuns();
      if (runId === selectedRunId) refreshTrace();
      onMutated();
    },
    [refreshRuns, refreshTrace, selectedRunId, onMutated],
  );

  const EXEC_TEXT: Record<string, string> = { human: "text-human", agent: "text-ai", system: "text-script" };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3.5 py-2.5">
        <span className="text-xs text-muted-foreground">{runs.length} 件のラン</span>
        <div className="flex items-center gap-2">
          {selectedRun?.status === "running" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-destructive/40 text-destructive"
              onClick={cancelSelected}
            >
              キャンセル
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-ai/40 text-ai"
            disabled={starting}
            onClick={startRun}
            title={triggerNode ? `トリガー「${triggerNode.title || "（無題）"}」を発火` : "ラン開始"}
          >
            ▶ 発火
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3.5">
        <table className="w-full min-w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-[3] min-w-40 whitespace-nowrap border-b border-border bg-muted px-2.5 py-1.5 text-left text-xs font-semibold text-muted-foreground">
                ラン
              </th>
              {columns.map((col) => (
                <th
                  key={col.id}
                  title={col.title || "（無題）"}
                  className="sticky top-0 z-[2] whitespace-nowrap border-b border-border bg-muted px-2.5 py-1.5 text-left text-xs font-semibold text-muted-foreground"
                >
                  {truncateTitle(col.title)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td className="p-4 text-center text-text-lo" colSpan={columns.length + 1}>
                  まだランがありません
                </td>
              </tr>
            )}
            {runs.map((run) => (
              <tr
                key={run.id}
                className={cn("cursor-pointer hover:bg-accent/40", run.id === selectedRunId && "bg-ai/[0.08]")}
                onClick={() => setSelectedRunId(run.id)}
              >
                <td
                  className={cn(
                    "sticky left-0 z-[1] flex min-w-40 items-center gap-1.5 border-b border-border bg-muted px-2.5 py-1.5",
                    run.id === selectedRunId && "bg-[#131a22]",
                  )}
                >
                  <StatusCircle status={RUN_STATUS_TO_DISPLAY[run.status]} size={12} />
                  <span className="max-w-[220px] truncate" title={run.title}>
                    {run.title}
                  </span>
                </td>
                {columns.map((col) => {
                  const item = run.items[col.id];
                  // 分岐はトグルではない（decide経由でしか確定しないため、セルクリックでの切替は無効）
                  const toggleDisabled = col.kind === "decision";
                  return (
                    <td
                      key={col.id}
                      className={cn(
                        "border-b border-border px-2.5 py-1.5 text-center align-middle",
                        !toggleDisabled && "cursor-pointer",
                      )}
                      onClick={(e) => {
                        if (toggleDisabled) return;
                        if (!item || (item.status !== "pending" && item.status !== "done")) return;
                        e.stopPropagation();
                        toggleCell(run.id, col.id, item.status);
                      }}
                    >
                      {renderCell(item, col)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedRun && (
        <div className="flex max-h-[34%] flex-shrink-0 flex-col border-t border-border bg-muted">
          <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3.5 py-2 text-xs font-semibold text-muted-foreground">
            <span>トレース: {selectedRun.title}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-ai/40 text-ai"
              disabled={events.length === 0}
              onClick={toggleReplay}
              title="1.1秒間隔でイベントを順に再生する"
            >
              {replaying ? "⏸" : "▶再生"}
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3.5 py-1.5" ref={traceBodyRef}>
            {events.length === 0 && <div className="py-2 text-xs text-text-lo">まだありません</div>}
            {events.map((ev, i) => (
              <div
                key={ev.id}
                data-trace-id={ev.id}
                className={cn(
                  "flex items-center gap-2 rounded-sm border-b border-white/5 px-0 py-0.5 text-xs",
                  i === replayIndex && "rounded-sm bg-ai/[0.12]",
                )}
              >
                <span
                  className={cn(
                    "flex-shrink-0",
                    EXEC_TEXT[ev.author.kind === "human" ? "human" : ev.author.kind === "agent" ? "agent" : "system"],
                  )}
                >
                  <Icon name={AUTHOR_ICON[ev.author.kind] ?? "gear"} size={12} />
                </span>
                <span className="flex-shrink-0 font-mono text-xs text-text-lo">
                  {new Date(ev.ts).toLocaleString("ja-JP")}
                </span>
                <span className="max-w-[140px] flex-shrink-0 truncate text-muted-foreground">{ev.nodeTitle}</span>
                <span className="min-w-0 flex-1 truncate">{ev.body}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
