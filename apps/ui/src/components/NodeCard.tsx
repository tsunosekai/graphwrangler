import { useEffect, useState } from "react";
import { Handle, Position } from "@xyflow/react";
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

export interface NodeCardData {
  node: Node;
  selected: boolean;
  editing: boolean;
  /** 手順ページ（テンプレートの編集）で描かれているカードか。テンプレートは status を
   *  持たない思想（docs/design.md 3.8）なので、status 由来の見た目は出さない */
  isTemplate?: boolean;
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

  const classes = [
    "node-card",
    `kind-${node.kind}`,
    `exec-${node.executor}`, // アクティブ枠の色（実行者の色）に使う
    isTemplate ? "" : `status-${node.status}`,
    `lifecycle-${node.lifecycle}`,
    data.selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} onClick={() => data.onSelect(node.id)} onDoubleClick={() => data.onDoubleClick(node.id)}>
      <Handle type="target" position={Position.Top} />
      {/* PDG風の完了/中止マーク（カード左外側の丸バッジ）。テンプレートには出さない */}
      {!isTemplate && node.status === "done" && (
        <span className="pdg-badge pdg-done" title="完了">
          <Icon name="check" size={14} />
        </span>
      )}
      {!isTemplate && node.status === "dropped" && (
        <span className="pdg-badge pdg-dropped" title="中止">
          <Icon name="x" size={13} />
        </span>
      )}
      {node.pendingRequest && <span className="dot-pending" title="あなたの番" />}
      <div className="node-card-head">
        <span className={`exec-badge exec-${node.executor}`}>
          <Icon name={EXEC_ICON[node.executor]} />
        </span>
        {node.impl && (
          <span
            className="impl-badge"
            title={node.impl.type === "doc" ? "実装: 手順書（文書）" : "実装: スクリプト（決定的）"}
          >
            <Icon name={node.impl.type === "doc" ? "doc" : "code"} size={12} />
          </span>
        )}
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
            <Icon name="alert" size={12} />
          </span>
        )}
      </div>
      {!isTemplate && node.status !== "done" && node.status !== "dropped" && (
        <div className="node-card-foot">
          <span className={`status-chip status-${node.status}`}>{STATUS_LABEL[node.status]}</span>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
