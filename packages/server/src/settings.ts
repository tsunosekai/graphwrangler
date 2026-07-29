// AI設定の保存（dataDir/settings.json）。OpenClaw のプロバイダ設定の思想を参考に、
// チャットAI（APIプロバイダ）と実行AI（CLIエージェント）を分けて持つ。
// APIキーは書き込み専用: GET では有無だけ返し、値は返さない。
// 環境変数（ANTHROPIC_API_KEY 等）は設定より優先ではなく**フォールバック**。
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ChatSettingsSchema = z.object({
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  /** null = プロバイダ既定（anthropic: claude-sonnet-5 / openai: gpt-5） */
  model: z.string().nullable().default(null),
  /** 書き込み専用。GET では返さない */
  apiKey: z.string().nullable().default(null),
});

export const EngineSettingsSchema = z.object({
  /** AI executor の CLI。claude 以外（codex 等）も同じ形で差し替えられる */
  cliPath: z.string().default("claude"),
  model: z.string().default("sonnet"),
  extraArgs: z.array(z.string()).default([]),
});

export const SettingsSchema = z.object({
  chat: ChatSettingsSchema.default({}),
  engine: EngineSettingsSchema.default({}),
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
      setupDone: patch.setupDone ?? this.cache.setupDone,
    });
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
    this.cache = next;
    return next;
  }

  /** チャットの実効APIキー（設定 → 環境変数の順のフォールバック） */
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
        provider: this.cache.chat.provider,
        model: this.cache.chat.model,
        hasApiKey: key !== null,
        keySource: source,
      },
      engine: this.cache.engine,
      setupDone: this.cache.setupDone,
    };
  }
}
