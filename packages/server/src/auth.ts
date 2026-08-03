// 内蔵ログイン（2026-08-03 本人指示「ちゃんとシステム化してほしい、ログインを」）。
// - アカウント: sidecar/users.json（git 管理外）。email + scrypt ハッシュ。
//   管理は scripts/gw-user.mjs（サーバは users.json を毎回読み直すので再起動不要）
// - セッション: HMAC-SHA256 署名付きトークンを httpOnly Cookie に載せるステートレス方式
//   （サーバ側セッションストアなし。失効はパスワード変更＝ユーザー行削除で必要十分）
// - ゲートの適用範囲は index.ts 側: ユーザーが1人でも居れば「外部経由（X-Forwarded-For
//   あり=リバースプロキシ越し）」の /api/* にセッション必須。ローカル直（エンジン・MCP・
//   同一マシンの curl）は従来どおり通す——ポートは loopback バインドなので、外から
//   届く経路はプロキシ経由しか無い
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const SESSION_COOKIE = "gw_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

const UserSchema = z.object({
  email: z.string().min(1),
  /** scrypt(password, salt) の hex */
  hash: z.string().min(1),
  salt: z.string().min(1),
  created: z.string().optional(),
});
export type User = z.infer<typeof UserSchema>;
const UsersFileSchema = z.object({ users: z.array(UserSchema).default([]) });

/** users.json を読む（毎回読み直す=CLIでの追加・削除が再起動なしで効く。壊れていたら空扱い） */
export function loadUsers(file: string): User[] {
  try {
    if (!fs.existsSync(file)) return [];
    return UsersFileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))).users;
  } catch {
    console.error(`[auth] users.json が読めません（ログイン全拒否で継続）: ${file}`);
    return [];
  }
}

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt ?? crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(password, s, 32).toString("hex");
  return { hash: h, salt: s };
}

export function verifyPassword(user: User, password: string): boolean {
  const { hash } = hashPassword(password, user.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(user.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** セッション署名鍵。sidecar/auth-secret に生成・永続化（git 管理外。無ければ作る） */
export function ensureSecret(file: string): string {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // 無ければ生成
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret + "\n", { encoding: "utf8", mode: 0o600 });
  return secret;
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

/** セッショントークン: base64url({email, exp}) + "." + HMAC 署名 */
export function createSession(email: string, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ email, exp: now + SESSION_TTL_MS })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload, secret)}`;
}

/** 検証。改ざん・期限切れ・形式不正は null */
export function verifySession(token: string, secret: string, now = Date.now()): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.email !== "string" || typeof parsed.exp !== "number") return null;
    if (parsed.exp < now) return null;
    return parsed.email;
  } catch {
    return null;
  }
}
