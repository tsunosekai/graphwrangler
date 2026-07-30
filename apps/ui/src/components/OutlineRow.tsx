import { useEffect, useState, type KeyboardEvent } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import type { OutlineEntry } from "../lib/tree";
import { siblingsOf } from "../lib/tree";
import type { Node } from "../types";
import { Icon } from "./Icon";
import { StatusCircle } from "./StatusCircle";

// 担当アイコン（NodeCard と同じ「B. 明快系」セット）
const EXEC_ICON: Record<Node["executor"], "user" | "bot" | "terminal"> = {
  human: "user",
  ai: "bot",
  script: "terminal",
};
const EXEC_TEXT: Record<Node["executor"], string> = {
  human: "text-human",
  ai: "text-ai",
  script: "text-script",
};

interface Props {
  entry: OutlineEntry;
  depth: number;
  allNodes: Node[];
  selectedId: string | null;
  editingId: string | null;
  onSelect: (id: string) => void;
  onStartEdit: (id: string | null) => void;
  onMutated: () => void;
}

export function OutlineRow({
  entry,
  depth,
  allNodes,
  selectedId,
  editingId,
  onSelect,
  onStartEdit,
  onMutated,
}: Props) {
  const { node, children, extraParents } = entry;
  const editing = editingId === node.id;
  const [draft, setDraft] = useState(node.title);

  useEffect(() => {
    if (editing) setDraft(node.title);
  }, [editing, node.title]);

  const commit = async () => {
    onStartEdit(null);
    const t = draft.trim();
    if (t && t !== node.title) {
      await api.patchNode(node.id, { title: t });
      onMutated();
    }
  };

  const toggleDone = async () => {
    await api.patchNode(node.id, { status: node.status === "done" ? "pending" : "done" });
    onMutated();
  };

  // このノードがフォルダ（グループ）か: メンバーがいる、または kind=goal
  const isFolder = node.kind === "goal" || allNodes.some((n) => n.group === node.id);

  const addSibling = async () => {
    const created = await api.addNode({ title: "", parents: node.parents, group: node.group });
    onMutated();
    onSelect(created.id);
    onStartEdit(created.id);
  };

  const addChild = async () => {
    // フォルダへの「＋子」はメンバー追加（包含）、タスクへの「＋子」は依存の後続
    const created = isFolder
      ? await api.addNode({ title: "", group: node.id })
      : await api.addNode({ title: "", parents: [node.id], group: node.group });
    onMutated();
    onSelect(created.id);
    onStartEdit(created.id);
  };

  const indent = async () => {
    const sibs = siblingsOf(allNodes, node);
    const idx = sibs.findIndex((s) => s.id === node.id);
    if (idx <= 0) return; // 直前の兄がいなければ何もしない
    const newParent = sibs[idx - 1];
    await api.patchNode(node.id, { parents: [newParent.id, ...node.parents.slice(1)] });
    onMutated();
  };

  const outdent = async () => {
    const primaryId = node.parents[0];
    if (!primaryId) return; // 既にルート
    const parent = allNodes.find((n) => n.id === primaryId);
    if (!parent) return;
    await api.patchNode(node.id, { parents: [...parent.parents] });
    onMutated();
  };

  const handleRowKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      addSibling();
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) outdent();
      else indent();
    }
  };

  return (
    <div>
      <div
        className={cn(
          "group relative flex items-center gap-1.5 rounded-sm px-2 py-1 outline-none hover:bg-accent/60",
          selectedId === node.id && "bg-accent",
        )}
        style={{ paddingLeft: depth * 16 + 8 }}
        tabIndex={0}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => onStartEdit(node.id)}
        onKeyDown={handleRowKeyDown}
      >
        <button
          type="button"
          className="inline-flex flex-shrink-0 rounded-sm p-0.5 hover:bg-accent"
          title={`状態: ${node.status}（クリックで完了⇔待機）`}
          onClick={(e) => {
            e.stopPropagation();
            toggleDone();
          }}
        >
          <StatusCircle status={node.status} />
        </button>
        {!isFolder && (
          <span className={cn("inline-flex flex-shrink-0", EXEC_TEXT[node.executor])}>
            <Icon name={EXEC_ICON[node.executor]} />
          </span>
        )}
        {editing ? (
          <input
            autoFocus
            className="min-w-0 flex-1 rounded-sm border border-border bg-transparent px-1 py-px text-sm outline-none focus:border-border-strong"
            value={draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onStartEdit(null);
              }
            }}
            onBlur={commit}
          />
        ) : (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              node.status === "dropped" && "text-text-lo line-through",
              node.status === "done" && "text-text-lo",
            )}
          >
            {node.title || "（無題）"}
          </span>
        )}
        {node.pendingRequest && (
          <span className="size-2 flex-shrink-0 rounded-full bg-[#ff9f43]" title="あなたの番" />
        )}
        {extraParents.map((p) => (
          <button
            key={p.id}
            type="button"
            className="flex-shrink-0 rounded-sm px-1.5 text-xs text-muted-foreground hover:bg-accent"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(p.id);
            }}
          >
            ⇡ {p.title || "（無題）"}
          </button>
        ))}
        <button
          type="button"
          className="invisible flex-shrink-0 rounded-sm px-1.5 text-xs text-muted-foreground hover:bg-accent group-hover:visible"
          title="子ノードを追加"
          onClick={(e) => {
            e.stopPropagation();
            addChild();
          }}
        >
          ＋子
        </button>
      </div>
      {children.length > 0 && (
        <div>
          {children.map((c) => (
            <OutlineRow
              key={c.node.id}
              entry={c}
              depth={depth + 1}
              allNodes={allNodes}
              selectedId={selectedId}
              editingId={editingId}
              onSelect={onSelect}
              onStartEdit={onStartEdit}
              onMutated={onMutated}
            />
          ))}
        </div>
      )}
    </div>
  );
}
