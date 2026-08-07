// 初回セットアップ + いつでも開ける⚙設定。2026-08-02 本人指示「設定はモーダルじゃなくて
// 全面表示に」でダイアログから全画面レイヤーへ変更（fixed inset-0。ヘッダー行 + スクロール本体）。
// 「チャットAI」（GraphWrangler AI）と「実行AI＝エンジン」それぞれについて、まず「接続方式」
// （APIキー / ヘッドレスエージェントCLI）をドロップダウンで選ばせ、選んだ方式に応じて
// 入力欄を出し分ける（docs/design.md: LLM選択は「APIキーの差し替え」でなく
// 「エージェントごと差し替え」。2026-07-29 本人フィードバック「どっちを使う設定か分からない」対応）。
import { useEffect, useState } from "react";
import {
  api,
  type SettingsPatch,
  type SettingsView,
  type UpdateStatus,
  type UserSettings,
} from "../lib/api";
import { hintsEnabled, resetHints, setHintsEnabled, useHintsVersion } from "../lib/hints";
import { pushToast } from "../lib/toast";
import { useTheme, type ThemeMode } from "../lib/theme";
import { Button } from "./ui/button";
import { X } from "lucide-react";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

interface Props {
  settings: SettingsView;
  /** true = 起動時の強制オーバーレイ（初回セットアップ）。「あとで設定」ボタンを出す */
  forced: boolean;
  onSaved: (next: SettingsView) => void;
  onSkip: () => void;
  onClose: () => void;
}

type ChatMode = "api" | "cli";
type EngineMode = "cli" | "api";

const CHAT_DEFAULT_MODEL: Record<"anthropic" | "openai", string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5",
};

// CLI（claude -p）のモデルは選択式（本人指定 2026-07-31。既定は Opus 5）。
// claude CLI のエイリアス名をそのまま値にする。保存済みの値がリストに無い場合は
// 「カスタム」として選択肢に足し、既存設定を壊さない
const CLI_MODELS = [
  { value: "fable", label: "Fable 5（最高性能）" },
  { value: "opus", label: "Opus 5（高性能・既定）" },
  { value: "sonnet", label: "Sonnet 5（標準）" },
  { value: "haiku", label: "Haiku 4.5（高速）" },
];

function CliModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isCustom = value !== "" && !CLI_MODELS.some((m) => m.value === value);
  return (
    <Select value={value || "opus"} onValueChange={onChange}>
      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {CLI_MODELS.map((m) => (
          <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
        ))}
        {isCustom && <SelectItem value={value}>{value}（カスタム）</SelectItem>}
      </SelectContent>
    </Select>
  );
}

// エフォート（思考の深さ。claude CLI の --effort）の選択肢（2026-08-07 モデル/エフォート切替）
const EFFORT_OPTIONS = [
  // 「既定」とだけ書かず中身を書く（2026-08-07 本人指摘）。null = --effort を渡さない
  { value: "default", label: "CLIに任せる（指定しない）" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "特高" },
  { value: "max", label: "最大" },
];

type EffortValue = "low" | "medium" | "high" | "xhigh" | "max" | null;

function EffortSelect({ value, onChange }: { value: EffortValue; onChange: (v: EffortValue) => void }) {
  return (
    <Select
      value={value ?? "default"}
      onValueChange={(v) => onChange(v === "default" ? null : (v as EffortValue))}
    >
      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {EFFORT_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const CHAT_MODE_DESC: Record<ChatMode, string> = {
  api: "APIキーで直接呼び出します。",
  cli: "claude -p 等のログイン済みCLIを使います。APIキー不要。",
};

const ENGINE_MODE_DESC: Record<EngineMode, string> = {
  cli: "claude -p 等のログイン済みCLIを使います。APIキー不要。",
  api: "APIキーで直接呼び出します（チャットAIで設定したプロバイダ/キーを使用）。",
};

export function SetupModal({ settings, forced, onSaved, onSkip, onClose }: Props) {
  const [themeMode, setThemeMode] = useTheme();
  const [chatMode, setChatMode] = useState<ChatMode>(settings.chat.mode);
  const [provider, setProvider] = useState<"anthropic" | "openai">(settings.chat.provider);
  const [model, setModel] = useState(settings.chat.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [editingKey, setEditingKey] = useState(!settings.chat.hasApiKey);
  const [chatCliPath, setChatCliPath] = useState(settings.chat.cliPath);
  const [chatCliModel, setChatCliModel] = useState(settings.chat.cliModel);
  const [chatCliEffort, setChatCliEffort] = useState<EffortValue>(settings.chat.cliEffort ?? null);
  const [chatCliExtraTools, setChatCliExtraTools] = useState(settings.chat.cliExtraTools.join(" "));

  const [engineMode, setEngineMode] = useState<EngineMode>(settings.engine.mode);
  const [cliPath, setCliPath] = useState(settings.engine.cliPath);
  const [engineModel, setEngineModel] = useState(settings.engine.model);
  const [engineEffort, setEngineEffort] = useState<EffortValue>(settings.engine.effort ?? null);
  const [extraArgs, setExtraArgs] = useState(settings.engine.extraArgs.join(" "));
  const [engineCliExtraTools, setEngineCliExtraTools] = useState(
    settings.engine.cliExtraTools.join(" "),
  );
  const [aiAddDirs, setAiAddDirs] = useState(settings.ai.addDirs.join(" "));
  const [engineApiModel, setEngineApiModel] = useState(settings.engine.apiModel ?? "");

  const [gitAutoPush, setGitAutoPush] = useState(settings.git.autoPush);
  const [gitIntervalSec, setGitIntervalSec] = useState(String(settings.git.intervalSec));

  // 本体の自動アップデート（2026-08-05）。設定値は下の「保存」で送り、版の状態
  // （何コミット遅れ・最終結果）は /api/update から別途読む
  const [updAutoCheck, setUpdAutoCheck] = useState(settings.update?.autoCheck ?? true);
  const [updAutoApply, setUpdAutoApply] = useState(settings.update?.autoApply ?? false);
  const [updIntervalMin, setUpdIntervalMin] = useState(String(settings.update?.intervalMin ?? 60));
  const [updStatus, setUpdStatus] = useState<UpdateStatus | null>(null);
  const [updBusy, setUpdBusy] = useState(false);
  useEffect(() => {
    void api.getUpdate().then(setUpdStatus);
  }, []);
  const checkUpdate = async () => {
    setUpdBusy(true);
    try {
      setUpdStatus(await api.checkUpdate());
    } catch {
      // api 側でトースト済み
    } finally {
      setUpdBusy(false);
    }
  };
  const runUpdate = async () => {
    setUpdBusy(true);
    try {
      const res = await api.runUpdate();
      setUpdStatus(res.status);
      pushToast(res.message, res.ok ? "info" : "error");
    } catch {
      // api 側でトースト済み
    } finally {
      setUpdBusy(false);
    }
  };

  const [saving, setSaving] = useState(false);

  // あなたの番が来たらデスクトップ通知（localStorage gw.notify。実際の発火は App 側）
  const [notifyEnabled, setNotifyEnabled] = useState(() => localStorage.getItem("gw.notify") === "1");

  // Discord Webhook 通知（2026-08-07。こちらはサーバ設定＝タブを閉じていても届く）。
  // URL は APIキーと同じ書き込み専用: 有無だけ受け取り、値は「変更」を押したときだけ送る
  const [discordEnabled, setDiscordEnabled] = useState(settings.notify?.discordEnabled ?? false);
  const [webhookUrl, setWebhookUrl] = useState("");

  // ユーザーごとの設定（2026-08-07「設定はユーザーごとと全体で分けて」）。
  // 読み込みはマウント時、書き込みはトグルの瞬間に即時反映（「保存」を経由しない＝
  // 古い設定画面の保存で巻き戻らない）
  const [mySettings, setMySettings] = useState<UserSettings | null>(null);
  useEffect(() => {
    void api
      .getMySettings()
      .then(setMySettings)
      .catch(() => {
        // 旧サーバには /api/me/settings が無い。ユーザー設定欄は「読み込めません」表示のまま
      });
  }, []);
  const patchMySettings = (patch: Partial<UserSettings>) => {
    if (mySettings) setMySettings({ ...mySettings, ...patch }); // 楽観更新
    void api
      .updateMySettings(patch)
      .then(setMySettings)
      .catch(() => {
        // api() 側でトースト表示済み。次回読み込みでサーバ値に戻る
      });
  };

  // 設定タブ（2026-08-07）: user = 自分だけに効く設定（即時保存）/ global = インスタンス全体。
  // 既定はユーザータブ（本人指定「ユーザー設定が最初に開くように」）。初回セットアップ
  // （forced）は全体設定の入力が目的なのでタブ関係なく全体側が出る
  const [tab, setTab] = useState<"user" | "global">("user");
  const [editingWebhook, setEditingWebhook] = useState(!(settings.notify?.hasDiscordWebhook ?? false));
  const [testingNotify, setTestingNotify] = useState(false);
  const testNotify = async () => {
    setTestingNotify(true);
    try {
      await api.testNotify();
      pushToast("テスト通知を送りました（Discord のチャンネルを確認してください）", "info");
    } catch {
      // api() 側でトースト表示済み
    } finally {
      setTestingNotify(false);
    }
  };
  const removeWebhook = async () => {
    try {
      const next = await api.updateSettings({ notify: { discordWebhookUrl: null } });
      setEditingWebhook(true);
      onSaved(next);
    } catch {
      // api() 側でトースト表示済み
    }
  };

  // ヒント（マウスオーバーの説明吹き出し。lib/hints.ts）。テーマ・通知と同じく
  // localStorage 持ちの即時反映で、下の「保存」を経由しない
  useHintsVersion();

  const toggleNotify = async () => {
    const next = !notifyEnabled;
    if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    setNotifyEnabled(next);
    localStorage.setItem("gw.notify", next ? "1" : "0");
  };

  const save = async () => {
    setSaving(true);
    try {
      const patch: SettingsPatch = {
        chat: {
          mode: chatMode,
          provider,
          model: model.trim() || null,
          cliPath: chatCliPath.trim() || "claude",
          cliModel: chatCliModel.trim() || "opus",
          cliEffort: chatCliEffort,
          cliExtraTools: chatCliExtraTools.trim() ? chatCliExtraTools.trim().split(/\s+/) : [],
        },
        engine: {
          mode: engineMode,
          cliPath: cliPath.trim() || "claude",
          model: engineModel.trim() || "opus",
          effort: engineEffort,
          extraArgs: extraArgs.trim() ? extraArgs.trim().split(/\s+/) : [],
          cliExtraTools: engineCliExtraTools.trim() ? engineCliExtraTools.trim().split(/\s+/) : [],
          apiModel: engineApiModel.trim() || null,
        },
        ai: {
          addDirs: aiAddDirs.trim() ? aiAddDirs.trim().split(/\s+/) : [],
        },
        git: {
          autoPush: gitAutoPush,
          intervalSec: Math.min(3600, Math.max(15, parseInt(gitIntervalSec, 10) || 60)),
        },
        update: {
          autoCheck: updAutoCheck,
          autoApply: updAutoApply,
          intervalMin: Math.min(1440, Math.max(5, parseInt(updIntervalMin, 10) || 60)),
        },
        notify: { discordEnabled },
        setupDone: true,
      };
      if (editingKey) patch.chat = { ...patch.chat, apiKey: apiKey.trim() || null };
      // URL 入力中のみ送る（空欄で保存しても既存の URL を消さない。消すのは「削除」ボタン）
      if (editingWebhook && webhookUrl.trim()) {
        patch.notify = { ...patch.notify, discordWebhookUrl: webhookUrl.trim() };
      }
      const next = await api.updateSettings(patch);
      setApiKey("");
      setEditingKey(!next.chat.hasApiKey);
      setWebhookUrl("");
      setEditingWebhook(!next.notify.hasDiscordWebhook);
      onSaved(next);
    } catch {
      // api() 側でトースト表示済み
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    try {
      const next = await api.updateSettings({ chat: { apiKey: null } });
      setEditingKey(true);
      onSaved(next);
    } catch {
      // api() 側でトースト表示済み
    }
  };

  const section = "flex flex-col gap-2 border-t border-border pt-2.5 first:border-t-0 first:pt-0";
  const heading = "text-xs font-semibold tracking-wide text-muted-foreground";
  const desc = "text-xs text-text-lo";
  const field = "flex flex-col gap-1 text-xs text-muted-foreground";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex flex-shrink-0 items-center gap-2 border-b px-4 py-3">
        <h2 className="flex-1 text-lg font-semibold">設定</h2>
        {!forced && (
          <Button type="button" variant="ghost" size="icon" aria-label="閉じる" onClick={onClose}>
            <X />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-3.5">

        {/* ユーザー / 全体のタブ（2026-08-07「設定はユーザーごとと全体で分けて」）。
            ユーザータブは自分だけに効く設定（即時保存）、全体タブはインスタンス全体の設定
            （下の「保存」で反映） */}
        {!forced && (
          <div className="flex gap-1 rounded-md border border-border p-1 text-sm">
            <button
              type="button"
              className={`flex-1 rounded-sm px-3 py-1 transition-colors ${tab === "user" ? "bg-muted font-semibold" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setTab("user")}
            >
              ユーザー
            </button>
            <button
              type="button"
              className={`flex-1 rounded-sm px-3 py-1 transition-colors ${tab === "global" ? "bg-muted font-semibold" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setTab("global")}
            >
              全体
            </button>
          </div>
        )}

        {(forced || tab === "global") && (<>
        <section className={section}>
          <h3 className={heading}>チャットAI（GraphWrangler AI）</h3>
          <label className={field}>
            <span>接続方式</span>
            <Select value={chatMode} onValueChange={(v) => setChatMode(v as ChatMode)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="api">APIキー（Anthropic / OpenAI）</SelectItem>
                <SelectItem value="cli">ヘッドレスエージェント（claude 等のCLI）</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <p className={desc}>{CHAT_MODE_DESC[chatMode]}</p>

          {chatMode === "api" ? (
            <>
              <label className={field}>
                <span>プロバイダ</span>
                <Select value={provider} onValueChange={(v) => setProvider(v as "anthropic" | "openai")}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="anthropic">anthropic</SelectItem>
                    <SelectItem value="openai">openai</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className={field}>
                <span>モデル</span>
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={CHAT_DEFAULT_MODEL[provider]}
                />
              </label>
              <label className={field}>
                <span>APIキー</span>
                {editingKey ? (
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                  />
                ) : (
                  <span className="flex items-center gap-2 text-sm text-foreground">
                    設定済み（●●●）
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditingKey(true)}>
                      変更
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={removeKey}>
                      削除
                    </Button>
                  </span>
                )}
              </label>
            </>
          ) : (
            <>
              <label className={field}>
                <span>CLIパス</span>
                <Input
                  value={chatCliPath}
                  onChange={(e) => setChatCliPath(e.target.value)}
                  placeholder="claude"
                />
              </label>
              <label className={field}>
                <span>モデル</span>
                <CliModelSelect value={chatCliModel} onChange={setChatCliModel} />
              </label>
              <label className={field}>
                <span>エフォート（思考の深さ）</span>
                <EffortSelect value={chatCliEffort} onChange={setChatCliEffort} />
              </label>
              <label className={field}>
                <span>追加許可ツール</span>
                <Input
                  value={chatCliExtraTools}
                  onChange={(e) => setChatCliExtraTools(e.target.value)}
                  placeholder="空欄=既定のフルセット。例: mcp__foo__*"
                />
              </label>
              <p className={desc}>
                GraphWrangler AI / Task AI の --allowedTools に追記するツール（空白区切り）。
                Bash 含むフルセットが既定で許可済みなので、MCP ツール等を足す用途
              </p>
            </>
          )}
        </section>

        <section className={section}>
          <h3 className={heading}>実行AI（エンジン）</h3>
          <label className={field}>
            <span>接続方式</span>
            <Select value={engineMode} onValueChange={(v) => setEngineMode(v as EngineMode)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cli">ヘッドレスエージェント（CLI）</SelectItem>
                <SelectItem value="api">APIキー（チャットと同じキーを使用）</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <p className={desc}>{ENGINE_MODE_DESC[engineMode]}</p>

          {engineMode === "cli" ? (
            <>
              <label className={field}>
                <span>CLIパス</span>
                <Input value={cliPath} onChange={(e) => setCliPath(e.target.value)} placeholder="claude" />
              </label>
              <label className={field}>
                <span>モデル</span>
                <CliModelSelect value={engineModel} onChange={setEngineModel} />
              </label>
              <label className={field}>
                <span>エフォート（思考の深さ）</span>
                <EffortSelect value={engineEffort} onChange={setEngineEffort} />
              </label>
              <label className={field}>
                <span>追加引数</span>
                <Input
                  value={extraArgs}
                  onChange={(e) => setExtraArgs(e.target.value)}
                  placeholder="--flag value"
                />
              </label>
              <label className={field}>
                <span>追加許可ツール</span>
                <Input
                  value={engineCliExtraTools}
                  onChange={(e) => setEngineCliExtraTools(e.target.value)}
                  placeholder="空欄=既定のフルセット。例: mcp__foo__*"
                />
              </label>
              <p className={desc}>
                実行AIの --allowedTools に追記するツール（空白区切り）。
                Bash 含むフルセットが既定で許可済みなので、MCP ツール等を足す用途
              </p>
            </>
          ) : (
            <label className={field}>
              <span>モデル（任意）</span>
              <Input
                value={engineApiModel}
                onChange={(e) => setEngineApiModel(e.target.value)}
                placeholder="空欄=チャットAIと同じ既定モデル"
              />
            </label>
          )}
        </section>

        <section className={section}>
          <h3 className={heading}>AIの作業範囲</h3>
          <label className={field}>
            <span>追加作業ディレクトリ</span>
            <Input
              value={aiAddDirs}
              onChange={(e) => setAiAddDirs(e.target.value)}
              placeholder="空欄=ワークスペース内のみ。例: /home/ubuntu"
            />
          </label>
          <p className={desc}>
            三役（GraphWrangler AI / Task AI / 実行AI）共通。claude の --add-dir
            に渡すディレクトリ（空白区切り）。ファイル操作はワークスペースルートに閉じるのが既定なので、
            外のリポジトリ等を触らせたいときにここへ足す
          </p>
        </section>

        <section className={section}>
          <h3 className={heading}>Git 自動プッシュ</h3>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={gitAutoPush} onCheckedChange={setGitAutoPush} />
            <span>グラフの変更を自動で commit / push する</span>
          </label>
          <p className={desc}>
            ワークスペースモードのみ。GraphWrangler が書くファイル（workflow.gw.json と
            .graphwrangler/ のスレッド・チャット履歴）だけを対象に、変更があれば commit して
            origin へ push します（push 前に pull --rebase。他のファイルは巻き込みません）
          </p>
          {gitAutoPush && (
            <label className={field}>
              <span>チェック間隔（秒）</span>
              <Input
                type="number"
                min={15}
                max={3600}
                value={gitIntervalSec}
                onChange={(e) => setGitIntervalSec(e.target.value)}
              />
            </label>
          )}
        </section>

        {/* 本体の自動アップデート（2026-08-05 本人要望。zinsei と stremix で別インスタンスが
            走っているので、それぞれが自分で追随できるようにする）。
            取り込みは fast-forward のみ・未コミットの変更があるときは見送り（selfupdate.ts） */}
        <section className={section}>
          <h3 className={heading}>アップデート</h3>
          {updStatus?.unavailableReason ? (
            <p className={desc}>{updStatus.unavailableReason}</p>
          ) : (
            <>
              <p className={desc}>
                現在の版: {updStatus?.current ?? "—"}
                {updStatus?.branch ? `（${updStatus.branch}）` : ""}
                {updStatus?.currentSubject ? ` ${updStatus.currentSubject}` : ""}
              </p>
              <p className={desc}>
                {updStatus === null
                  ? "状態を取得中…"
                  : updStatus.behind > 0
                    ? `更新が ${updStatus.behind} コミットあります`
                    : "最新です"}
                {updStatus?.restartPending && "（更新済み・再起動待ち）"}
                {updStatus && !updStatus.supervised && " / プロセス管理下ではないので再起動は手動です"}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled={updBusy} onClick={() => void checkUpdate()}>
                  今すぐ確認
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={updBusy || !updStatus || updStatus.behind === 0}
                  onClick={() => void runUpdate()}
                >
                  今すぐ更新
                </Button>
              </div>
              {updStatus?.lastResult && <p className={desc}>直近の結果: {updStatus.lastResult}</p>}
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Switch checked={updAutoCheck} onCheckedChange={setUpdAutoCheck} />
                <span>更新があるか定期的に確認する</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Switch checked={updAutoApply} onCheckedChange={setUpdAutoApply} />
                <span>見つけたら自動で取り込んで再起動する</span>
              </label>
              <p className={desc}>
                git pull（fast-forward のみ）→ 依存の導入 → UI ビルド → 再起動まで自動で行います。
                アプリのリポジトリに未コミットの変更があるときは何もしません（開発中のツリーを壊さないため）。
                再起動は systemd / pm2 に任せるので、それらの管理下でないときは取り込みだけ行って停止しません
              </p>
              {updAutoCheck && (
                <label className={field}>
                  <span>確認の間隔（分）</span>
                  <Input
                    type="number"
                    min={5}
                    max={1440}
                    value={updIntervalMin}
                    onChange={(e) => setUpdIntervalMin(e.target.value)}
                  />
                </label>
              )}
            </>
          )}
        </section>

        {/* 通知（インスタンス全体）: webhook は全員共通のチャンネル設定なのでこちら側。
            受け取るかどうかの個人設定はユーザータブ（2026-08-07 分離） */}
        <section className={section}>
          <h3 className={heading}>通知（Discord・全体）</h3>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={discordEnabled} onCheckedChange={setDiscordEnabled} />
            <span>Discord 通知を有効にする（インスタンス全体の親スイッチ）</span>
          </label>
          <label className={field}>
            <span>Discord Webhook URL</span>
            {editingWebhook ? (
              <Input
                type="password"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://discord.com/api/webhooks/..."
              />
            ) : (
              <span className="flex items-center gap-2 text-sm text-foreground">
                設定済み（●●●）
                <Button type="button" variant="outline" size="sm" onClick={() => setEditingWebhook(true)}>
                  変更
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={removeWebhook}>
                  削除
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={testingNotify} onClick={() => void testNotify()}>
                  テスト送信
                </Button>
              </span>
            )}
          </label>
          <p className={desc}>
            通知先チャンネルの設定 → 連携サービス → ウェブフックで URL を発行して貼り付け、下の「保存」で反映されます。
            担当者が付いたノードはその人をメンション（ユーザー管理で Discord ID を登録）、担当者なしは
            @here で全員に届きます。受け取るかどうかの個人設定はユーザータブにあります
          </p>
        </section>

        <section className={section}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => window.open("/api/export")}
          >
            データをエクスポート
          </Button>
        </section>
        </>)}

        {!forced && tab === "user" && (<>
        <section className={section}>
          <h3 className={heading}>表示</h3>
          {/* テーマはヘッダーのアイコンから設定内へ移動（2026-08-02 本人指示
              「ライト、ダークは設定の中に含めて。レスポンシブじゃなくても」）。
              選択は即時反映+localStorage 永続化（useTheme） */}
          <label className="flex items-center justify-between gap-2 text-sm text-foreground">
            <span>テーマ</span>
            <Select value={themeMode} onValueChange={(v) => setThemeMode(v as ThemeMode)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">ライト</SelectItem>
                <SelectItem value="dark">ダーク</SelectItem>
                <SelectItem value="system">システムに合わせる</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </section>

        <section className={section}>
          <h3 className={heading}>ヒント</h3>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={hintsEnabled()} onCheckedChange={setHintsEnabled} />
            <span>マウスオーバーで説明の吹き出しを表示</span>
          </label>
          <p className={desc}>
            各ヒントの「OK」を押すと、そのヒントは以後表示されません（この端末のみ）
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => {
              resetHints();
              pushToast("OKで消したヒントを再表示します", "info");
            }}
          >
            OKで消したヒントを再表示
          </Button>
        </section>

        {/* 通知（あなた宛）: 自分だけに効く受け取り設定（2026-08-07 分離）。
            Discord の2つはサーバのユーザー別設定で、切り替えの瞬間に保存される */}
        <section className={section}>
          <h3 className={heading}>通知（あなた宛）</h3>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={notifyEnabled} onCheckedChange={toggleNotify} />
            <span>あなたの番が来たらデスクトップ通知</span>
          </label>
          <p className={desc}>デスクトップ通知はこのブラウザのタブが開いている間だけ届きます</p>
          {mySettings ? (
            <>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Switch
                  checked={mySettings.discordTurnNotify}
                  onCheckedChange={(v) => patchMySettings({ discordTurnNotify: v })}
                />
                <span>自分の番が来たら Discord に通知（メンション付き）</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Switch
                  checked={mySettings.discordAiReplies}
                  onCheckedChange={(v) => patchMySettings({ discordAiReplies: v })}
                />
                <span>Task AI がスレッドに返信し終えたときも通知</span>
              </label>
              <p className={desc}>
                切り替えは即時保存されます。届くには全体タブで Discord 通知（親スイッチ）と
                Webhook URL が設定されている必要があります
              </p>
            </>
          ) : (
            <p className={desc}>Discord の個人設定を読み込み中…</p>
          )}
        </section>
        </>)}

        <div className="flex justify-end gap-2 pt-1.5">
          {forced && (
            <Button type="button" variant="outline" onClick={onSkip} disabled={saving}>
              あとで設定
            </Button>
          )}
          {/* ユーザータブは即時保存なので「保存」は全体タブのときだけ出す */}
          {(forced || tab === "global") && (
            <Button type="button" className="text-primary-foreground" onClick={save} disabled={saving}>
              保存
            </Button>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
