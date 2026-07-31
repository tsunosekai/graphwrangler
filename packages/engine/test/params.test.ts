// パラメータ宣言の置換ロジック（docs/design.md 3.5.1）。
// packages/server/src/trial.ts の substituteParams と同じ挙動になっていることを確認する
// （engine 側に複製したロジックのユニットテスト。「変えたら両方直す」の両方が揃っていることの検証）。
import { describe, expect, it } from "vitest";
import { missingParamsReason, substituteParams } from "../src/params.js";

describe("substituteParams", () => {
  it("宣言なし・プレースホルダなしのcommandはそのまま通る", () => {
    expect(substituteParams("node run.mjs", null)).toEqual({ ok: true, command: "node run.mjs" });
  });

  it("{name} を対応する value に置換し、二重引用符で囲む", () => {
    expect(substituteParams("node run.mjs {target}", [{ name: "target", value: "foo" }])).toEqual({
      ok: true,
      command: 'node run.mjs "foo"',
    });
  });

  it("value 未入力（null）の宣言が残っていれば missing に入る", () => {
    expect(substituteParams("node run.mjs {target}", [{ name: "target", value: null }])).toEqual({
      ok: false,
      missing: ["target"],
    });
  });

  it("宣言に無い {xxx} は missing に入る", () => {
    expect(substituteParams("node run.mjs {target}", [])).toEqual({
      ok: false,
      missing: ["target"],
    });
  });
});

describe("missingParamsReason", () => {
  it("名前一覧とパネル案内文を含む理由文言を組み立てる", () => {
    const reason = missingParamsReason(["target", "count"]);
    expect(reason).toContain("target, count");
    expect(reason).toContain("パネルの実装欄");
  });
});
