import { describe, expect, it } from "vitest";
import {
  RETRO_OPTION_APPLY,
  buildFieldPatch,
  buildProposalBody,
  buildRetroPrompt,
  buildRetroRequest,
  changedSinceRun,
  deriveRetroPhase,
  detectRunEndings,
  editableField,
  formatTraceEntry,
  parseRetroOutput,
  pickRetroTarget,
  planRetroApply,
  retroMarker,
  selectTraceLines,
  textHash,
  validateRetroChanges,
  type RetroChange,
  type RetroProposal,
  type TraceEntry,
} from "../src/retro.js";
import type { Message, Node, Run } from "../src/types.js";

let nodeSeq = 0;
function node(partial: Partial<Node> = {}): Node {
  nodeSeq += 1;
  return {
    id: partial.id ?? `n-${nodeSeq}`,
    title: partial.title ?? `node ${nodeSeq}`,
    detail: partial.detail ?? null,
    impl: partial.impl ?? null,
    parents: partial.parents ?? [],
    group: partial.group === undefined ? "page" : partial.group,
    folder: partial.folder ?? null,
    folderSection: partial.folderSection ?? null,
    order: partial.order ?? null,
    kind: partial.kind ?? "task",
    executor: partial.executor ?? "ai",
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
    catchUp: true,
    prep: partial.prep ?? true,
    prepRequest: partial.prepRequest ?? false,
    muted: false,
    wait: null,
    waitUntil: null,
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

function run(partial: Partial<Run> = {}): Run {
  return {
    id: partial.id ?? "r-1",
    pageId: partial.pageId ?? "page",
    title: partial.title ?? "11/27 のラン",
    trigger: partial.trigger ?? "trigger:t:manual",
    status: partial.status ?? "done",
    items: partial.items ?? {},
    context: partial.context ?? {},
    retroRequest: partial.retroRequest ?? false,
    created: partial.created ?? "2026-11-27T00:00:00Z",
  };
}

let msgSeq = 0;
function msg(partial: Partial<Message>): Message {
  msgSeq += 1;
  return {
    id: partial.id ?? `m-${msgSeq}`,
    node: partial.node ?? "page",
    ts: partial.ts ?? `2026-11-27T00:${String(msgSeq % 60).padStart(2, "0")}:00Z`,
    author: partial.author ?? { kind: "agent" },
    via: partial.via ?? "engine",
    kind: partial.kind ?? "status",
    body: partial.body ?? "",
    runId: partial.runId ?? "r-1",
    payload: partial.payload ?? null,
    ...(partial.requestStatus ? { requestStatus: partial.requestStatus } : {}),
  };
}

function change(partial: Partial<RetroChange> = {}): RetroChange {
  const oldText = partial.oldText ?? "古い手順";
  return {
    nodeId: partial.nodeId ?? "a",
    title: partial.title ?? "請求書を集める",
    field: partial.field ?? "impl.text",
    reason: partial.reason ?? "人が訂正した",
    what: partial.what ?? "フォルダの場所を直す",
    newText: partial.newText ?? "新しい手順",
    oldText,
    oldHash: partial.oldHash ?? textHash(oldText),
  };
}

function proposal(changes: RetroChange[], runId = "r-1"): RetroProposal {
  return { retro: true, runId, state: "proposed", summary: "要約", changes, pageStatus: "pending" };
}

describe("editableField（直せる欄）", () => {
  it("手順書が文面なら impl.text、無ければ detail、ロック中はなし", () => {
    expect(editableField(node({ impl: { type: "doc", text: "手順" } }))).toBe("impl.text");
    expect(editableField(node({ impl: null }))).toBe("detail");
    expect(editableField(node({ impl: { type: "script", command: "echo hi" } }))).toBe("detail");
    expect(editableField(node({ impl: { type: "doc", text: "手順" }, fixed: true }))).toBeNull();
  });

  it("手順書がファイルだけにあるときはファイルを直さず detail", () => {
    expect(editableField(node({ impl: { type: "doc", path: "docs/a.md" } }))).toBe("detail");
    expect(editableField(node({ impl: { type: "doc", path: "docs/a.md", text: "手順" } }))).toBe("impl.text");
  });

  it("impl.text の書き換えは path など他の欄を残す", () => {
    const n = node({ impl: { type: "doc", text: "古い", path: "docs/a.md" } });
    expect(buildFieldPatch(n, "impl.text", "新しい")).toEqual({
      impl: { type: "doc", text: "新しい", path: "docs/a.md" },
    });
    expect(buildFieldPatch(n, "detail", "補足")).toEqual({ detail: "補足" });
  });
});

describe("detectRunEndings（ランの終わりを拾う）", () => {
  const t0 = Date.parse("2026-11-27T00:00:00Z");

  it("起動直後の1周目は覚えるだけ（過去に終わったランを振り返らない）", () => {
    const { ended, seen } = detectRunEndings(null, [run({ id: "r-1", status: "done" })], t0);
    expect(ended).toEqual([]);
    expect(seen.statuses.get("r-1")).toBe("done");
  });

  it("running から done / cancelled へ変わったものだけ", () => {
    const prev = {
      statuses: new Map([
        ["r-1", "running"],
        ["r-2", "running"],
        ["r-3", "done"],
        ["r-4", "running"],
      ]),
      at: t0,
    };
    const { ended } = detectRunEndings(
      prev,
      [
        run({ id: "r-1", status: "done" }),
        run({ id: "r-2", status: "cancelled" }),
        run({ id: "r-3", status: "done" }),
        run({ id: "r-4", status: "running" }),
      ],
      t0 + 5000,
    );
    expect(ended).toEqual(["r-1", "r-2"]);
  });

  it("前に見たあとに作られてもう終わっているランも拾う。古いランが現れても拾わない", () => {
    const prev = { statuses: new Map<string, string>(), at: t0 };
    const { ended } = detectRunEndings(
      prev,
      [
        run({ id: "new", status: "done", created: "2026-11-27T00:00:03Z" }),
        run({ id: "old", status: "done", created: "2026-10-01T00:00:00Z" }),
        run({ id: "live", status: "running", created: "2026-11-27T00:00:03Z" }),
      ],
      t0 + 5000,
    );
    expect(ended).toEqual(["new"]);
  });
});

describe("pickRetroTarget", () => {
  it("手動の依頼が最優先。走っているランの依頼は無視する", () => {
    const runs = [
      run({ id: "r-1" }),
      run({ id: "r-2", retroRequest: true, created: "2026-11-27T01:00:00Z" }),
      run({ id: "r-3", retroRequest: true, status: "running" }),
    ];
    const picked = pickRetroTarget(runs, ["r-1", "r-2"]);
    expect(picked?.run.id).toBe("r-2");
    expect(picked?.manual).toBe(true);
    expect(picked?.queue).toEqual(["r-1"]);
  });

  it("依頼が無ければ待ち行列の先頭。もう無いランは捨てる", () => {
    const picked = pickRetroTarget([run({ id: "r-1" })], ["gone", "r-1"]);
    expect(picked?.run.id).toBe("r-1");
    expect(picked?.manual).toBe(false);
    expect(picked?.queue).toEqual([]);
    expect(pickRetroTarget([run({ id: "r-1" })], [])).toBeNull();
  });
});

describe("deriveRetroPhase（印からどこまで進んだか）", () => {
  it("印が無ければ none、終わりの印なら final", () => {
    expect(deriveRetroPhase([msg({ body: "ラン完了" })], "r-1")).toEqual({ phase: "none" });
    const none = msg({ payload: { retro: true, runId: "r-1", state: "none" } });
    expect(deriveRetroPhase([none], "r-1")).toEqual({ phase: "final", state: "none" });
    // 別ランの印は見ない
    expect(deriveRetroPhase([none], "r-2")).toEqual({ phase: "none" });
  });

  it("案を出してカードがまだ → request=null、開いている → open、答え済み → option", () => {
    const p = msg({ kind: "say", payload: proposal([change()]) });
    expect(deriveRetroPhase([p], "r-1")).toMatchObject({ phase: "proposed", request: null });

    const req = msg({
      id: "m-req",
      kind: "decision_request",
      body: `反映しますか？ ${retroMarker("r-1")}`,
      requestStatus: "open",
    });
    expect(deriveRetroPhase([p, req], "r-1")).toMatchObject({
      phase: "proposed",
      request: { id: "m-req", status: "open" },
    });

    const answered = { ...req, requestStatus: "answered" as const };
    const ans = msg({
      kind: "decision_answer",
      author: { kind: "human" },
      payload: { requestId: "m-req", option: RETRO_OPTION_APPLY, note: null },
    });
    expect(deriveRetroPhase([p, answered, ans], "r-1")).toMatchObject({
      phase: "proposed",
      request: { id: "m-req", status: "answered", option: "apply" },
    });
  });

  it("最後の印が正（やり直したら前の結果を上書きする）。案より前のカードは数えない", () => {
    const oldReq = msg({ kind: "decision_request", body: `x ${retroMarker("r-1")}`, requestStatus: "answered" });
    const applied = msg({ payload: { retro: true, runId: "r-1", state: "applied" } });
    const p = msg({ kind: "say", payload: proposal([change()]) });
    expect(deriveRetroPhase([oldReq, applied, p], "r-1")).toMatchObject({ phase: "proposed", request: null });
    expect(deriveRetroPhase([p, applied], "r-1")).toEqual({ phase: "final", state: "applied" });
  });
});

describe("selectTraceLines（記録を詰める）", () => {
  const entry = (partial: Partial<TraceEntry>): TraceEntry => ({
    ts: partial.ts ?? "2026-11-27T00:00:00Z",
    nodeTitle: partial.nodeTitle ?? "作業",
    author: partial.author ?? { kind: "agent" },
    kind: partial.kind ?? "status",
    body: partial.body ?? "",
    payload: partial.payload ?? null,
  });

  it("本文は1件ごとに切り詰め、時刻順に並べる", () => {
    const long = "あ".repeat(3000);
    const { lines, omitted } = selectTraceLines([
      entry({ ts: "2026-11-27T00:02:00Z", body: "後" }),
      entry({ ts: "2026-11-27T00:01:00Z", body: long }),
    ]);
    expect(omitted).toBe(0);
    expect(lines[0].length).toBeLessThan(1700);
    expect(lines[1]).toContain("後");
  });

  it("上限を超えたら、人の発言と失敗を残して他を落とす", () => {
    const filler = "い".repeat(1400);
    const entries = [
      entry({ ts: "2026-11-27T00:00:01Z", kind: "status", body: `記録 ${filler}` }),
      entry({ ts: "2026-11-27T00:00:02Z", kind: "say", body: `AIの発言 ${filler}` }),
      entry({ ts: "2026-11-27T00:00:03Z", kind: "say", author: { kind: "human" }, body: "フォルダが違う" }),
      entry({ ts: "2026-11-27T00:00:04Z", kind: "status", body: "実行失敗: ファイルが無い" }),
    ];
    const { lines, omitted } = selectTraceLines(entries, 300);
    expect(omitted).toBe(2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("フォルダが違う");
    expect(lines[1]).toContain("実行失敗");
  });

  it("回答は選んだ選択肢を添える", () => {
    const line = formatTraceEntry(
      entry({
        kind: "decision_answer",
        author: { kind: "human", name: "ツノ" },
        body: "毎回これ聞かないで",
        payload: { requestId: "m-1", option: "go", note: "毎回これ聞かないで" },
      }),
    );
    expect(line).toContain("人（ツノ）の回答");
    expect(line).toContain("「go」を選択: 毎回これ聞かないで");
  });
});

describe("buildRetroPrompt", () => {
  it("ゴール・ノード（直せる欄とランの結果つき）・記録・返し方が入り、読むだけと書いてある", () => {
    const goal = node({ id: "page", kind: "goal", group: null, title: "月末の請求", detail: "未払いを片づける" });
    const a = node({ id: "a", title: "請求書を集める", impl: { type: "doc", text: "フォルダXを見る" } });
    const s = node({ id: "s", title: "集計", executor: "script", impl: { type: "script", command: "node sum.js" } });
    const f = node({ id: "f", title: "確定", fixed: true });
    const prompt = buildRetroPrompt({
      goal,
      members: [a, s, f],
      run: run({ items: { a: { status: "done", note: null, choice: null, resolvedParams: null, waitUntil: null } } }),
      traceLines: ["- [11/27 09:00] 請求書を集める / 人の発言: フォルダはYです"],
      omitted: 3,
    });
    expect(prompt).toContain("月末の請求");
    expect(prompt).toContain("未払いを片づける");
    expect(prompt).toContain("### a「請求書を集める」");
    expect(prompt).toContain("直せる欄: impl.text");
    expect(prompt).toContain("このランでの結果: 完了");
    expect(prompt).toContain("フォルダXを見る");
    expect(prompt).toContain("スクリプト（直さない）: node sum.js");
    expect(prompt).toContain("直せる欄: なし");
    expect(prompt).toContain("フォルダはYです");
    expect(prompt).toContain("ほかに 3 件");
    expect(prompt).toContain("書き換えない");
    expect(prompt).toContain("```json");
  });

  it("ランの後に手順が変わったノードには当時の手順を添え、後から足したノードはそう書く", () => {
    const goal = node({ id: "page", kind: "goal", group: null, title: "生成" });
    const start = node({ id: "start", title: "生成を始める", kind: "decision", executor: "script",
      impl: { type: "script", command: "start.sh" }, branches: [{ id: "started", label: "始めた" }, { id: "none", label: "対象なし" }] });
    const added = node({ id: "added", title: "新しい確認" });
    const same = node({ id: "same", title: "変わらない", impl: { type: "doc", text: "そのまま" } });
    const snapNode = (n: Node, patch: Partial<Node> = {}) => {
      const { id, title, detail, impl, parents, group, kind, executor, approval, autonomy, aiModel, aiEffort,
        lifecycle, status, fixed, schedule, catchUp, prep, wait, branches, outputs, parentOptions, assignee } = { ...n, ...patch };
      return { id, title, detail, impl, parents, group, kind, executor, approval, autonomy, aiModel, aiEffort,
        lifecycle, status, fixed, schedule, catchUp, prep, wait, branches, outputs, parentOptions, assignee };
    };
    const snapshot = { capturedAt: "2026-11-27T05:19:00Z", nodes: [snapNode(start, { kind: "task", branches: null }), snapNode(same)] };
    expect(changedSinceRun(start, snapshot.nodes[0])).toBe(true);
    expect(changedSinceRun(same, snapshot.nodes[1])).toBe(false);
    const prompt = buildRetroPrompt({ goal, members: [start, added, same], run: { ...run(), snapshot }, traceLines: [], omitted: 0 });
    expect(prompt).toContain("このランの時点の手順は今と違う");
    expect(prompt).toContain("ランの時点では: 種類 task");
    expect(prompt).toContain("このノードはランの後に足された");
    expect(prompt).toContain("ランの後に直し済み");
    // 決まりの文で1回 + 変わったノード（start）で1回。変わらないノード（same）には付かない
    expect(prompt.match(/このランの時点の手順は今と違う/g)?.length).toBe(2);
  });
});

describe("parseRetroOutput", () => {
  it("最後の json ブロックを読む", () => {
    const out = [
      "考えた結果です。",
      "```json",
      '{"summary":"古い","changes":[]}',
      "```",
      "やっぱりこちら:",
      "```json",
      '{"summary":"一行目\\n二行目\\n三行目\\n四行目","changes":[{"nodeId":"a","newText":"x"}]}',
      "```",
    ].join("\n");
    const parsed = parseRetroOutput(out);
    expect(parsed?.summary).toBe("一行目\n二行目\n三行目");
    expect(parsed?.changes).toHaveLength(1);
  });

  it("ブロックが無くても裸の JSON を読む。読めなければ null", () => {
    expect(parseRetroOutput('答え: {"summary":"なし","changes":[]}')).toEqual({ summary: "なし", changes: [] });
    expect(parseRetroOutput("直すところはありません")).toBeNull();
    expect(parseRetroOutput("```json\n{壊れた\n```")).toBeNull();
    expect(parseRetroOutput('{"changes":"文字列"}')).toBeNull();
  });
});

describe("validateRetroChanges", () => {
  const a = node({ id: "a", title: "請求書を集める", impl: { type: "doc", text: "古い手順" } });
  const d = node({ id: "d", title: "送る", detail: "補足" });
  const f = node({ id: "f", title: "確定", fixed: true });

  it("通る案は欄を補い、元の文面と指紋を持つ", () => {
    const { valid, dropped } = validateRetroChanges(
      [{ nodeId: "a", reason: "人が\n訂正", what: "場所を直す", newText: " 新しい手順 " }],
      [a, d],
    );
    expect(dropped).toEqual([]);
    expect(valid).toEqual([
      {
        nodeId: "a",
        title: "請求書を集める",
        field: "impl.text",
        reason: "人が 訂正",
        what: "場所を直す",
        newText: "新しい手順",
        oldText: "古い手順",
        oldHash: textHash("古い手順"),
      },
    ]);
  });

  it("ページ外・直せない欄・空・同じ文面・ロック中・重複は落とす", () => {
    const { valid, dropped } = validateRetroChanges(
      [
        { nodeId: "zzz", newText: "x" },
        { nodeId: "a", field: "detail", newText: "x" },
        { nodeId: "d", newText: "   " },
        { nodeId: "d", newText: "補足" },
        { nodeId: "f", newText: "x" },
        { nodeId: "d", field: "detail", newText: "新しい補足" },
        { nodeId: "d", field: "detail", newText: "もう一つ" },
      ],
      [a, d, f],
    );
    expect(valid.map((c) => c.newText)).toEqual(["新しい補足"]);
    expect(dropped).toHaveLength(6);
  });
});

describe("本文とカード", () => {
  it("本文は短く、全文を載せない", () => {
    const body = buildProposalBody("要約です", [change({ newText: "とても長い全文" })], 1);
    expect(body).toContain("振り返り: 要約です");
    expect(body).toContain("- 請求書を集める: フォルダの場所を直す（理由: 人が訂正した）");
    expect(body).toContain("使えない案 1 件");
    expect(body).not.toContain("とても長い全文");
  });

  it("カードは反映する／反映しないの2択で、ランの目印と3行以内の文脈を持つ", () => {
    const req = buildRetroRequest({ id: "r-9", title: "夜のラン" }, "一行目\n二行目", [change(), change({ title: "送る" })]);
    expect(req.options.map((o) => o.label)).toEqual(["反映する", "反映しない"]);
    expect(req.question).toContain(retroMarker("r-9"));
    expect(req.context.split("\n").length).toBeLessThanOrEqual(3);
    expect(req.context).toContain("2か所");
    expect(req.context).toContain("請求書を集める、送る");
  });
});

describe("planRetroApply（反映する／見送る）", () => {
  it("案を作ったときの文面のままなら書き換える", () => {
    const a = node({ id: "a", impl: { type: "doc", text: "古い手順", path: "p.md" } });
    const steps = planRetroApply([change()], [a], "page");
    expect(steps).toEqual([
      { change: change(), patch: { impl: { type: "doc", text: "新しい手順", path: "p.md" } } },
    ]);
  });

  it("その間に書き換えられた・ロックされた・ページから外れた・消えたものは見送る", () => {
    const edited = node({ id: "a", impl: { type: "doc", text: "人が直した" } });
    const locked = node({ id: "b", impl: { type: "doc", text: "古い手順" }, fixed: true });
    const moved = node({ id: "c", impl: { type: "doc", text: "古い手順" }, group: "other" });
    const steps = planRetroApply(
      [change({ nodeId: "a" }), change({ nodeId: "b" }), change({ nodeId: "c" }), change({ nodeId: "gone" })],
      [edited, locked, moved],
      "page",
    );
    expect(steps.map((s) => ("skip" in s ? s.skip : "patch"))).toEqual([
      "案を作ったあとに書き換えられていた",
      "ロックされた",
      "ノードがもうこのページに無い",
      "ノードがもうこのページに無い",
    ]);
  });

  it("補足（detail）の案も同じく照合する", () => {
    const d = node({ id: "d", detail: "補足" });
    const steps = planRetroApply(
      [change({ nodeId: "d", field: "detail", oldText: "補足", newText: "新しい補足" })],
      [d],
      "page",
    );
    expect(steps[0]).toMatchObject({ patch: { detail: "新しい補足" } });
  });
});
