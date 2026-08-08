// 「その時のノードの状態」（2026-08-08 本人要望）の2本柱のテスト:
//   A. 発火時にランへ中身を焼く（RunStore.createFromTrigger の snapshot）
//   B. 操作ログを時刻まで再生して当時を復元する（GraphStore.nodesAt）+ ログの辻褄合わせ（reconcileLog）
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore, RunStore, writeWorkspaceFile, type Node } from "../src/index.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-history-"));
});

/** ops.jsonl の ts を書き換える（時刻を跨いだ再生を、待たずに検証するため） */
function restampOps(sidecar: string, pick: (line: Record<string, unknown>) => string | null): void {
  const file = path.join(sidecar, "ops.jsonl");
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const l of lines) {
    const ts = pick(l);
    if (ts) l.ts = ts;
  }
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

describe("ランへの発火時スナップショット（A）", () => {
  it("発火時点のタイトル・手順を残し、後からテンプレートを書き換えても影響されない", () => {
    const g = new GraphStore(dir);
    const page = g.addNode({ title: "ルーティーン", kind: "goal" });
    const trigger = g.addNode({ title: "定刻", kind: "trigger", group: page.id, executor: "script" });
    const task = g.addNode({
      title: "当時のタイトル",
      detail: "当時の説明",
      group: page.id,
      parents: [trigger.id],
    });
    const runs = new RunStore(dir);
    const run = runs.createFromTrigger(page.id, trigger.id, [trigger, task], {
      title: "ラン1",
      pageNode: page,
    });

    const snap = run.snapshot;
    expect(snap).not.toBeNull();
    const byId = new Map((snap?.nodes ?? []).map((n) => [n.id, n]));
    // ページ自身・トリガー・メンバーの全部が残る（items はトリガーの子孫だけ＝task のみ）
    expect([...byId.keys()].sort()).toEqual([page.id, trigger.id, task.id].sort());
    expect(Object.keys(run.items)).toEqual([task.id]);
    expect(byId.get(task.id)?.title).toBe("当時のタイトル");
    expect(byId.get(task.id)?.detail).toBe("当時の説明");

    // テンプレートを書き換えてもランに焼いた中身は変わらない
    g.patchNode(task.id, { title: "今のタイトル", detail: "今の説明" });
    const reread = runs.get(run.id);
    expect(reread.snapshot?.nodes.find((n) => n.id === task.id)?.title).toBe("当時のタイトル");
    expect(g.get(task.id).title).toBe("今のタイトル");
  });

  it("スナップショットの無い旧ランもそのまま読める（default null）", () => {
    const runs = new RunStore(dir);
    const g = new GraphStore(dir);
    const page = g.addNode({ title: "p", kind: "goal" });
    const trigger = g.addNode({ title: "t", kind: "trigger", group: page.id });
    const run = runs.createFromTrigger(page.id, trigger.id, [trigger]);
    // 旧データを模して snapshot キーごと落とす
    const file = path.join(dir, "runs", `${run.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete raw.snapshot;
    fs.writeFileSync(file, JSON.stringify(raw), "utf8");
    expect(runs.get(run.id).snapshot).toBeNull();
  });
});

describe("操作ログからの時刻指定復元（B）", () => {
  it("その時刻に存在したノードと、当時の中身を返す", () => {
    const g = new GraphStore(dir);
    const a = g.addNode({ title: "旧タイトル" });
    const b = g.addNode({ title: "あとから作るノード" });
    g.patchNode(a.id, { title: "新タイトル" });
    // 1件目=a作成、2件目=b作成、3件目=aのpatch に時刻を割り振る
    let i = 0;
    const stamps = ["2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z"];
    restampOps(dir, () => stamps[i++] ?? null);

    const early = g.nodesAt("2026-02-01T00:00:00.000Z");
    expect(early.nodes.map((n) => n.id)).toEqual([a.id]);
    expect(early.nodes[0].title).toBe("旧タイトル");

    const mid = g.nodesAt("2026-04-01T00:00:00.000Z");
    expect(mid.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(mid.nodes.find((n) => n.id === a.id)?.title).toBe("旧タイトル");

    const late = g.nodesAt("2026-06-01T00:00:00.000Z");
    expect(late.nodes.find((n) => n.id === a.id)?.title).toBe("新タイトル");
  });

  it("削除されたノードも、削除前の時刻なら出てくる", () => {
    const g = new GraphStore(dir);
    const n = g.addNode({ title: "消えるノード" });
    g.removeNode(n.id);
    let i = 0;
    const stamps = ["2026-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z"];
    restampOps(dir, () => stamps[i++] ?? null);
    expect(g.nodesAt("2026-03-01T00:00:00.000Z").nodes.map((x) => x.id)).toEqual([n.id]);
    expect(g.nodesAt("2026-06-01T00:00:00.000Z").nodes).toEqual([]);
  });
});

describe("操作ログの辻褄合わせ（reconcileLog）", () => {
  /** GraphWrangler を通さずに正データファイルへ直接書いたワークスペースを作る */
  function externalWorkspace(nodes: Node[]): { file: string; sidecar: string } {
    const file = path.join(dir, "workflow.gw.json");
    const sidecar = path.join(dir, ".graphwrangler");
    fs.mkdirSync(sidecar, { recursive: true });
    writeWorkspaceFile(file, nodes);
    return { file, sidecar };
  }

  const fixedNode = (id: string, title: string, created: string): Node => ({
    id,
    title,
    detail: null,
    impl: null,
    implTrial: null,
    parents: [],
    group: null,
    folder: null,
    folderSection: null,
    order: null,
    kind: "task",
    executor: "human",
    approval: false,
    autonomy: "normal",
    aiModel: null,
    aiEffort: null,
    lifecycle: "draft",
    status: "pending",
    fixed: false,
    pendingRequest: null,
    schedule: null,
    branches: null,
    choice: null,
    parentOptions: {},
    createdBy: null,
    assignee: null,
    members: [],
    created,
  });

  it("ログに無い外部書き込みを追記して、再生が実態に追いつく", () => {
    const { file, sidecar } = externalWorkspace([
      fixedNode("n-20260101-0001", "外から入れたノード", "2026-01-01T00:00:00.000Z"),
    ]);
    const g = GraphStore.workspace(file, sidecar);
    // 辻褄合わせ前: ログが空なので再生しても何も出ない
    expect(g.nodesAt("2030-01-01T00:00:00.000Z").nodes).toEqual([]);

    const fixedCount = g.reconcileLog();
    expect(fixedCount).toEqual({ added: 1, patched: 0, removed: 0 });

    // 追記後: 実態に追いつく。作成時刻は node.created を名乗るので、その頃から在った形になる
    const now = g.nodesAt("2030-01-01T00:00:00.000Z");
    expect(now.nodes.map((n) => n.id)).toEqual(["n-20260101-0001"]);
    expect(g.nodesAt("2026-06-01T00:00:00.000Z").nodes.map((n) => n.id)).toEqual(["n-20260101-0001"]);
    // ただし「当時の中身は記録が無い」ので baseline 印が付く（呼び出し側が断って見せるため）
    expect([...now.baseline]).toEqual(["n-20260101-0001"]);
    // 正データファイルは触らない
    expect(JSON.parse(fs.readFileSync(file, "utf8")).nodes).toHaveLength(1);
  });

  it("ログに無いノードへの patch が混ざっていても落ちない（移行データを持つ実インスタンス）", () => {
    const { file, sidecar } = externalWorkspace([
      fixedNode("n-20260101-0001", "外から入れたノード", "2026-01-01T00:00:00.000Z"),
    ]);
    // add の記録が無いまま patch だけがログに載っている状態を作る（zinsei が実際にこの形）
    fs.writeFileSync(
      path.join(sidecar, "ops.jsonl"),
      JSON.stringify({
        id: "op-x",
        ts: "2026-02-01T00:00:00.000Z",
        actor: { kind: "human" },
        via: "ui",
        op: "node.patch",
        payload: { nodeId: "n-20260101-0001", patch: { title: "記録だけある変更" } },
      }) + "\n",
      "utf8",
    );
    const g = GraphStore.workspace(file, sidecar);
    expect(() => g.reconcileLog()).not.toThrow();
    // 宙に浮いていた古い patch が add を足したことで生き返っても、最後は実態（正データ）へ寄る
    expect(g.nodesAt("2030-01-01T00:00:00.000Z").nodes[0].title).toBe("外から入れたノード");
    // そして2回目は何も足さない（収束している）
    expect(g.reconcileLog()).toEqual({ added: 0, patched: 0, removed: 0 });
  });

  it("2回目以降は何も追記しない（毎起動でログが太らない）", () => {
    const { file, sidecar } = externalWorkspace([
      fixedNode("n-20260101-0001", "外から入れたノード", "2026-01-01T00:00:00.000Z"),
    ]);
    const g = GraphStore.workspace(file, sidecar);
    g.reconcileLog();
    const before = fs.readFileSync(path.join(sidecar, "ops.jsonl"), "utf8");
    expect(g.reconcileLog()).toEqual({ added: 0, patched: 0, removed: 0 });
    expect(fs.readFileSync(path.join(sidecar, "ops.jsonl"), "utf8")).toBe(before);
  });

  it("外から書き換えられた中身も追記され、辻褄合わせの行は undo の対象にならない", () => {
    const { file, sidecar } = externalWorkspace([
      fixedNode("n-20260101-0001", "最初", "2026-01-01T00:00:00.000Z"),
    ]);
    const g1 = GraphStore.workspace(file, sidecar);
    g1.reconcileLog();
    // GraphWrangler を止めている間に外から書き換えた、を模す
    writeWorkspaceFile(file, [fixedNode("n-20260101-0001", "外で書き換えた", "2026-01-01T00:00:00.000Z")]);
    const g2 = GraphStore.workspace(file, sidecar);
    expect(g2.reconcileLog()).toEqual({ added: 0, patched: 1, removed: 0 });
    expect(g2.nodesAt("2030-01-01T00:00:00.000Z").nodes[0].title).toBe("外で書き換えた");
    // 人間の操作ではないので「元に戻す」で巻き戻らない
    expect(g2.undoLast()).toBeNull();
  });
});
