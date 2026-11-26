// 未読導出と threadKey（lib/unread.ts）のテスト。会話キーの規約
// （"<ノードid>" / "<ノードid>@<ランid>"）と「初見＝未読」の規約を固める。
import { describe, expect, it } from "vitest";
import { isUnreadKey, threadKey, unreadCountForNode } from "./unread";
import { hashForUnread, unreadLocationsForNode } from "./unread";

describe("threadKey", () => {
  it("ラン指定なしはノードid そのもの（テンプレート側の会話）", () => {
    expect(threadKey("n1")).toBe("n1");
    expect(threadKey("n1", null)).toBe("n1");
    expect(threadKey("n1", undefined)).toBe("n1");
  });

  it("ラン指定ありは <ノードid>@<ランid>", () => {
    expect(threadKey("n1", "r1")).toBe("n1@r1");
  });
});

describe("isUnreadKey", () => {
  it("最終メッセージ時刻が無ければ会話自体が無い＝未読なし", () => {
    expect(isUnreadKey("n1", {}, {})).toBe(false);
  });

  it("既読の記録が無いものは「初見＝未読」", () => {
    expect(isUnreadKey("n1", { n1: "2026-08-01T00:00:00Z" }, {})).toBe(true);
  });

  it("既読時刻が最終メッセージ時刻以降なら未読なし", () => {
    const meta = { n1: "2026-08-01T00:00:00Z" };
    expect(isUnreadKey("n1", meta, { n1: "2026-08-01T00:00:00Z" })).toBe(false);
    expect(isUnreadKey("n1", meta, { n1: "2026-08-02T00:00:00Z" })).toBe(false);
  });

  it("既読後に新しいメッセージが来ていれば未読", () => {
    const meta = { n1: "2026-08-03T00:00:00Z" };
    expect(isUnreadKey("n1", meta, { n1: "2026-08-02T00:00:00Z" })).toBe(true);
  });
});

describe("unreadCountForNode", () => {
  it("テンプレート側 + 全ランぶんを数える", () => {
    const meta = {
      n1: "2026-08-01T00:00:00Z",
      "n1@r1": "2026-08-01T00:00:00Z",
      "n1@r2": "2026-08-01T00:00:00Z",
    };
    expect(unreadCountForNode("n1", meta, {})).toBe(3);
    expect(unreadCountForNode("n1", meta, { "n1@r1": "2026-08-02T00:00:00Z" })).toBe(2);
  });

  it("他ノードのキーは数えない（id が前方一致していても @ 区切りで区別される）", () => {
    const meta = {
      n10: "2026-08-01T00:00:00Z",
      "n10@r1": "2026-08-01T00:00:00Z",
    };
    expect(unreadCountForNode("n1", meta, {})).toBe(0);
  });

  it("会話が1つも無ければ 0", () => {
    expect(unreadCountForNode("n1", {}, {})).toBe(0);
  });
});

describe("unreadLocationsForNode / hashForUnread（未読の出どころ）", () => {
  const meta = { n1: "2026-01-02", "n1@r1": "2026-01-03", "n1@r2": "2026-01-01", n10: "2026-01-05" };
  it("テンプレート側と各ランの未読を、場所として列挙する（前方一致の別ノードは混ぜない）", () => {
    const locs = unreadLocationsForNode("n1", meta, { "n1@r2": "2026-01-01" });
    expect(locs).toEqual([
      { nodeId: "n1", runId: null },
      { nodeId: "n1", runId: "r1" },
    ]);
  });
  it("ランの会話はランのページの中のノードへ、それ以外はページの中のノードへ飛ぶ", () => {
    expect(hashForUnread("p1", { nodeId: "n1", runId: null })).toBe("#/p/p1/n/n1");
    expect(hashForUnread("p1", { nodeId: "n1", runId: "r1" })).toBe("#/r/r1/n/n1");
  });
});
