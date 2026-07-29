// 左レールのページ一覧。ゴール（フォルダ）1つ = 1ページ（desk の左レール方式）。
// タイトル下にメンバーの状態内訳ドット（desk の ball 内訳ドットの継承）。
import { api } from "../lib/api";
import type { Node, Status } from "../types";
import { StatusCircle } from "./StatusCircle";

interface Props {
  folders: Node[];
  allNodes: Node[];
  pageId: string | null;
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
};

// 目に入るべき順: あなたの番 → 実行中 → 待機系 → 完了 → 中止
const DOT_ORDER: Status[] = ["waiting", "running", "pending", "unplanned", "done", "dropped"];
const MAX_DOTS = 16;

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
        const members = allNodes
          .filter((n) => n.group === f.id)
          .sort((a, b) => DOT_ORDER.indexOf(a.status) - DOT_ORDER.indexOf(b.status));
        const shown = members.slice(0, MAX_DOTS);
        const rest = members.length - shown.length;
        return (
          <button
            key={f.id}
            type="button"
            className={`page-row${pageId === f.id ? " is-active" : ""}`}
            onClick={() => onSelectPage(f.id)}
          >
            <span className="page-row-main">
              <StatusCircle status={f.status} size={12} />
              <span className="page-row-title">{f.title || "（無題）"}</span>
            </span>
            {members.length > 0 && (
              <span className="page-row-dots">
                {shown.map((m) => (
                  <i
                    key={m.id}
                    className="goal-dot"
                    title={`${m.title || "（無題）"} — ${m.status}`}
                    style={{ background: DOT_COLOR[m.status] }}
                  />
                ))}
                {rest > 0 && <span className="goal-dot-more">+{rest}</span>}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
