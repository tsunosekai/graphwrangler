// ヒント（マウスオーバーの説明吹き出し。lib/hints.ts）の節。テーマ・通知と同じく
// localStorage 持ちの即時反映で、下の「保存」を経由しない
// （再描画のための useHintsVersion() は SetupModal 側で購読する）
import { hintsEnabled, resetHints, setHintsEnabled } from "../../lib/hints";
import { pushToast } from "../../lib/toast";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { desc, heading, section } from "./styles";

export function HintsSection() {
  return (
    <section className={section}>
      <h3 className={heading}>ヒント</h3>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <Switch checked={hintsEnabled()} onCheckedChange={setHintsEnabled} />
        <span>マウスオーバーで説明の吹き出しを表示</span>
      </label>
      <p className={desc}>
        各ヒントの「OK」を押すと、そのヒントは以後表示されません（この端末のみ）
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          resetHints();
          pushToast("OKで消したヒントを再表示します", "info");
        }}
      >
        OKで消したヒントを再表示
      </Button>
    </section>
  );
}
