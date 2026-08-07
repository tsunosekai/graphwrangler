import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, Keyboard, KeyRound, LogOut, Search, Settings, Undo2, Users } from "lucide-react";
import { api } from "../lib/api";
import { usePolling } from "../hooks/usePolling";
import { subscribeFocusGoalCapture } from "../lib/capture";
import { openPalette, openShortcuts } from "../lib/palette";
import { colorOf, displayNameOf, useTeam } from "../lib/team";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { UserAdminDialog } from "./UserAdminDialog";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Hint } from "./Hint";
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


/** ヘッダーのアイコンボタン。ホバーは Hint（吹き出し）で統一——title=操作名（常時）、
 *  hint=一歩踏み込んだ説明（OKで消える。無い操作は省略でラベルだけの吹き出し） */
function IconButton({
  id,
  title,
  hint,
  onClick,
  active,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Hint id={id} always={title} text={hint}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={active ? "text-ai" : undefined}
        onClick={onClick}
      >
        {children}
      </Button>
    </Hint>
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
      placeholder="やりたいことを書く → Enter で新しいプロジェクト"
      aria-label="やりたいことを登録して新しいプロジェクトを作る"
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

/** ログイン中のユーザーチップ（チーム化 2026-08-04）。イニシャル丸 + 表示名。クリックで
 *  メニュー（表示名・メール + パスワード変更 + admin ならユーザー管理 + ログアウト）。
 *  未ログイン運用では何も出さない（従来の見た目のまま）。
 *  ロスターが1人でもログイン中なら出してよい（degrade 原則の例外） */
function UserChip() {
  const { me, users } = useTeam();
  const [pwOpen, setPwOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  if (!me.email) return null;
  const name = me.displayName || displayNameOf(me.email, users);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-full border border-border py-0.5 pl-1 pr-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            title={me.email}
          >
            {/* 丸の地色はユーザーの決定的カラー（colorOf。2026-08-04）——どの画面のバッジとも同じ色 */}
            <span
              className="inline-flex size-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
              style={{ background: colorOf(me.email) }}
            >
              {name.slice(0, 1).toUpperCase()}
            </span>
            <span className="max-w-28 truncate max-md:hidden">{name}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="flex flex-col">
            <span>{name}</span>
            <span className="text-xs font-normal text-muted-foreground">{me.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setPwOpen(true)}>
            <KeyRound className="size-3.5" /> パスワード変更
          </DropdownMenuItem>
          {/* ユーザー管理は admin のみ（サーバ側でも当然に検査される。UI は導線を隠すだけ） */}
          {me.admin && (
            <DropdownMenuItem onSelect={() => setAdminOpen(true)}>
              <Users className="size-3.5" /> ユーザー管理
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              // Cookie を消してからリロード=ログイン画面へ（logout の失敗はリロードで気付ける）
              void api.logout().finally(() => window.location.reload());
            }}
          >
            <LogOut className="size-3.5" /> ログアウト
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
      {me.admin && <UserAdminDialog open={adminOpen} onOpenChange={setAdminOpen} />}
    </>
  );
}

export function TopBar({ chatOpen, onToggleChat, onOpenSettings, onUndo, onCaptureGoal }: Props) {
  // エンジン稼働インジケータ（5秒毎ポーリング）。平常時は何も出さず、
  // 「AIが動いていない」ときだけ警告として表示する（2026-07-31 本人指示。
  // ノード数バッジも同時に廃止: 常時出る情報バッジは圧になるだけ）
  const { data: engineStatus } = usePolling(() => api.getEngineStatus(), 5000);
  const engineDown = engineStatus != null && !engineStatus.alive;
  // 本体の更新（selfupdate.ts。2026-08-05）。エンジン停止表示と同じ流儀で、
  // 「更新がある」ときだけ小さく出す（クリックで設定の「アップデート」節へ）。
  // 5分毎の**表示用**ポーリングで、origin を見に行くのはサーバ側の定期チェック
  const { data: updateStatus } = usePolling(() => api.getUpdate(), 5 * 60 * 1000);
  const updateAvailable = (updateStatus?.behind ?? 0) > 0 || updateStatus?.restartPending === true;

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
          <IconButton
            id="undo"
            title="元に戻す (Ctrl+Z)"
            hint="直前のグラフ操作を取り消す（操作ログへの補償追記なので、AIの変更も戻せる）"
            onClick={onUndo}
          >
            <Undo2 />
          </IconButton>
        </span>
        {engineDown && (
          <Hint
            id="engine-down"
            always={`最終確認: ${engineStatus?.lastSeen ?? "-"}\n起動: pnpm --filter @graphwrangler/engine start`}
            text="AI・スクリプトのノードを自動で進めるプロセスが動いていない。起動するまでノードは進まない"
          >
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <i className="inline-block size-2 flex-shrink-0 rounded-full bg-text-lo" />
              エンジン停止中
            </span>
          </Hint>
        )}
        {updateAvailable && (
          <Hint
            id="update-available"
            always={
              updateStatus?.restartPending
                ? "更新を取り込み済み（再起動待ち）"
                : `更新が ${updateStatus?.behind} コミットあります`
            }
            text="GraphWrangler 本体の新しい版が origin にある。押すと設定の「アップデート」節が開く（取り込みと再起動はそこから）"
          >
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full border border-ai/40 px-2 py-0.5 text-xs text-ai transition-colors hover:bg-ai/10"
              onClick={onOpenSettings}
            >
              <ArrowUpCircle className="size-3.5" />
              {updateStatus?.restartPending ? "再起動待ち" : "更新あり"}
            </button>
          </Hint>
        )}
      </div>
      {/* 旧「あなたの番 N」＝受信箱があった場所。数を数える箱をやめ、ゴールを投げ込む口にした */}
      <div className="flex w-full min-w-0 max-w-md justify-center px-2">
        <GoalCapture onCapture={onCaptureGoal} />
      </div>
      <div className="flex flex-1 items-center justify-end gap-3">
        <IconButton
          id="search"
          title="全ノード検索 (Ctrl+K)"
          hint="タイトル・detail で全ページのノードを横断検索して移動"
          onClick={() => openPalette()}
        >
          <Search />
        </IconButton>
        {/* キーボードショートカットはモバイルでは無意味なので隠す */}
        <span className="max-md:hidden">
          <IconButton id="shortcuts" title="ショートカット一覧 (?)" onClick={() => openShortcuts()}>
            <Keyboard />
          </IconButton>
        </span>
        <IconButton id="settings" title="設定" onClick={onOpenSettings}>
          <Settings />
        </IconButton>
        {/* モバイルでは下部タブバーの「チャット」と重複するので隠す（2026-08-02 本人指示） */}
        <span className="max-md:hidden">
          <IconButton
            id="chat-ai"
            title="GraphWrangler AI とチャット"
            hint="グラフ全体を見て分解・整理・一括操作を手伝うAI。ノード単位の相談はノードを開いた先の Task AI へ"
            onClick={onToggleChat}
            active={chatOpen}
          >
            <Icon name="chat" size={16} />
          </IconButton>
        </span>
        <UserChip />
      </div>
    </header>
  );
}
