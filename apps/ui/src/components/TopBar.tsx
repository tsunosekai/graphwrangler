import { useEffect, useRef, useState } from "react";
import type { Node } from "../types";
import { Icon } from "./Icon";

interface Props {
  nodes: Node[];
  onSelect: (id: string) => void;
}

export function TopBar({ nodes, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pending = nodes.filter((n) => n.pendingRequest);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <header className="topbar">
      <div className="topbar-logo">GraphWrangler</div>
      <div className="topbar-chip">{nodes.length} ノード</div>
      <div className="topbar-spacer" />
      <div className="inbox" ref={ref}>
        <button
          type="button"
          className={`inbox-btn${pending.length > 0 ? " has-pending" : ""}`}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="user" size={12} /> あなたの番 {pending.length}
        </button>
        {open && (
          <div className="inbox-dropdown">
            {pending.length === 0 && <div className="inbox-empty">今はありません</div>}
            {pending.map((n) => (
              <button
                key={n.id}
                type="button"
                className="inbox-item"
                onClick={() => {
                  onSelect(n.id);
                  setOpen(false);
                }}
              >
                {n.title || "（無題）"}
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
