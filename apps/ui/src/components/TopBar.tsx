import { Keyboard, Monitor, Moon, Search, Settings, Sun, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import { usePolling } from "../hooks/usePolling";
import { openPalette, openShortcuts } from "../lib/palette";
import { useTheme, type ThemeMode } from "../lib/theme";
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
  chatOpen: boolean;
  onToggleChat: () => void;
  onOpenSettings: () => void;
  /** 元に戻す（操作ログの補償追記）。ボタンはヘッダー、Ctrl+Z は GraphView が持つ */
  onUndo: () => void;
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

export function TopBar({ chatOpen, onToggleChat, onOpenSettings, onUndo }: Props) {
  // QOL-5: エンジン稼働インジケータ（5秒毎ポーリング）。平常時は何も出さず、
  // 「AIが動いていない」ときだけ警告として表示する（2026-07-31 本人指示。
  // ノード数バッジも同時に廃止: 常時出る情報バッジは圧になるだけ）
  const { data: engineStatus } = usePolling(() => api.getEngineStatus(), 5000);
  const engineDown = engineStatus != null && !engineStatus.alive;

  return (
    <header className="flex h-14 flex-shrink-0 items-center gap-3 border-b bg-background px-4">
      <div className="font-semibold">GraphWrangler</div>
      {engineDown && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <i className="inline-block size-2 flex-shrink-0 rounded-full bg-text-lo" />
              エンジン停止中
            </span>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">
            {`最終確認: ${engineStatus?.lastSeen ?? "-"}\n起動: pnpm --filter @graphwrangler/engine start`}
          </TooltipContent>
        </Tooltip>
      )}
      <div className="flex-1" />
      <IconButton title="元に戻す (Ctrl+Z)" onClick={onUndo}>
        <Undo2 />
      </IconButton>
      <IconButton title="全ノード検索 (Ctrl+K)" onClick={() => openPalette()}>
        <Search />
      </IconButton>
      <IconButton title="ショートカット一覧 (?)" onClick={() => openShortcuts()}>
        <Keyboard />
      </IconButton>
      <ThemeToggle />
      <IconButton title="AI設定" onClick={onOpenSettings}>
        <Settings />
      </IconButton>
      <IconButton title="Workflow AI とチャット" onClick={onToggleChat} active={chatOpen}>
        <Icon name="chat" size={16} />
      </IconButton>
    </header>
  );
}
