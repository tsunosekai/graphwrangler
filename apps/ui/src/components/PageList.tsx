// 左レールのページ一覧。ゴール（フォルダ）1つ = 1ページ（desk の左レール方式）。
import { api } from "../lib/api";
import type { Node } from "../types";
import { StatusCircle } from "./StatusCircle";

interface Props {
  folders: Node[];
  allNodes: Node[];
  pageId: string | null;
  onSelectPage: (id: string) => void;
  onMutated: () => void;
}

export function PageList({ folders, allNodes, pageId, onSelectPage, onMutated }: Props) {
  const addGoal = async () => {
    const created = await api.addNode({ title: "新しいゴール", kind: "goal" });
    onMutated();
    onSelectPage(created.id);
  };

  return (
    <div className="page-list">
      <div className="page-list-head">
        <span>ゴール</span>
        <button type="button" className="page-add-btn" title="ゴールを追加" onClick={addGoal}>
          ＋
        </button>
      </div>
      {folders.map((f) => {
        const members = allNodes.filter((n) => n.group === f.id);
        const pending = members.filter((n) => n.pendingRequest).length;
        return (
          <button
            key={f.id}
            type="button"
            className={`page-row${pageId === f.id ? " is-active" : ""}`}
            onClick={() => onSelectPage(f.id)}
          >
            <StatusCircle status={f.status} size={12} />
            <span className="page-row-title">{f.title || "（無題）"}</span>
            {pending > 0 && <span className="dot-pending" title="あなたの番あり" />}
            <span className="page-row-count">{members.length}</span>
          </button>
        );
      })}
    </div>
  );
}
