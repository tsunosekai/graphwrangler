// 内蔵ログイン画面（2026-08-03。サーバの users.json にユーザーが居る運用でのみ表示される）。
// 成功すると httpOnly Cookie が張られ、以後の操作は本人のメールが帰属として記録される
import { useState } from "react";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface Props {
  onLoggedIn: () => void;
}

export function LoginScreen({ onLoggedIn }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(email.trim(), password);
      onLoggedIn();
    } catch {
      // api() が toast も出すが、フォーム内にも残す（見落とし防止）
      setError("メールアドレスかパスワードが違います");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <form
        onSubmit={submit}
        className="flex w-80 flex-col gap-3 rounded-lg border border-border bg-card p-6"
      >
        <h1 className="text-lg font-semibold">GraphWrangler</h1>
        <p className="text-sm text-muted-foreground">ログインしてください</p>
        <Input
          type="email"
          autoComplete="username"
          placeholder="メールアドレス"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <Input
          type="password"
          autoComplete="current-password"
          placeholder="パスワード"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? "確認中…" : "ログイン"}
        </Button>
      </form>
    </div>
  );
}
