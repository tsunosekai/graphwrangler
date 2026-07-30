import { Monitor, Moon, Search, Settings, Sun } from "lucide-react";
import { api } from "../lib/api";
import { usePolling } from "../hooks/usePolling";
import { openPalette } from "../lib/palette";
import { useTheme, type ThemeMode } from "../lib/theme";
import type { Node } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Icon } from "./Icon";

/** ルーティーンページのラン待ち項目。App がデスクトップ通知（QOL-6）の判定に使う
 *  （旧「あなたの番 N」ボタン=受信箱ドロップダウンは 2026-07-31 本人指示で廃止:
 *  「数字が出ると焦るから嫌」。導線はノード/レールのオレンジ表示が担う） */
export interface RunWaitItem {
  key: string;
  nodeId: string;
  label: string;
}

interface Props {
  nodes: Node[];
  chatOpen: boolean;
  onToggleChat: () => void;
  onOpenSettings: () => void;
}

const THEME_ICON: Record<ThemeMode, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const THEME_LABEL: Record<ThemeMode, string> = { light: "ライト", dark: "ダーク", system: "システム" };

function IconButton({
  title,
  onClick,
  active,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={active ? "text-ai" : undefined}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function ThemeToggle() {
  const [mode, setMode] = useTheme();
  const ActiveIcon = THEME_ICON[mode];
  return (
    <DropdownMenu>
      {/* Tooltip と DropdownMenuTrigger は同じ要素へ二重に asChild すると
         ref を橋渡しできず警告が出るため、ここは title 属性だけにする */}
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" title={`テーマ: ${THEME_LABEL[mode]}`}>
          <ActiveIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(["light", "dark", "system"] as ThemeMode[]).map((m) => {
          const ItemIcon = THEME_ICON[m];
          return (
            <DropdownMenuItem key={m} onSelect={() => setMode(m)} data-active={m === mode}>
              <ItemIcon />
              {THEME_LABEL[m]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TopBar({ nodes, chatOpen, onToggleChat, onOpenSettings }: Props) {
  // QOL-5: エンジン稼働インジケータ（5秒毎ポーリング）
  const { data: engineStatus } = usePolling(() => api.getEngineStatus(), 5000);
  const engineAlive = engineStatus?.alive ?? false;
  const engineTitle = engineAlive
    ? `最終確認: ${engineStatus?.lastSeen ?? "-"}`
    : `最終確認: ${engineStatus?.lastSeen ?? "-"}\n起動: pnpm --filter @graphwrangler/engine start`;

  return (
    <header className="flex h-14 flex-shrink-0 items-center gap-3 border-b bg-background px-4">
      <div className="font-semibold">GraphWrangler</div>
      <Badge variant="secondary">{nodes.length} ノード</Badge>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <i className={`inline-block size-2 flex-shrink-0 rounded-full ${engineAlive ? "bg-ok" : "bg-text-lo"}`} />
            {engineAlive ? "エンジン稼働中" : "エンジン停止中"}
          </span>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-line">{engineTitle}</TooltipContent>
      </Tooltip>
      <div className="flex-1" />
      <IconButton title="全ノード検索 (Ctrl+K)" onClick={() => openPalette()}>
        <Search />
      </IconButton>
      <ThemeToggle />
      <IconButton title="AI設定" onClick={onOpenSettings}>
        <Settings />
      </IconButton>
      <IconButton title="相棒AIとチャット" onClick={onToggleChat} active={chatOpen}>
        <Icon name="chat" size={16} />
      </IconButton>
    </header>
  );
}
