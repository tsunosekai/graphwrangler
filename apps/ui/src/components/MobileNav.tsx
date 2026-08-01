// モバイル（<768px）専用の下部タブバー。ヘッダーを除く画面は常に
// 一覧（プロジェクト）/ グラフ / ノード詳細（Task AI）/ ワークフローAI の
// どれか1つが専有する（2026-08-02 本人指定）。親指で届く位置に切替を置く。
// ノードタブは選択中ノードが無いときは無効（タップ先が無いため）
import { ClipboardList, List, MessageSquare, Network } from "lucide-react";
import { cn } from "../lib/utils";

export type MobileView = "pages" | "graph" | "node" | "chat";

interface Props {
  view: MobileView;
  /** ノードタブが押せるか（単一選択 or 複数選択があるとき） */
  nodeEnabled: boolean;
  /** ノードタブの下に出す選択中ノード名（あれば。長い場合は truncate） */
  nodeLabel: string | null;
  onChange: (view: MobileView) => void;
}

const ITEMS: Array<{ key: MobileView; label: string; icon: typeof List }> = [
  { key: "pages", label: "一覧", icon: List },
  { key: "graph", label: "グラフ", icon: Network },
  { key: "node", label: "ノード", icon: ClipboardList },
  { key: "chat", label: "チャット", icon: MessageSquare },
];

export function MobileNav({ view, nodeEnabled, nodeLabel, onChange }: Props) {
  return (
    <nav className="flex h-14 flex-shrink-0 items-stretch border-t bg-background md:hidden">
      {ITEMS.map(({ key, label, icon: IconCmp }) => {
        const active = view === key;
        const disabled = key === "node" && !nodeEnabled;
        const text = key === "node" && nodeLabel ? nodeLabel : label;
        return (
          <button
            key={key}
            type="button"
            disabled={disabled}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors",
              active ? "text-ai" : "text-muted-foreground",
              disabled && "opacity-40",
            )}
            onClick={() => onChange(key)}
          >
            <IconCmp className="size-5" />
            <span className="max-w-full truncate px-1">{text}</span>
          </button>
        );
      })}
    </nav>
  );
}
