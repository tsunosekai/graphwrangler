// アプリ内の確認/入力ダイアログのホスト（App 直下に常駐。ToastHost と同じ位置づけ）。
// ブラウザ標準の window.confirm / window.prompt の代替で、呼び出しは lib/dialogs.ts の
// confirmDialog / promptDialog から行う。複数の要求はキューにして1つずつ表示する。
import { useEffect, useState } from "react";
import { subscribeDialogs, type DialogRequest } from "../lib/dialogs";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

export function DialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const [value, setValue] = useState("");
  const current = queue[0] ?? null;

  useEffect(() => subscribeDialogs((req) => setQueue((q) => [...q, req])), []);

  // prompt の初期値は要求ごとにリセットする
  useEffect(() => {
    if (current?.kind === "prompt") setValue(current.defaultValue ?? "");
  }, [current]);

  if (!current) return null;

  const finish = (submit: boolean) => {
    if (current.kind === "confirm") current.resolve(submit);
    else current.resolve(submit ? value : null);
    setQueue((q) => q.slice(1));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && finish(false)}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="whitespace-pre-line text-base font-medium leading-relaxed">
            {current.message}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {current.kind === "confirm" ? "確認ダイアログ" : "入力ダイアログ"}
          </DialogDescription>
        </DialogHeader>
        {current.kind === "prompt" && (
          <Input
            autoFocus
            value={value}
            placeholder={current.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                finish(true);
              }
            }}
          />
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={() => finish(false)}>
            キャンセル
          </Button>
          <Button
            type="button"
            autoFocus={current.kind === "confirm"}
            variant={current.kind === "confirm" && current.danger ? "outline" : "default"}
            className={
              current.kind === "confirm" && current.danger
                ? "border-destructive/40 text-destructive"
                : "text-primary-foreground"
            }
            onClick={() => finish(true)}
          >
            {current.confirmLabel ?? "OK"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
