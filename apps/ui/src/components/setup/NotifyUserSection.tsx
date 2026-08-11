// 通知（あなた宛）の節: 自分だけに効く受け取り設定（2026-08-07 分離）。
// Discord の2つはサーバのユーザー別設定で、切り替えの瞬間に保存される
import type { UserSettings } from "../../lib/api";
import { Switch } from "../ui/switch";
import { desc, heading, section } from "./styles";

interface Props {
  notifyEnabled: boolean;
  toggleNotify: () => void;
  /** null = /api/me/settings をまだ読めていない（旧サーバには無い） */
  mySettings: UserSettings | null;
  patchMySettings: (patch: Partial<UserSettings>) => void;
}

export function NotifyUserSection({
  notifyEnabled,
  toggleNotify,
  mySettings,
  patchMySettings,
}: Props) {
  return (
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
          <p className={desc}>
            切り替えは即時保存されます。届くには全体タブで Discord 通知（親スイッチ）・
            Webhook URL・通知リンクの基底URL が設定されている必要があります
          </p>
          {/* 「Task AI がスレッドに返信し終えたときも通知」のスイッチは廃止（2026-08-11
              本人指示——チャット中に1往復ごとに鳴っていた。返信は開けば読める） */}
        </>
      ) : (
        <p className={desc}>Discord の個人設定を読み込み中…</p>
      )}
    </section>
  );
}
