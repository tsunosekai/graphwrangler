import { useEffect, useState } from "react";
import { api, type NodePatchInput } from "../lib/api";
import { usePolling } from "../hooks/usePolling";
import type { Node } from "../types";
import { Icon } from "./Icon";
import { Thread } from "./Thread";

interface Props {
  node: Node;
  onMutated: () => void;
  onClose: () => void;
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
export function NodePanel({ node, onMutated, onClose }: Props) {
  const [tab, setTab] = useState<"talk" | "history">("talk");
  const { data: thread, refresh: refreshThread } = usePolling(() => api.getThread(node.id), 10000);

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
    <aside className="node-panel">
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
        <button type="button" className="icon-btn" title="このノードを削除" onClick={handleDelete}>
          <Icon name="trash" size={14} />
        </button>
        <button type="button" className="node-panel-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
      </div>

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
