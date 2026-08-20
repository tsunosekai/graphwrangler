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
  /** 同じ人の人間作業が続く区間をまとめて1通にするか（2026-08-20） */
  quietConsecutive: boolean;
  setQuietConsecutive: (v: boolean) => void;
  /** 業務連絡（手順書で指定されたチャンネルへの投稿）用。2026-08-11 */
  editingBotToken: boolean;
  setEditingBotToken: (v: boolean) => void;
  botToken: string;
  setBotToken: (v: string) => void;
  removeBotToken: () => void;
  guildId: string;
  setGuildId: (v: string) => void;
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
  quietConsecutive,
  setQuietConsecutive,
  editingBotToken,
  setEditingBotToken,
  botToken,
  setBotToken,
  removeBotToken,
  guildId,
  setGuildId,
}: Props) {
  return (
    <section className={section}>
      <h3 className={heading}>通知（Discord・全体）</h3>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <Switch checked={discordEnabled} onCheckedChange={setDiscordEnabled} />
        <span>Discord 通知を有効にする（インスタンス全体の親スイッチ）</span>
      </label>
      <label className={field}>
        <span>グラフ通知チャンネルの Webhook URL</span>
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
        「あなたの番」だけがここへ流れます（判断リクエスト・AIの質問・承認ゲート・失敗リカバリ・
        分岐・ランの待ち）。通知先チャンネルの設定 → 連携サービス → ウェブフックで URL を発行して
        貼り付け、下の「保存」で反映されます。宛先は関係者から解決してメンションします
        （担当 → ノードの作成者 → ページの関係者 → 直近の会話相手の順。ユーザー管理で Discord ID
        を登録した人だけが実際に鳴ります）。受け取るかどうかの個人設定はユーザータブにあります
      </p>
      {/* 公開URL（2026-08-08 本人指示）: 通知からこのインスタンスへ飛ぶリンクの基底。
          サーバは自分の外向きURLを知らないのでここで教える。
          2026-08-11 から**必須**（未設定なら通知を出さない） */}
      <label className={field}>
        <span>公開URL（通知のリンク用・必須）</span>
        <Input
          value={publicUrl}
          onChange={(e) => setPublicUrl(e.target.value)}
          placeholder="http://100.86.224.19:8770"
        />
      </label>
      <p className={desc}>
        通知に付くノードURLの基底。<strong>未設定だと通知そのものが出ません</strong>
        （何の話か分からない通知は出さない方針）
      </p>

      {/* 連続する人間作業の消音（2026-08-20 本人指示「人間実行ノードかつ担当者が同じタスクが
          連続している場合のみ通知が出ないようにしてね」）。ノードごとの設定ではなく、
          グラフの形（直前の作業が同じ人の手作業か）から自動で決まる */}
      <label className="mt-4 flex items-center gap-2 text-sm text-foreground">
        <Switch checked={quietConsecutive} onCheckedChange={setQuietConsecutive} />
        <span>続けて自分の番が来るときは通知をまとめる</span>
      </label>
      <p className={desc}>
        直前の作業が<strong>同じ担当者の人間ノード</strong>だけのときは鳴らしません
        （手を動かしている最中に鳴らしても情報が増えないため）。区間の先頭や、AI・スクリプトの
        仕事が終わって回ってきた番は今までどおり鳴ります。橙の「あなたの番」表示は変わりません
      </p>

      {/* 業務連絡（2026-08-11 本人要望）: 手順書に「#運営一般 に報告」と書かれたノードで、
          AI がその実行としてチャンネルへ投げるための口。グラフ通知とは別系統で、
          チャンネルごとに Webhook を発行して回らずに済むよう Bot トークン + 名前解決にした */}
      <h4 className="mt-4 text-sm font-medium text-foreground">業務連絡（手順書で指定したチャンネルへ）</h4>
      <label className={field}>
        <span>Discord Bot トークン</span>
        {editingBotToken ? (
          <Input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="Bot トークンを貼り付け"
          />
        ) : (
          <span className="flex items-center gap-2 text-sm text-foreground">
            設定済み（●●●）
            <Button type="button" variant="outline" size="sm" onClick={() => setEditingBotToken(true)}>
              変更
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={removeBotToken}>
              削除
            </Button>
          </span>
        )}
      </label>
      <label className={field}>
        <span>サーバーID（guild ID）</span>
        <Input
          value={guildId}
          onChange={(e) => setGuildId(e.target.value)}
          placeholder="123456789012345678"
        />
      </label>
      <p className={desc}>
        手順書に「#運営一般 に報告」のようにチャンネル名を書いておくと、AI がその実行として
        そこへ投稿します（ノードURL・関係者メンション・出し元の [Graph Wrangler] はサーバが自動で
        付けます）。Bot はそのサーバーに参加していてチャンネル一覧を読める必要があります。
        手順書に書かれていないチャンネルへは投稿されません
      </p>
    </section>
  );
}
