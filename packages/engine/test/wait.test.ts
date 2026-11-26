import { describe, expect, it } from "vitest";
import { parseWait } from "@graphwrangler/core";
import { resolveWaitUntil, selectWaitActions, waitNote } from "../src/wait.js";
import type { Node, Run, RunItem } from "../src/types.js";

let nodeSeq = 0;
function node(partial: Partial<Node> = {}): Node {
  nodeSeq += 1;
  return {
    id: partial.id ?? `n-${nodeSeq}`,
    title: partial.title ?? `node ${nodeSeq}`,
    detail: partial.detail ?? null,
    impl: partial.impl ?? null,
    parents: partial.parents ?? [],
    group: partial.group ?? "proc-1",
    // 左レールの整理棚と並び順（2026-08-05）。エンジンは見ないが型のため埋める
    folder: partial.folder ?? null,
    folderSection: partial.folderSection ?? null,
    order: partial.order ?? null,
    kind: partial.kind ?? "task",
    executor: partial.executor ?? "script",
    approval: partial.approval ?? false,
    autonomy: partial.autonomy ?? "normal",
    aiModel: partial.aiModel ?? null,
    aiEffort: partial.aiEffort ?? null,
    lifecycle: partial.lifecycle ?? "committed",
    status: partial.status ?? "pending", // ランには関係しない（テンプレートは status を持たない扱い）
    fixed: partial.fixed ?? false,
    pendingRequest: partial.pendingRequest ?? null,
    implTrial: partial.implTrial ?? null,
    schedule: partial.schedule ?? null,
    catchUp: true,
    prep: true,
    prepRequest: false,
    muted: false,
    wait: partial.wait ?? null,
    waitUntil: partial.waitUntil ?? null,
    branches: partial.branches ?? null,
    choice: partial.choice ?? null,
    parentOptions: partial.parentOptions ?? {},
    createdBy: partial.createdBy ?? null,
    assignee: partial.assignee ?? null,
    members: partial.members ?? [],
    outputs: partial.outputs ?? null,
    created: partial.created ?? `2026-01-01T00:00:${String(nodeSeq).padStart(2, "0")}Z`,
  };
}

function item(partial: Partial<RunItem> = {}): RunItem {
  return {
    status: partial.status ?? "pending",
    note: partial.note ?? null,
    choice: partial.choice ?? null,
    resolvedParams: partial.resolvedParams ?? null,
    waitUntil: partial.waitUntil ?? null,
  };
}

let runSeq = 0;
function run(items: Record<string, RunItem>, partial: Partial<Run> = {}): Run {
  runSeq += 1;
  return {
    id: partial.id ?? `r-${runSeq}`,
    pageId: partial.pageId ?? "proc-1",
    title: partial.title ?? `ラン ${runSeq}`,
    trigger: partial.trigger ?? "manual",
    status: partial.status ?? "running",
    items,
    context: partial.context ?? {},
    snapshot: partial.snapshot ?? { capturedAt: "2026-01-01T00:00:00Z", nodes: [] },
    created: partial.created ?? `2026-01-01T01:00:${String(runSeq).padStart(2, "0")}Z`,
  };
}

const NONE = new Set<string>();
const PAGES = new Set(["proc-1"]);
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo, d, h, mi);

describe("parseWait（待ち方の書式）", () => {
  it("時間・N日後の時刻・次の暦の日時を解釈する", () => {
    expect(parseWait("after 3h")).toMatchObject({ type: "after", ms: 3 * 3600_000 });
    expect(parseWait("after 8d 09:00")).toMatchObject({ type: "afterDays", days: 8, hour: 9, minute: 0 });
    expect(parseWait("until monthly day 9 09:00")).toMatchObject({ type: "until" });
  });
  it("次の1点が定まらない書式・不正な値は受け付けない", () => {
    expect(parseWait("until every 15m")).toBeNull();
    expect(parseWait("until 0 9 * * *")).toBeNull();
    expect(parseWait("after 0h")).toBeNull();
    expect(parseWait("after 8d 25:00")).toBeNull();
    expect(parseWait("7日待つ")).toBeNull();
  });
});

describe("resolveWaitUntil（待ちが明ける時刻）", () => {
  it("after: 順番が回ってきた時刻からその時間", () => {
    const ready = at(2026, 0, 1, 10, 30);
    expect(resolveWaitUntil(parseWait("after 3h")!, ready, ready)).toEqual(at(2026, 0, 1, 13, 30));
  });

  it("afterDays: 順番が回ってきた日の N 日後の時刻（送付が遅れたら、そのぶん後ろへずれる）", () => {
    const w = parseWait("after 8d 09:00")!;
    expect(resolveWaitUntil(w, at(2026, 10, 1, 10, 0), at(2026, 10, 1, 9, 0))).toEqual(at(2026, 10, 9, 9, 0));
    expect(resolveWaitUntil(w, at(2026, 10, 3, 18, 0), at(2026, 10, 1, 9, 0))).toEqual(at(2026, 10, 11, 9, 0));
  });

  it("afterDays: 当日の時刻をもう過ぎていたら、翌日へ送らずすぐ明ける", () => {
    const ready = at(2026, 0, 1, 10, 0);
    expect(resolveWaitUntil(parseWait("after 0d 09:00")!, ready, ready)).toEqual(ready);
  });

  it("until: ランが始まった後で最初のその日時", () => {
    const w = parseWait("until monthly day 9 09:00")!;
    const runCreated = at(2026, 10, 1, 9, 0);
    expect(resolveWaitUntil(w, at(2026, 10, 2, 12, 0), runCreated)).toEqual(at(2026, 10, 9, 9, 0));
  });

  it("until: 前のステップが遅れて過ぎていても来月へは送らない（明ける時刻は過去＝すぐ明ける）", () => {
    const w = parseWait("until monthly day 9 09:00")!;
    const until = resolveWaitUntil(w, at(2026, 10, 12, 12, 0), at(2026, 10, 1, 9, 0));
    expect(until).toEqual(at(2026, 10, 9, 9, 0));
    expect(until.getTime()).toBeLessThan(at(2026, 10, 12, 12, 0).getTime());
  });

  it("waitNote: ローカル時刻で一言にする", () => {
    expect(waitNote(at(2026, 11, 9, 9, 0))).toBe("12/9(水) 09:00 まで待機");
  });
});

describe("selectWaitActions: ラン層", () => {
  const now = at(2026, 10, 1, 10, 0);
  const created = at(2026, 10, 1, 9, 0).toISOString();

  it("親が終わった待ちは、明ける時刻を決めて始める", () => {
    const send = node({ id: "send" });
    const wait = node({ id: "w", kind: "wait", wait: "after 8d 09:00", parents: ["send"] });
    const r = run({ send: item({ status: "done" }), w: item() }, { created });
    const actions = selectWaitActions([send, wait], [r], PAGES, now);
    expect(actions).toEqual([{ type: "start", node: wait, run: r, until: at(2026, 10, 9, 9, 0) }]);
  });

  it("親がまだなら始めない／下書きの待ちは進めない", () => {
    const send = node({ id: "send" });
    const wait = node({ id: "w", kind: "wait", wait: "after 3h", parents: ["send"] });
    const r = run({ send: item({ status: "running" }), w: item() }, { created });
    expect(selectWaitActions([send, wait], [r], PAGES, now)).toEqual([]);
    const draft = { ...wait, lifecycle: "draft" as const };
    const r2 = run({ send: item({ status: "done" }), w: item() }, { created });
    expect(selectWaitActions([send, draft], [r2], PAGES, now)).toEqual([]);
  });

  it("待っている間は何もせず、時刻を過ぎたら明ける（止まっていた後でも同じ）", () => {
    const wait = node({ id: "w", kind: "wait", wait: "after 3h" });
    const waitUntil = at(2026, 10, 1, 13, 0).toISOString();
    const r = run({ w: item({ status: "running", waitUntil }) }, { created });
    expect(selectWaitActions([wait], [r], PAGES, at(2026, 10, 1, 12, 59))).toEqual([]);
    expect(selectWaitActions([wait], [r], PAGES, at(2026, 10, 1, 13, 0))).toEqual([
      { type: "finish", node: wait, run: r },
    ]);
    // 3日止まっていて起きた
    expect(selectWaitActions([wait], [r], PAGES, at(2026, 10, 4, 8, 0))).toEqual([
      { type: "finish", node: wait, run: r },
    ]);
  });

  it("終わったラン・済んだ待ちは見ない", () => {
    const wait = node({ id: "w", kind: "wait", wait: "after 3h" });
    const done = run({ w: item({ status: "done", waitUntil: created }) }, { created });
    const cancelled = run({ w: item() }, { created, status: "cancelled" });
    expect(selectWaitActions([wait], [done, cancelled], PAGES, now)).toEqual([]);
  });

  it("待ち方が未設定・解釈不能なら invalid（黙って止まらない）", () => {
    const wait = node({ id: "w", kind: "wait", wait: "らいしゅう" });
    const r = run({ w: item() }, { created });
    expect(selectWaitActions([wait], [r], PAGES, now)).toEqual([{ type: "invalid", node: wait, run: r }]);
  });
});

describe("selectWaitActions: プロジェクト層", () => {
  const now = at(2026, 10, 1, 10, 0);

  it("親が終わった待ちを始め、時刻を過ぎたら明ける", () => {
    const a = node({ id: "a", group: "proj", status: "done" });
    const wait = node({ id: "w", group: "proj", kind: "wait", wait: "after 2d 09:00", parents: ["a"] });
    expect(selectWaitActions([a, wait], [], NONE, now)).toEqual([
      { type: "start", node: wait, run: null, until: at(2026, 10, 3, 9, 0) },
    ]);
    const waiting = { ...wait, status: "running" as const, waitUntil: at(2026, 10, 3, 9, 0).toISOString() };
    expect(selectWaitActions([a, waiting], [], NONE, at(2026, 10, 3, 8, 59))).toEqual([]);
    expect(selectWaitActions([a, waiting], [], NONE, at(2026, 10, 3, 9, 0))).toEqual([
      { type: "finish", node: waiting, run: null },
    ]);
  });

  it("ルーティーンのメンバー（テンプレート）はプロジェクト層では進めない", () => {
    const wait = node({ id: "w", kind: "wait", wait: "after 3h" }); // group=proc-1
    expect(selectWaitActions([wait], [], PAGES, now)).toEqual([]);
  });
});
