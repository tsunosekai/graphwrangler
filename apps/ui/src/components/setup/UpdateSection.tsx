// 本体の自動アップデートの節（2026-08-05 本人要望。zinsei と stremix で別インスタンスが
// 走っているので、それぞれが自分で追随できるようにする）。
// 取り込みは fast-forward のみ・未コミットの変更があるときは見送り（selfupdate.ts）。
// 設定値（autoCheck/autoApply/intervalMin）は下の「保存」で送り、版の状態は /api/update から別途読む
import type { UpdateStatus } from "../../lib/api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { desc, field, heading, section } from "./styles";

interface Props {
  /** /api/update の結果。null = 取得中 or 取れなかった */
  updStatus: UpdateStatus | null;
  updBusy: boolean;
  checkUpdate: () => void;
  runUpdate: () => void;
  updAutoCheck: boolean;
  setUpdAutoCheck: (v: boolean) => void;
  updAutoApply: boolean;
  setUpdAutoApply: (v: boolean) => void;
  updIntervalMin: string;
  setUpdIntervalMin: (v: string) => void;
}

export function UpdateSection({
  updStatus,
  updBusy,
  checkUpdate,
  runUpdate,
  updAutoCheck,
  setUpdAutoCheck,
  updAutoApply,
  setUpdAutoApply,
  updIntervalMin,
  setUpdIntervalMin,
}: Props) {
  return (
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
  );
}
