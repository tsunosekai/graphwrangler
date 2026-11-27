// AIの作業範囲の節（三役共通の --add-dir）
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { desc, field, heading, section } from "./styles";

interface Props {
  aiAddDirs: string;
  setAiAddDirs: (v: string) => void;
  aiAllowAll: boolean;
  setAiAllowAll: (v: boolean) => void;
}

export function WorkDirsSection({ aiAddDirs, setAiAddDirs, aiAllowAll, setAiAllowAll }: Props) {
  return (
    <section className={section}>
      <h3 className={heading}>AIの作業範囲</h3>
      <label className={field}>
        <span>追加作業ディレクトリ</span>
        <Input
          value={aiAddDirs}
          onChange={(e) => setAiAddDirs(e.target.value)}
          placeholder="空欄=ワークスペース内のみ。例: /home/ubuntu"
        />
      </label>
      <p className={desc}>
        三役（GraphWrangler AI / Task AI / 実行AI）共通。claude の --add-dir
        に渡すディレクトリ（空白区切り）。ファイル操作はワークスペースルートに閉じるのが既定なので、
        外のリポジトリ等を触らせたいときにここへ足す
      </p>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <Switch checked={aiAllowAll} onCheckedChange={setAiAllowAll} />
        <span>すべてのツールを確認なしで使わせる</span>
      </label>
      <p className={desc}>
        三役共通。ON にすると、許可リストに無いツール（MCP など）も「未許可」で止まらずに使える
        （claude の --permission-mode bypassPermissions）。「追加許可ツール」に足す手間が要らなくなる
      </p>
    </section>
  );
}
