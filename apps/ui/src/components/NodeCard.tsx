import { useEffect, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { cn } from "../lib/utils";
import type { Node } from "../types";
import { Icon } from "./Icon";

const EXEC_ICON: Record<Node["executor"], "user" | "cpu" | "gear"> = {
  human: "user",
  ai: "cpu",
  script: "gear",
};
const STATUS_LABEL: Record<Node["status"], string> = {
  unplanned: "未計画",
  pending: "待機",
  running: "実行中",
  waiting: "回答待ち",
  done: "完了",
  dropped: "中止",
};

const EXEC_TEXT: Record<Node["executor"], string> = {
  human: "text-human",
  ai: "text-ai",
  script: "text-script",
};

export interface NodeCardData {
  node: Node;
  selected: boolean;
  editing: boolean;
  /** 手順ページ（テンプレートの編集）で描かれているカードか。テンプレートは status を
   *  持たない思想（docs/design.md 3.8）なので、status 由来の見た目は出さない */
  isTemplate?: boolean;
  /** QOL-7: 既読ts(localStorage gw.read.<id>)より新しいメッセージがあるか */
  unread?: boolean;
  onSelect: (id: string) => void;
  onDoubleClick: (id: string) => void;
  onCommitTitle: (id: string, title: string) => void;
  onCancelEdit: () => void;
  [key: string]: unknown;
}

export function NodeCard({ data }: { data: NodeCardData }) {
  const { node, isTemplate } = data;
  const [draft, setDraft] = useState(node.title);

  useEffect(() => {
    if (data.editing) setDraft(node.title);
  }, [data.editing, node.title]);

  const showFoot = !isTemplate && node.status !== "done" && node.status !== "dropped";

  return (
    <div
      className={cn(
        // marker クラス（exec-*/status-*/lifecycle-*）は index.css のパルスアニメーション・
        // 下書きの粗い破線背景に使う。見た目の大半は Tailwind ユーティリティで組む
        "node-card relative w-[220px] rounded-md border border-border bg-card p-3 shadow-xs transition-colors hover:border-border-hover",
        `exec-${node.executor}`,
        `lifecycle-${node.lifecycle}`,
        !isTemplate && `status-${node.status}`,
        !isTemplate && (node.status === "done" || node.status === "dropped") && "opacity-90",
        data.selected && "is-selected border-border-strong shadow-[0_0_0_1px_var(--border-strong)]",
      )}
      onClick={() => data.onSelect(node.id)}
      onDoubleClick={() => data.onDoubleClick(node.id)}
    >
      <Handle type="target" position={Position.Top} />
      {/* PDG風の完了/中止マーク（カード左外側の丸バッジ）。テンプレートには出さない */}
      {!isTemplate && node.status === "done" && (
        <span className="pdg-badge text-ok" title="完了">
          <Icon name="check" size={14} />
        </span>
      )}
      {!isTemplate && node.status === "dropped" && (
        <span className="pdg-badge text-text-lo" title="中止">
          <Icon name="x" size={13} />
        </span>
      )}
      {node.pendingRequest && (
        <span
          className="absolute -right-1 -top-1 size-2 flex-shrink-0 rounded-full bg-[#ff9f43]"
          title="あなたの番"
        />
      )}
      {data.unread && (
        <span className="absolute -left-1 -top-1 size-2 flex-shrink-0 rounded-full bg-ai" title="未読メッセージあり" />
      )}
      <div
        className={cn(
          "flex items-center gap-1.5",
          !isTemplate && (node.status === "done" || node.status === "dropped") && "opacity-55",
        )}
      >
        <span className={cn("inline-flex flex-shrink-0", EXEC_TEXT[node.executor])}>
          <Icon name={EXEC_ICON[node.executor]} />
        </span>
        {node.impl && (
          <span
            className="inline-flex flex-shrink-0 text-script opacity-75"
            title={node.impl.type === "doc" ? "実装: 手順書（文書）" : "実装: スクリプト（決定的）"}
          >
            <Icon name={node.impl.type === "doc" ? "doc" : "code"} size={12} />
          </span>
        )}
        {data.editing ? (
          <input
            autoFocus
            className="nodrag min-w-0 flex-1 rounded-sm border border-border bg-transparent px-1 py-px text-sm text-foreground outline-none focus:border-border-strong"
            value={draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                data.onCommitTitle(node.id, draft);
              } else if (e.key === "Escape") {
                e.preventDefault();
                data.onCancelEdit();
              }
            }}
            onBlur={() => data.onCommitTitle(node.id, draft)}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm">{node.title || "（無題）"}</span>
        )}
        {node.impact === "irreversible" && (
          <span className="flex-shrink-0 text-destructive" title="不可逆">
            <Icon name="alert" size={12} />
          </span>
        )}
      </div>
      {showFoot && (
        <div className="mt-1.5">
          <span className="text-xs text-muted-foreground">{STATUS_LABEL[node.status]}</span>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
