import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore, GraphError, type OpRecord } from "../src/index.js";
import { readJsonl } from "../src/storage.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-graph-"));
});

describe("GraphStore", () => {
  it("ノード作成: 既定値が入り、idが採番される", () => {
    const g = new GraphStore(dir);
    const n = g.addNode({ title: "最初の仕事" });
    expect(n.id).toMatch(/^n-\d{8}-0001$/);
    expect(n.executor).toBe("human");
    expect(n.impact).toBe("safe");
    expect(n.lifecycle).toBe("draft");
    expect(n.status).toBe("pending");
    expect(n.pendingRequest).toBeNull();
  });

  it("存在しない親は拒否", () => {
    const g = new GraphStore(dir);
    expect(() => g.addNode({ title: "x", parents: ["n-99999999-0001"] })).toThrow(
      GraphError,
    );
  });

  it("循環禁止: 自分自身・子孫を親にできない", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "a" });
    const b = g.addNode({ title: "b", parents: [a.id] });
    const c = g.addNode({ title: "c", parents: [b.id] });
    expect(() => g.patchNode(a.id, { parents: [a.id] })).toThrow(/own parent/);
    expect(() => g.patchNode(a.id, { parents: [c.id] })).toThrow(/cycle/);
  });

  it("子を持つノードは消せない", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "a" });
    g.addNode({ title: "b", parents: [a.id] });
    expect(() => g.removeNode(a.id)).toThrow(/children/);
  });

  it("frontier: 親が全てdoneの未完ノードだけ", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "a" });
    const b = g.addNode({ title: "b", parents: [a.id] });
    g.addNode({ title: "c", parents: [b.id] });
    expect(g.frontier().map((n) => n.id)).toEqual([a.id]);
    g.patchNode(a.id, { status: "done" });
    expect(g.frontier().map((n) => n.id)).toEqual([b.id]);
  });

  it("操作ログに帰属(actor/via)が残る", () => {
    const g = new GraphStore(dir);
    g.addNode({ title: "x" }, { actor: { kind: "agent", name: "planner" }, via: "mcp" });
    const ops = readJsonl<OpRecord>(path.join(dir, "ops.jsonl"));
    expect(ops).toHaveLength(1);
    expect(ops[0].actor).toEqual({ kind: "agent", name: "planner" });
    expect(ops[0].via).toBe("mcp");
  });

  it("ops.jsonl のリプレイがスナップショットと一致する", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "a" });
    const b = g.addNode({ title: "b", parents: [a.id] });
    g.patchNode(a.id, { status: "done", detail: "済んだ" });
    g.removeNode(b.id);
    const replayed = GraphStore.replay(dir);
    const live = new Map(g.state().nodes.map((n) => [n.id, n]));
    expect(replayed).toEqual(live);
  });

  it("スナップショットから再ロードできる", () => {
    const g1 = new GraphStore(dir);
    const a = g1.addNode({ title: "a" });
    const g2 = new GraphStore(dir);
    expect(g2.get(a.id).title).toBe("a");
  });
});
