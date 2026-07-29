// グラフビューのキーボードショートカット一覧（? / Shift+/ で開く。ツールバーの⌨からも）。
// Houdini/Blender/ComfyUI 等のノードエディタに準じたショートカット群のリファレンス。
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

interface ShortcutRow {
  keys: string[];
  desc: string;
}

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
          <DialogDescription>グラフビュー上で有効（入力欄・ダイアログにフォーカス中は無効）</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
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
