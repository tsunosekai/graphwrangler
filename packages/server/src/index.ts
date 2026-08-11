// graphwrangler API サーバ。コアの GraphStore / ThreadStore を HTTP で公開する。
// UI も MCP もエンジンも、全員がこの API（＝操作ログ）を通る。
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { GraphStore, ThreadStore, RunStore, GraphError, nowIso } from "@graphwrangler/core";
import { z } from "zod";
import { chatKeyMissing, completeText, handleChat } from "./chat.js";
import { activeChatCliCount, handleChatCli } from "./chat_cli.js";
import {
  SettingsStore,
  AiSettingsSchema,
  BrandingSettingsSchema,
  ChatSettingsSchema,
  EngineSettingsSchema,
  GitSettingsSchema,
  NotifySettingsSchema,
  UpdateSettingsSchema,
} from "./settings.js";
import {
  FAVICON_MAX_BYTES,
  IndexHtmlRenderer,
  brandingDir,
  clearFavicon,
  detectFaviconType,
  faviconContentType,
  readFavicon,
  writeFavicon,
} from "./branding.js";
import { sendDiscordWebhook } from "./discord.js";
import { UserPrefsSchema, UserSettingsStore } from "./user_settings.js";
import { GitSync } from "./gitsync.js";
import { SelfUpdate } from "./selfupdate.js";
import { threadAiActiveCount } from "./thread_ai.js";
import { getCookie } from "hono/cookie";
import {
  SESSION_COOKIE,
  currentUserEmail,
  currentUserStore,
  ensureSecret,
  loadUsers,
  resolveSessionUser,
} from "./auth.js";
import { ReadsStore } from "./reads.js";
import type { AppContext } from "./app_context.js";
import { authRoutes } from "./routes/auth.js";
import { graphRoutes } from "./routes/graph.js";
import { nodeRoutes } from "./routes/nodes.js";
import { runRoutes } from "./routes/runs.js";
import { threadRoutes } from "./routes/threads.js";

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
// branding/ もインスタンス固有（settings.json と同じ扱い）。会社/個人で別のロゴを出すための
// 手置き画像なので、リポジトリに乗せるとワークスペースを共有した相手の見た目まで変わる。
// runfiles/ はラン毎の作業ディレクトリ（GW_RUN_DIR。docs/design.md 3.15「成果物はファイル、
// context にはパス」）——実行の中間生成物なのでコミットさせない
const GITIGNORE_CONTENT =
  "ops.jsonl\nruns/\nrunfiles/\nsettings.json\nuser-settings.json\nreads.json\nusers.json\nauth-secret\nattachments/\nbranding/\n";

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

/** インスタンスのブランディング画像の置き場（sidecar/branding または dataDir/branding。
 *  どちらも git 管理外）。selfupdate でコードが入れ替わっても残る場所に置く＝更新でロゴが消えない */
let brandingPath: string;

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
  brandingPath = brandingDir(sidecarDir);
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
  brandingPath = brandingDir(dataDir);
  serverModeLabel = `data: ${dataDir}`;
}

// 操作ログ（ops.jsonl）を実態に合わせる（2026-08-08）。GraphWrangler を通らない書き換え
// （移行データの流し込み・git pull・他エージェントの直接編集）はログに載らないため、
// 起動のたびに差分を system 印で追記しておく。これをやらないと「ランの時点のノード」を
// 再構築する GET /api/runs/:id/graph が実態とずれる。正データファイルには書かない
{
  const fixed = graph.reconcileLog();
  if (fixed.added || fixed.patched || fixed.removed) {
    console.log(
      `[graph] 操作ログを実態に合わせました: +${fixed.added} 変更${fixed.patched} 削除${fixed.removed}`,
    );
  }
}

// ---- 本体の自動アップデート（selfupdate.ts。2026-08-05 本人要望「zinsei と stremix で
//      別インスタンスなので自動アップデートが欲しい」）。対象はワークスペース（データ）ではなく
//      **このアプリのクローン**なので、モードに関わらず常に立ち上げる ----
const selfUpdate = new SelfUpdate({
  root: repoRoot,
  getConfig: () => settings.get().update,
  // 会話の途中で自動アップデートの再起動が入ると、SSE と CLI 子プロセスが殺されて
  // 「ネットワークエラー」「応答が消えた」に見える（2026-08-07 調査）。応答中は見送る
  isBusy: () => {
    if (activeChatCliCount() > 0) return "チャットの応答が進行中";
    if (threadAiActiveCount() > 0) return "Task AI の応答が進行中";
    return null;
  },
});
void selfUpdate.init().then(() => selfUpdate.start());

// ---- 内蔵ログイン（auth.ts。2026-08-03 本人指示「ちゃんとシステム化してほしい、ログインを」）----
// users.json にユーザーが1人でも居ればログイン必須になる。ただし適用は「外部経由」
// （X-Forwarded-For あり=リバースプロキシ越し）の /api/* のみ——:8770 は loopback バインド
// なので外から届く経路はプロキシしか無く、ローカル直のエンジン・MCP は従来どおり動く。
// ユーザーが居なければ何も変わらない（zinsei の Tailscale 内・個人運用はログイン無しのまま）
const usersFile = path.join(authDir, "users.json");
const sessionSecret = ensureSecret(path.join(authDir, "auth-secret"));

// ---- ユーザーごとの設定（user_settings.ts。2026-08-07「設定はユーザーごとと全体で分けて」）----
// authDir と同じ場所（sidecar または dataDir）に user-settings.json として持つ
const userSettings = new UserSettingsStore(authDir);

// ---- 既読時刻（reads.ts。端末をまたいで共有 + ログインユーザーごと。docs/design.md 3.11）----
const reads = new ReadsStore(readsFile);

// ---- チャットの添付ファイル（2026-08-07 本人要望「ファイル添付機能」）----
// 置き場は sidecar/attachments（gitignore 済み＝**リポジトリには決して入らない**）。
// AI はメッセージ中の「[添付ファイル: <絶対パス>]」を Read で読む。データは使い捨ての
// 受け渡し場所なので、7日より古いものは自動削除する（重いデータを溜め込まない）
const attachmentsDir = path.join(authDir, "attachments");
const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function pruneAttachments(): void {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(attachmentsDir)) {
      const p = path.join(attachmentsDir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && Date.now() - st.mtimeMs > ATTACHMENT_TTL_MS) {
          fs.unlinkSync(p);
          removed++;
        }
      } catch {
        // 個別失敗は無視（次回また試す）
      }
    }
  } catch {
    return; // ディレクトリ未作成など
  }
  if (removed > 0) console.log(`[attachments] 期限切れの添付を削除: ${removed}件`);
}
pruneAttachments();
setInterval(pruneAttachments, 24 * 60 * 60 * 1000).unref?.();

// ---- GraphWrangler AI 会話履歴の保存/取得（UIMessage[] スナップショット。UI は 2026-08-02 から
// キー "global" の1本だけを使う。エンドポイントはキー汎用のまま） ----

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
  // /api/login と /api/me だけはログイン前でも通す（ログイン画面が使うため）。
  // GET /api/branding も同じ理由で通す——ログイン画面にもサイト名を出すため。返すのは
  // サイト名とファビコンの版だけで、他の情報は一切載せない（branding.ts / GET ハンドラ参照）
  const authRequired = loadUsers(usersFile).length > 0;
  const external = !!c.req.header("x-forwarded-for");
  const p = c.req.path;
  const publicPath =
    p === "/api/login" || p === "/api/me" || (p === "/api/branding" && c.req.method === "GET");
  if (authRequired && external && !email && !publicPath) {
    return c.json({ error: "ログインが必要です" }, 401);
  }

  if (email) {
    await accessEmailStore.run(email, next);
    return;
  }
  await next();
});

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

// ---- ルートモジュール（src/routes/*.ts）の配線 ----
// 各モジュールは実効パス（"/api/..."）そのままで登録するので、前置きは "/" で束ねる。
// **必ず上のミドルウェア（cors + ログインゲート）より後・UI配信のフォールバックより前**に
// 置く: Hono は登録順にハンドラを合成するため、順番がゲートの掛かり方をそのまま決める。
const ctx: AppContext = {
  graph,
  threads,
  runs,
  settings,
  userSettings,
  reads,
  usersFile,
  sessionSecret,
  chatsDir,
  attachmentsDir,
  brandingPath,
  gitSync,
  selfUpdate,
  port,
};

app.route("/", authRoutes(ctx));
app.route("/", graphRoutes(ctx));
app.route("/", nodeRoutes(ctx));
app.route("/", threadRoutes(ctx));
app.route("/", runRoutes(ctx));

// ---- AI設定（初回セットアップ + ⚙。実装は settings.ts。キーの値は返さない） ----

const SettingsPatchSchema = z.object({
  chat: ChatSettingsSchema.partial().optional(),
  engine: EngineSettingsSchema.partial().optional(),
  ai: AiSettingsSchema.partial().optional(),
  git: GitSettingsSchema.partial().optional(),
  update: UpdateSettingsSchema.partial().optional(),
  notify: NotifySettingsSchema.partial().optional(),
  // ブランディングは siteTitle だけ受ける。faviconVersion はサーバが管理する値なので、
  // 外から書けないようにここでスキーマごと落とす（zod は未知キーを捨てる）
  branding: BrandingSettingsSchema.pick({ siteTitle: true }).partial().optional(),
  setupDone: z.boolean().optional(),
});

app.get("/api/settings", (c) => c.json(settings.publicView()));

app.post("/api/settings", async (c) => {
  const body = SettingsPatchSchema.parse(await c.req.json());
  settings.update(body);
  return c.json(settings.publicView());
});

// ---- インスタンスのブランディング（branding.ts。2026-08-08 本人要望「会社インスタンスだけ
//      ARK のタイトルとファビコンにしたい。コードに焼くと zinsei まで変わる」）----
//
// GET は**認証不要**（上のログインゲートで通している）: ログイン画面にもサイト名が要るため。
// そのぶん返すのは siteTitle と faviconVersion の2値だけに限る。
// 変更側（サイト名は POST /api/settings、ファビコンは以下の2本）は他の設定と同じ認可レベル。

app.get("/api/branding", (c) => {
  const b = settings.get().branding;
  return c.json({ siteTitle: b.siteTitle, faviconVersion: b.faviconVersion });
});

/** ファビコンの差し替え。**Content-Type もファイル名も信じず中身で判定する**（detectFaviconType）。
 *  成功すると faviconVersion が +1 され、UI とブラウザのキャッシュがそこで切り替わる */
app.post("/api/branding/favicon", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    throw new GraphError("file がありません（multipart/form-data で file を送ってください）", 400);
  }
  if (file.size > FAVICON_MAX_BYTES) {
    throw new GraphError("ファビコンは 512KB までです", 413);
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const type = detectFaviconType(buf);
  if (!type) {
    throw new GraphError("PNG または SVG の画像を指定してください", 400);
  }
  writeFavicon(brandingPath, buf, type);
  const next = settings.update({
    branding: { faviconVersion: settings.get().branding.faviconVersion + 1 },
  });
  return c.json({ faviconVersion: next.branding.faviconVersion });
});

/** 手置きを消して UI ビルド同梱の既定へ戻す（faviconVersion=0） */
app.post("/api/branding/favicon/reset", (c) => {
  clearFavicon(brandingPath);
  const next = settings.update({ branding: { faviconVersion: 0 } });
  return c.json({ faviconVersion: next.branding.faviconVersion });
});

// ---- チャットの添付ファイル（2026-08-07）----
// multipart/form-data の file を attachments/（gitignore 済み）へ保存し、AI が Read で
// 読める絶対パスを返す。7日で自動削除される（上の pruneAttachments）
app.post("/api/chat/attachments", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    throw new GraphError("file がありません（multipart/form-data で file を送ってください）", 400);
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    throw new GraphError("添付は 50MB までです", 413);
  }
  fs.mkdirSync(attachmentsDir, { recursive: true });
  // 元のファイル名は表示用に保ちつつ、衝突・パス文字を避けた保存名にする
  const safeName = file.name.replace(/[\\/:*?"<>|]/g, "_").slice(-80) || "file";
  const stored = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${safeName}`;
  const abs = path.join(attachmentsDir, stored);
  fs.writeFileSync(abs, Buffer.from(await file.arrayBuffer()));
  return c.json({ path: abs, name: file.name, size: file.size });
});

// ---- ユーザーごとの設定（2026-08-07「設定はユーザーごとと全体で分けて」）----
// ログイン中ならそのメール、未ログイン（zinsei の一人運用）は "default" 1枠。
// 書き込みは即時反映（全体設定の「保存」を経由しない＝古い画面の保存で巻き戻らない）
app.get("/api/me/settings", (c) => c.json(userSettings.get(currentUserEmail())));

app.put("/api/me/settings", async (c) => {
  const patch = UserPrefsSchema.partial().parse(await c.req.json());
  return c.json(userSettings.update(currentUserEmail(), patch));
});

/** Discord 通知のテスト送信（設定画面の「テスト送信」）。保存済みの Webhook URL で
 *  メンションなしの1通を実際に送り、結果を同期で返す。discordEnabled OFF でも送れる
 *  （設定→確認→ONにする、の順で試せるように） */
app.post("/api/notify/test", async (c) => {
  const n = settings.get().notify;
  if (!n.discordWebhookUrl) {
    return c.json({ ok: false, error: "Webhook URL が未設定です（保存してから試してください）" }, 400);
  }
  try {
    await sendDiscordWebhook(n.discordWebhookUrl, {
      content: "GraphWrangler のテスト通知です（あなたの番が来るとここへ届きます）",
      allowed_mentions: { parse: [] },
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 502);
  }
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

// ---- 本体の自動アップデート（selfupdate.ts） ----

app.get("/api/update", (c) => c.json(selfUpdate.status()));

/** 今すぐ origin を見に行く（取り込みはしない） */
app.post("/api/update/check", async (c) => c.json(await selfUpdate.check()));

/** 今すぐ取り込む（pull --ff-only → install → ui build → 監視下なら自動再起動）。
 *  応答を返しきってから終了するよう、selfupdate 側が少し待ってから exit する */
app.post("/api/update/run", async (c) => {
  const result = await selfUpdate.apply();
  return c.json({ ...result, status: selfUpdate.status() }, result.ok ? 200 : 500);
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
  // 中断シグナル: UI の「停止」= fetch の abort がここへ届く。CLI なら claude を木ごと殺し、
  // API なら生成要求ごと止める（2026-08-05。以前は裏で走り続けてグラフを書き換えていた）
  const signal = c.req.raw.signal;
  if (settings.get().chat.mode === "cli") {
    // attachmentsDir を --add-dir に足す: datadir モードでは添付置き場が cwd の外になるため
    return handleChatCli(graph, threads, settings, body, port, signal, attachmentsDir);
  }
  const missing = chatKeyMissing(settings);
  if (missing) return c.json({ error: missing }, 400);
  return handleChat(graph, threads, settings, body, signal);
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

// ファビコン（2026-08-08）。手置き（<dataDir>/branding/）があればそれ、無ければ UI 同梱の既定。
// **serveStatic より前**に置く: dist/favicon.png が素通しで先に返ると手置きが効かない。
// キャッシュ規律も /assets/ や index.html とは別で、URL の ?v=<faviconVersion> が
// 変わるまでは1日キャッシュしてよい（差し替えたら版が上がるので即座に切り替わる）
app.get("/favicon.png", (c) => {
  const custom = readFavicon(brandingPath);
  const found =
    custom ??
    (() => {
      // 既定は UI のビルド成果物。開発時（未ビルド）は public/ から拾う
      for (const p of [
        path.join(uiDist, "favicon.png"),
        path.join(repoRoot, "apps", "ui", "public", "favicon.png"),
      ]) {
        try {
          return { body: fs.readFileSync(p), type: "png" as const };
        } catch {
          // 次の候補へ
        }
      }
      return null;
    })();
  if (!found) return c.notFound();
  const headers: Record<string, string> = {
    "Content-Type": faviconContentType(found.type),
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  };
  // SVG は同一オリジンで開けるスクリプト実行面になりうる（アップロードできるのは
  // 設定を触れる人だけだが、画像に実行権を与える理由が無い）。閉じたCSPを付ける
  if (found.type === "svg") {
    headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  }
  return new Response(new Uint8Array(found.body), { headers });
});

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
  // index.html は素通しではなくサーバで置換して返す（2026-08-08 ブランディング）。
  // <title> と <link rel="icon"> をインスタンスの値に差し替えるので、JS が動く前＝
  // タブに出る最初の1文字目から会社名になる。置換は IndexHtmlRenderer が
  // 「index.html の mtime × サイト名 × 版」でキャッシュする
  const indexHtml = new IndexHtmlRenderer(path.join(uiDist, "index.html"));
  const serveIndex = (c: Context) => {
    const b = settings.get().branding;
    return c.html(indexHtml.render(b.siteTitle, b.faviconVersion));
  };
  app.get("/", serveIndex);
  app.get("/index.html", serveIndex);
  app.use("/*", serveStatic({ root }));
  app.get("*", serveIndex); // SPA フォールバック（/graph/... 等の直接アクセス）
}

// バインド先。既定は従来どおり全インターフェイス（Tailscale 内アクセス等の互換）だが、
// リバースプロキシ越しに公開する構成では **GRAPHWRANGLER_HOST=127.0.0.1 を必ず設定する**
// （露出したままだと試走APIほかが認証なしで外から叩ける。2026-08-03 stremix 公開時に対応）
const host = process.env.GRAPHWRANGLER_HOST ?? "0.0.0.0";
serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`graphwrangler server: http://${host}:${port} (${serverModeLabel})`);
});
