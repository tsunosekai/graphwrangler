// AI設定の保存（dataDir/settings.json）。OpenClaw のプロバイダ設定の思想を参考に、
// チャットAI（GraphWrangler AI）と実行AI（エンジン）それぞれについて「接続方式（API / CLI）」を
// ドロップダウンで選ばせる。方式ごとに必要な項目だけを使う:
//   chat.mode="api"  → provider/model/apiKey を使う（APIキーで直接プロバイダを呼ぶ）
//   chat.mode="cli"  → cliPath/cliModel を使う（claude 等のヘッドレスCLIを使う。APIキー不要）
//   engine.mode="cli" → cliPath/model/extraArgs を使う（従来どおり claude -p 起動）
//   engine.mode="api" → apiModel（null ならチャット既定）でチャット側のプロバイダ/キーを間借りする
// APIキーは書き込み専用: GET では有無だけ返し、値は返さない。
// 環境変数（ANTHROPIC_API_KEY 等）は設定より優先ではなく**フォールバック**。
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ChatSettingsSchema = z.object({
  /** api = プロバイダのAPIキーで直接呼ぶ / cli = claude 等のヘッドレスCLIを使う。
   *  既定は cli（本人指示 2026-07-29: 基本はヘッドレスエージェントを使う運用のため） */
  mode: z.enum(["api", "cli"]).default("cli"),
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  /** null = プロバイダ既定（anthropic: claude-sonnet-5 / openai: gpt-5）。mode="api" のときのみ使う */
  model: z.string().nullable().default(null),
  /** 書き込み専用。GET では返さない。mode="api" のときのみ使う */
  apiKey: z.string().nullable().default(null),
  /** mode="cli" のときのヘッドレスCLI実行ファイル */
  cliPath: z.string().default("claude"),
  /** mode="cli" のときの --model */
  cliModel: z.string().default("opus"),
  /** mode="cli" の GraphWrangler AI / Task AI に**追加で**許可するツール（--allowedTools へ追記）。
   *  2026-08-03 の権限拡張で既定が Bash 含むフルセット（chat_cli.ts DEFAULT_CLI_TOOLS）に
   *  なったため、この設定は MCP ツール等（例: "mcp__foo__*"）をさらに足す用途 */
  cliExtraTools: z.array(z.string()).default([]),
});

export const EngineSettingsSchema = z.object({
  /** cli = ヘッドレスCLI(claude -p 等)を起動する / api = チャット側のAPIキーで直接呼ぶ */
  mode: z.enum(["cli", "api"]).default("cli"),
  /** AI executor の CLI。claude 以外（codex 等）も同じ形で差し替えられる。mode="cli" のときのみ使う */
  cliPath: z.string().default("claude"),
  model: z.string().default("opus"),
  extraArgs: z.array(z.string()).default([]),
  /** mode="cli" の実行AIに**追加で**許可するツール（--allowedTools へ追記。既定のフルセットは
   *  engine/executors/claude.ts の ALLOWED_TOOLS。例: "mcp__foo__*"。2026-08-03 権限拡張で追加） */
  cliExtraTools: z.array(z.string()).default([]),
  /** mode="api" のときのモデル。null = チャット側の既定モデルと同じ */
  apiModel: z.string().nullable().default(null),
});

/** AI（三役共通）の作業範囲。2026-08-04 本人指示「AI が stremix-document
 *  （=ワークスペースルート）外も触れるように」で追加 */
export const AiSettingsSchema = z.object({
  /** claude -p の --add-dir に渡す追加ディレクトリ。ファイルツール（Read/Write/Edit）は
   *  cwd=ワークスペースルート配下に閉じるため、外のパスはここに列挙して開放する。
   *  Bash には元々パス制限が無いので、これは檻ではなくファイルツールの作業範囲の話 */
  addDirs: z.array(z.string()).default([]),
});

/** ワークスペースの自動 commit/push（gitsync.ts。ワークスペースモードのみ意味を持つ）。
 *  既定OFF——リポジトリへ勝手に push する機能なので、人間が明示的に入れる */
export const GitSettingsSchema = z.object({
  autoPush: z.boolean().default(false),
  /** チェック間隔（秒）。変更は次周から効く */
  intervalSec: z.number().int().min(15).max(3600).default(60),
  /** 既定の対象（正データ + .graphwrangler/）に**追加で** commit/push するワークスペース内
   *  相対パス。例: グラフの手順書ノードが参照する docs ディレクトリ（2026-08-03 stremix の
   *  claw-skills 一本化で追加）。ワークスペース外を指す値は gitsync 側で無視する */
  extraPaths: z.array(z.string()).default([]),
});

/** GraphWrangler 本体の自動アップデート（selfupdate.ts。2026-08-05 本人要望——
 *  zinsei と stremix の2インスタンスを手で追随させるのをやめるため）。
 *  チェック（見るだけ）は副作用が無いので既定ON、取り込み（再起動を伴う）は既定OFF */
export const UpdateSettingsSchema = z.object({
  autoCheck: z.boolean().default(true),
  autoApply: z.boolean().default(false),
  /** チェック間隔（分）。5分未満・1日超は selfupdate 側で丸める */
  intervalMin: z.number().int().min(5).max(1440).default(60),
});

/** 「あなたの番」の Discord Webhook 通知（discord.ts。2026-08-07 本人要望）。
 *  Webhook URL は書き込み専用: URL を知っていれば誰でもそのチャンネルへ投稿できる
 *  秘密情報なので、apiKey と同じく GET では有無だけ返す */
export const NotifySettingsSchema = z.object({
  discordEnabled: z.boolean().default(false),
  /** 書き込み専用。undefined=維持 / null=削除 / string=設定（apiKey と同じ扱い） */
  discordWebhookUrl: z.string().nullable().default(null),
  /** Task AI がスレッドへ返信し終えたときも通知するか（2026-08-07「通知が来ない」対応——
   *  判断リクエストとラン待ちだけでは、相談中心の使い方だと通知の機会がほぼ無い）。
   *  discordEnabled が親スイッチ（こちらだけONでも discordEnabled OFF なら鳴らない） */
  discordAiReplies: z.boolean().default(true),
});

export const SettingsSchema = z.object({
  chat: ChatSettingsSchema.default({}),
  engine: EngineSettingsSchema.default({}),
  ai: AiSettingsSchema.default({}),
  git: GitSettingsSchema.default({}),
  update: UpdateSettingsSchema.default({}),
  notify: NotifySettingsSchema.default({}),
  /** 初回セットアップ画面を完了したか（スキップ含む） */
  setupDone: z.boolean().default(false),
});
export type Settings = z.infer<typeof SettingsSchema>;

export class SettingsStore {
  private file: string;
  private cache: Settings;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "settings.json");
    this.cache = this.load();
  }

  private load(): Settings {
    try {
      if (fs.existsSync(this.file)) {
        // 既存の settings.json に mode/cliPath/cliModel/apiModel が無くても
        // zod の .default() が既定値を補うので、そのまま後方互換で読める
        return SettingsSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
      }
    } catch {
      // 壊れていたら既定値で継続（上書き保存はユーザー操作時のみ）
    }
    return SettingsSchema.parse({});
  }

  get(): Settings {
    return this.cache;
  }

  /** 部分更新。apiKey は undefined=維持 / null=削除 / string=設定 */
  update(patch: {
    chat?: Partial<z.input<typeof ChatSettingsSchema>>;
    engine?: Partial<z.input<typeof EngineSettingsSchema>>;
    ai?: Partial<z.input<typeof AiSettingsSchema>>;
    git?: Partial<z.input<typeof GitSettingsSchema>>;
    update?: Partial<z.input<typeof UpdateSettingsSchema>>;
    notify?: Partial<z.input<typeof NotifySettingsSchema>>;
    setupDone?: boolean;
  }): Settings {
    const next: Settings = SettingsSchema.parse({
      chat: {
        ...this.cache.chat,
        ...patch.chat,
        apiKey:
          patch.chat && "apiKey" in patch.chat ? (patch.chat.apiKey ?? null) : this.cache.chat.apiKey,
      },
      engine: { ...this.cache.engine, ...patch.engine },
      ai: { ...this.cache.ai, ...patch.ai },
      git: { ...this.cache.git, ...patch.git },
      update: { ...this.cache.update, ...patch.update },
      notify: {
        ...this.cache.notify,
        ...patch.notify,
        // Webhook URL は apiKey と同じ書き込み専用3値（undefined=維持 / null=削除 / string=設定）
        discordWebhookUrl:
          patch.notify && "discordWebhookUrl" in patch.notify
            ? (patch.notify.discordWebhookUrl ?? null)
            : this.cache.notify.discordWebhookUrl,
      },
      setupDone: patch.setupDone ?? this.cache.setupDone,
    });
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
    this.cache = next;
    return next;
  }

  /** チャットの実効APIキー（設定 → 環境変数の順のフォールバック）。mode="cli" でも
   *  engine.mode="api"（チャットのキーを間借りする）から呼ばれうるので mode 分岐はしない */
  resolveChatKey(): { key: string | null; source: "settings" | "env" | "none" } {
    if (this.cache.chat.apiKey) return { key: this.cache.chat.apiKey, source: "settings" };
    const envKey =
      this.cache.chat.provider === "openai"
        ? process.env.OPENAI_API_KEY
        : process.env.ANTHROPIC_API_KEY;
    if (envKey) return { key: envKey, source: "env" };
    return { key: null, source: "none" };
  }

  /** GET /api/settings 用の公開形（キーの値は出さない） */
  publicView() {
    const { key, source } = this.resolveChatKey();
    return {
      chat: {
        mode: this.cache.chat.mode,
        provider: this.cache.chat.provider,
        model: this.cache.chat.model,
        hasApiKey: key !== null,
        keySource: source,
        cliPath: this.cache.chat.cliPath,
        cliModel: this.cache.chat.cliModel,
        cliExtraTools: this.cache.chat.cliExtraTools,
      },
      engine: {
        mode: this.cache.engine.mode,
        cliPath: this.cache.engine.cliPath,
        model: this.cache.engine.model,
        extraArgs: this.cache.engine.extraArgs,
        cliExtraTools: this.cache.engine.cliExtraTools,
        apiModel: this.cache.engine.apiModel,
      },
      ai: {
        addDirs: this.cache.ai.addDirs,
      },
      git: {
        autoPush: this.cache.git.autoPush,
        intervalSec: this.cache.git.intervalSec,
        extraPaths: this.cache.git.extraPaths,
      },
      update: {
        autoCheck: this.cache.update.autoCheck,
        autoApply: this.cache.update.autoApply,
        intervalMin: this.cache.update.intervalMin,
      },
      notify: {
        discordEnabled: this.cache.notify.discordEnabled,
        hasDiscordWebhook: this.cache.notify.discordWebhookUrl !== null,
        discordAiReplies: this.cache.notify.discordAiReplies,
      },
      setupDone: this.cache.setupDone,
    };
  }
}
