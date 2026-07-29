import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { usePolling } from "../hooks/usePolling";
import { openPalette } from "../lib/palette";
import type { Node } from "../types";
import { Icon } from "./Icon";

/** 手順ページのラン待ち項目（B-6: 受信箱への統合）。クリックで onSelect(nodeId) を呼べば
 *  テンプレートノードの選択 + そのページへの移動は App.selectNode が面倒を見る */
export interface RunWaitItem {
  key: string;
  nodeId: string;
  label: string;
}

interface Props {
  nodes: Node[];
  runWaitItems?: RunWaitItem[];
  onSelect: (id: string) => void;
  chatOpen: boolean;
  onToggleChat: () => void;
  onOpenSettings: () => void;
}

export function TopBar({ nodes, runWaitItems = [], onSelect, chatOpen, onToggleChat, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pending = nodes.filter((n) => n.pendingRequest);
  const totalCount = pending.length + runWaitItems.length;

  // QOL-5: エンジン稼働インジケータ（5秒毎ポーリング）
  const { data: engineStatus } = usePolling(() => api.getEngineStatus(), 5000);
  const engineAlive = engineStatus?.alive ?? false;
  const engineTitle = engineAlive
    ? `最終確認: ${engineStatus?.lastSeen ?? "-"}`
    : `最終確認: ${engineStatus?.lastSeen ?? "-"}\n起動: pnpm --filter @graphwrangler/engine start`;

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
      <span className={`engine-status${engineAlive ? " is-alive" : ""}`} title={engineTitle}>
        <i className="engine-dot" />
        {engineAlive ? "エンジン稼働中" : "エンジン停止中"}
      </span>
      <div className="topbar-spacer" />
      <button
        type="button"
        className="chat-toggle-btn"
        onClick={() => openPalette()}
        title="全ノード検索 (Ctrl+K)"
      >
        <Icon name="search" size={13} />
      </button>
      <button
        type="button"
        className="chat-toggle-btn"
        onClick={onOpenSettings}
        title="AI設定"
      >
        <Icon name="gear" size={13} />
      </button>
      <button
        type="button"
        className={`chat-toggle-btn${chatOpen ? " is-active" : ""}`}
        onClick={onToggleChat}
        title="相棒AIとチャット"
      >
        <Icon name="chat" size={13} />
      </button>
      <div className="inbox" ref={ref}>
        <button
          type="button"
          className={`inbox-btn${totalCount > 0 ? " has-pending" : ""}`}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="user" size={12} /> あなたの番 {totalCount}
        </button>
        {open && (
          <div className="inbox-dropdown">
            {totalCount === 0 && <div className="inbox-empty">今はありません</div>}
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
            {runWaitItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className="inbox-item"
                onClick={() => {
                  onSelect(item.nodeId);
                  setOpen(false);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
