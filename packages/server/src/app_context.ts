// ルートモジュール（src/routes/*.ts）へ共有状態を渡す入れ物。index.ts が起動時に組み立てる。
// DI コンテナではない——モジュール分割前に index.ts のトップレベルにあった変数の束で、
// 生成と所有は今も index.ts。各ルートはここから従来と同じ参照を受け取るだけ。
import type { GraphStore, RunStore, ThreadStore } from "@graphwrangler/core";
import type { GitSync } from "./gitsync.js";
import type { ReadsStore } from "./reads.js";
import type { SelfUpdate } from "./selfupdate.js";
import type { SettingsStore } from "./settings.js";
import type { UserSettingsStore } from "./user_settings.js";

export interface AppContext {
  graph: GraphStore;
  threads: ThreadStore;
  runs: RunStore;
  settings: SettingsStore;
  /** ユーザーごとの設定（user_settings.ts。2026-08-07「設定はユーザーごとと全体で分けて」） */
  userSettings: UserSettingsStore;
  /** 既読時刻の保存（reads.ts。docs/design.md 3.11） */
  reads: ReadsStore;
  /** ログインユーザー（users.json）のパス。auth.ts のヘルパ群が読む */
  usersFile: string;
  /** セッション署名鍵（auth-secret の中身。auth.ts の ensureSecret が返す） */
  sessionSecret: string;
  /** GraphWrangler AI の会話履歴の保存先（sidecar/chats/ または dataDir/chats/） */
  chatsDir: string;
  /** チャットの添付ファイル置き場（gitignore 済み。7日で自動削除） */
  attachmentsDir: string;
  /** インスタンスのブランディング画像の置き場（branding.ts） */
  brandingPath: string;
  /** ワークスペースモードのみ生成される自動プッシュ（gitsync.ts）。datadir モードでは null */
  gitSync: GitSync | null;
  selfUpdate: SelfUpdate;
  port: number;
}
