// script executor の出力デコード（Windows の CP932 文字化け対策。2026-07-31 実測に基づく）。
// decodeOutput は win32 のときだけ Shift_JIS フォールバックを持つため、該当テストは
// win32 でのみ意味を持つ（CI 等の他OSでは skip）。
import { describe, expect, it } from "vitest";
import { decodeOutput } from "../src/executors/script.js";

describe("decodeOutput", () => {
  it("正しい UTF-8 はそのまま通る", () => {
    const buf = Buffer.from("記録完了: 辛さ3", "utf8");
    expect(decodeOutput(buf)).toBe("記録完了: 辛さ3");
  });

  it.runIf(process.platform === "win32")(
    "UTF-8 として壊れているバイト列は Shift_JIS として読み直す（cmd.exe の CP932 出力）",
    () => {
      // "記録完了: 辛さ3" の Shift_JIS バイト列
      const sjis = Buffer.from([
        0x8b, 0x4c, 0x98, 0x5e, 0x8a, 0xae, 0x97, 0xb9, 0x3a, 0x20, 0x90, 0x68, 0x82, 0xb3, 0x33,
      ]);
      expect(decodeOutput(sjis)).toBe("記録完了: 辛さ3");
    },
  );
});
