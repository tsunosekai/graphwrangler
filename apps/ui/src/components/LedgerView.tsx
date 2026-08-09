// ルーティーンページの第3の投影: 台帳ビュー（docs/design.md 3.8）。
// 列=テンプレートノード（トポロジカル順）、行=ラン（新しい順）、セル=ワークアイテムの状態。
// テキスト・グラフ・表は同一データへの3つの投影という位置づけなので、変更はすべて
// サーバAPI（/api/runs/...）へ委ね、このコンポーネントは表示とトグルだけを持つ。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Play } from "lucide-react";
import {
  cancelRunWithConfirm,
  hasUnread,
  markKeysRead,
  readKeysForPage,
  renameRunDialog,
} from "../lib/actions";
import { api } from "../lib/api";
import { fireTrigger } from "../lib/fire";
import { usePolling } from "../hooks/usePolling";
import { HINT_TEXT } from "../lib/hints";
import { buildRoute } from "../lib/route";
import { pushToast } from "../lib/toast";
import { threadKey } from "../lib/unread";
import { cn } from "../lib/utils";
import type { Node, Run, RunItem, RunItemStatus, RunStatus, Status, TraceEvent } from "../types";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Hint } from "./Hint";
import { Icon } from "./Icon";
import { StatusCircle } from "./StatusCircle";

interface Props {
  /** このルーティーンページ自身のノード */
  page: Node;
  /** このルーティーンページの全メンバー（テンプレートノード。draft含む） */
  members: Node[];
  /** 会話キー → 最終メッセージ時刻 / 既読時刻。右クリックの「既読にする」の可否判定にだけ使う
   *  （台帳自体は未読バッジを持たない）。App の /state ポーリングを GraphView 経由で受ける
   *  ——台帳が自分で /state を引くと同じ状態の取得口が二重になる */
  threadMeta: Record<string, string>;
  reads: Record<string, string>;
  /** 既読の即時反映（App の readOverrides。NodePanel / PageList / グラフと同じもの） */
  onViewed: (key: string, lastTs: string | null) => void;
  onMutated: () => void;
  /** 発火でランが生まれたときに呼ばれる（そのランのページへ移る。2026-08-08） */
  onRunStarted?: (runId: string) => void;
}

// ラン自体の status は Status に無い値("cancelled")を持つので StatusCircle 用に変換する
const RUN_STATUS_TO_DISPLAY: Record<RunStatus, Status> = {
  running: "running",
  done: "done",
  cancelled: "dropped",
};

// agent は担当アイコンの AI（bot）と揃える。system は担当軸ではないので gear のまま
const AUTHOR_ICON: Record<string, "user" | "bot" | "gear"> = {
  human: "user",
  agent: "bot",
  system: "gear",
};

function truncateTitle(title: string): string {
  const t = title || "（無題）";
  return t.length > 8 ? `${t.slice(0, 8)}…` : t;
}

/** そのランのページ（ノード指定があればそのノードを選択した状態）を開く。
 *  hash を書き換えるだけで、ページ切替・選択・ラン投影は App 側のルート適用が面倒をみる
 *  （Discord のリンクを踏んだときと同じ経路。lib/route.ts） */
function openRunPage(runId: string, nodeId?: string) {
  const hash = buildRoute({ pageId: null, nodeId: nodeId ?? null, runId, chat: false });
  if (window.location.hash === hash) return; // 同じ hash では hashchange が出ない
  window.location.hash = hash;
}

/** parents を辿った層順（トポロジカル順）。同層は created 順 */
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
      {/* 凡例ヒントはセル側（td を包む Hint）が持つので二重に出さない */}
      <StatusCircle status={item.status} size={13} hint={false} />
      {choiceLabel && <span className="text-[10px] text-muted-foreground">{choiceLabel}</span>}
    </span>
  );
}

export function LedgerView({
  page,
  members,
  threadMeta,
  reads,
  onViewed,
  onMutated,
  onRunStarted,
}: Props) {
  const columns = useMemo(() => topoOrder(members), [members]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // トレース再生（1.1秒間隔でイベント行を順にハイライト+スクロール）
  const [replayIndex, setReplayIndex] = useState(-1);
  const [replaying, setReplaying] = useState(false);
  const traceBodyRef = useRef<HTMLDivElement>(null);
  // 右クリックの対象（ラン行 = nodeId:null / セル = その行のラン × その列のノード）。
  // 表はセルが行×列ぶん増えるので、ContextMenu は tbody に1つだけ置き、対象はここへ控える
  // （セルごとに Radix の Root/Trigger を作ると、その数だけツリーとリスナが増える）
  const [menuTarget, setMenuTarget] = useState<{ runId: string; nodeId: string | null } | null>(null);

  const { data: runsData, refresh: refreshRuns } = usePolling(
    () => api.listRuns(page.id),
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

  // 発火先: メンバー中のトリガーノード（created昇順で最初の1件。docs/design.md 3.8）。
  // ルーティーンページ ⇔ トリガーを持つページ なので、台帳が出ている時点で必ず存在する
  const triggerNode = useMemo(
    () =>
      members
        .filter((m) => m.kind === "trigger")
        .sort((a, b) => a.created.localeCompare(b.created))[0] ?? null,
    [members],
  );

  const startRun = useCallback(async () => {
    if (!triggerNode) return;
    setStarting(true);
    try {
      // フォーム（名前 + トリガーの outputs 宣言）・確認文・トーストは lib/fire.ts が持つ
      // ——カードの▶・左レールの「発火」と同じもの。ここは開始後の後始末だけ
      const run = await fireTrigger(triggerNode, { lastRunContext: runs[0]?.context });
      if (!run) return;
      await refreshRuns();
      setSelectedRunId(run.id);
      onMutated();
      onRunStarted?.(run.id); // 生まれたランのページへ移る
    } finally {
      setStarting(false);
    }
  }, [triggerNode, runs, refreshRuns, onMutated, onRunStarted]);

  // ランの打ち切り。上のキャンセルボタン（選択中のラン）と右クリックメニュー（その行のラン）で
  // 同じ経路を通すため、対象は引数で受ける。確認文は左レールのラン子行と同じ
  // （面によって「聞かれる/聞かれない」が変わらないように。ダイアログの「キャンセル」と
  // 紛れないよう実行ラベルは「打ち切る」）
  const cancelRun = useCallback(
    async (runId: string) => {
      const run = runs.find((r) => r.id === runId);
      if (!run) return;
      if (!(await cancelRunWithConfirm(run))) return;
      await refreshRuns();
      onMutated();
    },
    [runs, refreshRuns, onMutated],
  );

  // ラン名の後編集（並列ラン=ランの区別用ラベル）。ダイアログは左レール・グラフ上部と同じ
  const renameRun = useCallback(
    async (run: Run) => {
      if (!(await renameRunDialog(run))) return;
      await refreshRuns();
      onMutated();
    },
    [refreshRuns, onMutated],
  );

  // ワークアイテムの状態更新。セルのクリック（トグル）と、右クリックメニューの
  // 「もう一度」「このランでは飛ばす」が同じ経路を通る
  const patchItem = useCallback(
    async (runId: string, nodeId: string, status: RunItemStatus) => {
      await api.patchRunItem(runId, nodeId, { status });
      await refreshRuns();
      if (runId === selectedRunId) refreshTrace();
      onMutated();
    },
    [refreshRuns, refreshTrace, selectedRunId, onMutated],
  );

  const toggleCell = useCallback(
    async (runId: string, nodeId: string, current: RunItemStatus) => {
      if (current !== "pending" && current !== "done") return;
      await patchItem(runId, nodeId, current === "pending" ? "done" : "pending");
    },
    [patchItem],
  );

  // ---- 右クリックメニュー用（メニューが開いている間しか評価されないので memo しない） ----

  /** ランぶんの既読キー = ページ配下の全ノード × このラン（テンプレート側の会話は含めない） */
  const runReadKeys = (runId: string) =>
    readKeysForPage(page.id, members, threadMeta).filter((k) => k.endsWith(`@${runId}`));

  /** まだ未読が残っているか（「押しても意味が無い」の判定）。既読にした直後は onViewed の
   *  ローカル上書きが reads に載るので、この画面用の別持ちは要らない */
  const stillUnread = (keys: string[]) => hasUnread(keys, threadMeta, reads);

  /** 既読にする。台帳には未読バッジが無いので、効いたことは件数のトーストで返す */
  const markRead = (keys: string[]) => {
    const marked = markKeysRead(keys, threadMeta, onViewed);
    if (marked === 0) return;
    pushToast(`${marked} 件を既読にしました`, "info");
  };

  const targetRun = menuTarget ? (runs.find((r) => r.id === menuTarget.runId) ?? null) : null;
  const targetCol = menuTarget?.nodeId
    ? (columns.find((c) => c.id === menuTarget.nodeId) ?? null)
    : null;
  const targetItem = targetRun && targetCol ? targetRun.items[targetCol.id] : undefined;

  const EXEC_TEXT: Record<string, string> = { human: "text-human", agent: "text-ai", system: "text-script" };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3.5 py-2.5">
        <span className="text-xs text-muted-foreground">{runs.length} 件のラン</span>
        <div className="flex items-center gap-2">
          {selectedRun?.status === "running" && (
            <Hint id="run-cancel" text="選択中のランを打ち切る（アイテムはそれ以上進まなくなる）">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-destructive/40 text-destructive"
                onClick={() => {
                  if (selectedRunId) void cancelRun(selectedRunId);
                }}
              >
                キャンセル
              </Button>
            </Hint>
          )}
          <Hint
            id="fire"
            always={triggerNode ? `トリガー「${triggerNode.title || "（無題）"}」を開始` : undefined}
            text={HINT_TEXT.fire}
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-ai/40 text-ai"
              disabled={starting || !triggerNode}
              // disabled 理由だけは native title（disabled にはポインタイベントが来ない）
              title={triggerNode ? undefined : "トリガーがありません"}
              onClick={startRun}
            >
              {/* 絵はノードの発火ボタン・ラン状態と同じ Play で揃える（2026-08-08） */}
              <Play className="size-3" />
              発火
            </Button>
          </Hint>
        </div>
      </div>

      {/* 右クリック＝メニュー（既存操作への近道）。未読の元データは App の /state
          ポーリング（3秒）が props で降りてくるので、ここでの取り直しは要らない */}
      <ContextMenu>
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
            {/* 右クリックは tbody（=行とセルの全域）でまとめて受ける。どのラン・どのセルを
                指したかは各 td の onContextMenu が控える（capture でいったん空にしてから
                拾い直すので、前回の対象が残らない） */}
            <ContextMenuTrigger asChild>
              <tbody onContextMenuCapture={() => setMenuTarget(null)}>
                {runs.length === 0 && (
                  <tr>
                    <td
                      className="p-4 text-center text-text-lo"
                      colSpan={columns.length + 1}
                      // ランが無い＝近道にできる操作も無いので、メニューは出さない
                      onContextMenu={(e) => e.stopPropagation()}
                    >
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
                        // sticky セルは不透明背景が必要なのでテーマ色 popover を使う
                        // （旧: ダーク直書き #131a22。ライトモードで黒い行が浮いていた）
                        run.id === selectedRunId && "bg-popover",
                      )}
                      onContextMenu={() => setMenuTarget({ runId: run.id, nodeId: null })}
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
                        // waiting の理由（失敗: … / 承認待ち / 分岐待ち）は always でセルに残す
                        <Hint
                          key={col.id}
                          id="ledger-cell"
                          always={item?.note}
                          text={
                            toggleDisabled
                              ? "分岐のセルはクリックでは切り替わらない（「分岐を選ぶ」でのみ決着）"
                              : "セルのクリックで完了⇄待ちを切り替えられる（—=対象外/スキップ）"
                          }
                        >
                          <td
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
                            onContextMenu={() => setMenuTarget({ runId: run.id, nodeId: col.id })}
                          >
                            {renderCell(item, col)}
                          </td>
                        </Hint>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </ContextMenuTrigger>
          </table>
        </div>

        {/* メニューは既存の操作を並べ替えて短く見せるだけ（新しい操作は作らない）。
            該当しない項目は disabled にせず出さない（「既読にする」だけは
            「押しても意味が無い」ので disabled で残す） */}
        <ContextMenuContent className="w-56">
          {targetRun && !targetCol && (
            <>
              <ContextMenuItem onSelect={() => openRunPage(targetRun.id)}>開く</ContextMenuItem>
              <ContextMenuItem onSelect={() => void renameRun(targetRun)}>名前を変更</ContextMenuItem>
              <ContextMenuItem
                disabled={!stillUnread(runReadKeys(targetRun.id))}
                onSelect={() => markRead(runReadKeys(targetRun.id))}
              >
                既読にする
              </ContextMenuItem>
              {targetRun.status === "running" && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onSelect={() => void cancelRun(targetRun.id)}>
                    キャンセル
                  </ContextMenuItem>
                </>
              )}
            </>
          )}
          {targetRun && targetCol && (
            <>
              <ContextMenuItem onSelect={() => openRunPage(targetRun.id, targetCol.id)}>
                このノードを開く
              </ContextMenuItem>
              {/* AI/スクリプトの実行失敗（note が「失敗」始まり）は放置すると行き止まりになる。
                  ノードのパネルにしか無かった導線を、台帳の丸からも届くようにする */}
              {targetItem && targetItem.status === "waiting" && targetItem.note?.startsWith("失敗") && (
                <>
                  <ContextMenuItem onSelect={() => void patchItem(targetRun.id, targetCol.id, "pending")}>
                    もう一度
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => void patchItem(targetRun.id, targetCol.id, "skipped")}>
                    このランでは飛ばす
                  </ContextMenuItem>
                </>
              )}
              {/* 分岐(decision)と —（未生成/スキップ）は切り替えの対象外なので出さない */}
              {targetItem &&
                targetCol.kind !== "decision" &&
                (targetItem.status === "pending" || targetItem.status === "done") && (
                  <ContextMenuItem
                    onSelect={() => void toggleCell(targetRun.id, targetCol.id, targetItem.status)}
                  >
                    {targetItem.status === "pending" ? "完了にする" : "待ちに戻す"}
                  </ContextMenuItem>
                )}
              <ContextMenuItem
                disabled={!stillUnread([threadKey(targetCol.id, targetRun.id)])}
                onSelect={() => markRead([threadKey(targetCol.id, targetRun.id)])}
              >
                既読にする
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {selectedRun && (
        <div className="flex max-h-[34%] flex-shrink-0 flex-col border-t border-border bg-muted">
          <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3.5 py-2 text-xs font-semibold text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate">トレース: {selectedRun.title}</span>
              <Hint id="run-rename" always="ラン名を変更">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-muted-foreground"
                  onClick={() => void renameRun(selectedRun)}
                >
                  {/* アイコンは左レールのフォルダ・ページの「名前を変更」と同じ（2026-08-09 本人指示） */}
                  <Pencil className="size-3" />
                </Button>
              </Hint>
            </span>
            <Hint id="ledger-replay" text="このランの記録（トレース）を1.1秒間隔で順に再生する">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-ai/40 text-ai"
                disabled={events.length === 0}
                onClick={toggleReplay}
              >
                {replaying ? "⏸" : "▶再生"}
              </Button>
            </Hint>
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
