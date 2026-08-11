// ハッシュルーティング（lib/route.ts）のテスト。外部リンク（Discord 通知等）から
// 貼られた URL を寛容に受ける parse と、UI が出力する build の規約を固める。
import { describe, expect, it } from "vitest";
import { buildRoute, parseRoute, type RouteState } from "./route";

const empty: RouteState = { pageId: null, nodeId: null, runId: null, chat: false };

describe("parseRoute", () => {
  it("#/p/<pageId> でページを開く", () => {
    expect(parseRoute("#/p/abc")).toEqual({ ...empty, pageId: "abc" });
  });

  it("#/p/<pageId>/n/<nodeId> の複合形を受ける", () => {
    expect(parseRoute("#/p/abc/n/xyz")).toEqual({ ...empty, pageId: "abc", nodeId: "xyz" });
  });

  it("#/n/<nodeId> の単独形も受ける", () => {
    expect(parseRoute("#/n/xyz")).toEqual({ ...empty, nodeId: "xyz" });
  });

  it("#/r/<runId> はランのページ", () => {
    expect(parseRoute("#/r/run1")).toEqual({ ...empty, runId: "run1" });
    expect(parseRoute("#/r/run1/n/xyz")).toEqual({ ...empty, runId: "run1", nodeId: "xyz" });
  });

  it("?run=<runId> はランとして解釈しない（ランは #/r/<runId> の一本）", () => {
    expect(parseRoute("#/p/abc?run=run1")).toEqual({ ...empty, pageId: "abc" });
    expect(parseRoute("#?run=run1")).toBeNull();
  });

  it("#/chat と ?chat=1 でチャットドロワーを開く（ページ指定と併用可）", () => {
    expect(parseRoute("#/chat")).toEqual({ ...empty, chat: true });
    expect(parseRoute("#/p/abc?chat=1")).toEqual({ ...empty, pageId: "abc", chat: true });
  });

  it("先頭 # の有無・前後スラッシュの揺れを許す", () => {
    expect(parseRoute("/p/abc")).toEqual({ ...empty, pageId: "abc" });
    expect(parseRoute("#p/abc/")).toEqual({ ...empty, pageId: "abc" });
  });

  it("未知セグメントは無視して先へ進む", () => {
    expect(parseRoute("#/v2/p/abc")).toEqual({ ...empty, pageId: "abc" });
  });

  it("ルーティング情報が何も無ければ null（hash は関与しない）", () => {
    expect(parseRoute("")).toBeNull();
    expect(parseRoute("#")).toBeNull();
    expect(parseRoute("#/")).toBeNull();
    expect(parseRoute("#/unknown")).toBeNull();
    // 値の無い "p" だけでは情報にならない
    expect(parseRoute("#/p")).toBeNull();
  });

  it("セグメントは decodeURIComponent される", () => {
    expect(parseRoute("#/p/a%2Fb")).toEqual({ ...empty, pageId: "a/b" });
  });

  it("壊れた %xx はそのまま返す（手打ち・改変に寛容）", () => {
    expect(parseRoute("#/p/%zz")).toEqual({ ...empty, pageId: "%zz" });
  });
});

describe("buildRoute", () => {
  it("全て空なら #/", () => {
    expect(buildRoute(empty)).toBe("#/");
  });

  it("ページとノードは #/p/x/n/y の複合形で出す", () => {
    expect(buildRoute({ ...empty, pageId: "x", nodeId: "y" })).toBe("#/p/x/n/y");
  });

  it("ランを開いているときはランのページ（pageId は載せない）", () => {
    expect(buildRoute({ ...empty, pageId: "x", runId: "r1", nodeId: "y" })).toBe("#/r/r1/n/y");
  });

  it("chat は ?chat=1 で出す", () => {
    expect(buildRoute({ ...empty, chat: true })).toBe("#/?chat=1");
    expect(buildRoute({ ...empty, pageId: "x", chat: true })).toBe("#/p/x?chat=1");
  });

  it("各セグメントは encodeURIComponent（id にスラッシュ等が混ざっても壊れない）", () => {
    expect(buildRoute({ ...empty, pageId: "a/b" })).toBe("#/p/a%2Fb");
  });
});

describe("parse と build の往復", () => {
  it("build した hash を parse すると同じ状態に戻る", () => {
    const cases: RouteState[] = [
      { pageId: "p1", nodeId: null, runId: null, chat: false },
      { pageId: "p1", nodeId: "n1", runId: null, chat: true },
      { pageId: null, nodeId: "n1", runId: "r1", chat: false },
      { pageId: null, nodeId: null, runId: "r1", chat: true },
    ];
    for (const s of cases) {
      // buildRoute はラン表示時に pageId を落とすので、期待値もその規約に合わせる
      const expected = s.runId ? { ...s, pageId: null } : s;
      expect(parseRoute(buildRoute(s))).toEqual(expected);
    }
  });
});
