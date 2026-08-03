import { useEffect, useRef, useState } from "react";
import { Keyboard, Search, Settings, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import { usePolling } from "../hooks/usePolling";
import { subscribeFocusGoalCapture } from "../lib/capture";
import { openPalette, openShortcuts } from "../lib/palette";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Icon } from "./Icon";

/** ルーティーンページのラン待ち項目。App がデスクトップ通知の判定に使う
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
  /** ゴール捕獲欄で Enter を押したとき。新しいプロジェクト（goal ノード）を作って開く */
  onCaptureGoal: (title: string) => Promise<void>;
}


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


/** ゴール捕獲欄（2026-08-01 本人指示で受信箱を置き換え）。zinsei の #inbox と同じ体験:
 *  思いついたゴールを一行書いて Enter を押すだけで、新しいプロジェクト（空の goal ページ）が
 *  生まれてそこへ移動する。溜め置き（未整理の受信箱）は作らない——溜まる場所を作ると
 *  「捌く」仕事が増えるため、書いた瞬間にプロジェクトになる（docs/design.md 4章 ②）。
 *  分解は自動で走らせない: 開いた先で自分から GraphWrangler AI に頼む。 */
function GoalCapture({ onCapture }: { onCapture: (title: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  // 左レールの「＋」からもここへ来る（作成の入口はこの1箇所に集約する）
  useEffect(() => subscribeFocusGoalCapture(() => ref.current?.focus()), []);

  // 二重送信は busy フラグだけで防ぎ、入力欄は disabled にしない——disabled にすると
  // ブラウザがフォーカスを外し、連投しようとした2件目が欄の外へタイプされてしまう
  const submit = async () => {
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await onCapture(title);
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Input
      ref={ref}
      value={text}
      placeholder="思いついたゴールを書く → Enter で新しいプロジェクト"
      aria-label="ゴールを登録して新しいプロジェクトを作る"
      className="h-8 w-full max-w-md bg-muted/40 text-sm"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void submit();
        } else if (e.key === "Escape") {
          setText("");
          ref.current?.blur();
        }
      }}
    />
  );
}

export function TopBar({ chatOpen, onToggleChat, onOpenSettings, onUndo, onCaptureGoal }: Props) {
  // エンジン稼働インジケータ（5秒毎ポーリング）。平常時は何も出さず、
  // 「AIが動いていない」ときだけ警告として表示する（2026-07-31 本人指示。
  // ノード数バッジも同時に廃止: 常時出る情報バッジは圧になるだけ）
  const { data: engineStatus } = usePolling(() => api.getEngineStatus(), 5000);
  const engineDown = engineStatus != null && !engineStatus.alive;

  return (
    // 3カラム構造: 左右を flex-1 の等分にして、ゴール捕獲欄が**画面の中心**に来るようにする
    // （2026-08-02 本人指摘「ちょっと左にずれてる」——左右のグループ幅が違うため、
    // 残り空間の中央=画面中央からずれていた）
    <header className="flex h-14 flex-shrink-0 items-center gap-3 border-b bg-background px-4">
      <div className="flex flex-1 items-center gap-3">
        {/* モバイルではロゴを隠して捕獲欄の幅を確保する */}
        <div className="font-semibold max-md:hidden">GraphWrangler</div>
        {/* 元に戻すはタイトルの右（2026-08-01 本人指定。グラフ操作の直後に目が行く位置）。
            モバイルでは非表示（2026-08-02 本人指示「前のページに戻るボタンだと思って押してしまう」） */}
        <span className="max-md:hidden">
          <IconButton title="元に戻す (Ctrl+Z)" onClick={onUndo}>
            <Undo2 />
          </IconButton>
        </span>
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
      </div>
      {/* 旧「あなたの番 N」＝受信箱があった場所。数を数える箱をやめ、ゴールを投げ込む口にした */}
      <div className="flex w-full min-w-0 max-w-md justify-center px-2">
        <GoalCapture onCapture={onCaptureGoal} />
      </div>
      <div className="flex flex-1 items-center justify-end gap-3">
        <IconButton title="全ノード検索 (Ctrl+K)" onClick={() => openPalette()}>
          <Search />
        </IconButton>
        {/* キーボードショートカットはモバイルでは無意味なので隠す */}
        <span className="max-md:hidden">
          <IconButton title="ショートカット一覧 (?)" onClick={() => openShortcuts()}>
            <Keyboard />
          </IconButton>
        </span>
        <IconButton title="設定" onClick={onOpenSettings}>
          <Settings />
        </IconButton>
        {/* モバイルでは下部タブバーの「チャット」と重複するので隠す（2026-08-02 本人指示） */}
        <span className="max-md:hidden">
          <IconButton title="GraphWrangler AI とチャット" onClick={onToggleChat} active={chatOpen}>
            <Icon name="chat" size={16} />
          </IconButton>
        </span>
      </div>
    </header>
  );
}
