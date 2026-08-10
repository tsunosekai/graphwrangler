// 左レールの索引（lib/railIndex.ts）が、素朴な走査（actions.ts / unread.ts）と
// **同じ集合・同じ数**を返すことを固めるテスト。索引は速さのためだけのものなので、
// 「答えが一致する」ことが唯一の要件。
import { describe, expect, it } from "vitest";
import { readKeysForNode, readKeysForPage } from "./actions";
import { buildRailIndex } from "./railIndex";
import { makeNode } from "./testutil";
import { unreadCountForNode } from "./unread";

const nodes = [
  makeNode({ id: "page" }),
  makeNode({ id: "m1", group: "page" }),
  makeNode({ id: "m2", group: "page" }),
  // 入れ子の group（メンバーがさらに子を持つ）
  makeNode({ id: "m1a", group: "m1" }),
  makeNode({ id: "other" }),
  makeNode({ id: "otherMember", group: "other" }),
];

const meta: Record<string, string> = {
  page: "2026-08-01T00:00:00Z",
  "page@r1": "2026-08-02T00:00:00Z",
  m1: "2026-08-03T00:00:00Z",
  "m1@r1": "2026-08-04T00:00:00Z",
  "m1a@r1": "2026-08-05T00:00:00Z",
  otherMember: "2026-08-06T00:00:00Z",
};

describe("buildRailIndex", () => {
  it("membersOf は group が一致する直下ノードだけを返す（入れ子は含めない）", () => {
    const ix = buildRailIndex(nodes, meta);
    expect(ix.membersOf("page").map((n) => n.id)).toEqual(["m1", "m2"]);
    expect(ix.membersOf("m1").map((n) => n.id)).toEqual(["m1a"]);
    expect(ix.membersOf("m2")).toEqual([]);
    expect(ix.membersOf("居ないid")).toEqual([]);
  });

  it("nodeById で id からノードを引ける", () => {
    const ix = buildRailIndex(nodes, meta);
    expect(ix.nodeById.get("m1a")?.group).toBe("m1");
    expect(ix.nodeById.get("居ないid")).toBeUndefined();
  });

  it("keysOf は readKeysForNode と同じ集合を返す", () => {
    const ix = buildRailIndex(nodes, meta);
    for (const n of nodes) {
      expect([...ix.keysOf(n.id)].sort()).toEqual(readKeysForNode(n.id, meta).sort());
    }
  });

  it("readKeysForPage は入れ子の group も辿り、素朴版と同じ集合を返す", () => {
    const ix = buildRailIndex(nodes, meta);
    expect(ix.readKeysForPage("page").sort()).toEqual(readKeysForPage("page", nodes, meta).sort());
    expect(ix.readKeysForPage("page").sort()).toEqual(["m1", "m1@r1", "m1a@r1", "page", "page@r1"]);
    // 別ページのぶんは混ざらない
    expect(ix.readKeysForPage("other")).toEqual(["otherMember"]);
  });

  it("unreadCount は unreadCountForNode と同じ数を返す", () => {
    const ix = buildRailIndex(nodes, meta);
    const reads = { "m1@r1": "2026-08-09T00:00:00Z", page: "2026-07-01T00:00:00Z" };
    for (const n of nodes) {
      expect(ix.unreadCount(n.id, reads)).toBe(unreadCountForNode(n.id, meta, reads));
    }
    expect(ix.unreadCount("m1", reads)).toBe(1); // m1 は未読、m1@r1 は既読
    expect(ix.unreadCount("page", reads)).toBe(2); // 既読時刻より新しい
  });

  it("会話が1つも無い（threadMeta が空）ならキーも未読数も空", () => {
    const ix = buildRailIndex(nodes, {});
    expect(ix.readKeysForPage("page")).toEqual([]);
    expect(ix.unreadCount("page", {})).toBe(0);
  });
});
