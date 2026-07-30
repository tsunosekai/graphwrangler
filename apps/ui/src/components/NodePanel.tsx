import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  GitBranch,
  History,
  Lock,
  MessageSquare,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { api, type NodePatchInput } from "../lib/api";
import { usePolling } from "../hooks/usePolling";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { pushToast } from "../lib/toast";
import type { Node, NodeBranch } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Thread } from "./Thread";

interface Props {
  node: Node;
  onMutated: () => void;
  onClose: () => void;
  /** ノード複製後に新規ノードを選択するため（QOL-8）。ページ切替も面倒を見る App.selectNode を渡す */
  onSelect: (id: string) => void;
  /** グラフ上での複数選択件数（QOL）。2以上の時だけ「他N件選択中」を出す */
  selectedCount?: number;
}

const KIND_OPTIONS: Node["kind"][] = ["goal", "task", "procedure", "decision"];
const EXECUTOR_OPTIONS: Node["executor"][] = ["human", "ai", "script"];
const IMPACT_OPTIONS: Node["impact"][] = ["safe", "reversible", "irreversible"];
const LIFECYCLE_OPTIONS: Node["lifecycle"][] = ["draft", "committed"];
// 人間が選ぶ意味のある状態だけに絞る（running/waiting/skipped は機械が付ける内部状態。
// 現在値がそれらの場合のみ読み取り専用の選択肢として表示する）
const STATUS_OPTIONS: Node["status"][] = ["unplanned", "pending", "done", "dropped"];
const STATUS_JA: Record<Node["status"], string> = {
  unplanned: "未計画",
  pending: "進行",
  running: "実行中（内部）",
  waiting: "回答待ち（内部）",
  done: "完了",
  dropped: "中止",
  skipped: "スキップ（内部）",
};

/** decision の枝の新規id採番: b1, b2, ... の空いている最初の番号（既存idは変更しない。docs/design.md 3.9） */
function nextBranchId(existing: NodeBranch[]): string {
  let i = 1;
  while (existing.some((b) => b.id === `b${i}`)) i++;
  return `b${i}`;
}

/** 分岐エディタの1行。ラベルを入力→blurで確定（title/detailと同じ「編集中は自分のdraftを見る」流儀） */
function BranchRow({
  branch,
  disableRemove,
  onCommit,
  onRemove,
}: {
  branch: NodeBranch;
  disableRemove: boolean;
  onCommit: (label: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(branch.label);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(branch.label);
  }, [branch.label, focused]);

  return (
    <div className="flex items-center gap-1.5">
      <Input
        className="h-8 flex-1"
        value={draft}
        onFocus={() => setFocused(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false);
          const t = draft.trim();
          if (t && t !== branch.label) onCommit(t);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disableRemove}
        title={disableRemove ? "分岐は最低2つ必要です" : "この枝を削除"}
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

// key={node.id} で App から渡されるため、node が切り替わるたびにこのコンポーネントは
// まっさらな状態で再マウントされる（未読ドラフト・タブ・スレッドポーリングが混線しない）。
export function NodePanel({ node, onMutated, onClose, onSelect, selectedCount }: Props) {
  const [tab, setTab] = useState<"talk" | "history">("talk");
  // 会話に縦幅を使うため、メタ情報（detail/種別/担当…）は既定で折りたたむ
  const [metaOpen, setMetaOpen] = useState(false);
  const [width, startResize] = useResizableWidth("panelW", 380, 300, 640);
  const { data: thread, refresh: refreshThread } = usePolling(() => api.getThread(node.id), 10000);

  // QOL-7: スレッドを表示したら既読ts(localStorage)を更新する（thread取得のたびに更新=
  // 開いたまま新着が来ても「読んだ」扱いを追随させる）
  useEffect(() => {
    if (!thread) return;
    try {
      localStorage.setItem(`gw.read.${node.id}`, new Date().toISOString());
    } catch {
      // 容量超過等は無視（未読バッジは補助機能）
    }
  }, [thread, node.id]);

  const [titleDraft, setTitleDraft] = useState(node.title);
  const [titleFocused, setTitleFocused] = useState(false);
  useEffect(() => {
    if (!titleFocused) setTitleDraft(node.title);
  }, [node.title, titleFocused]);

  const [detailDraft, setDetailDraft] = useState(node.detail ?? "");
  const [detailFocused, setDetailFocused] = useState(false);
  useEffect(() => {
    if (!detailFocused) setDetailDraft(node.detail ?? "");
  }, [node.detail, detailFocused]);

  // kind=procedure 専用: 定期トリガーの記述（v1では自由文字列。解釈はしない）
  const [scheduleDraft, setScheduleDraft] = useState(node.schedule ?? "");
  const [scheduleFocused, setScheduleFocused] = useState(false);
  useEffect(() => {
    if (!scheduleFocused) setScheduleDraft(node.schedule ?? "");
  }, [node.schedule, scheduleFocused]);

  const patch = async (fields: NodePatchInput) => {
    await api.patchNode(node.id, fields);
    onMutated();
  };

  const saveTitle = async () => {
    setTitleFocused(false);
    const t = titleDraft.trim();
    if (t && t !== node.title) await patch({ title: t });
  };

  const saveDetail = async () => {
    setDetailFocused(false);
    if (detailDraft !== (node.detail ?? "")) await patch({ detail: detailDraft || null });
  };

  const saveSchedule = async () => {
    setScheduleFocused(false);
    if (scheduleDraft !== (node.schedule ?? "")) await patch({ schedule: scheduleDraft || null });
  };

  // QOL-8: ノード複製。作成後は新規ノードを選択する。
  // parents は複製元と同じ集合のままなので parentOptions（decision分岐の対応）もそのまま引き継げる。
  // kind=decision は branches が無いとサーバ検証で弾かれるためこちらも引き継ぐ（choiceは新規なので引き継がない）
  const handleDuplicate = async () => {
    try {
      const created = await api.addNode({
        title: node.title ? `${node.title}のコピー` : "のコピー",
        detail: node.detail,
        impl: node.impl,
        parents: node.parents,
        parentOptions: node.parentOptions,
        group: node.group,
        kind: node.kind,
        branches: node.branches,
        executor: node.executor,
        impact: node.impact,
        status: "pending",
        lifecycle: "draft",
      });
      onMutated();
      onSelect(created.id);
    } catch {
      // api() 側でトースト表示済み
    }
  };

  // decision の choice 未確定のときだけ「分岐を選ぶ」を出す（docs/design.md 3.9）
  const decide = async (branchId: string, label: string) => {
    try {
      await api.decide(node.id, branchId);
      onMutated();
      pushToast(`${label} に分岐しました`, "info");
    } catch {
      // api() 側でトースト表示済み
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`「${node.title || "（無題）"}」を削除しますか？`)) return;
    try {
      await api.removeNode(node.id);
      onMutated();
      onClose();
    } catch {
      // 子ノードが残っている等のエラーは api() 側でトースト表示済み
    }
  };

  const messages = thread?.messages ?? [];
  const filtered = messages.filter((m) =>
    tab === "talk"
      ? m.kind === "say" || m.kind === "decision_request" || m.kind === "decision_answer"
      : m.kind === "status" || m.kind === "artifact",
  );

  return (
    <aside
      className="relative flex flex-shrink-0 flex-col gap-3 overflow-hidden border-l bg-background p-4"
      style={{ width }}
    >
      <div className="resize-handle resize-handle-left" onPointerDown={(e) => startResize(e, -1)} />
      <div className="flex items-center gap-2">
        <Input
          className="flex-1 border-transparent bg-transparent text-lg font-semibold hover:border-input focus-visible:border-input"
          value={titleDraft}
          onFocus={() => setTitleFocused(true)}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              // Fix済み=濃く（緑の錠前）、未Fix=薄く（開いた錠前）
              className={node.fixed ? "text-ok" : "text-text-lo opacity-60"}
              onClick={() => patch({ fixed: !node.fixed })}
            >
              {node.fixed ? <Lock /> : <Unlock />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {node.fixed
              ? "Fix済み: やり方が確定。AIは実装を書き換えない"
              : "未Fix（改善中）: AIが実装を書き換えてよい。クリックで Fix する"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" onClick={handleDuplicate}>
              <Copy />
            </Button>
          </TooltipTrigger>
          <TooltipContent>このノードを複製</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" onClick={handleDelete}>
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>このノードを削除</TooltipContent>
        </Tooltip>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="閉じる">
          <X />
        </Button>
      </div>

      {/* 複数選択中(QOL): このノードは代表表示のみで、実際は他にも選択がある旨を示す */}
      {selectedCount != null && selectedCount > 1 && (
        <span className="-mt-2 text-xs text-muted-foreground">他 {selectedCount - 1} 件選択中</span>
      )}

      {/* decision ノード: choice 未確定なら分岐を選ぶボタン列、確定済みなら選択結果（docs/design.md 3.9）。
          human分岐はエンジンが開く判断リクエスト(Threadタブ)でも回答できるが、ここから直接 /decide も正 */}
      {node.kind === "decision" &&
        node.branches &&
        (node.status === "done" || node.status === "skipped" ? (
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
            <GitBranch className="size-3.5 flex-shrink-0" />
            選択済み: {node.branches.find((b) => b.id === node.choice)?.label ?? node.choice ?? "-"}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-border-strong bg-card p-2.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GitBranch className="size-3.5" /> 分岐を選ぶ
            </span>
            {node.branches.map((b) => (
              <Button
                key={b.id}
                type="button"
                variant="outline"
                size="sm"
                className="justify-start"
                title={b.then}
                onClick={() => decide(b.id, b.label)}
              >
                {b.label}
              </Button>
            ))}
          </div>
        ))}

      {!metaOpen && (
        <button
          type="button"
          className="flex flex-col items-stretch gap-1.5 rounded-md text-left text-muted-foreground hover:bg-accent/40"
          onClick={() => setMetaOpen(true)}
        >
          <span className="flex flex-wrap items-center gap-1">
            {[node.kind, node.executor, node.impact, node.lifecycle, node.status].map((v) => (
              <Badge key={v} variant="outline" className="font-mono">
                {v}
              </Badge>
            ))}
          </span>
          {node.detail && <span className="truncate text-sm text-muted-foreground">{node.detail}</span>}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      )}

      {metaOpen && (
        <>
          <button
            type="button"
            className="flex items-center gap-1 text-left text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setMetaOpen(false)}
          >
            <ChevronUp className="size-3.5" /> たたむ
          </button>
          <Textarea
            placeholder="detail / 補足"
            value={detailDraft}
            onFocus={() => setDetailFocused(true)}
            onChange={(e) => setDetailDraft(e.target.value)}
            onBlur={saveDetail}
            rows={3}
          />

          {node.kind === "procedure" && (
            <Input
              placeholder="例: daily 09:00（v1は記録のみ）"
              value={scheduleDraft}
              onFocus={() => setScheduleFocused(true)}
              onChange={(e) => setScheduleDraft(e.target.value)}
              onBlur={saveSchedule}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          )}

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              種別
              <Select
                value={node.kind}
                onValueChange={(v) => {
                  const kind = v as Node["kind"];
                  // decision に切り替えた時、branches が未設定なら既定2枝を立てる（docs/design.md 3.9）
                  if (kind === "decision" && !node.branches) {
                    patch({
                      kind,
                      branches: [
                        { id: "a", label: "A" },
                        { id: "b", label: "B" },
                      ],
                    });
                  } else {
                    patch({ kind });
                  }
                }}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KIND_OPTIONS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              担当
              <Select value={node.executor} onValueChange={(v) => patch({ executor: v as Node["executor"] })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EXECUTOR_OPTIONS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              影響
              <Select value={node.impact} onValueChange={(v) => patch({ impact: v as Node["impact"] })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {IMPACT_OPTIONS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              確定
              <Select value={node.lifecycle} onValueChange={(v) => patch({ lifecycle: v as Node["lifecycle"] })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LIFECYCLE_OPTIONS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              進捗
              <Select value={node.status} onValueChange={(v) => patch({ status: v as Node["status"] })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {/* 現在値が内部状態(running/waiting/skipped)の時だけ、読み取り用にその項目も出す */}
                  {(STATUS_OPTIONS.includes(node.status)
                    ? STATUS_OPTIONS
                    : [node.status, ...STATUS_OPTIONS]
                  ).map((k) => (
                    <SelectItem key={k} value={k} disabled={!STATUS_OPTIONS.includes(k)}>
                      {STATUS_JA[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          {/* decision の枝エディタ: ラベル編集+削除（最低2枝）+追加。id は既存のものを変更しない
              （エッジが parentOptions[decisionId]=branchId で紐づいているため。docs/design.md 3.9） */}
          {node.kind === "decision" && (
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <GitBranch className="size-3.5" /> 分岐の枝
              </span>
              {(node.branches ?? []).map((b) => (
                <BranchRow
                  key={b.id}
                  branch={b}
                  disableRemove={(node.branches?.length ?? 0) <= 2}
                  onCommit={(label) =>
                    patch({
                      branches: (node.branches ?? []).map((x) => (x.id === b.id ? { ...x, label } : x)),
                    })
                  }
                  onRemove={() => patch({ branches: (node.branches ?? []).filter((x) => x.id !== b.id) })}
                />
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  patch({
                    branches: [
                      ...(node.branches ?? []),
                      { id: nextBranchId(node.branches ?? []), label: "新しい枝" },
                    ],
                  })
                }
              >
                + 枝を追加
              </Button>
            </div>
          )}
        </>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as "talk" | "history")} className="gap-3">
        <TabsList>
          <TabsTrigger value="talk">
            <MessageSquare className="size-3.5" /> 会話
          </TabsTrigger>
          <TabsTrigger value="history">
            <History className="size-3.5" /> 履歴
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Thread
        nodeId={node.id}
        messages={filtered}
        showReplyBox={tab === "talk"}
        onMutated={() => {
          onMutated();
          refreshThread();
        }}
      />
    </aside>
  );
}
