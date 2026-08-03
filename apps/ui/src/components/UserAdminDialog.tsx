// ユーザー管理ダイアログ（アカウント管理 2026-08-04。me.admin のときだけ TopBar メニューに出る）。
// 一覧 + 追加 + 表示名変更 + admin/無効化トグル + パスワードリセット。
// - 完全削除は UI に置かない: 無効化（Linear の Suspend 相当）が UI の到達点で、削除は CLI のみ
// - 初期パスワード / リセット後パスワードはサーバ応答で一度だけ返り、保存されない——
//   下部のパネルに表示してコピーさせる（閉じると二度と出ない旨を明記）
// - 自分自身の admin 剥奪・無効化はサーバが 400 で拒否するが、UI でも disabled にして防ぐ
// - 操作後は TeamContext の refreshUsers でロスターを再取得（全画面のバッジ・候補が追従する）
import { useState } from "react";
import { Copy, KeyRound, Loader2, Pencil } from "lucide-react";
import { api } from "../lib/api";
import { confirmDialog, promptDialog } from "../lib/dialogs";
import { colorOf, displayNameOf, initialOf, sameEmail, useTeam } from "../lib/team";
import { pushToast } from "../lib/toast";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 一度だけ表示するパスワード（追加 or リセットの応答）。閉じる/次の操作で消える */
interface IssuedPassword {
  email: string;
  password: string;
  kind: "add" | "reset";
}

export function UserAdminDialog({ open, onOpenChange }: Props) {
  const { me, users, refreshUsers } = useTeam();
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedPassword | null>(null);
  const [addEmail, setAddEmail] = useState("");
  const [addName, setAddName] = useState("");

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      // パスワードの一度きり表示は閉じたら消す（state に残さない）
      setIssued(null);
      setAddEmail("");
      setAddName("");
    }
  };

  /** 操作の共通ラッパ: busy ガード + 成功後のロスター再取得（エラーは api.ts がトースト済み） */
  const run = async (op: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await op();
      refreshUsers();
    } catch {
      // api() 側でエラートースト表示済み
    } finally {
      setBusy(false);
    }
  };

  const addUser = () =>
    run(async () => {
      const email = addEmail.trim();
      if (!email) return;
      const res = await api.adminAddUser(email, addName.trim() || undefined);
      setIssued({ ...res, kind: "add" });
      setAddEmail("");
      setAddName("");
    });

  const rename = (email: string, currentName: string | null) =>
    run(async () => {
      const value = await promptDialog("表示名を変更", {
        defaultValue: currentName ?? "",
        confirmLabel: "変更",
      });
      if (value === null) return; // キャンセル
      await api.adminPatchUser({ email, displayName: value.trim() });
    });

  const toggleAdmin = (email: string, next: boolean) =>
    run(async () => {
      await api.adminPatchUser({ email, admin: next });
    });

  const toggleDisabled = (email: string, next: boolean) =>
    run(async () => {
      if (next) {
        const ok = await confirmDialog(
          `${displayNameOf(email, users)} を無効化しますか？\nログインできなくなり、新しい割当の候補にも出なくなります（有効化で元に戻せます）`,
          { confirmLabel: "無効化", danger: true },
        );
        if (!ok) return;
      }
      await api.adminPatchUser({ email, disabled: next });
    });

  const resetPassword = (email: string) =>
    run(async () => {
      const ok = await confirmDialog(
        `${displayNameOf(email, users)} のパスワードをリセットしますか？\n現在のパスワードは使えなくなります`,
        { confirmLabel: "リセット" },
      );
      if (!ok) return;
      const res = await api.adminResetPassword(email);
      setIssued({ ...res, kind: "reset" });
    });

  const copyIssued = () => {
    if (!issued) return;
    navigator.clipboard
      .writeText(issued.password)
      .then(() => pushToast("パスワードをコピーしました", "info"))
      .catch(() => pushToast("コピーできませんでした（手動で控えてください）"));
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>ユーザー管理</DialogTitle>
          <DialogDescription>
            無効化はログイン停止（元に戻せます）。アカウントの削除はここからはできません
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
          {users.map((u) => {
            const self = sameEmail(u.email, me.email);
            return (
              <div
                key={u.email}
                className={cn(
                  "flex items-center gap-2 rounded-md border border-border px-2.5 py-2",
                  u.disabled && "opacity-60",
                )}
              >
                <span
                  className="inline-flex size-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
                  style={{ background: colorOf(u.email) }}
                >
                  {initialOf(u.email, users)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 text-sm">
                    <span className="truncate">{displayNameOf(u.email, users)}</span>
                    {u.admin && <Badge variant="outline">admin</Badge>}
                    {u.disabled && <Badge variant="outline">無効</Badge>}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  title="表示名を変更"
                  disabled={busy}
                  onClick={() => void rename(u.email, u.displayName)}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <label
                  className="flex items-center gap-1 text-xs text-muted-foreground"
                  title={self ? "自分自身の admin は外せません" : "管理者権限"}
                >
                  <Switch
                    checked={u.admin}
                    disabled={busy || self}
                    onCheckedChange={(v) => void toggleAdmin(u.email, v)}
                  />
                  admin
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  title={self ? "自分自身は無効化できません" : undefined}
                  disabled={busy || self}
                  onClick={() => void toggleDisabled(u.email, !u.disabled)}
                >
                  {u.disabled ? "有効化" : "無効化"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  title="パスワードをリセット（新パスワードを一度だけ表示）"
                  disabled={busy}
                  onClick={() => void resetPassword(u.email)}
                >
                  <KeyRound className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>

        {/* 一度きりのパスワード表示。サーバは保存しないので、ここを逃すとリセットし直しになる */}
        {issued && (
          <div className="flex flex-col gap-1 rounded-md border border-border bg-muted p-2.5">
            <span className="text-xs text-muted-foreground">
              {issued.kind === "add" ? "初期パスワード" : "新しいパスワード"}（
              {issued.email}）— この画面を閉じると二度と表示されません
            </span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-background px-1.5 py-0.5 font-mono text-sm">
                {issued.password}
              </code>
              <Button type="button" variant="outline" size="sm" onClick={copyIssued}>
                <Copy className="size-3.5" /> コピー
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <span className="text-sm text-muted-foreground">ユーザーを追加</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              className="h-8 min-w-40 flex-1 text-sm"
              type="email"
              placeholder="メールアドレス"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
            />
            <Input
              className="h-8 w-32 text-sm"
              placeholder="表示名（任意）"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addUser();
              }}
            />
            <Button type="button" size="sm" disabled={busy || !addEmail.trim()} onClick={() => void addUser()}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              追加
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
