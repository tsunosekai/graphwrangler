import { describe, expect, it } from "vitest";
import {
  buildDecisionRequest,
  buildDecisionPrompt,
  parseBranchChoice,
  selectDecisionAction,
} from "../src/decision.js";
import type { Message, Node } from "../src/types.js";

let seq = 0;
function node(partial: Partial<Node> = {}): Node {
  seq += 1;
  return {
    id: partial.id ?? `n-${seq}`,
    title: partial.title ?? `node ${seq}`,
    detail: partial.detail ?? null,
    impl: partial.impl ?? null,
    parents: partial.parents ?? [],
    group: partial.group ?? null,
    kind: partial.kind ?? "decision",
    executor: partial.executor ?? "script",
    approval: partial.approval ?? false,
    autonomy: partial.autonomy ?? "normal",
    lifecycle: partial.lifecycle ?? "committed",
    status: partial.status ?? "pending",
    fixed: partial.fixed ?? false,
    pendingRequest: partial.pendingRequest ?? null,
    implTrial: partial.implTrial ?? null,
    schedule: partial.schedule ?? null,
    branches: partial.branches ?? [
      { id: "a", label: "Aへ" },
      { id: "b", label: "Bへ", then: "Bの処理に進む" },
    ],
    choice: partial.choice ?? null,
    parentOptions: partial.parentOptions ?? {},
    createdBy: partial.createdBy ?? null,
    assignee: partial.assignee ?? null,
    members: partial.members ?? [],
    created: partial.created ?? `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
  };
}

function decisionAnswer(option: string | null): Message {
  return {
    id: "m-ans",
    node: "n-x",
    ts: "2026-01-01T00:01:00Z",
    author: { kind: "human" },
    via: "ui",
    kind: "decision_answer",
    body: "",
    payload: { requestId: "m-req", option, note: null },
  };
}

describe("selectDecisionAction: executor別の分岐処理", () => {
  it("executor=script は execute-script を返す", () => {
    const n = node({ executor: "script" });
    expect(selectDecisionAction([n])).toEqual({ type: "execute-script", node: n });
  });

  it("executor=ai は execute-ai を返す", () => {
    const n = node({ executor: "ai" });
    expect(selectDecisionAction([n])).toEqual({ type: "execute-ai", node: n });
  });

  it("executor=human は未回答なら open-human-request を返す", () => {
    const n = node({ executor: "human" });
    expect(selectDecisionAction([n])).toEqual({ type: "open-human-request", node: n });
  });

  it("executor=human で有効な枝idの回答があれば decide を返す", () => {
    const n = node({ executor: "human" });
    const action = selectDecisionAction([n], { [n.id]: decisionAnswer("b") });
    expect(action).toEqual({ type: "decide", node: n, choice: "b" });
  });

  it("executor=human で branches に無い回答は open-human-request のまま（想定外の回答は無視）", () => {
    const n = node({ executor: "human" });
    const action = selectDecisionAction([n], { [n.id]: decisionAnswer("z") });
    expect(action).toEqual({ type: "open-human-request", node: n });
  });
});

describe("selectDecisionAction: 失敗リカバリ", () => {
  it("直前の回答がabortならexecutorに関わらずdropになる", () => {
    const n = node({ executor: "script" });
    const action = selectDecisionAction([n], { [n.id]: decisionAnswer("abort") });
    expect(action).toEqual({ type: "drop", node: n });
  });

  it("直前の回答がmodifyならdemote（編集を待ち、即再実行しない）", () => {
    const n = node({ executor: "ai" });
    const action = selectDecisionAction([n], { [n.id]: decisionAnswer("modify") });
    expect(action).toEqual({ type: "demote", node: n });
  });
});

describe("selectDecisionAction: frontier/lifecycle/kind除外", () => {
  it("親が未完了(pending)なら候補にならない", () => {
    const parent = node({ id: "p1", kind: "task", status: "pending" });
    const child = node({ id: "c1", parents: ["p1"] });
    expect(selectDecisionAction([parent, child])).toEqual({ type: "none" });
  });

  it("親がskippedなら充足扱いで候補になる（合流の分岐にも使われる規則）", () => {
    const parent = node({ id: "p1", kind: "task", status: "skipped" });
    const child = node({ id: "c1", parents: ["p1"] });
    expect(selectDecisionAction([parent, child])).toEqual({ type: "execute-script", node: child });
  });

  // トリガーノードを持つページ（ルーティーンページ）の decision メンバーは、
  // プロジェクト側ではなくラン側(decisionRun.ts)が扱う（docs/design.md 3.4/3.8/3.9）
  it("トリガーノードを持つページのdecisionメンバーはプロジェクト側の候補にならない", () => {
    const page = node({ id: "g1", kind: "goal" });
    const trigger = node({ id: "tr1", kind: "trigger", group: "g1", status: "done" });
    const tmpl = node({ id: "t1", group: "g1", parents: ["tr1"] });
    expect(selectDecisionAction([page, trigger, tmpl])).toEqual({ type: "none" });
  });

  it("status=doneやskipped済みのdecisionは候補にならない", () => {
    const done = node({ status: "done", choice: "a" });
    const skipped = node({ status: "skipped" });
    expect(selectDecisionAction([done])).toEqual({ type: "none" });
    expect(selectDecisionAction([skipped])).toEqual({ type: "none" });
  });
});

describe("parseBranchChoice: script/ai出力の解釈", () => {
  it("枝idと完全一致すればそのidを返す", () => {
    const n = node();
    expect(parseBranchChoice(n, "a\n")).toBe("a");
  });

  it("前後に説明が付いた複数行でも、行単位で枝idと一致すれば拾う", () => {
    const n = node();
    expect(parseBranchChoice(n, "考えた結果\nb\nを選びます")).toBe("b");
  });

  it("枝idと一致しない出力は失敗として null を返す（不正出力の失敗扱い）", () => {
    const n = node();
    expect(parseBranchChoice(n, "よくわかりません")).toBeNull();
  });

  it("空文字の出力もnull（失敗）", () => {
    const n = node();
    expect(parseBranchChoice(n, "")).toBeNull();
  });
});

describe("buildDecisionRequest / buildDecisionPrompt", () => {
  it("branchesがoptionsにそのまま変換され、thenが無い枝は既定文言で補われる", () => {
    const n = node({ title: "本番構成を選ぶ" });
    const req = buildDecisionRequest(n);
    expect(req.options.map((o) => o.id)).toEqual(["a", "b"]);
    expect(req.options[0].then).toBe("「Aへ」の枝に進む"); // then省略時の既定文言
    expect(req.options[1].then).toBe("Bの処理に進む"); // then明示時はそのまま
    expect(req.context).toContain("本番構成を選ぶ");
  });

  it("AIプロンプトに枝のid/labelが含まれ、idのみ出力するよう指示する", () => {
    const n = node({ title: "本番構成を選ぶ" });
    const prompt = buildDecisionPrompt(n);
    expect(prompt).toContain("id=a label=Aへ");
    expect(prompt).toContain("id=b label=Bへ then=Bの処理に進む");
    expect(prompt).toContain("id のみを1行で出力");
  });
});
