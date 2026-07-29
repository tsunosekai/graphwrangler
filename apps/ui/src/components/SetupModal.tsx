// 初回セットアップ + いつでも開ける⚙設定（OpenClaw のプロバイダ設定画面を参考に）。
// 「チャットAI」（プロバイダのAPIキー）と「実行AI＝エンジン」（ヘッドレスCLI）を分けて持つ
// （docs/design.md: LLM選択は「APIキーの差し替え」でなく「エージェントごと差し替え」）。
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

const CHAT_DEFAULT_MODEL: Record<"anthropic" | "openai", string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5",
};

export function SetupModal({ settings, forced, onSaved, onSkip, onClose }: Props) {
  const [provider, setProvider] = useState<"anthropic" | "openai">(settings.chat.provider);
  const [model, setModel] = useState(settings.chat.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [editingKey, setEditingKey] = useState(!settings.chat.hasApiKey);
  const [cliPath, setCliPath] = useState(settings.engine.cliPath);
  const [engineModel, setEngineModel] = useState(settings.engine.model);
  const [extraArgs, setExtraArgs] = useState(settings.engine.extraArgs.join(" "));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const patch: SettingsPatch = {
        chat: { provider, model: model.trim() || null },
        engine: {
          cliPath: cliPath.trim() || "claude",
          model: engineModel.trim() || "sonnet",
          extraArgs: extraArgs.trim() ? extraArgs.trim().split(/\s+/) : [],
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
          <h3>チャットAI</h3>
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
        </section>

        <section className="setup-section">
          <h3>実行AI（エンジン）</h3>
          <p className="setup-desc">
            claude -p 等のヘッドレスCLIを使います。API キー不要（CLI のログインを利用）
          </p>
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
