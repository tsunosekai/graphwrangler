import { describe, expect, it } from "vitest";
import {
  APPROVAL_WAITING_NOTE,
  buildRunApprovalRequest,
  collectPendingApprovalItems,
  findRunGate,
  gateKey,
  runGateMarker,
  selectRunApprovalAction,
} from "../src/approval.js";
import type { Message, Node, Run, RunItem } from "../src/types.js";

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
    kind: partial.kind ?? "task",
    executor: partial.executor ?? "script",
    impact: partial.impact ?? "irreversible",
    autonomy: partial.autonomy ?? "normal",
    lifecycle: partial.lifecycle ?? "committed",
    status: partial.status ?? "pending",
    fixed: partial.fixed ?? false,
    pendingRequest: partial.pendingRequest ?? null,
    implTrial: partial.implTrial ?? null,
    schedule: partial.schedule ?? null,
    branches: partial.branches ?? null,
    choice: partial.choice ?? null,
    parentOptions: partial.parentOptions ?? {},
    created: partial.created ?? `2026-01-01T00:00:${String(nodeSeq).padStart(2, "0")}Z`,
  };
}

function item(partial: Partial<RunItem> = {}): RunItem {
  return {
    status: partial.status ?? "waiting",
    note: partial.note ?? APPROVAL_WAITING_NOTE,
    choice: partial.choice ?? null,
  };
}

let runSeq = 0;
function run(items: Record<string, RunItem>, partial: Partial<Run> = {}): Run {
  runSeq += 1;
  return {
    id: partial.id ?? `r-${runSeq}`,
    procedure: partial.procedure ?? "proc-1",
    title: partial.title ?? `ラン ${runSeq}`,
    trigger: partial.trigger ?? "manual",
    status: partial.status ?? "running",
    items,
    created: partial.created ?? `2026-01-01T01:00:${String(runSeq).padStart(2, "0")}Z`,
  };
}

function decisionRequestMessage(runId: string, opts: { answered?: boolean; id?: string } = {}): Message {
  return {
    id: opts.id ?? "m-req",
    node: "n-x",
    ts: "2026-01-01T00:01:00Z",
    author: { kind: "agent" },
    via: "engine",
    kind: "decision_request",
    body: `これは元に戻せない操作です。実行していいですか？ ${runGateMarker(runId)}`,
    payload: null,
    requestStatus: opts.answered ? "answered" : "open",
  };
}

function decisionAnswerMessage(requestId: string, option: string | null): Message {
  return {
    id: "m-ans",
    node: "n-x",
    ts: "2026-01-01T00:02:00Z",
    author: { kind: "human" },
    via: "ui",
    kind: "decision_answer",
    body: "",
    payload: { requestId, option, note: null },
  };
}

describe("findRunGate", () => {
  it("マーカーに一致するdecision_requestが無ければnone", () => {
    expect(findRunGate([], "r-1")).toEqual({ status: "none" });
    expect(findRunGate([decisionRequestMessage("r-2")], "r-1")).toEqual({ status: "none" });
  });

  it("未回答のdecision_requestがあればopen", () => {
    const messages = [decisionRequestMessage("r-1", { answered: false })];
    expect(findRunGate(messages, "r-1")).toEqual({ status: "open" });
  });

  it("回答済み(go)ならanswered+option=go", () => {
    const req = decisionRequestMessage("r-1", { answered: true, id: "m-req" });
    const ans = decisionAnswerMessage("m-req", "go");
    expect(findRunGate([req, ans], "r-1")).toEqual({ status: "answered", option: "go" });
  });

  it("回答済み(skip)ならanswered+option=skip", () => {
    const req = decisionRequestMessage("r-1", { answered: true, id: "m-req" });
    const ans = decisionAnswerMessage("m-req", "skip");
    expect(findRunGate([req, ans], "r-1")).toEqual({ status: "answered", option: "skip" });
  });
});

describe("buildRunApprovalRequest", () => {
  it("go/skipの2択・impact=irreversible・questionにランIDのマーカーを含む", () => {
    const n = node({ title: "本番へ反映" });
    const r = run({}, { id: "r-99", title: "夜間バッチ" });
    const req = buildRunApprovalRequest(n, r);
    expect(req.options.map((o) => o.id)).toEqual(["go", "skip"]);
    expect(req.impact).toBe("irreversible");
    expect(req.question).toContain("[ラン r-99]");
    expect(req.context).toContain("本番へ反映");
    expect(req.context).toContain("夜間バッチ");
  });
});

describe("collectPendingApprovalItems", () => {
  it("waiting+承認待ちノートのirreversibleアイテムだけを集める", () => {
    const irr = node({ id: "irr1", impact: "irreversible" });
    const safe = node({ id: "safe1", impact: "safe" });
    const r = run({
      irr1: item({ status: "waiting", note: APPROVAL_WAITING_NOTE }),
      safe1: item({ status: "waiting", note: APPROVAL_WAITING_NOTE }),
    });
    const out = collectPendingApprovalItems([irr, safe], [r]);
    expect(out).toEqual([{ run: r, node: irr }]);
  });

  it("statusがwaiting以外、またはnoteが違うものは除外", () => {
    const irr = node({ id: "irr1", impact: "irreversible" });
    const r = run({ irr1: item({ status: "pending", note: null }) });
    expect(collectPendingApprovalItems([irr], [r])).toEqual([]);
  });
});

describe("selectRunApprovalAction: 承認前は実行しない", () => {
  it("ゲート未発行(none)ならopen-gateを返す(実行しない)", () => {
    const n = node({ id: "irr1" });
    const r = run({ irr1: item() });
    const action = selectRunApprovalAction([n], [r], {});
    expect(action).toEqual({ type: "open-gate", run: r, node: n });
  });

  it("ゲート発行済み・未回答(open)なら何もしない(実行しない・二重に開かない)", () => {
    const n = node({ id: "irr1" });
    const r = run({ irr1: item() });
    const gateStates = { [gateKey(r.id, "irr1")]: { status: "open" as const } };
    const action = selectRunApprovalAction([n], [r], gateStates);
    expect(action).toEqual({ type: "none" });
  });
});

describe("selectRunApprovalAction: go後に1回実行", () => {
  it("回答がgoならexecuteを返す", () => {
    const n = node({ id: "irr1" });
    const r = run({ irr1: item() });
    const gateStates = { [gateKey(r.id, "irr1")]: { status: "answered" as const, option: "go" } };
    const action = selectRunApprovalAction([n], [r], gateStates);
    expect(action).toEqual({ type: "execute", run: r, node: n });
  });

  it("実行後(アイテムがwaiting/承認待ちでなくなった)は対象から外れる", () => {
    const n = node({ id: "irr1" });
    // 実行済みを模して item.status が done に変わった状態
    const r = run({ irr1: { status: "done", note: null, choice: null } });
    const gateStates = { [gateKey(r.id, "irr1")]: { status: "answered" as const, option: "go" } };
    const action = selectRunApprovalAction([n], [r], gateStates);
    expect(action).toEqual({ type: "none" });
  });
});

describe("selectRunApprovalAction: skip後はskipped", () => {
  it("回答がskipならskipアクションを返す(呼び出し側がitems patch skippedする)", () => {
    const n = node({ id: "irr1" });
    const r = run({ irr1: item() });
    const gateStates = { [gateKey(r.id, "irr1")]: { status: "answered" as const, option: "skip" } };
    const action = selectRunApprovalAction([n], [r], gateStates);
    expect(action).toEqual({ type: "skip", run: r, node: n });
  });
});

describe("selectRunApprovalAction: 二重カードを開かない", () => {
  it("同じゲートがopenのままの間、何度呼んでもopen-gateにはならない", () => {
    const n = node({ id: "irr1" });
    const r = run({ irr1: item() });
    const gateStates = { [gateKey(r.id, "irr1")]: { status: "open" as const } };
    for (let i = 0; i < 3; i += 1) {
      expect(selectRunApprovalAction([n], [r], gateStates)).toEqual({ type: "none" });
    }
  });
});
