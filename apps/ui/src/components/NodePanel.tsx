import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
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
import { Switch } from "./ui/switch";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { DecisionCard } from "./DecisionCard";
import { Icon } from "./Icon";
import { StatusCircle } from "./StatusCircle";
import { Thread } from "./Thread";

interface Props {
  node: Node;
  /** 実行フェーズゲート（docs/design.md 3.9）の判定に使う全ノード。分岐の親の status を見る */
  allNodes: Node[];
  onMutated: () => void;
  onClose: () => void;
  /** ノード複製後に新規ノードを選択するため（QOL-8）。ページ切替も面倒を見る App.selectNode を渡す */
  onSelect: (id: string) => void;
  /** グラフ上での複数選択件数（QOL）。2以上の時だけ「他N件選択中」を出す */
  selectedCount?: number;
}

// 種別はノードの3種のみ（ゴールはページなので選択肢に出さない。現在値がゴール等の時だけ表示）
const KIND_OPTIONS: Node["kind"][] = ["task", "decision", "trigger"];
const KIND_JA: Record<Node["kind"], string> = {
  task: "実行",
  decision: "判断",
  trigger: "トリガー",
  goal: "ゴール（ページ）",
  procedure: "ルーティーン（旧）",
};
const EXECUTOR_OPTIONS: Node["executor"][] = ["human", "ai", "script"];
const EXECUTOR_JA: Record<Node["executor"], string> = { human: "人間", ai: "AI", script: "スクリプト" };
// 進捗はドロップダウンでなくボタン遷移（2026-07-31 本人指定）。
// 人間の語彙: 未計画 →[プラン済みにする]→ 待ち →[着手]→ 進行中 →[完了]。
// 待ち/進行中は人間ノードでは「やってるかどうかの目印」、AI/スクリプトでは機械が動かす。
// 中止(dropped)は選択肢から廃止（消すならノード削除。Ctrl+Zで戻せる）
const STATUS_JA: Record<Node["status"], string> = {
  unplanned: "未計画",
  pending: "待ち",
  running: "進行中",
  waiting: "あなたの番（回答待ち）",
  done: "完了",
  dropped: "中止",
  skipped: "スキップ",
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
export function NodePanel({ node, allNodes, onMutated, onClose, onSelect, selectedCount }: Props) {
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

  // 実行フェーズの原則（docs/design.md 3.9）: 分岐を選ぶのは lifecycle=committed かつ
  // 全 parents が done|skipped（frontier）のノードでのみ許可する。まだ順番が来ていない
  // ノードで実行系操作ができてしまわないための UI 側ガード（サーバ側は GraphStore.validateDecisionGate
  // が同じ規則で 409 を返す。ここでは事前にボタンを無効化して分かりやすくするだけ）
  const isFrontier = node.parents.every((pid) => {
    const s = allNodes.find((n) => n.id === pid)?.status;
    return s === "done" || s === "skipped";
  });
  const decisionGateOk = node.lifecycle === "committed" && isFrontier;

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
  // 開いている判断リクエストは会話の流れではなく「ノード詳細とチャット欄の間」に固定表示する
  // （本人指定 2026-07-31）。タブに関わらず見える（履歴タブでも回答できる）
  const openRequests = messages.filter(
    (m) => m.kind === "decision_request" && m.requestStatus === "open",
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
            <Icon name="branch" size={13} />
            選択済み: {node.branches.find((b) => b.id === node.choice)?.label ?? node.choice ?? "-"}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-border-strong bg-card p-2.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon name="branch" size={13} /> 分岐を選ぶ
            </span>
            {node.branches.map((b) => (
              <Button
                key={b.id}
                type="button"
                variant="outline"
                size="sm"
                className="justify-start"
                title={b.then}
                disabled={!decisionGateOk}
                onClick={() => decide(b.id, b.label)}
              >
                {b.label}
              </Button>
            ))}
            {!decisionGateOk && (
              <span className="text-xs text-muted-foreground">
                {node.lifecycle !== "committed" ? "下書きです。先に確定してください" : "前のノードが終わると選べます"}
              </span>
            )}
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

          {/* トリガーの起動方式（docs/design.md 3.8）。human は手動発火(▶)のみなので欄自体を出さない。
              script=cron的な発火条件、ai=発火要否を判定させる間隔 */}
          {node.kind === "trigger" &&
            (node.executor === "human" ? (
              <p className="text-xs text-muted-foreground">手動発火のみ（カードの ▶ から発火）</p>
            ) : (
              <Input
                placeholder={
                  node.executor === "ai"
                    ? "チェック間隔: every 1h（条件は detail や手順書に書く）"
                    : "every 15m / daily 09:00 / weekly mon 09:00"
                }
                value={scheduleDraft}
                onFocus={() => setScheduleFocused(true)}
                onChange={(e) => setScheduleDraft(e.target.value)}
                onBlur={saveSchedule}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
            ))}

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
                  {(KIND_OPTIONS.includes(node.kind) ? KIND_OPTIONS : [node.kind, ...KIND_OPTIONS]).map(
                    (k) => (
                      <SelectItem key={k} value={k} disabled={!KIND_OPTIONS.includes(k)}>
                        {KIND_JA[k]}
                      </SelectItem>
                    ),
                  )}
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
                      {EXECUTOR_JA[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="col-span-2 flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <span className="flex flex-col">
                <span>不可逆</span>
                <span className="text-xs text-muted-foreground">
                  実行前に人間の承認ゲートを通る（外部公開・送信・削除など取り返しのつかない操作）
                </span>
              </span>
              <Switch
                checked={node.impact === "irreversible"}
                onCheckedChange={(v) => patch({ impact: v ? "irreversible" : "safe" })}
              />
            </label>
            {/* トリガーに進捗はない（docs/design.md 3.8。発火はあってもステータス遷移という概念が無い）。
                質問が開いている（pendingRequest あり）間は status が何であれ「あなたの番」を優先して
                描き、進捗ボタンも出さない（NodeCard の visualStatus / PageList の effStatus と同じ保険。
                回答は上の判断カードから行う） */}
            {node.kind !== "trigger" &&
              (() => {
                const vs = node.pendingRequest ? ("waiting" as const) : node.status;
                return (
                  <div className="col-span-2 flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">進捗:</span>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusCircle status={vs} />
                      {STATUS_JA[vs]}
                    </span>
                    <span className="flex-1" />
                    {vs === "unplanned" && (
                      <Button type="button" variant="outline" size="sm"
                        onClick={() => patch({ status: "pending", lifecycle: "committed" })}>
                        プラン済みにする
                      </Button>
                    )}
                    {vs === "pending" && (
                      <Button type="button" variant="outline" size="sm" onClick={() => patch({ status: "running" })}>
                        着手
                      </Button>
                    )}
                    {(vs === "pending" || vs === "running") && (
                      <Button type="button" variant="outline" size="sm" onClick={() => patch({ status: "done" })}>
                        完了
                      </Button>
                    )}
                    {vs === "done" && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => patch({ status: "pending" })}>
                        戻す
                      </Button>
                    )}
                  </div>
                );
              })()}
          </div>

          {/* decision の枝エディタ: ラベル編集+削除（最低2枝）+追加。id は既存のものを変更しない
              （エッジが parentOptions[decisionId]=branchId で紐づいているため。docs/design.md 3.9） */}
          {node.kind === "decision" && (
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Icon name="branch" size={13} /> 分岐の枝
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

      {openRequests.map((m) => (
        <DecisionCard
          key={m.id}
          message={m}
          nodeId={node.id}
          onMutated={() => {
            onMutated();
            refreshThread();
          }}
        />
      ))}

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
