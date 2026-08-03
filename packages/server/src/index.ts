// graphwrangler API サーバ。コアの GraphStore / ThreadStore を HTTP で公開する。
// UI も MCP もエンジンも、全員がこの API（＝操作ログ）を通る。
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  GraphStore,
  ThreadStore,
  RunStore,
  GraphError,
  DecisionRequestSchema,
  NodeInputSchema,
  NodePatchSchema,
  ActorSchema,
  RunItemStatusSchema,
  nowIso,
  type Actor,
} from "@graphwrangler/core";
import { z } from "zod";
import { chatKeyMissing, completeText, handleChat } from "./chat.js";
import { handleChatCli } from "./chat_cli.js";
import {
  SettingsStore,
  AiSettingsSchema,
  ChatSettingsSchema,
  EngineSettingsSchema,
  GitSettingsSchema,
} from "./settings.js";
import { GitSync } from "./gitsync.js";
import { resolveWorkspacePath } from "./files.js";
import { isThreadAiRunning, maybeTriggerThreadAi } from "./thread_ai.js";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  currentUserEmail,
  currentUserStore,
  ensureSecret,
  generatePassword,
  hashPassword,
  loadUsers,
  passwordVersion,
  resolveSessionUser,
  saveUsers,
  verifyPassword,
} from "./auth.js";
import { assertTrialAllowed, runTrial, sha256Hex, substituteParams, trialCwd } from "./trial.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const port = Number(process.env.GRAPHWRANGLER_PORT ?? 8770);

// ---- 起動時解決: ワークスペースモード（ワークスペース=1ファイル化） or 従来の data-dir モード ----
// 優先順: GRAPHWRANGLER_WORKSPACE 環境変数 → --workspace <path> CLI引数 → 従来の GRAPHWRANGLER_DATA。
// path が ".gw.json" で終わればそのファイルを正データファイルとし、それ以外はディレクトリと
// みなして "<dir>/workflow.gw.json" を正データファイルにする（仕様書「ファイルレイアウト」参照）。

/** --workspace <path> の値を argv から取り出す（無ければ null） */
function parseWorkspaceArg(argv: string[]): string | null {
  const idx = argv.indexOf("--workspace");
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value) throw new Error("--workspace には path を指定してください");
  return value;
}

/** rawPath から正データファイルの絶対パスを決める */
function resolveCanonicalFile(rawPath: string): string {
  const abs = path.resolve(rawPath);
  if (abs.toLowerCase().endsWith(".gw.json")) return abs;
  return path.join(abs, "workflow.gw.json");
}

// users.json（パスワードハッシュ）と auth-secret（セッション署名鍵）は絶対にコミットさせない
// （authDir = sidecar なので、この2行が無いとワークスペースモードで git に乗ってしまう）
const GITIGNORE_CONTENT = "ops.jsonl\nruns/\nsettings.json\nreads.json\nusers.json\nauth-secret\n";

const workspaceArg = process.env.GRAPHWRANGLER_WORKSPACE ?? parseWorkspaceArg(process.argv.slice(2));

let graph: GraphStore;
let threads: ThreadStore;
let runs: RunStore;
let settings: SettingsStore;
let serverModeLabel: string;
/** ワークスペースモードのみ生成される自動プッシュ（gitsync.ts）。datadir モードでは null */
let gitSync: GitSync | null = null;

/** GraphWrangler AI の会話履歴の保存先（sidecar/chats/ または dataDir/chats/。threads と同じく
 *  コミット対象＝gitignore に入れない。2026-07-31 本人要望「会話履歴も見れるように」で
 *  localStorage からサーバ保存へ移行） */
let chatsDir: string;

/** ログインユーザー（users.json）とセッション署名鍵（auth-secret）の置き場
 *  （sidecar または dataDir。どちらも git 管理外）。auth.ts / scripts/gw-user.mjs 参照 */
let authDir: string;

/** 既読時刻の保存先（sidecar/reads.json）。2026-08-02 本人要望「PC で読んだノードが
 *  スマホでは全部未読になる」への対応で localStorage からサーバ保存へ移行した。
 *  中身は { nodeId: ISO時刻 }。個人の閲覧状態であって活動の記録ではないので
 *  gitignore 側（settings.json と同じ扱い＝毎時コミットを汚さない） */
let readsFile: string;

if (workspaceArg) {
  const canonicalFile = resolveCanonicalFile(workspaceArg);
  const workspaceRoot = path.dirname(canonicalFile);
  const sidecarDir = path.join(workspaceRoot, ".graphwrangler");
  fs.mkdirSync(sidecarDir, { recursive: true });
  const gitignorePath = path.join(sidecarDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, "utf8");
  } else {
    // 既存ワークスペースにも後から増えた行（reads.json 等）を足す。作り直しではなく追記
    // なので、人が手で加えた行は消えない
    const current = fs.readFileSync(gitignorePath, "utf8");
    const lines = new Set(current.split("\n").map((l) => l.trim()));
    const missing = GITIGNORE_CONTENT.split("\n").filter((l) => l && !lines.has(l));
    if (missing.length > 0) {
      fs.appendFileSync(gitignorePath, (current.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n", "utf8");
    }
  }
  graph = GraphStore.workspace(canonicalFile, sidecarDir);
  threads = new ThreadStore(sidecarDir);
  runs = new RunStore(sidecarDir);
  settings = new SettingsStore(sidecarDir); // settings.json は sidecar 配下＝gitignore 済みなのでAPIキーは漏れない
  chatsDir = path.join(sidecarDir, "chats");
  readsFile = path.join(sidecarDir, "reads.json");
  authDir = sidecarDir;
  serverModeLabel = `workspace: ${canonicalFile}`;
  // 自動プッシュ（gitsync.ts）。対象は GW が書くファイルだけ: 正データファイル + sidecar
  // （sidecar 内の runs/ops 等は .gitignore が除外する）。有効/無効は settings.git（既定OFF）
  gitSync = new GitSync({
    root: workspaceRoot,
    paths: [path.basename(canonicalFile), ".graphwrangler"],
    getConfig: () => settings.get().git,
  });
  gitSync.start();
} else {
  const dataDir = process.env.GRAPHWRANGLER_DATA ?? path.join(repoRoot, "data");
  graph = new GraphStore(dataDir);
  threads = new ThreadStore(dataDir);
  runs = new RunStore(dataDir);
  settings = new SettingsStore(dataDir);
  chatsDir = path.join(dataDir, "chats");
  readsFile = path.join(dataDir, "reads.json");
  authDir = dataDir;
  serverModeLabel = `data: ${dataDir}`;
}

// ---- 内蔵ログイン（auth.ts。2026-08-03 本人指示「ちゃんとシステム化してほしい、ログインを」）----
// users.json にユーザーが1人でも居ればログイン必須になる。ただし適用は「外部経由」
// （X-Forwarded-For あり=リバースプロキシ越し）の /api/* のみ——:8770 は loopback バインド
// なので外から届く経路はプロキシしか無く、ローカル直のエンジン・MCP は従来どおり動く。
// ユーザーが居なければ何も変わらない（zinsei の Tailscale 内・個人運用はログイン無しのまま）
const usersFile = path.join(authDir, "users.json");
const sessionSecret = ensureSecret(path.join(authDir, "auth-secret"));

// ---- GraphWrangler AI 会話履歴の保存/取得（UIMessage[] スナップショット。UI は 2026-08-02 から
// キー "global" の1本だけを使う。エンドポイントはキー汎用のまま=旧ページ単位ファイルも読める） ----

function chatHistoryPath(pageId: string): string | null {
  // ファイル名に使うのはノードid（n-... 形式）か "global" のみ。パス脱出を構造で防ぐ
  if (!/^[A-Za-z0-9_-]+$/.test(pageId)) return null;
  return path.join(chatsDir, `${pageId}.json`);
}

/** 会話アーカイブ（「新しい会話」で退避したセッション履歴）の保存先。pageId検証は
 *  chatHistoryPath と共通（拡張子だけ .archive.json に差し替える） */
function chatArchivePath(pageId: string): string | null {
  const file = chatHistoryPath(pageId);
  return file ? file.replace(/\.json$/, ".archive.json") : null;
}

interface ChatArchiveSession {
  id: string;
  ts: string;
  messages: unknown[];
}

function readChatArchive(file: string): ChatArchiveSession[] {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as ChatArchiveSession[]) : [];
  } catch {
    return [];
  }
}

/** ラン既定タイトル「MM/DD HH:mm のラン」（docs/design.md 3.8） */
function defaultRunTitle(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi} のラン`;
}

const app = new Hono();
app.use("/api/*", cors());

// ---- Cloudflare Access 連携: 「誰が操作しているか」の受け取り（2026-08-03 本人要望
// 「だれが操作してるか分からない」）。ログインを自作せず、Access が認証済みユーザーの
// メールを毎リクエスト Cf-Access-Authenticated-User-Email ヘッダで渡してくるのを使う。
// このヘッダは Access を通らない経路では誰でも付けられるため、**明示オプトイン**:
// env GRAPHWRANGLER_TRUST_ACCESS_EMAIL=1 のときだけ信用する（cloudflared トンネル +
// :8770 loopback バインドで「Access を通らない経路が無い」構成が前提。zinsei の
// Tailscale 内アクセスのような Access 無し運用では設定しない＝従来どおり）----
const trustAccessEmail = process.env.GRAPHWRANGLER_TRUST_ACCESS_EMAIL === "1";
// 操作者メールのリクエストスコープ保持は auth.ts の currentUserStore（chat.ts と共用）
const accessEmailStore = currentUserStore;

app.use("/api/*", async (c, next) => {
  // 操作者の特定: ①内蔵ログインのセッションCookie ②（オプトイン時のみ）Access ヘッダ。
  // Cookie は署名・期限に加えて「ユーザーが現存・非無効化・パスワード版数一致」まで見る
  // （resolveSessionUser。2026-08-04 失効の穴ふさぎ——それまでは remove しても30日生きた）
  let email: string | undefined;
  const token = getCookie(c, SESSION_COOKIE);
  if (token) email = resolveSessionUser(token, sessionSecret, usersFile)?.email;
  if (!email && trustAccessEmail) {
    const accessEmail = c.req.header("Cf-Access-Authenticated-User-Email");
    // Access 認証済みでも users.json 上で無効化されている人は操作者と認めない
    if (accessEmail) {
      const u = loadUsers(usersFile).find(
        (x) => x.email.toLowerCase() === accessEmail.toLowerCase(),
      );
      if (!u?.disabled) email = accessEmail;
    }
  }

  // ログインゲート: ユーザー登録があり、かつ外部経由（プロキシ越し）なら未ログインを弾く。
  // /api/login と /api/me だけはログイン前でも通す（ログイン画面が使うため）
  const authRequired = loadUsers(usersFile).length > 0;
  const external = !!c.req.header("x-forwarded-for");
  const p = c.req.path;
  if (authRequired && external && !email && p !== "/api/login" && p !== "/api/me") {
    return c.json({ error: "ログインが必要です" }, 401);
  }

  if (email) {
    await accessEmailStore.run(email, next);
    return;
  }
  await next();
});

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

/** ユーザー属性の変更（管理者）: 表示名・管理者・無効化。
 *  自分自身の admin 剥奪・無効化は拒否（自分を締め出す操作は別の管理者がやる） */
app.post("/api/admin/users/patch", async (c) => {
  if (!isAdminRequest(c)) return c.json({ error: "管理者のみ実行できます" }, 403);
  const body = z
    .object({
      email: z.string(),
      displayName: z.string().nullable().optional(),
      admin: z.boolean().optional(),
      disabled: z.boolean().optional(),
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

/** リクエストボディから帰属メタ（actor/via）を取り出す。既定は human/ui。
 *  body に actor が無い（=UIからの操作）とき、Access のメールが分かれば actor.name に刻む
 *  ——ops・スレッド発言の「誰が」がメールで残る（複数人運用の帰属。design 3.2） */
function meta(body: Record<string, unknown>): { actor: Actor; via: string; user: string | null } {
  const accessEmail = accessEmailStore.getStore();
  const actor = body.actor
    ? ActorSchema.parse(body.actor)
    : { kind: "human" as const, ...(accessEmail ? { name: accessEmail } : {}) };
  const via = typeof body.via === "string" ? body.via : "ui";
  // user = 操作の背後にいる人間（actor が agent でも保持。addNode の createdBy に刻まれる）
  return { actor, via, user: accessEmail ?? null };
}

app.onError((err, c) => {
  if (err instanceof GraphError) {
    return c.json({ error: err.message }, err.status as 400);
  }
  if (err instanceof z.ZodError) {
    return c.json({ error: err.issues.map((i) => i.message).join("; ") }, 400);
  }
  console.error(err);
  return c.json({ error: String(err) }, 500);
});

// ---- 既読時刻（端末をまたいで共有する。2026-08-02 localStorage から移行、
//      2026-08-03 チーム運用のため per-user 化。docs/design.md 3.11） ----
//
// ファイル形式 v2: { version: 2, shared: {nodeId: ts}, users: { email: {nodeId: ts} } }
// - shared  … ログイン無し（匿名）運用の既読置き場。旧フラット形式はここへ読み替える
//             （zinsei の一人運用は従来どおり「端末をまたいで共有」の挙動のまま）
// - users   … ログインユーザーごとの既読。ユーザーの見る既読 = shared と自分の max マージ
//             （per-user 化の導入時に、それまで共有だった既読が急に未読へ戻らないため）
// 書き込みは、匿名なら shared へ、ログイン中なら自分のバケツへ。

interface ReadsFile {
  shared: Record<string, string>;
  users: Record<string, Record<string, string>>;
}

/** メモリ上のキャッシュ。プロセス内で唯一の書き手なので、読むたびに読み直す必要はない */
let readsCache: ReadsFile | null = null;

function sanitizeMarks(v: unknown): Record<string, string> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([, t]) => typeof t === "string"),
      ) as Record<string, string>)
    : {};
}

function loadReadsFile(): ReadsFile {
  if (readsCache) return readsCache;
  try {
    const raw = fs.readFileSync(readsFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      if (o.version === 2) {
        const users: Record<string, Record<string, string>> = {};
        for (const [email, marks] of Object.entries(
          o.users && typeof o.users === "object" ? (o.users as Record<string, unknown>) : {},
        )) {
          users[email] = sanitizeMarks(marks);
        }
        readsCache = { shared: sanitizeMarks(o.shared), users };
      } else {
        // 旧フラット形式 {nodeId: ts} → shared として読み替え（次回保存で v2 になる）
        readsCache = { shared: sanitizeMarks(parsed), users: {} };
      }
    } else {
      readsCache = { shared: {}, users: {} };
    }
  } catch {
    // 未作成・壊れている場合は空から始める（既読は補助情報なので落とさない）
    readsCache = { shared: {}, users: {} };
  }
  return readsCache;
}

function saveReadsFile(next: ReadsFile): void {
  readsCache = next;
  fs.mkdirSync(path.dirname(readsFile), { recursive: true });
  fs.writeFileSync(readsFile, JSON.stringify({ version: 2, ...next }, null, 2), "utf8");
}

/** 今の操作者から見た既読 = shared と自分のバケツの max マージ（匿名は shared のみ） */
function loadReads(): Record<string, string> {
  const file = loadReadsFile();
  const email = currentUserEmail();
  const own = email ? (file.users[email] ?? {}) : {};
  const merged: Record<string, string> = { ...file.shared };
  for (const [nodeId, ts] of Object.entries(own)) {
    if (!merged[nodeId] || merged[nodeId] < ts) merged[nodeId] = ts;
  }
  return merged;
}

/** 既読を進める。**巻き戻さない**（別端末が先に進めた既読を、遅れて届いた古い ts で
 *  戻すと未読が復活するため）。1件でも更新があれば true */
function markRead(marks: Record<string, string>): boolean {
  const file = loadReadsFile();
  const email = currentUserEmail();
  const bucket = email ? { ...(file.users[email] ?? {}) } : { ...file.shared };
  const baseline = email ? file.shared : {};
  let changed = false;
  for (const [nodeId, ts] of Object.entries(marks)) {
    if (typeof ts !== "string" || !ts) continue;
    // 操作者から見た現在の既読 = max(shared, 自分のバケツ)。それより進む分だけ書く
    // （shared で既読済みの範囲を自分のバケツへ複製しない）
    const own = bucket[nodeId];
    const shared = baseline[nodeId];
    const effective = own && shared ? (own > shared ? own : shared) : (own ?? shared);
    if (!effective || effective < ts) {
      bucket[nodeId] = ts;
      changed = true;
    }
  }
  if (changed) {
    saveReadsFile(
      email
        ? { ...file, users: { ...file.users, [email]: bucket } }
        : { ...file, shared: bucket },
    );
  }
  return changed;
}

const ReadsPatchSchema = z.object({ marks: z.record(z.string(), z.string()) });

app.post("/api/reads", async (c) => {
  const { marks } = ReadsPatchSchema.parse(await c.req.json());
  markRead(marks);
  return c.json({ reads: loadReads() });
});

// ---- グラフ ----

app.get("/api/state", (c) => {
  // threadMeta: 未読バッジ用にノードごとの最終メッセージ時刻を添える。reads（既読時刻）と
  // 突き合わせてクライアントが未読を判定する。どちらもサーバ持ちなので PC とスマホで一致する
  // （2026-08-02 それまで既読は localStorage で端末ごとに割れていた）。
  // スレッドファイルは小さいので毎回読んで良い規模
  const threadMeta: Record<string, string> = {};
  for (const n of graph.state().nodes) {
    const msgs = threads.list(n.id);
    if (msgs.length > 0) threadMeta[n.id] = msgs[msgs.length - 1].ts;
  }
  return c.json({ ...graph.state(), threadMeta, reads: loadReads(), now: nowIso() });
});

// ---- エクスポート（バックアップ用の一括JSON。APIキーは含まれない） ----

app.get("/api/export", (c) => {
  const nodes = graph.state().nodes;
  const groupIds = new Set(nodes.map((n) => n.group).filter((g): g is string => g !== null));
  const threadDump: Record<string, unknown> = {};
  const runDump: Record<string, unknown> = {};
  for (const n of nodes) {
    const msgs = threads.list(n.id);
    if (msgs.length > 0) threadDump[n.id] = msgs;
    // ページ（goal またはメンバーを持つノード）だけがランを持ちうる
    if (n.kind === "goal" || groupIds.has(n.id)) {
      const list = runs.list(n.id);
      if (list.length > 0) runDump[n.id] = list;
    }
  }
  c.header("Content-Disposition", `attachment; filename="graphwrangler-export.json"`);
  return c.json({
    exportedAt: nowIso(),
    nodes,
    threads: threadDump,
    runs: runDump,
    settings: settings.publicView(),
  });
});

// ---- ワークスペース=1ファイル化: 動作モード + ワークスペース内ファイルの参照 ----

/** 現在の動作モード（workspace/datadir）を返す。GraphStore#workspaceInfo をそのまま公開する */
app.get("/api/workspace", (c) => {
  return c.json(graph.workspaceInfo());
});

/** ワークスペース内のファイルを utf8 テキストとして読む。root（正データファイルの
 *  あるディレクトリ）基準で解決し、絶対パス・".." でのルート外脱出は 400。
 *  ワークスペースモード以外・path 未指定も 400。存在しない/ディレクトリは 404
 *  （engine の impl={type:"doc",path} 解決が主な利用者。仕様書参照） */
app.get("/api/files", (c) => {
  const info = graph.workspaceInfo();
  if (info.mode !== "workspace" || !info.root) {
    return c.json({ error: "ワークスペースモードではありません" }, 400);
  }
  const relPath = c.req.query("path");
  if (!relPath) {
    return c.json({ error: "path クエリパラメータが必要です" }, 400);
  }
  const absolute = resolveWorkspacePath(info.root, relPath);
  if (!absolute) {
    return c.json({ error: `ワークスペース外のパスは指定できません: ${relPath}` }, 400);
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    return c.json({ error: `ファイルが見つかりません: ${relPath}` }, 404);
  }
  const content = fs.readFileSync(absolute, "utf8");
  return c.json({ path: relPath, content });
});

// ---- エンジン稼働ハートビート（UIの稼働インジケータ用。メモリ保持のみ） ----

let engineLastSeen: string | null = null;

app.post("/api/engine/heartbeat", (c) => {
  engineLastSeen = nowIso();
  return c.json({ ok: true });
});

app.get("/api/engine/status", (c) => {
  const alive =
    engineLastSeen !== null && Date.now() - new Date(engineLastSeen).getTime() < 20_000;
  return c.json({ alive, lastSeen: engineLastSeen });
});

app.post("/api/nodes", async (c) => {
  const body = await c.req.json();
  const node = graph.addNode(NodeInputSchema.parse(body), meta(body));
  return c.json(node);
});

app.post("/api/nodes/:id", async (c) => {
  const body = await c.req.json();
  const node = graph.patchNode(c.req.param("id"), NodePatchSchema.parse(body), meta(body));
  return c.json(node);
});

app.post("/api/nodes/:id/remove", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // force=true: Fix済み・メンバー持ち・子持ちでも消す（確認モーダルは UI の責務。
  // メンバーは巻き添え削除、外の子は参照を切り離す。core の removeNode 参照）
  graph.removeNode(c.req.param("id"), meta(body), { force: body?.force === true });
  return c.json({ removed: true });
});

// ---- スクリプト試走（試走ゲート。docs/design.md 3.5 近く。実装は trial.ts） ----
// impl.type==="script" の command を実際に1回動かし、implTrial（hash/success/ts）を
// ノードに記録する。「実装をscriptにするのは宣言であって証明ではない」を埋めるための
// ソフトゲート（ハードブロックはしない。人間が主導権を持つ思想）。
// 2026-07-31: 試走は常に --dry-run 付きで実行する「予告編」に固定（AIが書くスクリプトは
// --dry-run 実装が規約。docs/design.md 3.5.1）。パラメータ宣言（同節）があれば
// substituteParams で {name} を値へ置換してから実行する。未入力があれば実行せず400。

app.post("/api/nodes/:id/trial", async (c) => {
  const id = c.req.param("id");
  const node = graph.get(id);
  assertTrialAllowed(node); // 400: impl.type!=="script"
  const sub = substituteParams(node.impl.command, node.impl.params);
  if (!sub.ok) {
    throw new GraphError(`パラメータが未入力です: ${sub.missing.join(", ")}`, 400);
  }
  const resolvedCommand = `${sub.command} --dry-run`;
  const cwd = trialCwd(graph.workspaceInfo().root);
  const result = await runTrial(resolvedCommand, cwd);
  // hash は command テンプレートのまま（値の変更だけでは stale にしない。既存挙動を維持）
  const implTrial = { hash: sha256Hex(node.impl.command), success: result.success, ts: nowIso() };
  const updated = graph.patchNode(id, { implTrial }, { actor: { kind: "system" }, via: "ui" });
  const resultLabel = result.success ? "試走成功" : `試走失敗（exit ${result.exitCode}）`;
  threads.post(id, {
    kind: "status",
    // resolvedCommand（パラメータ置換後 + --dry-run の実コマンド）を本文に含めて、
    // 追加UI無しでスレッド経由で見えるようにする（docs/design.md 3.5.1）
    body: `${resultLabel}（--dry-run）\n実行: ${resolvedCommand}\n${result.output.slice(0, 500)}`.trim(),
    payload: { implTrial, resolvedCommand },
    author: { kind: "system" },
    via: "ui",
  });
  return c.json({
    success: result.success,
    exitCode: result.exitCode,
    output: result.output.slice(0, 2000),
    implTrial: updated.implTrial,
    resolvedCommand,
  });
});

// ---- 手順書のファイル化（2026-08-02 本人要望「実装の手順をドキュメント化（ファイル化）する
// 機能が欲しい」） ----
// impl.type==="doc" のインライン本文（text）を、ワークスペース内のファイルへ書き出して
// impl を path 参照に切り替える。手順書がリポジトリの普通のファイルになるので、
// エディタで開ける・git で版管理される・スクリプトと同じ場所で育てられる。
// パスは resolveWorkspacePath でルート外への脱出を拒否。fixed ノードは impl 変更が
// patchNode の Fix ガードで 409 になる（＝ロック中はファイル化できない。先に解除）。

const ImplToFileSchema = z.object({
  /** 書き出し先（ワークスペースルートからの相対パス。例: docs/手順.md） */
  path: z.string().min(1),
  /** 既存ファイルがあるとき上書きするか（省略時は 409 で拒否） */
  overwrite: z.boolean().optional(),
});

app.post("/api/nodes/:id/impl/to-file", async (c) => {
  const id = c.req.param("id");
  const node = graph.get(id);
  if (node.impl?.type !== "doc" || !node.impl.text || !node.impl.text.trim()) {
    throw new GraphError("インライン本文を持つ手順書がありません（impl.type=doc で text が必要）", 400);
  }
  const info = graph.workspaceInfo();
  if (info.mode !== "workspace" || !info.root) {
    throw new GraphError("ファイル化はワークスペースモードでのみ使えます", 400);
  }
  const body = await c.req.json();
  const { path: relPathRaw, overwrite } = ImplToFileSchema.parse(body);
  const relPath = relPathRaw.replace(/\\/g, "/");
  const abs = resolveWorkspacePath(info.root, relPath);
  if (!abs) throw new GraphError(`ワークスペース外のパスは指定できません: ${relPath}`, 400);
  if (fs.existsSync(abs) && !overwrite) {
    throw new GraphError(`既にファイルがあります: ${relPath}`, 409);
  }
  const m = meta(body);
  const text = node.impl.text.endsWith("\n") ? node.impl.text : `${node.impl.text}\n`;
  // 先に impl の patch を通す（fixed の 409 をファイル書き込み前に踏むため。
  // patch が通ってから書き込みに失敗した場合は impl を書き戻す）
  graph.patchNode(id, { impl: { type: "doc", path: relPath, text: null } }, m);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  } catch (err) {
    graph.patchNode(id, { impl: node.impl }, m); // 書き込み失敗: インライン本文へ戻す
    throw new GraphError(`ファイルの書き込みに失敗しました: ${String(err)}`, 500);
  }
  threads.post(id, {
    kind: "status",
    body: `手順書をファイル化: ${relPath}`,
    payload: { implToFile: relPath },
    author: m.actor,
    via: m.via,
  });
  return c.json({ ok: true, path: relPath });
});

// ---- スレッド ----

app.get("/api/nodes/:id/thread", (c) => {
  const id = c.req.param("id");
  graph.get(id);
  // aiBusy: Task AI が応答生成中か（UI の「考え中」表示。GraphWrangler AI と挙動を揃える）
  return c.json({ messages: threads.list(id), aiBusy: isThreadAiRunning(id) });
});

const PostMessageSchema = z.object({
  kind: z.enum(["say", "status", "artifact"]).default("say"),
  body: z.string().min(1),
  payload: z.unknown().optional(),
});

app.post("/api/nodes/:id/messages", async (c) => {
  const id = c.req.param("id");
  graph.get(id);
  const body = await c.req.json();
  const input = PostMessageSchema.parse(body);
  const m = meta(body);
  const message = threads.post(id, { ...input, author: m.actor, via: m.via });
  // スレッド相談AI（機能1）: 人間の say かつ open な判断リクエストが無いノードにのみ、
  // 応答を待たず非同期でAI応答ジョブを起動する（thread_ai.ts 参照。レスポンスはブロックしない）
  maybeTriggerThreadAi({ graph, threads, settings, nodeId: id, kind: input.kind, actor: m.actor });
  return c.json(message);
});

/** 判断リクエストを開く（主に agent 側が使う）。pendingRequest がセットされ、ボールが人間に渡る
 *  （「あなたの番（waiting）」表示は UI が pendingRequest の有無から導出する） */
app.post("/api/nodes/:id/request", async (c) => {
  const id = c.req.param("id");
  const node = graph.get(id);
  if (node.pendingRequest) {
    throw new GraphError(`node already has an open request: ${node.pendingRequest}`, 409);
  }
  const body = await c.req.json();
  const m = meta(body);
  const message = threads.openRequest(
    id,
    DecisionRequestSchema.parse(body.request),
    { author: m.actor.kind === "human" ? { kind: "agent" } : m.actor, via: m.via },
  );
  graph.patchNode(
    id,
    { pendingRequest: message.id },
    { actor: { kind: "system" }, via: m.via },
  );
  return c.json(message);
});

const AnswerSchema = z.object({
  requestId: z.string(),
  option: z.string().nullable(),
  note: z.string().nullable().default(null),
});

/** 判断リクエストに答える。選択肢を選んだら pendingRequest が解け、ボールが戻る */
app.post("/api/nodes/:id/answer", async (c) => {
  const id = c.req.param("id");
  graph.get(id);
  const body = await c.req.json();
  const m = meta(body);
  const { message, resolved } = threads.answerRequest(id, AnswerSchema.parse(body), {
    author: m.actor,
    via: m.via,
  });
  if (resolved) {
    graph.patchNode(
      id,
      { pendingRequest: null, status: "pending" },
      { actor: { kind: "system" }, via: m.via },
    );
  }
  return c.json({ message, resolved, node: graph.get(id) });
});

// ---- 分岐ノード（kind=decision。docs/design.md 3.9） ----
// choice 確定 + skip伝搬は GraphStore.applyDecision に一任する（1トランザクション=複数patch opsの連続）。
// UI が直接叩く経路とエンジン(executor=script/ai の結果、または human回答後)が叩く経路の両方が正。

const DecideSchema = z.object({ choice: z.string().min(1) });

app.post("/api/nodes/:id/decide", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { choice } = DecideSchema.parse(body);
  const m = meta(body);
  const updated = graph.applyDecision(id, choice, { actor: m.actor, via: m.via });
  const label = updated.branches?.find((b) => b.id === choice)?.label ?? choice;
  threads.post(id, {
    kind: "status",
    body: `分岐: ${label} を選択`,
    payload: { choice },
    author: m.actor,
    via: m.via,
  });
  return c.json(updated);
});

/** 分岐の選び直し（手戻り）。choice を取り消して pending に戻し、この決着に由来する
 *  skip を復元する（GraphStore.revertDecision）。下流の done は戻さない */
app.post("/api/nodes/:id/decide/revert", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const m = meta(body);
  const updated = graph.revertDecision(id, { actor: m.actor, via: m.via });
  threads.post(id, {
    kind: "status",
    body: "分岐の選択を取り消し（選び直し）",
    author: m.actor,
    via: m.via,
  });
  return c.json(updated);
});

// ---- トリガーノード（kind=trigger。docs/design.md 3.4/3.8/3.9） ----
// 「ルーティーンであること」はページ種別ではなく先頭のトリガーノードから導出する。
// トリガーが発火すると、その group ページで createFromTrigger によりランが1本生成される。

const FireSchema = z.object({
  via: z.string().min(1).optional(),
  /** ランの名前（作品名など）。同じルーティーンを並列で回すとき（パラレルワールド）に
   *  どの世界線か区別するためのラベル。省略時は「MM/DD HH:mm のラン」 */
  title: z.string().min(1).optional(),
});

/** トリガーノードを発火し、その group ページでランを作成する。トリガーのスレッドへ
 *  「発火: <run.title>」を payload {runId} 付きで記録する */
app.post("/api/nodes/:id/fire", async (c) => {
  const id = c.req.param("id");
  const trigger = graph.get(id);
  const body = await c.req.json().catch(() => ({}));
  const { via, title } = FireSchema.parse(body);
  const m = meta(body);
  if (trigger.kind !== "trigger") {
    throw new GraphError(`node ${trigger.id} is not a trigger (kind=${trigger.kind})`, 400);
  }
  const pageId = trigger.group;
  if (!pageId) {
    throw new GraphError(`trigger node ${trigger.id} has no group (page) to fire into`, 400);
  }
  const members = graph.state().nodes.filter((n) => n.group === pageId);
  const run = runs.createFromTrigger(pageId, trigger.id, members, {
    title: title ?? defaultRunTitle(),
    via: via ?? "manual",
  });
  threads.post(trigger.id, {
    kind: "status",
    body: `発火: ${run.title}`,
    payload: { runId: run.id },
    author: m.actor,
    via: m.via,
  });
  return c.json(run);
});

// ---- ラン（実行インスタンス。docs/design.md 3.8） ----

/** ページ(:id)に属するラン一覧（どのページ種別でも同じ形で返る） */
app.get("/api/pages/:id/runs", (c) => {
  const id = c.req.param("id");
  graph.get(id);
  return c.json({ runs: runs.list(id) });
});

app.get("/api/runs/:id", (c) => {
  return c.json(runs.get(c.req.param("id")));
});

const PatchRunItemSchema = z.object({
  status: RunItemStatusSchema.optional(),
  note: z.string().nullable().optional(),
});

/** ワークアイテム更新。テンプレートノードのスレッドへ状態遷移を記録し、
 *  ラン全体が done に転じたらページノードのスレッドにも記録する */
app.post("/api/runs/:id/items/:nodeId", async (c) => {
  const runId = c.req.param("id");
  const nodeId = c.req.param("nodeId");
  const before = runs.get(runId);
  const beforeItem = before.items[nodeId];
  if (!beforeItem) {
    throw new GraphError(`run ${runId} has no work item for node ${nodeId}`, 404);
  }
  const body = await c.req.json();
  const input = PatchRunItemSchema.parse(body);
  const run = runs.patchItem(runId, nodeId, { status: input.status, note: input.note });
  const m = meta(body);
  const node = graph.get(nodeId);
  const fromStatus = beforeItem.status;
  const toStatus = run.items[nodeId].status;
  threads.post(nodeId, {
    kind: "status",
    body: `[ラン ${runId}] ${node.title}: ${fromStatus} → ${toStatus}`,
    payload: { runId },
    author: m.actor,
    via: m.via,
  });
  if (before.status !== "done" && run.status === "done") {
    threads.post(run.procedure, {
      kind: "status",
      body: `ラン完了: ${run.title}`,
      payload: { runId },
      author: { kind: "system" },
      via: m.via,
    });
  }
  return c.json(run);
});

const DecideRunItemSchema = z.object({ choice: z.string().min(1) });

/** ラン内の分岐アイテム(kind=decision)の choice を確定する（docs/design.md 3.9のラン内版）。
 *  templates はページの全メンバー（RunStore.applyItemDecision が parentOptions/branches の
 *  定義を引くのに必要。ラン作成時と同じ group=ページ フィルタ） */
app.post("/api/runs/:id/items/:nodeId/decide", async (c) => {
  const runId = c.req.param("id");
  const nodeId = c.req.param("nodeId");
  const run = runs.get(runId);
  const node = graph.get(nodeId);
  const body = await c.req.json();
  const { choice } = DecideRunItemSchema.parse(body);
  const m = meta(body);
  const templates = graph.state().nodes.filter((n) => n.group === run.procedure);
  const updated = runs.applyItemDecision(runId, nodeId, choice, templates);
  const label = node.branches?.find((b) => b.id === choice)?.label ?? choice;
  threads.post(nodeId, {
    kind: "status",
    body: `[ラン ${runId}] 分岐: ${label} を選択`,
    payload: { runId, choice },
    author: m.actor,
    via: m.via,
  });
  if (run.status !== "done" && updated.status === "done") {
    threads.post(run.procedure, {
      kind: "status",
      body: `ラン完了: ${run.title}`,
      payload: { runId },
      author: { kind: "system" },
      via: m.via,
    });
  }
  return c.json(updated);
});

const RenameRunSchema = z.object({ title: z.string().min(1) });

/** ラン名の変更（並列ラン=世界線の区別用ラベル） */
app.post("/api/runs/:id/rename", async (c) => {
  const { title } = RenameRunSchema.parse(await c.req.json());
  return c.json(runs.rename(c.req.param("id"), title));
});

app.post("/api/runs/:id/cancel", (c) => {
  return c.json(runs.cancel(c.req.param("id")));
});

/** トレース再生: ページノード+全ワークアイテムのスレッドから payload.runId が一致する
 *  メッセージを集め、ts 昇順で返す（docs/design.md 3.8「トレース」） */
app.get("/api/runs/:id/trace", (c) => {
  const runId = c.req.param("id");
  const run = runs.get(runId);
  const nodeIds = [run.procedure, ...Object.keys(run.items)];
  const events: Array<ReturnType<typeof threads.list>[number] & { nodeTitle: string }> = [];
  for (const nodeId of nodeIds) {
    if (!graph.has(nodeId)) continue;
    const node = graph.get(nodeId);
    for (const msg of threads.list(nodeId)) {
      const payload = msg.payload as { runId?: string } | null;
      if (payload && payload.runId === runId) {
        events.push({ ...msg, nodeTitle: node.title });
      }
    }
  }
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return c.json({ events });
});

// ---- 元に戻す / やり直す（操作ログの補償追記。core の undoLast/redoLast） ----

app.post("/api/undo", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const undone = graph.undoLast(meta(body));
  if (!undone) return c.json({ error: "戻せる操作がありません" }, 400);
  return c.json({ undone: { id: undone.id, op: undone.op, ts: undone.ts } });
});

app.post("/api/redo", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const redone = graph.redoLast(meta(body));
  if (!redone) return c.json({ error: "やり直せる操作がありません" }, 400);
  return c.json({ redone: { id: redone.id, op: redone.op, ts: redone.ts } });
});

// ---- AI設定（初回セットアップ + ⚙。実装は settings.ts。キーの値は返さない） ----

const SettingsPatchSchema = z.object({
  chat: ChatSettingsSchema.partial().optional(),
  engine: EngineSettingsSchema.partial().optional(),
  ai: AiSettingsSchema.partial().optional(),
  git: GitSettingsSchema.partial().optional(),
  setupDone: z.boolean().optional(),
});

app.get("/api/settings", (c) => c.json(settings.publicView()));

app.post("/api/settings", async (c) => {
  const body = SettingsPatchSchema.parse(await c.req.json());
  settings.update(body);
  return c.json(settings.publicView());
});

// ---- 自動プッシュ（gitsync.ts。ワークスペースモードのみ） ----

app.get("/api/gitsync", (c) => {
  if (!gitSync) {
    return c.json({
      enabled: false,
      unavailableReason: "ワークスペースモードではないため使えません",
      running: false,
      lastRunAt: null,
      lastPushAt: null,
      lastResult: null,
    });
  }
  return c.json(gitSync.status());
});

/** 手動で1回同期する（設定OFFでも可＝「今すぐ push」ボタン用） */
app.post("/api/gitsync/run", async (c) => {
  if (!gitSync) return c.json({ error: "ワークスペースモードではないため使えません" }, 400);
  const result = await gitSync.runOnce();
  return c.json(result, result.ok ? 200 : 500);
});

// GraphWrangler AI の会話履歴（GET=読み込み / PUT=丸ごと保存。UIMessage[] はサーバでは
// 不透明なJSONとして扱う。threads と同じくコミット対象）
app.get("/api/chats/:pageId", (c) => {
  const file = chatHistoryPath(c.req.param("pageId"));
  if (!file) throw new GraphError("不正なページidです", 400);
  if (!fs.existsSync(file)) return c.json({ messages: [] });
  try {
    return c.json({ messages: JSON.parse(fs.readFileSync(file, "utf8")) });
  } catch {
    return c.json({ messages: [] });
  }
});

app.put("/api/chats/:pageId", async (c) => {
  const file = chatHistoryPath(c.req.param("pageId"));
  if (!file) throw new GraphError("不正なページidです", 400);
  const body = await c.req.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  fs.mkdirSync(chatsDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(messages, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return c.json({ ok: true, count: messages.length });
});

// GraphWrangler AI の会話アーカイブ（「新しい会話」でスナップショットを退避した過去セッション）。
// POST=現行の会話を1件追記 / GET=一覧取得（新しい順で返す。ファイルへは追記=古い順で保存する）
app.post("/api/chats/:pageId/archive", async (c) => {
  const file = chatArchivePath(c.req.param("pageId"));
  if (!file) throw new GraphError("不正なページidです", 400);
  const body = await c.req.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const sessions = readChatArchive(file);
  sessions.push({ id: randomUUID(), ts: nowIso(), messages });
  fs.mkdirSync(chatsDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return c.json({ ok: true, count: sessions.length });
});

app.get("/api/chats/:pageId/archive", (c) => {
  const file = chatArchivePath(c.req.param("pageId"));
  if (!file) throw new GraphError("不正なページidです", 400);
  return c.json({ sessions: [...readChatArchive(file)].reverse() });
});

// ---- チャット（グラフ整理の GraphWrangler AI。実装は chat.ts / chat_cli.ts） ----
// chat.mode="cli" ならヘッドレスCLI（chat_cli.ts、MCP経由でグラフ操作）へ、
// "api" なら従来どおりプロバイダAPIキー方式（chat.ts）へ分岐する。
// APIキー未設定の400判定は api モードのときだけ行う（cliモードにAPIキーは無関係）。

app.post("/api/chat", async (c) => {
  const body = await c.req.json();
  if (settings.get().chat.mode === "cli") {
    return handleChatCli(graph, threads, settings, body, port);
  }
  const missing = chatKeyMissing(settings);
  if (missing) return c.json({ error: missing }, 400);
  return handleChat(graph, threads, settings, body);
});

// ---- エンジンの API 方式（engine.mode="api"）向け: ツールなしの単発テキスト生成 ----
// engine executor（packages/engine/src/executors/api.ts）がこれを叩く。
// プロバイダ/キーはチャット設定を間借りするため、キー未設定の判定もチャット側で行う。

const AiCompleteSchema = z.object({
  prompt: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
});

app.post("/api/ai/complete", async (c) => {
  const missing = chatKeyMissing(settings);
  if (missing) return c.json({ error: missing }, 400);
  const body = AiCompleteSchema.parse(await c.req.json());
  const text = await completeText(settings, body.prompt, body.maxTokens);
  return c.json({ text });
});

// ---- UI 配信（ビルド済みがあれば） ----

const uiDist = path.join(repoRoot, "apps", "ui", "dist");
if (fs.existsSync(uiDist)) {
  const root = path.relative(process.cwd(), uiDist).split(path.sep).join("/");
  // キャッシュ規律（2026-08-02）: index.html はデプロイで差し替わるため no-cache
  // （ブラウザのヒューリスティックキャッシュで古いUIが配信され続ける実害があった）。
  // ハッシュ付き /assets/ は内容が変われば名前も変わるので長期キャッシュしてよい
  app.use("/*", async (c, next) => {
    await next();
    if (c.req.path.startsWith("/assets/")) {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      c.header("Cache-Control", "no-cache");
    }
  });
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

// バインド先。既定は従来どおり全インターフェイス（Tailscale 内アクセス等の互換）だが、
// リバースプロキシ越しに公開する構成では **GRAPHWRANGLER_HOST=127.0.0.1 を必ず設定する**
// （露出したままだと試走APIほかが認証なしで外から叩ける。2026-08-03 stremix 公開時に対応）
const host = process.env.GRAPHWRANGLER_HOST ?? "0.0.0.0";
serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`graphwrangler server: http://${host}:${port} (${serverModeLabel})`);
});
