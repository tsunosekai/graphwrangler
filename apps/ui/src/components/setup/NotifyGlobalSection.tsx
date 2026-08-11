// 通知（インスタンス全体）の節: webhook は全員共通のチャンネル設定なのでこちら側。
// 受け取るかどうかの個人設定はユーザータブ（2026-08-07 分離）。
// URL は APIキーと同じ書き込み専用: 有無だけ受け取り、値は「変更」を押したときだけ送る
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { desc, field, heading, section } from "./styles";

interface Props {
  discordEnabled: boolean;
  setDiscordEnabled: (v: boolean) => void;
  /** true = 新しい URL を入力中（未設定 or「変更」を押した後）。false = 設定済み表示 */
  editingWebhook: boolean;
  setEditingWebhook: (v: boolean) => void;
  webhookUrl: string;
  setWebhookUrl: (v: string) => void;
  removeWebhook: () => void;
  testingNotify: boolean;
  testNotify: () => void;
  publicUrl: string;
  setPublicUrl: (v: string) => void;
}

export function NotifyGlobalSection({
  discordEnabled,
  setDiscordEnabled,
  editingWebhook,
  setEditingWebhook,
  webhookUrl,
  setWebhookUrl,
  removeWebhook,
  testingNotify,
  testNotify,
  publicUrl,
  setPublicUrl,
}: Props) {
  return (
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
      {/* 公開URL（2026-08-08 本人指示）: 通知からこのインスタンスへ飛ぶリンクの基底。
          サーバは自分の外向きURLを知らないのでここで教える */}
      <label className={field}>
        <span>公開URL（通知のリンク用）</span>
        <Input
          value={publicUrl}
          onChange={(e) => setPublicUrl(e.target.value)}
          placeholder="http://100.86.224.19:8770"
        />
      </label>
      <p className={desc}>通知に付くリンクの基底。未設定だと通知はリンク無しになります</p>
    </section>
  );
}
