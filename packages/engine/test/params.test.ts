// パラメータ宣言の置換ロジック（docs/design.md 3.5.1）と、ランのコンテキストによる解決（3.15）。
// 実体は packages/core/src/params.ts（engine/src/params.ts はそこからの re-export）。
// ここでは engine の窓口経由で本走が使う挙動（解決順・missing/unsafe の文言）を検証する。
// プレースホルダ規約そのもの（何が {name} で何が違うか）は core/test/params.test.ts が正。
import { describe, expect, it } from "vitest";
import { missingParamsReason, substituteParams, unsafeContextParamsReason } from "../src/params.js";

describe("substituteParams（従来: デフォルト値のみ）", () => {
  it("宣言なし・プレースホルダなしのcommandはそのまま通る", () => {
    expect(substituteParams("node run.mjs", null)).toEqual({
      ok: true,
      command: "node run.mjs",
      resolved: {},
    });
  });

  it("{name} を対応する value に置換し、二重引用符で囲む。resolved に使った値が入る", () => {
    expect(substituteParams("node run.mjs {target}", [{ name: "target", value: "foo" }])).toEqual({
      ok: true,
      command: 'node run.mjs "foo"',
      resolved: { target: "foo" },
    });
  });

  it("デフォルト値の内部の二重引用符はエスケープする（従来規則の維持）", () => {
    const result = substituteParams("echo {msg}", [{ name: "msg", value: 'say "hi"' }]);
    expect(result).toEqual({
      ok: true,
      command: 'echo "say \\"hi\\""',
      resolved: { msg: 'say "hi"' },
    });
  });

  it("デフォルト値（人間のUI入力）にはインジェクションガードを掛けない（括弧入りタイトル等の退行防止）", () => {
    const result = substituteParams("echo {title}", [{ name: "title", value: "夏の新作（仮）$100" }]);
    expect(result.ok).toBe(true);
  });

  it("value 未入力（null）の宣言が残っていれば missing に入る", () => {
    const result = substituteParams("node run.mjs {target}", [{ name: "target", value: null }]);
    expect(result).toMatchObject({ ok: false, kind: "missing", missing: ["target"] });
  });

  it("宣言に無い {xxx} は missing に入る", () => {
    const result = substituteParams("node run.mjs {target}", []);
    expect(result).toMatchObject({ ok: false, kind: "missing", missing: ["target"] });
  });

  it("missing の reason は従来のパネル案内文（コンテキストなし＝プロジェクト層）", () => {
    const result = substituteParams("node run.mjs {target}", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("パネルの実装欄");
      expect(result.reason).not.toContain("ランのコンテキスト");
    }
  });
});

describe("substituteParams（ランのコンテキスト。3.15）", () => {
  it("解決順: run.context がデフォルト値より優先される", () => {
    const result = substituteParams(
      "node run.mjs {target}",
      [{ name: "target", value: "default" }],
      { target: "from-context" },
    );
    expect(result).toEqual({
      ok: true,
      command: 'node run.mjs "from-context"',
      resolved: { target: "from-context" },
    });
  });

  it("context に無ければデフォルト値へ降格する（resolved には両方の由来が混ざる）", () => {
    const result = substituteParams(
      "node run.mjs {a} {b}",
      [{ name: "b", value: "default-b" }],
      { a: "ctx-a" },
    );
    expect(result).toEqual({
      ok: true,
      command: 'node run.mjs "ctx-a" "default-b"',
      resolved: { a: "ctx-a", b: "default-b" },
    });
  });

  it("どちらにも無ければ missing。reason はランのコンテキストにも無いことが分かる文", () => {
    const result = substituteParams("node run.mjs {target}", [], {});
    expect(result).toMatchObject({ ok: false, kind: "missing", missing: ["target"] });
    if (!result.ok) {
      expect(result.reason).toContain("ランのコンテキスト");
    }
  });

  it("context 由来の値がシェルのメタ文字を含むと unsafe（置換せず実行失敗）", () => {
    for (const bad of ["a`b", "a$b", "a\\b", 'a"b', "a'b", "a;b", "a|b", "a&b", "a<b", "a>b", "a(b", "a)b", "a{b", "a}b", "a\nb", "a\rb"]) {
      const result = substituteParams("echo {x}", [], { x: bad });
      expect(result).toMatchObject({ ok: false, kind: "unsafe", unsafe: ["x"] });
    }
  });

  it("unsafe の reason は GW_PARAM_* 環境変数へ誘導する", () => {
    const result = substituteParams("echo {x}", [], { x: "rm -rf; oops" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("GW_PARAM_");
    }
  });

  it("メタ文字を含まない context 値は通る（日本語・ハイフン・スペース等）", () => {
    const result = substituteParams("echo {x}", [], { x: "RMX-0231 夏の新作" });
    expect(result).toEqual({
      ok: true,
      command: 'echo "RMX-0231 夏の新作"',
      resolved: { x: "RMX-0231 夏の新作" },
    });
  });

  it("コマンドで参照されない context キーは resolved に入らない", () => {
    const result = substituteParams("echo {x}", [], { x: "v", unused: "w" });
    expect(result).toEqual({ ok: true, command: 'echo "v"', resolved: { x: "v" } });
  });
});

describe("missingParamsReason", () => {
  it("名前一覧とパネル案内文を含む理由文言を組み立てる", () => {
    const reason = missingParamsReason(["target", "count"]);
    expect(reason).toContain("target, count");
    expect(reason).toContain("パネルの実装欄");
  });

  it("withRunContext=true ではランのコンテキストにも無いことが分かる文になる", () => {
    const reason = missingParamsReason(["target"], true);
    expect(reason).toContain("ランのコンテキスト");
  });
});

describe("unsafeContextParamsReason", () => {
  it("名前一覧と GW_PARAM_* への誘導を含む", () => {
    const reason = unsafeContextParamsReason(["title"]);
    expect(reason).toContain("title");
    expect(reason).toContain("GW_PARAM_");
  });
});
