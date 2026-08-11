// AIの作業範囲の節（三役共通の --add-dir）
import { Input } from "../ui/input";
import { desc, field, heading, section } from "./styles";

interface Props {
  aiAddDirs: string;
  setAiAddDirs: (v: string) => void;
}

export function WorkDirsSection({ aiAddDirs, setAiAddDirs }: Props) {
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
    </section>
  );
}
