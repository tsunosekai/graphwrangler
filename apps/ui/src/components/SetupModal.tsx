// 初回セットアップ + いつでも開ける⚙設定（OpenClaw のプロバイダ設定画面を参考に）。
// 「チャットAI」（相棒AI）と「実行AI＝エンジン」それぞれについて、まず「接続方式」
// （APIキー / ヘッドレスエージェントCLI）をドロップダウンで選ばせ、選んだ方式に応じて
// 入力欄を出し分ける（docs/design.md: LLM選択は「APIキーの差し替え」でなく
// 「エージェントごと差し替え」。2026-07-29 本人フィードバック「どっちを使う設定か分からない」対応）。
import { useState } from "react";
import { api, type SettingsPatch, type SettingsView } from "../lib/api";

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

  return (
    <div className="modal-overlay">
      <div className="modal-card setup-modal">
        <div className="modal-head">
          <h2>AI設定</h2>
          {!forced && (
            <button type="button" className="modal-close" onClick={onClose} aria-label="閉じる">
              ×
            </button>
          )}
        </div>

        <section className="setup-section">
          <h3>チャットAI（相棒AI）</h3>
          <label className="setup-field">
            <span>接続方式</span>
            <select value={chatMode} onChange={(e) => setChatMode(e.target.value as ChatMode)}>
              <option value="api">APIキー（Anthropic / OpenAI）</option>
              <option value="cli">ヘッドレスエージェント（claude 等のCLI）</option>
            </select>
          </label>
          <p className="setup-mode-desc">{CHAT_MODE_DESC[chatMode]}</p>

          {chatMode === "api" ? (
            <>
              <label className="setup-field">
                <span>プロバイダ</span>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as "anthropic" | "openai")}
                >
                  <option value="anthropic">anthropic</option>
                  <option value="openai">openai</option>
                </select>
              </label>
              <label className="setup-field">
                <span>モデル</span>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={CHAT_DEFAULT_MODEL[provider]}
                />
              </label>
              <label className="setup-field">
                <span>APIキー</span>
                {editingKey ? (
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                  />
                ) : (
                  <span className="setup-key-set">
                    設定済み（●●●）
                    <button type="button" onClick={() => setEditingKey(true)}>
                      変更
                    </button>
                    <button type="button" onClick={removeKey}>
                      削除
                    </button>
                  </span>
                )}
              </label>
            </>
          ) : (
            <>
              <label className="setup-field">
                <span>CLIパス</span>
                <input
                  value={chatCliPath}
                  onChange={(e) => setChatCliPath(e.target.value)}
                  placeholder="claude"
                />
              </label>
              <label className="setup-field">
                <span>モデル</span>
                <input
                  value={chatCliModel}
                  onChange={(e) => setChatCliModel(e.target.value)}
                  placeholder="sonnet"
                />
              </label>
            </>
          )}
        </section>

        <section className="setup-section">
          <h3>実行AI（エンジン）</h3>
          <label className="setup-field">
            <span>接続方式</span>
            <select value={engineMode} onChange={(e) => setEngineMode(e.target.value as EngineMode)}>
              <option value="cli">ヘッドレスエージェント（CLI）</option>
              <option value="api">APIキー（チャットと同じキーを使用）</option>
            </select>
          </label>
          <p className="setup-mode-desc">{ENGINE_MODE_DESC[engineMode]}</p>

          {engineMode === "cli" ? (
            <>
              <label className="setup-field">
                <span>CLIパス</span>
                <input value={cliPath} onChange={(e) => setCliPath(e.target.value)} placeholder="claude" />
              </label>
              <label className="setup-field">
                <span>モデル</span>
                <input
                  value={engineModel}
                  onChange={(e) => setEngineModel(e.target.value)}
                  placeholder="sonnet"
                />
              </label>
              <label className="setup-field">
                <span>追加引数</span>
                <input
                  value={extraArgs}
                  onChange={(e) => setExtraArgs(e.target.value)}
                  placeholder="--flag value"
                />
              </label>
            </>
          ) : (
            <label className="setup-field">
              <span>モデル（任意）</span>
              <input
                value={engineApiModel}
                onChange={(e) => setEngineApiModel(e.target.value)}
                placeholder="空欄=チャットAIと同じ既定モデル"
              />
            </label>
          )}
        </section>

        <section className="setup-section">
          <h3>通知</h3>
          <label className="setup-notify-row">
            <input type="checkbox" checked={notifyEnabled} onChange={toggleNotify} />
            <span>あなたの番が来たらデスクトップ通知</span>
          </label>
        </section>

        <section className="setup-section">
          <button type="button" className="setup-export-btn" onClick={() => window.open("/api/export")}>
            データをエクスポート
          </button>
        </section>

        <div className="modal-actions">
          {forced && (
            <button type="button" onClick={onSkip} disabled={saving}>
              あとで設定
            </button>
          )}
          <button type="button" className="setup-save-btn" onClick={save} disabled={saving}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
