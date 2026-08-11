// tick（オーケストレーション層）の配線テスト。純粋関数層（pick/approval/decision 系）は
// それぞれのテストが見ているので、ここが狙うのは「どの層が・どこへ書くか」の配線だけ:
//   - 実行者（script/ai・cli/api）の振り分け
//   - プロジェクト層はノード、ラン層はランアイテムへ書く（patch 先・投稿先が入れ替わらない）
//   - カード発行の失敗で処理が止まらない（livelock を作らない）
// API（src/api.js）と executor 起動は差し替えて、HTTP も子プロセスも動かさずに配線だけを見る。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Node, Run, RunItem } from "../src/types.js";

// vi.hoisted で作った同一オブジェクトを返すことで、vi.resetModules() でモジュールを
// 読み直しても、テストから触るモック関数の参照が変わらないようにする
const api = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {},
  getState: vi.fn(),
  patchNode: vi.fn(),
  getThread: vi.fn(),
  postMessage: vi.fn(),
  decideNode: vi.fn(),
  openRequest: vi.fn(),
  listPageRuns: vi.fn(),
  runTriggerNode: vi.fn(),
  patchRunItem: vi.fn(),
  patchRunContext: vi.fn(),
  decideRunItem: vi.fn(),
  getSettings: vi.fn(),
  completeAi: vi.fn(),
  heartbeat: vi.fn(),
  getWorkspace: vi.fn(),
  getFile: vi.fn(),
}));
vi.mock("../src/api.js", () => api);

const exec = vi.hoisted(() => ({
  runScript: vi.fn(),
  runClaude: vi.fn(),
  runApi: vi.fn(),
}));
// script.js / claude.js は他の export（killTree, buildAiPrompt 等）が本物のまま必要なので部分差し替え
vi.mock("../src/executors/script.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runScript: exec.runScript,
}));
vi.mock("../src/executors/claude.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runClaude: exec.runClaude,
}));
vi.mock("../src/executors/api.js", () => ({ runApi: exec.runApi }));

const ENGINE_ACTOR = { kind: "agent", name: "engine" } as const;

let nodeSeq = 0;
function node(partial: Partial<Node> = {}): Node {
  nodeSeq += 1;
  return {
    id: partial.id ?? `n-${nodeSeq}`,
    title: partial.title ?? `node ${nodeSeq}`,
    detail: partial.detail ?? null,
    impl: partial.impl ?? null,
    parents: partial.parents ?? [],
    group: partial.group ?? null,
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
    status: partial.status ?? "pending",
    fixed: partial.fixed ?? false,
    pendingRequest: partial.pendingRequest ?? null,
    implTrial: partial.implTrial ?? null,
    schedule: partial.schedule ?? null,
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
  };
}

let runSeq = 0;
function run(items: Record<string, RunItem>, partial: Partial<Run> = {}): Run {
  runSeq += 1;
  return {
    id: partial.id ?? `r-${runSeq}`,
    pageId: partial.pageId ?? "page-1",
    title: partial.title ?? `ラン ${runSeq}`,
    trigger: partial.trigger ?? "manual",
    status: partial.status ?? "running",
    items,
    context: partial.context ?? {},
    snapshot: partial.snapshot ?? { capturedAt: "2026-01-01T00:00:00Z", nodes: [] },
    created: partial.created ?? `2026-01-01T01:00:${String(runSeq).padStart(2, "0")}Z`,
  };
}

/** ルーティーンページの最小構成（ページ + エンジンが何もしない human トリガー）。
 *  テンプレートはこのページに属することでプロジェクト層の対象から外れる（ラン側が実行する） */
function routinePage(): Node[] {
  return [
    node({ id: "page-1", kind: "goal" }),
    node({ id: "tr-human", kind: "trigger", executor: "human", group: "page-1" }),
  ];
}

function engineSettings(mode: "cli" | "api" = "cli") {
  return {
    engine: {
      mode,
      cliPath: "claude",
      model: "opus",
      effort: null,
      extraArgs: [],
      cliExtraTools: [],
      apiModel: null,
    },
    ai: { addDirs: [] },
  };
}

/** index.ts を読み直して tick を取り出す（設定・チェック時刻などのモジュール状態を
 *  テスト間で持ち越さないため） */
async function loadTick(): Promise<() => Promise<void>> {
  return (await import("../src/index.js")).tick;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});

  api.getSettings.mockResolvedValue(engineSettings("cli"));
  api.getWorkspace.mockResolvedValue({ mode: "datadir", root: null, file: null });
  api.heartbeat.mockResolvedValue({ version: null });
  api.getState.mockResolvedValue({ nodes: [], now: "2026-01-01T02:00:00Z" });
  api.getThread.mockResolvedValue({ messages: [] as Message[] });
  api.listPageRuns.mockResolvedValue([]);
  api.patchNode.mockResolvedValue({});
  api.patchRunItem.mockResolvedValue({});
  api.patchRunContext.mockResolvedValue({});
  api.postMessage.mockResolvedValue({});
  api.openRequest.mockResolvedValue({});
  api.decideNode.mockResolvedValue({});
  api.decideRunItem.mockResolvedValue({});
  api.runTriggerNode.mockResolvedValue({});
  api.getFile.mockResolvedValue("");

  exec.runScript.mockResolvedValue({ success: true, output: "ok" });
  exec.runClaude.mockResolvedValue({ success: true, output: "ok" });
  exec.runApi.mockResolvedValue({ success: true, output: "ok" });
});

describe("tick: 実行者の振り分け", () => {
  it("executor=script のタスクは script executor で実行する（AI は起動しない）", async () => {
    api.getState.mockResolvedValue({
      nodes: [node({ id: "t1", executor: "script", impl: { type: "script", command: "echo hi" } })],
      now: "2026-01-01T02:00:00Z",
    });

    await (await loadTick())();

    expect(exec.runScript).toHaveBeenCalledTimes(1);
    expect(exec.runScript.mock.calls[0][0]).toBe("echo hi");
    expect(exec.runClaude).not.toHaveBeenCalled();
    expect(exec.runApi).not.toHaveBeenCalled();
    expect(api.patchNode).toHaveBeenCalledWith("t1", { status: "done" }, ENGINE_ACTOR, "engine");
  });

  it("executor=ai のタスクは engine.mode=cli なら claude CLI で実行する", async () => {
    api.getState.mockResolvedValue({
      nodes: [node({ id: "t1", executor: "ai", impl: { type: "doc", text: "手順" } })],
      now: "2026-01-01T02:00:00Z",
    });

    await (await loadTick())();

    expect(exec.runClaude).toHaveBeenCalledTimes(1);
    expect(exec.runApi).not.toHaveBeenCalled();
    expect(exec.runScript).not.toHaveBeenCalled();
    // 発言の帰属も実行者に合わせて切り替わる
    const say = api.postMessage.mock.calls.find((c) => c[1].kind === "say");
    expect(say?.[2]).toEqual({ kind: "agent", name: "executor:claude" });
  });

  it("executor=ai のタスクは engine.mode=api ならサーバの /api/ai/complete で実行する", async () => {
    api.getSettings.mockResolvedValue(engineSettings("api"));
    api.getState.mockResolvedValue({
      nodes: [node({ id: "t1", executor: "ai", impl: { type: "doc", text: "手順" } })],
      now: "2026-01-01T02:00:00Z",
    });

    await (await loadTick())();

    expect(exec.runApi).toHaveBeenCalledTimes(1);
    expect(exec.runClaude).not.toHaveBeenCalled();
    const say = api.postMessage.mock.calls.find((c) => c[1].kind === "say");
    expect(say?.[2]).toEqual({ kind: "agent", name: "executor:api" });
  });
});

describe("tick: プロジェクト層とラン層の書き先", () => {
  it("プロジェクト層の実行はノードへ書き、ランアイテムには触らない", async () => {
    api.getState.mockResolvedValue({
      nodes: [node({ id: "t1", executor: "script", impl: { type: "script", command: "echo hi" } })],
      now: "2026-01-01T02:00:00Z",
    });

    await (await loadTick())();

    expect(api.patchNode).toHaveBeenCalledWith("t1", { status: "running" }, ENGINE_ACTOR, "engine");
    expect(api.patchNode).toHaveBeenCalledWith("t1", { status: "done" }, ENGINE_ACTOR, "engine");
    expect(api.patchRunItem).not.toHaveBeenCalled();
    // プロジェクト層の投稿にランの帰属は付かない（テンプレート側の記録になる）
    for (const call of api.postMessage.mock.calls) {
      expect(call[1].runId).toBeUndefined();
      expect((call[1].payload as { runId?: string } | undefined)?.runId).toBeUndefined();
    }
  });

  it("ラン層の実行はランアイテムへ書き、テンプレートノードの status には触らない", async () => {
    const template = node({
      id: "m1",
      group: "page-1",
      executor: "script",
      impl: { type: "script", command: "run.sh" },
    });
    api.getState.mockResolvedValue({
      nodes: [...routinePage(), template],
      now: "2026-01-01T02:00:00Z",
    });
    api.listPageRuns.mockResolvedValue([run({ m1: item({ status: "pending" }) }, { id: "r1" })]);

    await (await loadTick())();

    expect(exec.runScript).toHaveBeenCalledTimes(1);
    expect(api.patchRunItem).toHaveBeenCalledWith(
      "r1",
      "m1",
      { status: "running" },
      ENGINE_ACTOR,
      "engine",
    );
    expect(api.patchRunItem).toHaveBeenCalledWith(
      "r1",
      "m1",
      { status: "done", note: null },
      ENGINE_ACTOR,
      "engine",
    );
    expect(api.patchNode).not.toHaveBeenCalled();
    // 実行ログ・成果はテンプレートノードのスレッドへ、ラン帰属(Message.runId)付きで投稿する。
    // payload.runId は server の /api/runs/:id/trace 用の併記（帰属の正はフィールド側）
    expect(api.postMessage).toHaveBeenCalled();
    for (const call of api.postMessage.mock.calls) {
      expect(call[0]).toBe("m1");
      expect(call[1].runId).toBe("r1");
      expect((call[1].payload as { runId?: string }).runId).toBe("r1");
    }
  });
});

// 1tick=1件なので「どの層から見るか」で何が実行されるかが変わる。層を切り出した後は
// 呼ぶ順を1行入れ替えるだけで優先順位が反転してしまい、しかも他のテストは全部緑のままになる
// （各テストが1つの層しか動かさないため）。両方が実行可能な状態を作って順序自体を固定する
describe("tick: 層の優先順位", () => {
  it("プロジェクト層とラン層が同時に実行可能なら、プロジェクト層だけが動く", async () => {
    // プロジェクト層の対象（ルーティーンでないページのメンバー）
    const task = node({
      id: "t1",
      group: "page-plain",
      executor: "script",
      impl: { type: "script", command: "project.sh" },
    });
    // ラン層の対象（ルーティーンページのテンプレート + 実行可能なランアイテム）
    const template = node({
      id: "m1",
      group: "page-1",
      executor: "script",
      impl: { type: "script", command: "run.sh" },
    });
    api.getState.mockResolvedValue({
      nodes: [...routinePage(), node({ id: "page-plain", kind: "goal" }), task, template],
      now: "2026-01-01T02:00:00Z",
    });
    api.listPageRuns.mockResolvedValue([run({ m1: item({ status: "pending" }) }, { id: "r1" })]);

    await (await loadTick())();

    expect(exec.runScript).toHaveBeenCalledTimes(1);
    expect(exec.runScript.mock.calls[0][0]).toBe("project.sh");
    expect(api.patchRunItem).not.toHaveBeenCalled(); // ラン層はこの周では動かない
  });

  it("ラン層では、承認待ちの処理がAI質問待ちより先に動く", async () => {
    const gated = node({
      id: "m1",
      group: "page-1",
      approval: true,
      impl: { type: "script", command: "danger.sh" },
    });
    const asked = node({
      id: "m2",
      group: "page-1",
      executor: "ai",
      impl: { type: "doc", text: "手順" },
    });
    api.getState.mockResolvedValue({
      nodes: [...routinePage(), gated, asked],
      now: "2026-01-01T02:00:00Z",
    });
    api.listPageRuns.mockResolvedValue([
      run(
        {
          m1: item({ status: "waiting", note: "承認待ち" }),
          m2: item({ status: "waiting", note: "AI質問待ち" }),
        },
        { id: "r1" },
      ),
    ]);

    await (await loadTick())();

    // 開いたカードは承認の1枚だけ（AI質問の再発行まで進んでいない）
    expect(api.openRequest).toHaveBeenCalledTimes(1);
    expect(api.openRequest.mock.calls[0][0]).toBe("m1");
  });
});

describe("tick: カード発行の失敗で処理が止まらない", () => {
  it("承認カードを開けなくても、その周のうちに他のランのアイテムは実行される", async () => {
    const gated = node({
      id: "m1",
      group: "page-1",
      approval: true,
      impl: { type: "script", command: "danger.sh" },
    });
    const plain = node({
      id: "m2",
      group: "page-1",
      impl: { type: "script", command: "safe.sh" },
    });
    api.getState.mockResolvedValue({
      nodes: [...routinePage(), gated, plain],
      now: "2026-01-01T02:00:00Z",
    });
    api.listPageRuns.mockResolvedValue([
      run({ m1: item({ status: "waiting", note: "承認待ち" }) }, { id: "r1", created: "2026-01-01T01:00:00Z" }),
      run({ m2: item({ status: "pending" }) }, { id: "r2", created: "2026-01-01T01:30:00Z" }),
    ]);
    api.openRequest.mockRejectedValue(new Error("別のリクエストが開いています"));

    await (await loadTick())();

    expect(api.openRequest).toHaveBeenCalledTimes(1); // 承認カードの発行は試みた（失敗）
    expect(exec.runScript).toHaveBeenCalledTimes(1);
    expect(exec.runScript.mock.calls[0][0]).toBe("safe.sh"); // 後続のランは止まらない
  });

  it("AI質問カードを開けなかったノードは pending に戻す（running のまま詰まらせない）", async () => {
    api.getState.mockResolvedValue({
      nodes: [node({ id: "t1", executor: "ai", impl: { type: "doc", text: "手順" } })],
      now: "2026-01-01T02:00:00Z",
    });
    exec.runClaude.mockResolvedValue({
      success: true,
      output: "QUESTION: どちらにしますか？\nOPTION: A\nOPTION: B",
    });
    api.openRequest.mockRejectedValue(new Error("別のリクエストが開いています"));

    await (await loadTick())();

    expect(api.patchNode).toHaveBeenCalledWith("t1", { status: "pending" }, ENGINE_ACTOR, "engine");
    expect(api.patchNode).not.toHaveBeenCalledWith("t1", { status: "done" }, ENGINE_ACTOR, "engine");
  });
});

describe("tick: トリガー層", () => {
  it("script トリガーは schedule に従ってラン作成を依頼する（実行はしない）", async () => {
    api.getState.mockResolvedValue({
      nodes: [
        node({ id: "page-1", kind: "goal" }),
        node({ id: "tr1", kind: "trigger", executor: "script", schedule: "every 15m", group: "page-1" }),
      ],
      now: "2026-01-01T02:00:00Z",
    });

    await (await loadTick())();

    expect(api.runTriggerNode).toHaveBeenCalledWith(
      "tr1",
      { via: "schedule:every 15m" },
      ENGINE_ACTOR,
    );
    expect(exec.runScript).not.toHaveBeenCalled();
  });

  it("ai トリガーは AI に判定させ、run 判定のときだけラン作成を依頼する", async () => {
    api.getState.mockResolvedValue({
      nodes: [
        node({ id: "page-1", kind: "goal" }),
        node({ id: "tr1", kind: "trigger", executor: "ai", schedule: "every 15m", group: "page-1" }),
      ],
      now: "2026-01-01T02:00:00Z",
    });
    exec.runClaude.mockResolvedValue({ success: true, output: "skip" });

    const tick = await loadTick();
    await tick();

    expect(exec.runClaude).toHaveBeenCalledTimes(1);
    expect(api.runTriggerNode).not.toHaveBeenCalled();
  });
});
