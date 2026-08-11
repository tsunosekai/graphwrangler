// ユーザーごとの設定（2026-08-07 本人要望「設定はユーザーごとと全体で分けてほしい」）。
// 全体設定（settings.ts / settings.json = インスタンス運営: AI接続・エンジン・git・
// アップデート・Discord webhook）とは別ファイル（user-settings.json）に、メールを
// キーとして個人の通知設定だけを持つ。ログインの無い運用（zinsei）では "default"
// キー1つに畳まれる＝実質これまでどおり全体設定として振る舞う。
// 保存は即時（設定画面の「保存」を経由しない）——全体設定の「保存」が全項目を
// 書き戻す構造だと、別の端末で変えた個人設定が古い画面の保存で巻き戻るため。
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// discordAiReplies（Task AI の返信ごとの通知）は廃止（2026-08-11 本人指示——GW でチャット中に
// 1往復ごとに鳴っていた。オプトアウトで消す設定ではなく、機能そのものを落とした）。
// 既存の user-settings.json に残っていても zod が黙って捨てるので移行は不要
export const UserPrefsSchema = z.object({
  /** 自分の番（判断リクエスト・ラン待ち）の Discord メンション通知を受け取るか */
  discordTurnNotify: z.boolean().default(true),
});
export type UserPrefs = z.infer<typeof UserPrefsSchema>;

const FileSchema = z.record(z.string(), UserPrefsSchema);

const DEFAULT_KEY = "default";

export class UserSettingsStore {
  private file: string;
  private cache: Record<string, UserPrefs>;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "user-settings.json");
    this.cache = this.load();
  }

  private load(): Record<string, UserPrefs> {
    try {
      return FileSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      return {}; // 無い・壊れている → 全員既定値（全部ON）
    }
  }

  private keyOf(email: string | null | undefined): string {
    return email ? email.toLowerCase() : DEFAULT_KEY;
  }

  /** 未保存のユーザーは既定値（全部ON）で返す */
  get(email: string | null | undefined): UserPrefs {
    return this.cache[this.keyOf(email)] ?? UserPrefsSchema.parse({});
  }

  update(
    email: string | null | undefined,
    patch: Partial<z.input<typeof UserPrefsSchema>>,
  ): UserPrefs {
    const next = UserPrefsSchema.parse({ ...this.get(email), ...patch });
    this.cache = { ...this.cache, [this.keyOf(email)]: next };
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
    return next;
  }
}
