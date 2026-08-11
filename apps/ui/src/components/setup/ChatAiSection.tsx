// チャットAI（GraphWrangler AI）の節。まず「接続方式」（APIキー / ヘッドレスエージェントCLI）を
// 選ばせ、選んだ方式に応じて入力欄を出し分ける（docs/design.md: LLM選択は「APIキーの差し替え」でなく
// 「エージェントごと差し替え」。2026-07-29 本人フィードバック「どっちを使う設定か分からない」対応）。
// 入力値は SetupModal が持ち、下の「保存」でまとめて送る（APIキーの削除だけ即時）
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { CliModelSelect, EffortSelect, type EffortValue } from "./CliSelects";
import { desc, field, heading, section } from "./styles";

export type ChatMode = "api" | "cli";

const CHAT_DEFAULT_MODEL: Record<"anthropic" | "openai", string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5",
};

const CHAT_MODE_DESC: Record<ChatMode, string> = {
  api: "APIキーで直接呼び出します。",
  cli: "claude -p 等のログイン済みCLIを使います。APIキー不要。",
};

interface Props {
  chatMode: ChatMode;
  setChatMode: (v: ChatMode) => void;
  provider: "anthropic" | "openai";
  setProvider: (v: "anthropic" | "openai") => void;
  model: string;
  setModel: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  /** true = 新しいキーを入力中（未設定 or「変更」を押した後）。false = 設定済み表示 */
  editingKey: boolean;
  setEditingKey: (v: boolean) => void;
  removeKey: () => void;
  chatCliPath: string;
  setChatCliPath: (v: string) => void;
  chatCliModel: string;
  setChatCliModel: (v: string) => void;
  chatCliEffort: EffortValue;
  setChatCliEffort: (v: EffortValue) => void;
  chatCliExtraTools: string;
  setChatCliExtraTools: (v: string) => void;
}

export function ChatAiSection({
  chatMode,
  setChatMode,
  provider,
  setProvider,
  model,
  setModel,
  apiKey,
  setApiKey,
  editingKey,
  setEditingKey,
  removeKey,
  chatCliPath,
  setChatCliPath,
  chatCliModel,
  setChatCliModel,
  chatCliEffort,
  setChatCliEffort,
  chatCliExtraTools,
  setChatCliExtraTools,
}: Props) {
  return (
    <section className={section}>
      <h3 className={heading}>チャットAI（GraphWrangler AI）</h3>
      <label className={field}>
        <span>接続方式</span>
        <Select value={chatMode} onValueChange={(v) => setChatMode(v as ChatMode)}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="api">APIキー（Anthropic / OpenAI）</SelectItem>
            <SelectItem value="cli">ヘッドレスエージェント（claude 等のCLI）</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <p className={desc}>{CHAT_MODE_DESC[chatMode]}</p>

      {chatMode === "api" ? (
        <>
          <label className={field}>
            <span>プロバイダ</span>
            <Select value={provider} onValueChange={(v) => setProvider(v as "anthropic" | "openai")}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic">anthropic</SelectItem>
                <SelectItem value="openai">openai</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className={field}>
            <span>モデル</span>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={CHAT_DEFAULT_MODEL[provider]}
            />
          </label>
          <label className={field}>
            <span>APIキー</span>
            {editingKey ? (
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
            ) : (
              <span className="flex items-center gap-2 text-sm text-foreground">
                設定済み（●●●）
                <Button type="button" variant="outline" size="sm" onClick={() => setEditingKey(true)}>
                  変更
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={removeKey}>
                  削除
                </Button>
              </span>
            )}
          </label>
        </>
      ) : (
        <>
          <label className={field}>
            <span>CLIパス</span>
            <Input
              value={chatCliPath}
              onChange={(e) => setChatCliPath(e.target.value)}
              placeholder="claude"
            />
          </label>
          <label className={field}>
            <span>モデル</span>
            <CliModelSelect value={chatCliModel} onChange={setChatCliModel} />
          </label>
          <label className={field}>
            <span>思考の深さ</span>
            <EffortSelect value={chatCliEffort} onChange={setChatCliEffort} />
          </label>
          <label className={field}>
            <span>追加許可ツール</span>
            <Input
              value={chatCliExtraTools}
              onChange={(e) => setChatCliExtraTools(e.target.value)}
              placeholder="空欄=既定のフルセット。例: mcp__foo__*"
            />
          </label>
          <p className={desc}>
            GraphWrangler AI / Task AI の --allowedTools に追記するツール（空白区切り）。
            Bash 含むフルセットが既定で許可済みなので、MCP ツール等を足す用途
          </p>
        </>
      )}
    </section>
  );
}
