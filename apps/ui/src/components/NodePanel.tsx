import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Copy, History, Lock, MessageSquare, Trash2, Unlock, X } from "lucide-react";
import { api, type NodePatchInput } from "../lib/api";
import { usePolling } from "../hooks/usePolling";
import { useResizableWidth } from "../hooks/useResizableWidth";
import type { Node } from "../types";
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

const KIND_OPTIONS: Node["kind"][] = ["goal", "task", "procedure"];
const EXECUTOR_OPTIONS: Node["executor"][] = ["human", "ai", "script"];
const IMPACT_OPTIONS: Node["impact"][] = ["safe", "reversible", "irreversible"];
const LIFECYCLE_OPTIONS: Node["lifecycle"][] = ["draft", "committed"];
const STATUS_OPTIONS: Node["status"][] = [
  "unplanned",
  "pending",
  "running",
  "waiting",
  "done",
  "dropped",
];

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

  // QOL-8: ノード複製。作成後は新規ノードを選択する
  const handleDuplicate = async () => {
    try {
      const created = await api.addNode({
        title: node.title ? `${node.title}のコピー` : "のコピー",
        detail: node.detail,
        impl: node.impl,
        parents: node.parents,
        group: node.group,
        kind: node.kind,
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
              <Select value={node.kind} onValueChange={(v) => patch({ kind: v as Node["kind"] })}>
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
                  {STATUS_OPTIONS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
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
