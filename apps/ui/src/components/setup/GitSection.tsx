// Git 自動プッシュの節
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { desc, field, heading, section } from "./styles";

interface Props {
  gitAutoPush: boolean;
  setGitAutoPush: (v: boolean) => void;
  gitIntervalSec: string;
  setGitIntervalSec: (v: string) => void;
}

export function GitSection({
  gitAutoPush,
  setGitAutoPush,
  gitIntervalSec,
  setGitIntervalSec,
}: Props) {
  return (
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
  );
}
