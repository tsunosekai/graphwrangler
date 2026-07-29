import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore, RunStore, GraphError, type Node } from "../src/index.js";

let dir: string;
let graph: GraphStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-runs-"));
  graph = new GraphStore(dir);
});

/** procedure ノード + メンバー3個（committed/pending・committed/unplanned・draft）を用意 */
function setupProcedure(): { procedureId: string; committedPending: Node; committedUnplanned: Node; draft: Node } {
  const procedure = graph.addNode({ title: "月次経理", kind: "procedure" });
  const committedPending = graph.patchNode(
    graph.addNode({ title: "買い出し", group: procedure.id }).id,
    { lifecycle: "committed" },
  );
  const committedUnplanned = graph.patchNode(
    graph.addNode({ title: "やり方未定の工程", group: procedure.id }).id,
    { lifecycle: "committed", status: "unplanned" },
  );
  const draft = graph.addNode({ title: "まだdraftの工程", group: procedure.id });
  return { procedureId: procedure.id, committedPending, committedUnplanned, draft };
}

describe("RunStore", () => {
  it("create: committed のテンプレートだけが item になり、unplanned は skipped", () => {
    const runs = new RunStore(dir);
    const { procedureId, committedPending, committedUnplanned, draft } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const run = runs.create(procedureId, members);

    expect(run.id).toMatch(/^r-\d{8}-0001$/);
    expect(run.status).toBe("running");
    expect(Object.keys(run.items).sort()).toEqual(
      [committedPending.id, committedUnplanned.id].sort(),
    );
    expect(run.items[committedPending.id].status).toBe("pending");
    expect(run.items[committedUnplanned.id].status).toBe("skipped");
    expect(run.items[draft.id]).toBeUndefined();
  });

  it("create: title/trigger の既定値と明示指定", () => {
    const runs = new RunStore(dir);
    const { procedureId } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const withDefaults = runs.create(procedureId, members);
    expect(withDefaults.trigger).toBe("manual");

    const withOpts = runs.create(procedureId, members, {
      title: "臨時実行",
      trigger: "schedule:daily 09:00",
    });
    expect(withOpts.title).toBe("臨時実行");
    expect(withOpts.trigger).toBe("schedule:daily 09:00");
  });

  it("patchItem: status と note を更新できる", () => {
    const runs = new RunStore(dir);
    const { procedureId, committedPending } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const run = runs.create(procedureId, members);

    const patched = runs.patchItem(run.id, committedPending.id, {
      status: "running",
      note: "着手した",
    });
    expect(patched.items[committedPending.id].status).toBe("running");
    expect(patched.items[committedPending.id].note).toBe("着手した");
    // status を省略すれば既存値を維持
    const notePatched = runs.patchItem(run.id, committedPending.id, { note: "続けている" });
    expect(notePatched.items[committedPending.id].status).toBe("running");
    expect(notePatched.items[committedPending.id].note).toBe("続けている");
  });

  it("patchItem: 全アイテムが done/dropped/skipped になったらランが自動的に done になる", () => {
    const runs = new RunStore(dir);
    const { procedureId, committedPending, committedUnplanned } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const run = runs.create(procedureId, members);

    // unplanned は既に skipped 済み。残り1件を done にすれば全体が done になるはず
    expect(run.items[committedUnplanned.id].status).toBe("skipped");
    const stillRunning = runs.patchItem(run.id, committedPending.id, { status: "running" });
    expect(stillRunning.status).toBe("running");
    const done = runs.patchItem(run.id, committedPending.id, { status: "done" });
    expect(done.status).toBe("done");
  });

  it("patchItem: 存在しないノードの item は404相当のGraphError", () => {
    const runs = new RunStore(dir);
    const { procedureId } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const run = runs.create(procedureId, members);
    expect(() => runs.patchItem(run.id, "n-99999999-0001", { status: "done" })).toThrow(
      GraphError,
    );
  });

  it("cancel: status が cancelled になり、以後の patchItem で done に戻らない", () => {
    const runs = new RunStore(dir);
    const { procedureId, committedPending } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const run = runs.create(procedureId, members);

    const cancelled = runs.cancel(run.id);
    expect(cancelled.status).toBe("cancelled");
    // 全アイテムを done にしても cancelled のまま（done に覆されない）
    const afterPatch = runs.patchItem(run.id, committedPending.id, { status: "done" });
    expect(afterPatch.status).toBe("cancelled");
  });

  it("list: procedure ごとにフィルタし、created 降順で返す", () => {
    const runs = new RunStore(dir);
    const { procedureId } = setupProcedure();
    const otherProcedure = graph.addNode({ title: "別の手順", kind: "procedure" });
    const members = graph.state().nodes.filter((n) => n.group === procedureId);

    const first = runs.create(procedureId, members, { title: "1回目" });
    const second = runs.create(procedureId, members, { title: "2回目" });
    runs.create(otherProcedure.id, [], { title: "別手順のラン" });

    const list = runs.list(procedureId);
    expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(list.every((r) => r.procedure === procedureId)).toBe(true);
  });

  it("永続化ラウンドトリップ: 新しい RunStore インスタンスからも get/list できる", () => {
    const runs1 = new RunStore(dir);
    const { procedureId } = setupProcedure();
    const members = graph.state().nodes.filter((n) => n.group === procedureId);
    const run = runs1.create(procedureId, members);
    runs1.patchItem(run.id, Object.keys(run.items)[0], { status: "done" });

    const runs2 = new RunStore(dir);
    const reloaded = runs2.get(run.id);
    expect(reloaded).toEqual(runs1.get(run.id));
    expect(runs2.list(procedureId).map((r) => r.id)).toEqual([run.id]);
  });

  it("get: 存在しないランは404相当のGraphError", () => {
    const runs = new RunStore(dir);
    expect(() => runs.get("r-99999999-0001")).toThrow(GraphError);
  });
});
