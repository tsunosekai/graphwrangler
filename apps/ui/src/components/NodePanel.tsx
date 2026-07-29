import { useEffect, useState } from "react";
import { api, type NodePatchInput } from "../lib/api";
import { usePolling } from "../hooks/usePolling";
import { useResizableWidth } from "../hooks/useResizableWidth";
import type { Node } from "../types";
import { Icon } from "./Icon";
import { Thread } from "./Thread";

interface Props {
  node: Node;
  onMutated: () => void;
  onClose: () => void;
  /** ノード複製後に新規ノードを選択するため（QOL-8）。ページ切替も面倒を見る App.selectNode を渡す */
  onSelect: (id: string) => void;
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
export function NodePanel({ node, onMutated, onClose, onSelect }: Props) {
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
    <aside className="node-panel" style={{ width }}>
      <div className="resize-handle resize-handle-left" onPointerDown={(e) => startResize(e, -1)} />
      <div className="node-panel-head">
        <input
          className="node-title-field"
          value={titleDraft}
          onFocus={() => setTitleFocused(true)}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <button
          type="button"
          className="icon-btn"
          title={
            node.selfImprove
              ? "アンロック中: AIが実装(impl)を書き換えてよい"
              : "ロック中: AIは実装(impl)を書き換えない"
          }
          onClick={() => patch({ selfImprove: !node.selfImprove })}
        >
          <Icon name={node.selfImprove ? "unlock" : "lock"} size={14} />
        </button>
        <button type="button" className="icon-btn" title="このノードを複製" onClick={handleDuplicate}>
          <Icon name="copy" size={14} />
        </button>
        <button type="button" className="icon-btn" title="このノードを削除" onClick={handleDelete}>
          <Icon name="trash" size={14} />
        </button>
        <button type="button" className="node-panel-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
      </div>

      {!metaOpen && (
        <button type="button" className="node-meta-summary" onClick={() => setMetaOpen(true)}>
          <span className="node-meta-chips">
            <span className="meta-chip">{node.kind}</span>
            <span className="meta-chip">{node.executor}</span>
            <span className="meta-chip">{node.impact}</span>
            <span className="meta-chip">{node.lifecycle}</span>
            <span className="meta-chip">{node.status}</span>
          </span>
          {node.detail && <span className="node-detail-preview">{node.detail}</span>}
          <span className="meta-expand-hint">▾</span>
        </button>
      )}

      {metaOpen && (
        <>
          <button type="button" className="node-meta-summary" onClick={() => setMetaOpen(false)}>
            <span className="meta-expand-hint">▴ たたむ</span>
          </button>
          <textarea
            className="node-detail-field"
            placeholder="detail / 補足"
            value={detailDraft}
            onFocus={() => setDetailFocused(true)}
            onChange={(e) => setDetailDraft(e.target.value)}
            onBlur={saveDetail}
            rows={3}
          />

          {node.kind === "procedure" && (
            <input
              className="node-schedule-field"
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

          <div className="node-meta-grid">
        <label>
          種別
          <select value={node.kind} onChange={(e) => patch({ kind: e.target.value as Node["kind"] })}>
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          担当
          <select value={node.executor} onChange={(e) => patch({ executor: e.target.value as Node["executor"] })}>
            {EXECUTOR_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          影響
          <select value={node.impact} onChange={(e) => patch({ impact: e.target.value as Node["impact"] })}>
            {IMPACT_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          確定
          <select value={node.lifecycle} onChange={(e) => patch({ lifecycle: e.target.value as Node["lifecycle"] })}>
            {LIFECYCLE_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          進捗
          <select value={node.status} onChange={(e) => patch({ status: e.target.value as Node["status"] })}>
            {STATUS_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
          </div>
        </>
      )}

      <div className="node-panel-tabs">
        <button type="button" className={tab === "talk" ? "is-active" : ""} onClick={() => setTab("talk")}>
          💬 会話
        </button>
        <button type="button" className={tab === "history" ? "is-active" : ""} onClick={() => setTab("history")}>
          📜 履歴
        </button>
      </div>

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
