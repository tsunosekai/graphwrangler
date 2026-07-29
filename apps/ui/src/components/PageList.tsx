// 左レールのページ一覧。ゴール/手順（フォルダ）1つ = 1ページ（desk の左レール方式）。
// タイトル下にメンバーの状態内訳ドット（desk の ball 内訳ドットの継承）。
// 手順ページ（kind=procedure）は StatusCircle の代わりに repeat アイコンを出し、
// ドットはメンバーの status ではなく「最新ランのワークアイテム状態内訳」にする
// （テンプレート自身は status を持たない思想。docs/design.md 3.8）。
// 最新ランの取得は App 側でまとめてポーリングする（B-6: 受信箱のラン待ち統合と共有し、
// procedure 数ぶんの N+1 取得を1箇所に集約するため。旧: このコンポーネント内で自前ポーリングしていた）。
import { api } from "../lib/api";
import { useResizableWidth } from "../hooks/useResizableWidth";
import type { Node, Run, RunItemStatus, Status } from "../types";
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
};

// ワークアイテムの status（RunItemStatus は Status に "skipped" を足しただけ）
const RUN_DOT_COLOR: Record<RunItemStatus, string> = {
  ...DOT_COLOR,
  skipped: "var(--text-lo)",
};

// 目に入るべき順: あなたの番 → 実行中 → 待機系 → 完了 → 中止
const DOT_ORDER: Status[] = ["waiting", "running", "pending", "unplanned", "done", "dropped"];
const RUN_DOT_ORDER: RunItemStatus[] = ["waiting", "running", "pending", "done", "dropped", "skipped"];
const MAX_DOTS = 16;

export function PageList({ folders, allNodes, pageId, latestRuns, onSelectPage, onMutated }: Props) {
  const [width, startResize] = useResizableWidth("railW", 224, 160, 400);

  const addGoal = async () => {
    const created = await api.addNode({ title: "新しいゴール", kind: "goal" });
    onMutated();
    onSelectPage(created.id);
  };

  return (
    <div className="page-list" style={{ width }}>
      <div
        className="resize-handle resize-handle-right"
        onPointerDown={(e) => startResize(e, 1)}
      />
      <div className="page-list-head">
        <span>ゴール</span>
        <button type="button" className="page-add-btn" title="ゴールを追加" onClick={addGoal}>
          ＋
        </button>
      </div>
      {folders.map((f) => {
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
            className={`page-row${pageId === f.id ? " is-active" : ""}`}
            onClick={() => onSelectPage(f.id)}
          >
            <span className="page-row-main">
              {isProcedure ? (
                <span className="page-row-procedure-icon" title="手順ページ">
                  <Icon name="repeat" size={12} />
                </span>
              ) : (
                <StatusCircle status={f.status} size={12} />
              )}
              <span className="page-row-title">{f.title || "（無題）"}</span>
            </span>
            {dots.length > 0 && (
              <span className="page-row-dots">
                {shown.map((d) => (
                  <i key={d.key} className="goal-dot" title={d.title} style={{ background: d.color }} />
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
