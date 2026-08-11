// 初回セットアップ + いつでも開ける⚙設定。2026-08-02 本人指示「設定はモーダルじゃなくて
// 全面表示に」でダイアログから全画面レイヤーへ変更（fixed inset-0。ヘッダー行 + スクロール本体）。
// 区画ごとの見た目は components/setup/ の各節へ切り出し、ここは
// 「フォームの状態 + 保存（全体タブの一括保存 / ユーザー設定の即時保存）」だけを持つ。
import { useEffect, useRef, useState } from "react";
import {
  api,
  type SettingsPatch,
  type SettingsView,
  type UpdateStatus,
  type UserSettings,
} from "../lib/api";
import { DEFAULT_SITE_TITLE, refreshBranding } from "../lib/branding";
import { useHintsVersion } from "../lib/hints";
import { pushToast } from "../lib/toast";
import { useTheme } from "../lib/theme";
import { Button } from "./ui/button";
import { X } from "lucide-react";
import { BrandingSection } from "./setup/BrandingSection";
import { ChatAiSection, type ChatMode } from "./setup/ChatAiSection";
import type { EffortValue } from "./setup/CliSelects";
import { EngineSection, type EngineMode } from "./setup/EngineSection";
import { GitSection } from "./setup/GitSection";
import { HintsSection } from "./setup/HintsSection";
import { NotifyGlobalSection } from "./setup/NotifyGlobalSection";
import { NotifyUserSection } from "./setup/NotifyUserSection";
import { ThemeSection } from "./setup/ThemeSection";
import { UpdateSection } from "./setup/UpdateSection";
import { WorkDirsSection } from "./setup/WorkDirsSection";
import { section } from "./setup/styles";

interface Props {
  settings: SettingsView;
  /** true = 起動時の強制オーバーレイ（初回セットアップ）。「あとで設定」ボタンを出す */
  forced: boolean;
  onSaved: (next: SettingsView) => void;
  onSkip: () => void;
  onClose: () => void;
}

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

  // ブランディング（2026-08-08。会社インスタンスだけ ARK の名前とアイコンにする）。
  // サイト名は下の「保存」で他の設定と一緒に送る。画像は multipart なので即時反映の別口
  const [siteTitle, setSiteTitle] = useState(settings.branding?.siteTitle ?? DEFAULT_SITE_TITLE);
  const [faviconVersion, setFaviconVersion] = useState(settings.branding?.faviconVersion ?? 0);
  const [faviconBusy, setFaviconBusy] = useState(false);
  const faviconInputRef = useRef<HTMLInputElement>(null);
  const uploadFavicon = async (file: File) => {
    setFaviconBusy(true);
    try {
      const res = await api.uploadFavicon(file);
      setFaviconVersion(res.faviconVersion);
      await refreshBranding(); // タブのアイコンをその場で差し替える
      pushToast("ファビコンを差し替えました", "info");
    } catch {
      // api 側でトースト済み
    } finally {
      setFaviconBusy(false);
      if (faviconInputRef.current) faviconInputRef.current.value = ""; // 同じファイルを選び直せるように
    }
  };
  const resetFavicon = async () => {
    setFaviconBusy(true);
    try {
      const res = await api.resetFavicon();
      setFaviconVersion(res.faviconVersion);
      await refreshBranding();
      pushToast("ファビコンを既定に戻しました", "info");
    } catch {
      // api 側でトースト済み
    } finally {
      setFaviconBusy(false);
    }
  };

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

  // あなたの番が来たらデスクトップ通知（localStorage gw.notify。実際のラン作成は App 側）
  const [notifyEnabled, setNotifyEnabled] = useState(() => localStorage.getItem("gw.notify") === "1");

  // Discord Webhook 通知（2026-08-07。こちらはサーバ設定＝タブを閉じていても届く）。
  // URL は APIキーと同じ書き込み専用: 有無だけ受け取り、値は「変更」を押したときだけ送る
  const [discordEnabled, setDiscordEnabled] = useState(settings.notify?.discordEnabled ?? false);
  const [webhookUrl, setWebhookUrl] = useState("");
  // 公開URL（通知に付くリンクの基底。2026-08-08 本人指示）。空欄 = リンク無しで通知
  const [publicUrl, setPublicUrl] = useState(settings.notify?.publicUrl ?? "");
  // 業務連絡（手順書で指定したチャンネルへの投稿）用。トークンは Webhook URL と同じ
  // 書き込み専用の扱い（有無だけ受け取り、値は入力中のときだけ送る）。2026-08-11
  const [botToken, setBotToken] = useState("");
  const [guildId, setGuildId] = useState(settings.notify?.discordGuildId ?? "");

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
  const [editingBotToken, setEditingBotToken] = useState(
    !(settings.notify?.hasDiscordBotToken ?? false),
  );
  const removeBotToken = async () => {
    try {
      const next = await api.updateSettings({ notify: { discordBotToken: null } });
      setEditingBotToken(true);
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
        // publicUrl は末尾スラッシュを落として保存（リンク組み立て時の // を防ぐ）。空欄 = null（2026-08-08）
        notify: {
          discordEnabled,
          publicUrl: publicUrl.trim().replace(/\/+$/, "") || null,
          discordGuildId: guildId.trim() || null,
        },
        // 空欄で保存したら既定名へ戻す（min(1) のサーバ検証で弾かれないように畳んでおく）
        branding: { siteTitle: siteTitle.trim() || DEFAULT_SITE_TITLE },
        setupDone: true,
      };
      if (editingKey) patch.chat = { ...patch.chat, apiKey: apiKey.trim() || null };
      // URL 入力中のみ送る（空欄で保存しても既存の URL を消さない。消すのは「削除」ボタン）
      if (editingWebhook && webhookUrl.trim()) {
        patch.notify = { ...patch.notify, discordWebhookUrl: webhookUrl.trim() };
      }
      if (editingBotToken && botToken.trim()) {
        patch.notify = { ...patch.notify, discordBotToken: botToken.trim() };
      }
      const next = await api.updateSettings(patch);
      setApiKey("");
      setEditingKey(!next.chat.hasApiKey);
      setWebhookUrl("");
      setEditingWebhook(!next.notify.hasDiscordWebhook);
      setBotToken("");
      setEditingBotToken(!next.notify.hasDiscordBotToken);
      void refreshBranding(); // サイト名の変更をヘッダーとタブへ即反映
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
        <ChatAiSection
          chatMode={chatMode}
          setChatMode={setChatMode}
          provider={provider}
          setProvider={setProvider}
          model={model}
          setModel={setModel}
          apiKey={apiKey}
          setApiKey={setApiKey}
          editingKey={editingKey}
          setEditingKey={setEditingKey}
          removeKey={removeKey}
          chatCliPath={chatCliPath}
          setChatCliPath={setChatCliPath}
          chatCliModel={chatCliModel}
          setChatCliModel={setChatCliModel}
          chatCliEffort={chatCliEffort}
          setChatCliEffort={setChatCliEffort}
          chatCliExtraTools={chatCliExtraTools}
          setChatCliExtraTools={setChatCliExtraTools}
        />

        <EngineSection
          engineMode={engineMode}
          setEngineMode={setEngineMode}
          cliPath={cliPath}
          setCliPath={setCliPath}
          engineModel={engineModel}
          setEngineModel={setEngineModel}
          engineEffort={engineEffort}
          setEngineEffort={setEngineEffort}
          extraArgs={extraArgs}
          setExtraArgs={setExtraArgs}
          engineCliExtraTools={engineCliExtraTools}
          setEngineCliExtraTools={setEngineCliExtraTools}
          engineApiModel={engineApiModel}
          setEngineApiModel={setEngineApiModel}
        />

        <WorkDirsSection aiAddDirs={aiAddDirs} setAiAddDirs={setAiAddDirs} />

        <GitSection
          gitAutoPush={gitAutoPush}
          setGitAutoPush={setGitAutoPush}
          gitIntervalSec={gitIntervalSec}
          setGitIntervalSec={setGitIntervalSec}
        />

        <UpdateSection
          updStatus={updStatus}
          updBusy={updBusy}
          checkUpdate={checkUpdate}
          runUpdate={runUpdate}
          updAutoCheck={updAutoCheck}
          setUpdAutoCheck={setUpdAutoCheck}
          updAutoApply={updAutoApply}
          setUpdAutoApply={setUpdAutoApply}
          updIntervalMin={updIntervalMin}
          setUpdIntervalMin={setUpdIntervalMin}
        />

        <NotifyGlobalSection
          discordEnabled={discordEnabled}
          setDiscordEnabled={setDiscordEnabled}
          editingWebhook={editingWebhook}
          setEditingWebhook={setEditingWebhook}
          webhookUrl={webhookUrl}
          setWebhookUrl={setWebhookUrl}
          removeWebhook={removeWebhook}
          testingNotify={testingNotify}
          testNotify={testNotify}
          publicUrl={publicUrl}
          setPublicUrl={setPublicUrl}
          editingBotToken={editingBotToken}
          setEditingBotToken={setEditingBotToken}
          botToken={botToken}
          setBotToken={setBotToken}
          removeBotToken={removeBotToken}
          guildId={guildId}
          setGuildId={setGuildId}
        />

        <BrandingSection
          siteTitle={siteTitle}
          setSiteTitle={setSiteTitle}
          faviconVersion={faviconVersion}
          faviconBusy={faviconBusy}
          faviconInputRef={faviconInputRef}
          uploadFavicon={uploadFavicon}
          resetFavicon={resetFavicon}
        />

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
        <ThemeSection themeMode={themeMode} setThemeMode={setThemeMode} />

        <HintsSection />

        <NotifyUserSection
          notifyEnabled={notifyEnabled}
          toggleNotify={toggleNotify}
          mySettings={mySettings}
          patchMySettings={patchMySettings}
        />
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
