// 自分のパスワード変更ダイアログ（アカウント管理 2026-08-04）。TopBar のユーザーチップ
// メニューから開く。成功時はサーバが新しいセッション Cookie を自動で張り直すため、
// リロード不要でログアウトもされない（POST /api/me/password の契約）。
// クライアントで弾ける分（確認不一致・8文字未満）は送信前に弾き、サーバ側の検査
// （401=現パスワード違い等）は api.ts の共通トースト経路でメッセージ表示される
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../lib/api";
import { pushToast } from "../lib/toast";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({ open, onOpenChange }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  // 入力途中で怒らないよう、両欄が埋まってから出すインラインエラー
  const clientError =
    next && next.length < 8
      ? "新しいパスワードは8文字以上にしてください"
      : next && confirm && next !== confirm
        ? "確認用パスワードが一致しません"
        : null;
  const canSubmit = !busy && current.length > 0 && next.length >= 8 && next === confirm;

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      // 閉じたら入力を消す（パスワードを state に残さない）
      setCurrent("");
      setNext("");
      setConfirm("");
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await api.changePassword(current, next);
      pushToast("パスワードを変更しました", "info");
      close(false);
    } catch {
      // api() 側でエラートースト表示済み。ダイアログは開いたまま=入力し直せる
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>パスワード変更</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="現在のパスワード"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="新しいパスワード（8文字以上）"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="新しいパスワード（確認）"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          {clientError && <p className="text-xs text-destructive">{clientError}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)}>
            キャンセル
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            変更する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
