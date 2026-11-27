// QUESTION プロトコルとツール権限の案内文（AIのプロンプトに載る定型文）。
// 3役（GraphWrangler AI / Task AI / 実行AI）が同じ文面を共有するので、正本は core に置く。
import { describe, expect, it } from "vitest";
import { QUESTION_PROTOCOL_LINES, TOOL_PERMISSION_LINES } from "../src/ask.js";

describe("QUESTION_PROTOCOL_LINES", () => {
  it("出力の形（QUESTION / OPTION）を示す", () => {
    const text = QUESTION_PROTOCOL_LINES.join("\n");
    expect(text).toContain("QUESTION:");
    expect(text).toContain("OPTION:");
  });
});

// ツール権限の案内（2026-08-12 本人報告「ダイアログが何のことかわからない」）。
// ヘッドレスには許可ダイアログが無いのに AI が「承認してください」と待ち、
// 人間は押すものが無いまま会話が詰まっていた（Google カレンダー登録で実際に発生）。
// 2026-11-27 から許可リストは無く全ツール許可（bypassPermissions）なので、設定へ足す案内はしない
describe("TOOL_PERMISSION_LINES", () => {
  it("ダイアログが無いことと、全ツールが使えることを伝え、許可リストの話はしない", () => {
    const text = TOOL_PERMISSION_LINES.join("\n");
    expect(text).toContain("許可ダイアログは出ません");
    expect(text).toContain("ツールはすべて確認なしで使えます");
    expect(text).not.toContain("追加許可ツール");
    expect(text).not.toContain("mcp__<サーバ名>__*");
    // 「承認してください」と言わせない指示が入っている
    expect(text).toContain("とは言わないこと");
  });
});
