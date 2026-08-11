// 表示（テーマ）の節。テーマはヘッダーのアイコンから設定内へ移動（2026-08-02 本人指示
// 「ライト、ダークは設定の中に含めて。レスポンシブじゃなくても」）。
// 選択は即時反映+localStorage 永続化（useTheme）
import type { ThemeMode } from "../../lib/theme";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { heading, section } from "./styles";

interface Props {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
}

export function ThemeSection({ themeMode, setThemeMode }: Props) {
  return (
    <section className={section}>
      <h3 className={heading}>表示</h3>
      <label className="flex items-center justify-between gap-2 text-sm text-foreground">
        <span>テーマ</span>
        <Select value={themeMode} onValueChange={(v) => setThemeMode(v as ThemeMode)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">ライト</SelectItem>
            <SelectItem value="dark">ダーク</SelectItem>
            <SelectItem value="system">システムに合わせる</SelectItem>
          </SelectContent>
        </Select>
      </label>
    </section>
  );
}
