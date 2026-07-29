import { useEffect, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node } from "../types";

const EXEC_EMOJI: Record<Node["executor"], string> = { human: "🧑", ai: "🤖", script: "⚙" };
const EXEC_VAR: Record<Node["executor"], string> = {
  human: "var(--human)",
  ai: "var(--ai)",
  script: "var(--script)",
};
const STATUS_LABEL: Record<Node["status"], string> = {
  pending: "待機",
  running: "実行中",
  waiting: "回答待ち",
  done: "完了 ✓",
  dropped: "中止",
};

export interface NodeCardData {
  node: Node;
  selected: boolean;
  editing: boolean;
  onSelect: (id: string) => void;
  onDoubleClick: (id: string) => void;
  onCommitTitle: (id: string, title: string) => void;
  onCancelEdit: () => void;
  [key: string]: unknown;
}

export function NodeCard({ data }: { data: NodeCardData }) {
  const { node } = data;
  const [draft, setDraft] = useState(node.title);

  useEffect(() => {
    if (data.editing) setDraft(node.title);
  }, [data.editing, node.title]);

  const classes = [
    "node-card",
    `kind-${node.kind}`,
    `status-${node.status}`,
    `lifecycle-${node.lifecycle}`,
    data.selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} onClick={() => data.onSelect(node.id)} onDoubleClick={() => data.onDoubleClick(node.id)}>
      <Handle type="target" position={Position.Top} />
      {node.pendingRequest && <span className="dot-pending" title="あなたの番" />}
      <div className="node-card-head">
        <span className="exec-badge" style={{ color: EXEC_VAR[node.executor] }}>
          {EXEC_EMOJI[node.executor]}
        </span>
        {data.editing ? (
          <input
            autoFocus
            className="node-title-input nodrag"
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
          <span className="node-title">{node.title || "（無題）"}</span>
        )}
        {node.impact === "irreversible" && (
          <span className="badge-warn" title="不可逆">
            ⚠
          </span>
        )}
      </div>
      <div className="node-card-foot">
        <span className={`status-chip status-${node.status}`}>{STATUS_LABEL[node.status]}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
