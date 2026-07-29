// Ctrl+K 全ノード検索（QOL-1）。中央上部のオーバーレイで、全ページ横断のタイトル/detail部分一致から
// 選ぶと selectNode（ページ自動切替あり）を呼ぶ。常駐（App直下）でマウントし、
// Ctrl+K はここで待ち受ける。TopBar の🔍ボタンは lib/palette.ts のイベントバス経由で開く
// （lib/toast.ts と同じ「コンポーネントツリーを経由しない」流儀）。
// shadcn/cmdk の Command 部品ベース（Origin UI 流）。フィルタは既存どおり自前の
// 部分一致（title/detail）のままとし、cmdk 側のあいまい検索は使わない(shouldFilter=false)。
import { useEffect, useMemo, useState } from "react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
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

  useEffect(() => subscribeOpenPalette(() => setOpen(true)), []);

  // Ctrl+K で開く（Escape/クリック外は CommandDialog=Dialog 側が面倒を見る）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) setQuery("");
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
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="ノード検索"
      description="タイトル・detail から全ノードを横断検索する"
      className="max-w-[480px]"
      shouldFilter={false}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="ノードを検索..."
      />
      <CommandList>
        {matches.length === 0 && <CommandEmpty>見つかりませんでした</CommandEmpty>}
        <CommandGroup>
          {matches.map((n) => (
            <CommandItem key={n.id} value={n.id} onSelect={() => choose(n)}>
              <StatusCircle status={n.status} size={12} />
              <span className="min-w-0 flex-1 truncate">{n.title || "（無題）"}</span>
              {pageNameFor(n) && (
                <span className="flex-shrink-0 text-xs text-muted-foreground">{pageNameFor(n)}</span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
