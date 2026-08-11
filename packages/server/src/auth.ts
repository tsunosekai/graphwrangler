// 内蔵ログイン（2026-08-03 本人指示「ちゃんとシステム化してほしい、ログインを」）。
// - アカウント: sidecar/users.json（git 管理外）。email + scrypt ハッシュ。
//   管理は scripts/gw-user.mjs（サーバは users.json を毎回読み直すので再起動不要）
// - セッション: HMAC-SHA256 署名付きトークンを httpOnly Cookie に載せるステートレス方式
//   （サーバ側セッションストアなし。失効はパスワード変更＝ユーザー行削除で必要十分）
// - ゲートの適用範囲は index.ts 側: ユーザーが1人でも居れば「外部経由（X-Forwarded-For
//   あり=リバースプロキシ越し）」の /api/* にセッション必須。ローカル直（エンジン・MCP・
//   同一マシンの curl）は従来どおり通す——ポートは loopback バインドなので、外から
//   届く経路はプロキシ経由しか無い
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** リクエストスコープの操作者メール（セッション Cookie / Access ヘッダから index.ts の
 *  ミドルウェアが解決して run() する）。chat.ts などリクエスト処理の奥からも
 *  「今の操作の背後にいる人間」を参照できるよう auth に置く（index との循環 import 回避） */
export const currentUserStore = new AsyncLocalStorage<string>();

/** 今のリクエストの操作者メール（未ログイン・リクエスト外は null） */
export function currentUserEmail(): string | null {
  return currentUserStore.getStore() ?? null;
}

export const SESSION_COOKIE = "gw_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

const UserSchema = z.object({
  email: z.string().min(1),
  /** scrypt(password, salt) の hex */
  hash: z.string().min(1),
  salt: z.string().min(1),
  /** 表示名（チーム運用でメールの @ 前より読みやすい名前を出す用。省略可）。
   *  管理は scripts/gw-user.mjs の add/name か管理者UI。actor.name に刻むのは常にメール
   *  （不変の識別子）で、表示名への解決は UI 側の仕事 */
  displayName: z.string().optional(),
  /** 管理者（ユーザー管理UIが使える）。付与は gw-user.mjs admin か管理者UI */
  admin: z.boolean().optional(),
  /** 無効化（Linear の Suspend 相当）。ログイン・セッションを即座に拒否するが、
   *  ロスターには残す＝過去の createdBy/assignee/members の表示名解決を壊さない。
   *  完全削除（remove）は CLI のみ＝帰属を壊す操作は UI に置かない */
  disabled: z.boolean().optional(),
  /** Discord のユーザーID（数字）。「あなたの番」の Webhook 通知（discord.ts）で
   *  <@id> メンションに使う。設定は管理者UI か gw-user.mjs discord */
  discordId: z.string().optional(),
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

/** パスワード版数: ハッシュの先頭8桁。トークンに焼き込み、パスワード変更で
 *  既存セッションを即失効させる（署名鍵は全体共通なので、per-user の失効はこれが担う） */
export function passwordVersion(user: User): string {
  return user.hash.slice(0, 8);
}

/** セッショントークン: base64url({email, exp, v}) + "." + HMAC 署名。
 *  v = パスワード版数（必須。v を持たないトークンは verifySession で落ちる） */
export function createSession(
  email: string,
  pwVersion: string,
  secret: string,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: now + SESSION_TTL_MS, v: pwVersion }),
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** 署名・期限・形式の検証のみ（ユーザーの実在・無効化・版数の照合は resolveSessionUser が担う）。
 *  改ざん・期限切れ・形式不正は null */
export function verifySession(
  token: string,
  secret: string,
  now = Date.now(),
): { email: string; v: string } | null {
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
      v?: unknown;
    };
    if (typeof parsed.email !== "string" || typeof parsed.exp !== "number") return null;
    if (typeof parsed.v !== "string") return null;
    if (parsed.exp < now) return null;
    return { email: parsed.email, v: parsed.v };
  } catch {
    return null;
  }
}

/** トークン → 有効なユーザー。**セッション失効の正体はここ**（2026-08-04。
 *  それまでは署名と期限しか見ておらず、remove したユーザーの Cookie が30日生き残る穴があった）:
 *  ①ユーザーが users.json に現存し ②無効化されておらず ③トークンの版数が現在の
 *  パスワードと一致する、の3つが揃って初めてセッションと認める */
export function resolveSessionUser(token: string, secret: string, usersFile: string): User | null {
  const session = verifySession(token, secret);
  if (!session) return null;
  const user = loadUsers(usersFile).find(
    (u) => u.email.toLowerCase() === session.email.toLowerCase(),
  );
  if (!user || user.disabled) return null;
  if (passwordVersion(user) !== session.v) return null;
  return user;
}

/** users.json の保存（gw-user.mjs と同じ流儀: tmp + rename のアトミック書き、mode 0600） */
export function saveUsers(file: string, users: User[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
}

/** 紛らわしい文字（0O1lI）を除いた自動生成パスワード（gw-user.mjs と同一ロジック。
 *  管理者UIの「追加」「パスワードリセット」が使う。値は応答で一度だけ見せる） */
export function generatePassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(16), (b) => chars[b % chars.length]).join("");
}
