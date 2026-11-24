import { describe, expect, it } from "vitest";
import { extractActions, isWebUrl, parseActions } from "../src/prep.js";

describe("parseActions（gw-actions ブロック）", () => {
  it("開く・コマンドを1行1個で読む。auto は既定 true", () => {
    const { actions, invalid } = parseActions(
      [
        '{"label":"未払いフォルダを開く","open":"X:/経理/未払い"}',
        '{"label":"銀行を開く","open":"https://example.com/","auto":false}',
        '{"label":"下ごしらえ","run":"python prep.py"}',
        "",
      ].join("\n"),
    );
    expect(invalid).toEqual([]);
    expect(actions).toEqual([
      { type: "open", label: "未払いフォルダを開く", target: "X:/経理/未払い", auto: true },
      { type: "open", label: "銀行を開く", target: "https://example.com/", auto: false },
      { type: "run", label: "下ごしらえ", command: "python prep.py", auto: true },
    ]);
  });

  it("Windows のパスを \\ 1本で書いた行も救う", () => {
    const { actions, invalid } = parseActions('{"label":"開く","open":"X:\\00_ドキュメント\\未払い"}');
    expect(invalid).toEqual([]);
    expect(actions[0]).toMatchObject({ type: "open", target: "X:\\00_ドキュメント\\未払い" });
  });

  it("label が無ければ対象を名前にする／解釈できない行は invalid へ", () => {
    const { actions, invalid } = parseActions(
      ['{"open":"https://example.com/"}', "これは JSON ではない", '{"label":"両方","open":"a","run":"b"}', "42"].join(
        "\n",
      ),
    );
    expect(actions).toEqual([
      { type: "open", label: "https://example.com/", target: "https://example.com/", auto: true },
    ]);
    expect(invalid).toHaveLength(3);
  });
});

describe("extractActions（本文から全部取り出す）", () => {
  it("複数の gw-actions ブロックを順に拾い、ふつうのコードブロックは無視する", () => {
    const md = [
      "準備できました。",
      "```",
      "あららさん、お疲れさまです。",
      "```",
      "```gw-actions",
      '{"label":"フォルダ","open":"X:/a"}',
      "```",
      "文章",
      "```gw-actions",
      '{"label":"サイト","open":"https://example.com/"}',
      "```",
    ].join("\n");
    expect(extractActions(md).map((a) => a.label)).toEqual(["フォルダ", "サイト"]);
    expect(extractActions("実行ブロックなし")).toEqual([]);
  });
});

describe("isWebUrl", () => {
  it("http(s) だけが Web の URL（パスはデスクトップ版でだけ開ける）", () => {
    expect(isWebUrl("https://example.com/")).toBe(true);
    expect(isWebUrl("X:/経理/未払い")).toBe(false);
    expect(isWebUrl("file:///C:/a")).toBe(false);
  });
});
