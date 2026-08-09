// アプリ内の確認/入力ダイアログのホスト（App 直下に常駐。ToastHost と同じ位置づけ）。
// ブラウザ標準の window.confirm / window.prompt の代替で、呼び出しは lib/dialogs.ts の
// confirmDialog / promptDialog / formDialog から行う。複数の要求はキューにして1つずつ表示する。
import { useEffect, useState } from "react";
import { subscribeDialogs, type DialogRequest } from "../lib/dialogs";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

export function DialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const [value, setValue] = useState("");
  // form 用の欄ごとの値（キーは fields[].name。docs/design.md 3.15 発火フォーム等）
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const current = queue[0] ?? null;

  useEffect(() => subscribeDialogs((req) => setQueue((q) => [...q, req])), []);

  // prompt / form の初期値は要求ごとにリセットする
  useEffect(() => {
    if (current?.kind === "prompt") setValue(current.defaultValue ?? "");
    if (current?.kind === "form") {
      setValue(current.titleInput?.defaultValue ?? "");
      // プリフィル（直近ランの context 等）は宣言されている欄のぶんだけ取り込む
      const init: Record<string, string> = {};
      for (const f of current.fields) {
        const v = current.prefill?.[f.name];
        if (v !== undefined) init[f.name] = v;
      }
      setFieldValues(init);
    }
  }, [current]);

  if (!current) return null;

  const finish = (submit: boolean) => {
    if (current.kind === "confirm") current.resolve(submit ? "confirm" : "cancel");
    else if (current.kind === "prompt") current.resolve(submit ? value : null);
    else {
      // 空欄のキーは落として返す（空文字を context に積まない。docs/design.md 3.15）
      const values: Record<string, string> = {};
      for (const f of current.fields) {
        const v = fieldValues[f.name];
        if (v !== undefined && v !== "") values[f.name] = v;
      }
      current.resolve(submit ? { title: value, values } : null);
    }
    setQueue((q) => q.slice(1));
  };

  /** 第3の選択肢（confirm の alt。例: 削除の代わりにアーカイブ） */
  const finishAlt = () => {
    if (current.kind === "confirm") current.resolve("alt");
    setQueue((q) => q.slice(1));
  };
  const alt = current.kind === "confirm" ? current.alt : undefined;

  // Enter で確定（IME変換中は除く）。prompt / form の各入力欄で共通
  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      finish(true);
    }
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
            onKeyDown={submitOnEnter}
          />
        )}
        {current.kind === "form" && (
          <div className="flex flex-col gap-2">
            {current.titleInput && (
              <Input
                autoFocus
                value={value}
                placeholder={current.titleInput.placeholder}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={submitOnEnter}
              />
            )}
            {/* 宣言された欄（トリガーの outputs 等）。全部任意＝空のまま OK できる。
                label をラベル、example をプレースホルダに使う（docs/design.md 3.15） */}
            {current.fields.map((f) => (
              <label key={f.name} className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <span className="w-24 flex-shrink-0 truncate" title={f.name}>
                  {f.label || f.name}
                </span>
                <Input
                  className="h-8 flex-1"
                  autoFocus={!current.titleInput && f.name === current.fields[0]?.name}
                  value={fieldValues[f.name] ?? ""}
                  placeholder={f.example ?? undefined}
                  onChange={(e) =>
                    setFieldValues((prev) => ({ ...prev, [f.name]: e.target.value }))
                  }
                  onKeyDown={submitOnEnter}
                />
              </label>
            ))}
          </div>
        )}
        {/* alt がある確認は「推し（alt）を右端の primary」に置き、危ない方（confirm）は
            その左の控えめなボタンに落とす。初期フォーカスも推しへ渡す（2026-08-09） */}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={() => finish(false)}>
            キャンセル
          </Button>
          <Button
            type="button"
            autoFocus={current.kind === "confirm" && !alt}
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
          {alt && (
            <Button type="button" autoFocus className="text-primary-foreground" onClick={finishAlt}>
              {alt.label}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
