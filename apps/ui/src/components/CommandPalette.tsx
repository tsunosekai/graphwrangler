// Ctrl+K 全ノード検索（QOL-1）。中央上部のオーバーレイで、全ページ横断のタイトル/detail部分一致から
// 選ぶと selectNode（ページ自動切替あり）を呼ぶ。常駐（App直下）でマウントし、
// Ctrl+K はここで待ち受ける。TopBar の🔍ボタンは lib/palette.ts のイベントバス経由で開く
// （lib/toast.ts と同じ「コンポーネントツリーを経由しない」流儀）。
import { useEffect, useMemo, useRef, useState } from "react";
import { subscribeOpenPalette } from "../lib/palette";
import type { Node } from "../types";
import { StatusCircle } from "./StatusCircle";

interface Props {
  nodes: Node[];
  /** ページ（フォルダ）扱いのノード。行の「所属ページ名」の解決に使う */
  folders: Node[];
  onSelect: (id: string) => void;
}

const MAX_RESULTS = 12;

export function CommandPalette({ nodes, folders, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => subscribeOpenPalette(() => setOpen(true)), []);

  // Ctrl+K で開く / Escape で閉じる。常時待ち受ける必要があるため open に関わらず登録する
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? nodes.filter(
          (n) => n.title.toLowerCase().includes(q) || (n.detail ?? "").toLowerCase().includes(q),
        )
      : nodes;
    return filtered.slice(0, MAX_RESULTS);
  }, [nodes, query]);

  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  if (!open) return null;

  const pageNameFor = (n: Node): string => {
    if (n.group) {
      const f = folders.find((x) => x.id === n.group);
      if (f) return f.title || "（無題）";
    }
    if (folders.some((f) => f.id === n.id)) return "ページ";
    return "";
  };

  const choose = (n: Node) => {
    onSelect(n.id);
    setOpen(false);
  };

  return (
    <div className="palette-overlay" onClick={() => setOpen(false)}>
      <div className="palette-card" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ノードを検索..."
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((i) => Math.min(matches.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const n = matches[activeIndex];
              if (n) choose(n);
            }
          }}
        />
        <div className="palette-list">
          {matches.length === 0 && <div className="palette-empty">見つかりませんでした</div>}
          {matches.map((n, i) => (
            <button
              type="button"
              key={n.id}
              className={`palette-item${i === activeIndex ? " is-active" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => choose(n)}
            >
              <StatusCircle status={n.status} size={12} />
              <span className="palette-item-title">{n.title || "（無題）"}</span>
              {pageNameFor(n) && <span className="palette-item-page">{pageNameFor(n)}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
