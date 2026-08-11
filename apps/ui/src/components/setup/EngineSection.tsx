// 実行AI（エンジン）の節。チャットAIと同じく先に「接続方式」を選ばせ、CLI と APIキーで
// 入力欄を出し分ける（docs/design.md: エージェントごと差し替え）
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { CliModelSelect, EffortSelect, type EffortValue } from "./CliSelects";
import { desc, field, heading, section } from "./styles";

export type EngineMode = "cli" | "api";

const ENGINE_MODE_DESC: Record<EngineMode, string> = {
  cli: "claude -p 等のログイン済みCLIを使います。APIキー不要。",
  api: "APIキーで直接呼び出します（チャットAIで設定したプロバイダ/キーを使用）。",
};

interface Props {
  engineMode: EngineMode;
  setEngineMode: (v: EngineMode) => void;
  cliPath: string;
  setCliPath: (v: string) => void;
  engineModel: string;
  setEngineModel: (v: string) => void;
  engineEffort: EffortValue;
  setEngineEffort: (v: EffortValue) => void;
  extraArgs: string;
  setExtraArgs: (v: string) => void;
  engineCliExtraTools: string;
  setEngineCliExtraTools: (v: string) => void;
  engineApiModel: string;
  setEngineApiModel: (v: string) => void;
}

export function EngineSection({
  engineMode,
  setEngineMode,
  cliPath,
  setCliPath,
  engineModel,
  setEngineModel,
  engineEffort,
  setEngineEffort,
  extraArgs,
  setExtraArgs,
  engineCliExtraTools,
  setEngineCliExtraTools,
  engineApiModel,
  setEngineApiModel,
}: Props) {
  return (
    <section className={section}>
      <h3 className={heading}>実行AI（エンジン）</h3>
      <label className={field}>
        <span>接続方式</span>
        <Select value={engineMode} onValueChange={(v) => setEngineMode(v as EngineMode)}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="cli">ヘッドレスエージェント（CLI）</SelectItem>
            <SelectItem value="api">APIキー（チャットと同じキーを使用）</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <p className={desc}>{ENGINE_MODE_DESC[engineMode]}</p>

      {engineMode === "cli" ? (
        <>
          <label className={field}>
            <span>CLIパス</span>
            <Input value={cliPath} onChange={(e) => setCliPath(e.target.value)} placeholder="claude" />
          </label>
          <label className={field}>
            <span>モデル</span>
            <CliModelSelect value={engineModel} onChange={setEngineModel} />
          </label>
          <label className={field}>
            <span>思考の深さ</span>
            <EffortSelect value={engineEffort} onChange={setEngineEffort} />
          </label>
          <label className={field}>
            <span>追加引数</span>
            <Input
              value={extraArgs}
              onChange={(e) => setExtraArgs(e.target.value)}
              placeholder="--flag value"
            />
          </label>
          <label className={field}>
            <span>追加許可ツール</span>
            <Input
              value={engineCliExtraTools}
              onChange={(e) => setEngineCliExtraTools(e.target.value)}
              placeholder="空欄=既定のフルセット。例: mcp__foo__*"
            />
          </label>
          <p className={desc}>
            実行AIの --allowedTools に追記するツール（空白区切り）。
            Bash 含むフルセットが既定で許可済みなので、MCP ツール等を足す用途
          </p>
        </>
      ) : (
        <label className={field}>
          <span>モデル（任意）</span>
          <Input
            value={engineApiModel}
            onChange={(e) => setEngineApiModel(e.target.value)}
            placeholder="空欄=チャットAIと同じ既定モデル"
          />
        </label>
      )}
    </section>
  );
}
