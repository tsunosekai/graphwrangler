// ヘッドレスエージェント（CLI）用の共通入力部品。チャットAI・実行AIの両方で使う
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

// CLI（claude -p）のモデルは選択式（本人指定 2026-07-31。既定は Opus 5）。
// claude CLI のエイリアス名をそのまま値にする。保存済みの値がリストに無い場合は
// 「カスタム」として選択肢に足し、既存設定を壊さない
const CLI_MODELS = [
  { value: "fable", label: "Fable 5（最高性能）" },
  { value: "opus", label: "Opus 5（高性能・既定）" },
  { value: "sonnet", label: "Sonnet 5（標準）" },
  { value: "haiku", label: "Haiku 4.5（高速）" },
];

export function CliModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isCustom = value !== "" && !CLI_MODELS.some((m) => m.value === value);
  return (
    <Select value={value || "opus"} onValueChange={onChange}>
      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {CLI_MODELS.map((m) => (
          <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
        ))}
        {isCustom && <SelectItem value={value}>{value}（カスタム）</SelectItem>}
      </SelectContent>
    </Select>
  );
}

// エフォート（思考の深さ。claude CLI の --effort）の選択肢（2026-08-07 モデル/エフォート切替）
const EFFORT_OPTIONS = [
  // 「既定」とだけ書かず中身を書く（2026-08-07 本人指摘）。null = --effort を渡さない
  { value: "default", label: "指定なし（CLIの既定で動く）" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" },
  { value: "max", label: "最大" },
];

export type EffortValue = "low" | "medium" | "high" | "xhigh" | "max" | null;

export function EffortSelect({ value, onChange }: { value: EffortValue; onChange: (v: EffortValue) => void }) {
  return (
    <Select
      value={value ?? "default"}
      onValueChange={(v) => onChange(v === "default" ? null : (v as EffortValue))}
    >
      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {EFFORT_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
