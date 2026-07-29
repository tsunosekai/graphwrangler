// 初回セットアップ + いつでも開ける⚙設定（OpenClaw のプロバイダ設定画面を参考に）。
// 「チャットAI」（相棒AI）と「実行AI＝エンジン」それぞれについて、まず「接続方式」
// （APIキー / ヘッドレスエージェントCLI）をドロップダウンで選ばせ、選んだ方式に応じて
// 入力欄を出し分ける（docs/design.md: LLM選択は「APIキーの差し替え」でなく
// 「エージェントごと差し替え」。2026-07-29 本人フィードバック「どっちを使う設定か分からない」対応）。
import { useState } from "react";
import { api, type SettingsPatch, type SettingsView } from "../lib/api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
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
  anthropic: "claude-sonnet-5",
  openai: "gpt-5",
};

const CHAT_MODE_DESC: Record<ChatMode, string> = {
  api: "APIキーで直接呼び出します。",
  cli: "claude -p 等のログイン済みCLIを使います。APIキー不要。",
};

const ENGINE_MODE_DESC: Record<EngineMode, string> = {
  cli: "claude -p 等のログイン済みCLIを使います。APIキー不要。",
  api: "APIキーで直接呼び出します（チャットAIで設定したプロバイダ/キーを使用）。",
};

export function SetupModal({ settings, forced, onSaved, onSkip, onClose }: Props) {
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

  // QOL-6: あなたの番が来たらデスクトップ通知（localStorage gw.notify。実際の発火は App 側）
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
          cliModel: chatCliModel.trim() || "sonnet",
        },
        engine: {
          mode: engineMode,
          cliPath: cliPath.trim() || "claude",
          model: engineModel.trim() || "sonnet",
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
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !forced) onClose();
        // forced 中は Escape/外側クリックでは閉じない（「あとで設定」か「保存」だけが抜け道）
      }}
    >
      <DialogContent
        showCloseButton={!forced}
        // 元の実装は背景クリック/Escapeでは閉じず、×ボタン（または保存/あとで設定）だけが
        // 閉じる導線だった。挙動を変えないためどちらも無効化する
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        className="max-h-[calc(100vh-48px)] max-w-[420px] overflow-y-auto gap-3.5"
      >
        <DialogHeader>
          <DialogTitle>AI設定</DialogTitle>
        </DialogHeader>

        <section className={section}>
          <h3 className={heading}>チャットAI（相棒AI）</h3>
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
                <Input
                  value={chatCliModel}
                  onChange={(e) => setChatCliModel(e.target.value)}
                  placeholder="sonnet"
                />
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
                <Input
                  value={engineModel}
                  onChange={(e) => setEngineModel(e.target.value)}
                  placeholder="sonnet"
                />
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
      </DialogContent>
    </Dialog>
  );
}
