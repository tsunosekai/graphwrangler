// 内蔵ログイン・アカウント管理のルート（旧 index.ts から移設）。
// ログインゲートの middleware 自体は index.ts に残る（全 /api/* に先行して掛けるため）。
import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { nowIso } from "@graphwrangler/core";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  currentUserStore,
  generatePassword,
  hashPassword,
  loadUsers,
  passwordVersion,
  saveUsers,
  verifyPassword,
} from "../auth.js";
import type { AppContext } from "../app_context.js";

export function authRoutes(ctx: AppContext): Hono {
  const { usersFile, sessionSecret } = ctx;
  const accessEmailStore = currentUserStore;
  const app = new Hono();

  /** 現在の操作者と、ログインが必要な運用かどうか（UI がログイン画面を出す判定に使う） */
  app.get("/api/me", (c) => {
    const email = accessEmailStore.getStore() ?? null;
    const user = email
      ? loadUsers(usersFile).find((u) => u.email.toLowerCase() === email.toLowerCase())
      : undefined;
    return c.json({
      email,
      displayName: user?.displayName ?? null,
      admin: user?.admin === true,
      authRequired: loadUsers(usersFile).length > 0,
    });
  });

  /** 登録ユーザー一覧（担当者セレクト・人フィルタ・表示名解決用のロスター。
   *  ハッシュ等の秘匿情報は返さない。ログイン無し運用では空配列 = UI は人系UIを出さない。
   *  disabled も返す: 無効化ユーザーは表示名解決には要るが、担当候補・フィルタからは
   *  UI 側が除外する（Linear の Suspend と同じ「履歴は保つ・新規の割当先にはしない」） */
  app.get("/api/users", (c) =>
    c.json({
      users: loadUsers(usersFile).map((u) => ({
        email: u.email,
        displayName: u.displayName ?? null,
        admin: u.admin === true,
        disabled: u.disabled === true,
        discordId: u.discordId ?? null,
      })),
    }),
  );

  /** セッション Cookie の共通オプション（login と パスワード変更後の張り直しで共用）。
   *  https で来ている（プロキシが X-Forwarded-Proto を付ける）場合のみ Secure。
   *  Tailscale 内の素の http 運用でも使えるようにする */
  function sessionCookieOpts(c: Parameters<typeof setCookie>[0]) {
    return {
      path: "/",
      httpOnly: true,
      sameSite: "Lax" as const,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      secure: c.req.header("x-forwarded-proto") === "https",
    };
  }

  app.post("/api/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const user = loadUsers(usersFile).find((u) => u.email.toLowerCase() === email);
    if (!user || !password || !verifyPassword(user, password)) {
      // 総当たりを鈍らせる固定ディレイ（本格的なレート制限は前段のリバースプロキシの領分）
      await new Promise((r) => setTimeout(r, 500));
      return c.json({ error: "メールアドレスかパスワードが違います" }, 401);
    }
    if (user.disabled) {
      return c.json({ error: "このアカウントは無効化されています（管理者に連絡してください）" }, 403);
    }
    setCookie(
      c,
      SESSION_COOKIE,
      createSession(user.email, passwordVersion(user), sessionSecret),
      sessionCookieOpts(c),
    );
    return c.json({ email: user.email });
  });

  app.post("/api/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ---- アカウント管理（チーム運用 P1。2026-08-04 本人依頼「P1 やりましょう」）----
  //
  // 権限モデル: 管理者（users.json の admin:true）だけがユーザーの追加・無効化・
  // パスワードリセットをできる。ローカル直（プロキシ越しでない=そのマシンに入れる人）は
  // 従来どおり信頼済み扱い＝CLI（gw-user.mjs）と同じ地位。
  // 完全削除は CLI のみ（帰属の表示名解決を壊す操作を UI に置かない。無効化で足りる）

  /** 操作者が管理者権限を持つか。ローカル直はサーバの立つマシンに入れる人＝常に許可 */
  function isAdminRequest(c: { req: { header(name: string): string | undefined } }): boolean {
    const email = accessEmailStore.getStore();
    if (email) {
      const u = loadUsers(usersFile).find((x) => x.email.toLowerCase() === email.toLowerCase());
      return u?.admin === true;
    }
    // 操作者メール無しで届くのはローカル直だけ（外部経由の未ログインはゲートで 401 済み）
    return !c.req.header("x-forwarded-for");
  }

  /** 本人によるパスワード変更。現パスワードの確認必須。変更後は自分のセッションを
   *  新しい版数で張り直す（本人は継続、他端末・漏れた Cookie は即失効） */
  app.post("/api/me/password", async (c) => {
    const email = accessEmailStore.getStore();
    if (!email) return c.json({ error: "ログイン中のみパスワードを変更できます" }, 400);
    const body = z
      .object({
        current: z.string(),
        next: z.string().min(8, "新しいパスワードは8文字以上にしてください"),
      })
      .parse(await c.req.json());
    const users = loadUsers(usersFile);
    const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (!user) return c.json({ error: "ユーザーが見つかりません" }, 404);
    if (!verifyPassword(user, body.current)) {
      await new Promise((r) => setTimeout(r, 500));
      return c.json({ error: "現在のパスワードが違います" }, 401);
    }
    Object.assign(user, hashPassword(body.next));
    saveUsers(usersFile, users);
    setCookie(
      c,
      SESSION_COOKIE,
      createSession(user.email, passwordVersion(user), sessionSecret),
      sessionCookieOpts(c),
    );
    return c.json({ ok: true });
  });

  /** ユーザー追加（管理者）。初期パスワードは自動生成してこの応答で一度だけ返す
   *  （保存しない。管理者が本人へ渡し、本人がパスワード変更で上書きする想定） */
  app.post("/api/admin/users", async (c) => {
    if (!isAdminRequest(c)) return c.json({ error: "管理者のみ実行できます" }, 403);
    const body = z
      .object({
        email: z.string().email("メールアドレスの形式が不正です"),
        displayName: z.string().optional(),
      })
      .parse(await c.req.json());
    const users = loadUsers(usersFile);
    if (users.some((u) => u.email.toLowerCase() === body.email.toLowerCase())) {
      return c.json({ error: `既に存在します: ${body.email}` }, 409);
    }
    const password = generatePassword();
    users.push({
      email: body.email,
      ...hashPassword(password),
      ...(body.displayName ? { displayName: body.displayName } : {}),
      created: nowIso(),
    });
    saveUsers(usersFile, users);
    return c.json({ email: body.email, password });
  });

  /** ユーザー属性の変更（管理者）: 表示名・管理者・無効化・Discord ID。
   *  自分自身の admin 剥奪・無効化は拒否（自分を締め出す操作は別の管理者がやる） */
  app.post("/api/admin/users/patch", async (c) => {
    if (!isAdminRequest(c)) return c.json({ error: "管理者のみ実行できます" }, 403);
    const body = z
      .object({
        email: z.string(),
        displayName: z.string().nullable().optional(),
        admin: z.boolean().optional(),
        disabled: z.boolean().optional(),
        /** Discord のユーザーID（メンション通知用）。null/空文字で解除 */
        discordId: z.string().nullable().optional(),
      })
      .parse(await c.req.json());
    const users = loadUsers(usersFile);
    const user = users.find((u) => u.email.toLowerCase() === body.email.toLowerCase());
    if (!user) return c.json({ error: `見つかりません: ${body.email}` }, 404);
    const me = accessEmailStore.getStore();
    if (
      me &&
      me.toLowerCase() === user.email.toLowerCase() &&
      (body.admin === false || body.disabled === true)
    ) {
      return c.json({ error: "自分自身の管理者権限剥奪・無効化はできません" }, 400);
    }
    if (body.displayName !== undefined) {
      if (body.displayName) user.displayName = body.displayName;
      else delete user.displayName;
    }
    if (body.admin !== undefined) {
      if (body.admin) user.admin = true;
      else delete user.admin;
    }
    if (body.disabled !== undefined) {
      if (body.disabled) user.disabled = true;
      else delete user.disabled;
    }
    if (body.discordId !== undefined) {
      const id = body.discordId?.trim();
      if (id) {
        if (!/^\d{5,25}$/.test(id)) {
          return c.json({ error: "Discord ID は数字です（開発者モード→ユーザー右クリック→IDをコピー）" }, 400);
        }
        user.discordId = id;
      } else {
        delete user.discordId;
      }
    }
    saveUsers(usersFile, users);
    return c.json({ ok: true });
  });

  /** パスワードリセット（管理者）。新パスワードを自動生成してこの応答で一度だけ返す。
   *  版数が変わるので本人の既存セッションは即失効する */
  app.post("/api/admin/users/reset-password", async (c) => {
    if (!isAdminRequest(c)) return c.json({ error: "管理者のみ実行できます" }, 403);
    const body = z.object({ email: z.string() }).parse(await c.req.json());
    const users = loadUsers(usersFile);
    const user = users.find((u) => u.email.toLowerCase() === body.email.toLowerCase());
    if (!user) return c.json({ error: `見つかりません: ${body.email}` }, 404);
    const password = generatePassword();
    Object.assign(user, hashPassword(password));
    saveUsers(usersFile, users);
    return c.json({ email: user.email, password });
  });

  return app;
}
