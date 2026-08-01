// 初回セットアップ + いつでも開ける⚙設定。2026-08-02 本人指示「設定はモーダルじゃなくて
// 全面表示に」でダイアログから全画面レイヤーへ変更（fixed inset-0。ヘッダー行 + スクロール本体）。
// 「チャットAI」（Workflow AI）と「実行AI＝エンジン」それぞれについて、まず「接続方式」
// （APIキー / ヘッドレスエージェントCLI）をドロップダウンで選ばせ、選んだ方式に応じて
// 入力欄を出し分ける（docs/design.md: LLM選択は「APIキーの差し替え」でなく
// 「エージェントごと差し替え」。2026-07-29 本人フィードバック「どっちを使う設定か分からない」対応）。
import { useState } from "react";
import { api, type SettingsPatch, type SettingsView } from "../lib/api";
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

  const [engineMode, setEngineMode] = useState<EngineMode>(settings.engine.mode);
  const [cliPath, setCliPath] = useState(settings.engine.cliPath);
  const [engineModel, setEngineModel] = useState(settings.engine.model);
  const [extraArgs, setExtraArgs] = useState(settings.engine.extraArgs.join(" "));
  const [engineApiModel, setEngineApiModel] = useState(settings.engine.apiModel ?? "");

  const [saving, setSaving] = useState(false);

  // あなたの番が来たらデスクトップ通知（localStorage gw.notify。実際の発火は App 側）
  const [notifyEnabled, setNotifyEnabled] = useState(() => localStorage.getItem("gw.notify") === "1");

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
        },
        engine: {
          mode: engineMode,
          cliPath: cliPath.trim() || "claude",
          model: engineModel.trim() || "opus",
          extraArgs: extraArgs.trim() ? extraArgs.trim().split(/\s+/) : [],
          apiModel: engineApiModel.trim() || null,
        },
        setupDone: true,
      };
      if (editingKey) patch.chat = { ...patch.chat, apiKey: apiKey.trim() || null };
      const next = await api.updateSettings(patch);
      setApiKey("");
      setEditingKey(!next.chat.hasApiKey);
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

        <section className={section}>
          <h3 className={heading}>チャットAI（Workflow AI）</h3>
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
                <span>追加引数</span>
                <Input
                  value={extraArgs}
                  onChange={(e) => setExtraArgs(e.target.value)}
                  placeholder="--flag value"
                />
              </label>
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
          <h3 className={heading}>通知</h3>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={notifyEnabled} onCheckedChange={toggleNotify} />
            <span>あなたの番が来たらデスクトップ通知</span>
          </label>
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

        <div className="flex justify-end gap-2 pt-1.5">
          {forced && (
            <Button type="button" variant="outline" onClick={onSkip} disabled={saving}>
              あとで設定
            </Button>
          )}
          <Button type="button" className="text-primary-foreground" onClick={save} disabled={saving}>
            保存
          </Button>
        </div>
        </div>
      </div>
    </div>
  );
}
