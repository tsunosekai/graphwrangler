// グラフビューのキーボードショートカット一覧（? / Shift+/ で開く。ツールバーの⌨からも）。
// Houdini/Blender/ComfyUI 等のノードエディタに準じたショートカット群のリファレンス。
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

interface ShortcutRow {
  keys: string[];
  desc: string;
}

// マウス操作の一覧（2026-08-05 追加）。エッジ接続・紐からのノード生成などは画面上に
// ホバーで説明を付けられる要素が無い（キャンバス自体が対象）ため、発見の場をここに置く
const MOUSE_ROWS: ShortcutRow[] = [
  { keys: ["ドラッグ"], desc: "画面を動かす（ホイールでズーム）" },
  { keys: ["Shift", "ドラッグ"], desc: "矩形選択（Shift/Ctrl+クリックで追加選択）" },
  { keys: ["ダブルクリック"], desc: "ノードのタイトルを編集" },
  // 右クリックは例外なくメニュー（2026-08-09 案B）。空白の右クリックが直接ノードを作る
  // 挙動は廃止し、メニューの「ここにノードを作る」に入った
  { keys: ["右クリック"], desc: "メニュー（ノード / 空白 / 左レールの行 / 台帳）" },
  { keys: ["○からドラッグ"], desc: "ノード下端の点から次のノードへ依存エッジをつなぐ" },
  { keys: ["紐を空白で放す"], desc: "その位置に新しいノードを作って接続" },
  { keys: ["エッジをクリック"], desc: "選択して✂で依存を切る" },
];

const ROWS: ShortcutRow[] = [
  { keys: ["Ctrl", "K"], desc: "ノード検索" },
  { keys: ["Ctrl", "Z"], desc: "元に戻す" },
  { keys: ["Ctrl", "Shift", "Z"], desc: "やり直す" },
  { keys: ["Delete"], desc: "選択エッジを切断（無ければ選択ノードを削除）" },
  { keys: ["Ctrl", "A"], desc: "ページ内の全ノードを選択" },
  { keys: ["Ctrl", "C"], desc: "選択ノードをコピー" },
  { keys: ["Ctrl", "V"], desc: "貼り付け" },
  { keys: ["Ctrl", "D"], desc: "複製" },
  { keys: ["F"], desc: "選択ノードにズーム（無ければ全体表示）" },
  { keys: ["L"], desc: "整列" },
  { keys: ["F2"], desc: "選択ノード（単一）をリネーム" },
  { keys: ["Tab"], desc: "選択ノードの子ノードを作成してリネーム" },
  { keys: ["Escape"], desc: "選択解除" },
  { keys: ["?"], desc: "このショートカット一覧を開く" },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
      {children}
    </kbd>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutsDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>ショートカット一覧</DialogTitle>
          <DialogDescription>
            グラフビュー上で有効（入力欄・ダイアログにフォーカス中は無効）。右クリックのメニューだけは
            左レールの行・台帳でも使える
          </DialogDescription>
        </DialogHeader>
        {/* 2節構成で縦に長くなったため、小さい画面でははみ出さず内部スクロール */}
        <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto">
          <h3 className="text-xs font-semibold tracking-wide text-text-lo">マウス</h3>
          {MOUSE_ROWS.map((row) => (
            <div key={row.desc} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">{row.desc}</span>
              <span className="flex flex-shrink-0 items-center gap-1">
                {row.keys.map((k, i) => (
                  <span key={k} className="flex items-center gap-1">
                    {i > 0 && <span className="text-muted-foreground">+</span>}
                    <Kbd>{k}</Kbd>
                  </span>
                ))}
              </span>
            </div>
          ))}
          <h3 className="mt-2 text-xs font-semibold tracking-wide text-text-lo">キーボード</h3>
          {ROWS.map((row) => (
            <div key={row.desc} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">{row.desc}</span>
              <span className="flex flex-shrink-0 items-center gap-1">
                {row.keys.map((k, i) => (
                  <span key={k} className="flex items-center gap-1">
                    {i > 0 && <span className="text-muted-foreground">+</span>}
                    <Kbd>{k}</Kbd>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
