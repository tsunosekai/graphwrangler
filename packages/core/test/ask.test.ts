// QUESTION プロトコルとツール権限の案内文（AIのプロンプトに載る定型文）。
// 3役（GraphWrangler AI / Task AI / 実行AI）が同じ文面を共有するので、正本は core に置く。
import { describe, expect, it } from "vitest";
import { QUESTION_PROTOCOL_LINES, toolPermissionLines } from "../src/ask.js";

describe("QUESTION_PROTOCOL_LINES", () => {
  it("出力の形（QUESTION / OPTION）を示す", () => {
    const text = QUESTION_PROTOCOL_LINES.join("\n");
    expect(text).toContain("QUESTION:");
    expect(text).toContain("OPTION:");
  });
});

// ツール権限の案内（2026-08-12 本人報告「ダイアログが何のことかわからない」）。
// ヘッドレスには許可ダイアログが無いのに AI が「承認してください」と待ち、
// 人間は押すものが無いまま会話が詰まっていた（Google カレンダー登録で実際に発生）
describe("toolPermissionLines", () => {
  it("ダイアログが無いことと、代わりにどこへ何を足すかを伝える", () => {
    const text = toolPermissionLines("⚙（設定）→「実行AI（エンジン）」").join("\n");
    expect(text).toContain("許可ダイアログは出ません");
    expect(text).toContain("追加許可ツール");
    expect(text).toContain("⚙（設定）→「実行AI（エンジン）」");
    expect(text).toContain("mcp__<サーバ名>__*");
    // 「承認してください」と言わせない指示が入っている
    expect(text).toContain("とは言わないこと");
  });

  it("役ごとに設定の在り処を差し替えられる", () => {
    expect(toolPermissionLines("⚙（設定）→「チャットAI（GraphWrangler AI）」").join("\n")).toContain(
      "チャットAI（GraphWrangler AI）",
    );
  });
});
