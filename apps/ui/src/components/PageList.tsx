// 左レールのページ一覧。ゴール/ルーティーン（フォルダ）1つ = 1ページ（desk の左レール方式）。
// タイトル下にメンバーの状態内訳ドット（desk の ball 内訳ドットの継承）。
// ルーティーンページ（kind=procedure）は StatusCircle の代わりに repeat アイコンを出し、
// ドットはメンバーの status ではなく「最新ランのワークアイテム状態内訳」にする
// （テンプレート自身は status を持たない思想。docs/design.md 3.8）。
// 最新ランの取得は App 側でまとめてポーリングする（B-6: 受信箱のラン待ち統合と共有し、
// procedure 数ぶんの N+1 取得を1箇所に集約するため。旧: このコンポーネント内で自前ポーリングしていた）。
import { useState } from "react";
import { api } from "../lib/api";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { cn } from "../lib/utils";
import type { Node, Run, RunItemStatus, Status } from "../types";
import { Button } from "./ui/button";
import { Icon } from "./Icon";
import { StatusCircle } from "./StatusCircle";

interface Props {
  folders: Node[];
  allNodes: Node[];
  pageId: string | null;
  /** procedure id → 最新ラン（App 側でポーリング済み） */
  latestRuns: Record<string, Run | null>;
  onSelectPage: (id: string) => void;
  onMutated: () => void;
}

const DOT_COLOR: Record<Status, string> = {
  unplanned: "var(--text-lo)",
  pending: "var(--text-lo)",
  running: "var(--ai)",
  waiting: "var(--human)",
  done: "var(--done)", // 終わったちょぼは暗く（一覧では未処理が目立つべき）
  dropped: "var(--dropped)",
  skipped: "var(--text-lo)",
};

// ワークアイテムの status（RunItemStatus は Status と同形）
const RUN_DOT_COLOR: Record<RunItemStatus, string> = {
  ...DOT_COLOR,
};

// 目に入るべき順: あなたの番 → 実行中 → 待機系 → 完了 → 中止
const DOT_ORDER: Status[] = ["waiting", "running", "pending", "unplanned", "done", "dropped", "skipped"];
const RUN_DOT_ORDER: RunItemStatus[] = ["waiting", "running", "pending", "done", "dropped", "skipped"];
const MAX_DOTS = 16;

export function PageList({ folders, allNodes, pageId, latestRuns, onSelectPage, onMutated }: Props) {
  const [width, startResize] = useResizableWidth("railW", 224, 160, 400);
  // QOL-3: アーカイブ節（done/dropped なゴール）は既定で閉じておく
  const [archiveOpen, setArchiveOpen] = useState(false);

  const addGoal = async () => {
    const created = await api.addNode({ title: "新しいゴール", kind: "goal" });
    onMutated();
    onSelectPage(created.id);
  };

  // procedure は対象外。goal 等の status が done|dropped のものだけアーカイブへ回す
  const activeFolders = folders.filter(
    (f) => f.kind === "procedure" || (f.status !== "done" && f.status !== "dropped"),
  );
  const archivedFolders = folders.filter(
    (f) => f.kind !== "procedure" && (f.status === "done" || f.status === "dropped"),
  );

  const renderRow = (f: Node, archived: boolean) => {
    const isProcedure = f.kind === "procedure";
    const latestRun = latestRuns?.[f.id] ?? null;

    const memberDots = !isProcedure
      ? allNodes
          .filter((n) => n.group === f.id)
          .sort((a, b) => DOT_ORDER.indexOf(a.status) - DOT_ORDER.indexOf(b.status))
          .map((m) => ({ key: m.id, title: `${m.title || "（無題）"} — ${m.status}`, color: DOT_COLOR[m.status] }))
      : [];

    const runDots =
      isProcedure && latestRun
        ? Object.entries(latestRun.items)
            .sort(([, a], [, b]) => RUN_DOT_ORDER.indexOf(a.status) - RUN_DOT_ORDER.indexOf(b.status))
            .map(([nodeId, item]) => ({
              key: nodeId,
              title: `${item.status}`,
              color: RUN_DOT_COLOR[item.status],
            }))
        : [];

    const dots = isProcedure ? runDots : memberDots;
    const shown = dots.slice(0, MAX_DOTS);
    const rest = dots.length - shown.length;

    return (
      <button
        key={f.id}
        type="button"
        className={cn(
          "flex w-full flex-col items-stretch gap-0.5 rounded-sm px-2 py-1.5 text-left text-muted-foreground hover:bg-accent/60",
          pageId === f.id && "bg-accent text-foreground",
          archived && "opacity-70",
        )}
        onClick={() => onSelectPage(f.id)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {isProcedure ? (
            <span className="inline-flex size-3 flex-shrink-0 text-muted-foreground" title="ルーティーンページ">
              <Icon name="repeat" size={12} />
            </span>
          ) : (
            <StatusCircle status={f.status} size={12} />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">{f.title || "（無題）"}</span>
        </span>
        {dots.length > 0 && (
          <span className="flex flex-wrap items-center gap-[3px] pl-5">
            {shown.map((d) => (
              <i
                key={d.key}
                className="size-[5px] flex-shrink-0 rounded-full"
                title={d.title}
                style={{ background: d.color }}
              />
            ))}
            {rest > 0 && <span className="font-mono text-xs text-text-lo">+{rest}</span>}
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      className="relative flex flex-shrink-0 flex-col gap-px overflow-y-auto border-r border-border bg-muted p-1.5"
      style={{ width }}
    >
      <div className="resize-handle resize-handle-right" onPointerDown={(e) => startResize(e, 1)} />
      <div className="flex items-center justify-between px-2 pb-2 pt-1 text-xs font-semibold tracking-wide text-text-lo">
        <span>ゴール</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          title="ゴールを追加"
          onClick={addGoal}
        >
          ＋
        </Button>
      </div>
      {activeFolders.map((f) => renderRow(f, false))}
      {archivedFolders.length > 0 && (
        <>
          <button
            type="button"
            className="mt-1 flex items-center gap-1.5 border-t border-border px-2 py-1.5 text-left text-xs text-text-lo hover:bg-accent/40 hover:text-muted-foreground"
            onClick={() => setArchiveOpen((v) => !v)}
          >
            <span>{archiveOpen ? "▾" : "▸"}</span>
            <span>アーカイブ {archivedFolders.length}</span>
          </button>
          {archiveOpen && (
            <div className="flex flex-col gap-px">{archivedFolders.map((f) => renderRow(f, true))}</div>
          )}
        </>
      )}
    </div>
  );
}
