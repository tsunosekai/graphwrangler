import { useState } from "react";
import { api } from "../lib/api";
import type { DecisionRequest, MaterializedMessage } from "../types";

interface Props {
  message: MaterializedMessage;
  nodeId: string;
  onMutated: () => void;
}

export function DecisionCard({ message, nodeId, onMutated }: Props) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const payload = message.payload as { request: DecisionRequest } | null;
  const request = payload?.request;
  const open = message.requestStatus === "open";

  if (!request) return null;

  const choose = async (optionId: string) => {
    setBusy(true);
    try {
      await api.answer(nodeId, message.id, optionId);
      onMutated();
    } finally {
      setBusy(false);
    }
  };

  const rally = async () => {
    const text = note.trim();
    if (!text) return;
    setBusy(true);
    try {
      await api.answer(nodeId, message.id, null, text);
      setNote("");
      onMutated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`decision-card${open ? " is-open" : " is-answered"}`}>
      <div className="decision-context">{request.context}</div>
      <div className="decision-question">{request.question}</div>
      <div className="decision-options">
        {request.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`decision-option${opt.recommended ? " is-recommended" : ""}`}
            title={opt.then}
            disabled={!open || busy}
            onClick={() => choose(opt.id)}
          >
            <span className="decision-option-label">
              {opt.label}
              {opt.recommended && <span className="decision-recommend-tag">おすすめ</span>}
            </span>
            <span className="decision-option-then">{opt.then}</span>
          </button>
        ))}
      </div>
      <div className="decision-footer">
        <span>影響: {request.impact}</span>
        {request.undo && <span>取消: {request.undo}</span>}
        {request.expires && <span>期限: {new Date(request.expires).toLocaleString("ja-JP")}</span>}
        {!open && <span className="decision-answered-tag">回答済み</span>}
      </div>
      {open && (
        <div className="decision-rally">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="聞き返す..."
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                rally();
              }
            }}
          />
          <button type="button" disabled={busy || !note.trim()} onClick={rally}>
            聞き返す
          </button>
        </div>
      )}
    </div>
  );
}
