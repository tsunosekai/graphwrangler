import { describe, expect, it } from "vitest";
import {
  buildFailureRecoveryRequest,
  buildIrreversibleGateRequest,
  isFrontier,
  selectAction,
} from "../src/pick.js";
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
    // 左レールの整理棚と並び順（2026-08-05）。エンジンは見ないが型のため埋める
    folder: partial.folder ?? null,
    order: partial.order ?? null,
    kind: partial.kind ?? "task",
    executor: partial.executor ?? "script",
    approval: partial.approval ?? false,
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
    createdBy: partial.createdBy ?? null,
    assignee: partial.assignee ?? null,
    members: partial.members ?? [],
    created: partial.created ?? `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
  };
}

function decisionAnswer(option: string | null, requestId = "m-req"): Message {
  return {
    id: "m-ans",
    node: "n-x",
    ts: "2026-01-01T00:01:00Z",
    author: { kind: "human" },
    via: "ui",
    kind: "decision_answer",
    body: "",
    payload: { requestId, option, note: null },
  };
}

describe("isFrontier", () => {
  it("親が全てdoneなら真（parents空も真）", () => {
    const parent = node({ id: "p1", status: "done" });
    const child = node({ id: "c1", parents: ["p1"] });
    const byId = new Map([parent, child].map((n) => [n.id, n]));
    expect(isFrontier(child, byId)).toBe(true);
    expect(isFrontier(parent, byId)).toBe(true); // parents=[] は空なので真
  });

  it("親が未完了なら偽", () => {
    const parent = node({ id: "p1", status: "pending" });
    const child = node({ id: "c1", parents: ["p1"] });
    const byId = new Map([parent, child].map((n) => [n.id, n]));
    expect(isFrontier(child, byId)).toBe(false);
  });
});

describe("selectAction: frontier判定", () => {
  it("親がdoneのfrontierノードはexecute", () => {
    const parent = node({ status: "done" });
    const child = node({ parents: [parent.id] });
    const action = selectAction([parent, child]);
    expect(action).toEqual({ type: "execute", node: child });
  });

  it("親が未完了のノードは候補から除外される", () => {
    const parent = node({ status: "pending" });
    const child = node({ parents: [parent.id] });
    const action = selectAction([parent, child]);
    // parent 自身は frontier(親なし)なので parent が選ばれ、child は選ばれない
    expect(action).toEqual({ type: "execute", node: parent });
  });
});

describe("selectAction: draft除外", () => {
  it("lifecycle=draft のノードは実行候補にならない", () => {
    const n = node({ lifecycle: "draft" });
    expect(selectAction([n])).toEqual({ type: "none" });
  });
});

describe("selectAction: unplanned除外", () => {
  it("status=unplanned のノードは frontier でも候補にならない", () => {
    const n = node({ status: "unplanned" });
    expect(selectAction([n])).toEqual({ type: "none" });
  });
});

describe("selectAction: kind/executor 除外", () => {
  it("kind=goal は候補にならない", () => {
    const n = node({ kind: "goal" });
    expect(selectAction([n])).toEqual({ type: "none" });
  });

  it("executor=human は候補にならない", () => {
    const n = node({ executor: "human" });
    expect(selectAction([n])).toEqual({ type: "none" });
  });
});

describe("selectAction: irreversible除外と承認後許可", () => {
  it("approval=trueは承認なしでは実行されずopen-gateになる", () => {
    const n = node({ approval: true });
    expect(selectAction([n])).toEqual({ type: "open-gate", node: n });
  });

  it("直近のdecision_answerがoption=goならこの1回だけexecuteを許可する", () => {
    const n = node({ approval: true });
    const action = selectAction([n], { [n.id]: decisionAnswer("go") });
    expect(action).toEqual({ type: "execute", node: n });
  });

  it("直近のdecision_answerがoption=skipならdropになる", () => {
    const n = node({ approval: true });
    const action = selectAction([n], { [n.id]: decisionAnswer("skip") });
    expect(action).toEqual({ type: "drop", node: n });
  });

  it("goでない回答(retry等)は再度open-gateで確認を求める", () => {
    const n = node({ approval: true });
    const action = selectAction([n], { [n.id]: decisionAnswer("retry") });
    expect(action).toEqual({ type: "open-gate", node: n });
  });
});

describe("selectAction: modify回答は下書きへ戻す（即再実行しない）", () => {
  it("直近のdecision_answerがoption=modifyならdemote", () => {
    const n = node({ approval: false });
    const action = selectAction([n], { [n.id]: decisionAnswer("modify") });
    expect(action).toEqual({ type: "demote", node: n });
  });

  it("irreversibleでもmodifyはdemote（open-gateより先に編集を待つ）", () => {
    const n = node({ approval: true });
    const action = selectAction([n], { [n.id]: decisionAnswer("modify") });
    expect(action).toEqual({ type: "demote", node: n });
  });
});

describe("selectAction: 人間待ち（open な判断リクエスト）の除外と復帰", () => {
  it("pendingRequest があるノードは status=pending でも候補にならない", () => {
    const n = node({ status: "pending", pendingRequest: "m-1" });
    expect(selectAction([n])).toEqual({ type: "none" });
  });

  it("失敗リカバリでretryが返り status=pending に戻ったノードは通常どおりexecuteされる", () => {
    // server 側は option!=null の回答で status を pending に戻す（answerRequest の仕様）。
    // その状態を模した入力で、通常の実行候補として扱われることを確認する
    const n = node({ approval: false, status: "pending", pendingRequest: null });
    const action = selectAction([n], { [n.id]: decisionAnswer("retry") });
    expect(action).toEqual({ type: "execute", node: n });
  });

  it("失敗リカバリでabortが返ったノードはdropになる", () => {
    const n = node({ approval: false, status: "pending", pendingRequest: null });
    const action = selectAction([n], { [n.id]: decisionAnswer("abort") });
    expect(action).toEqual({ type: "drop", node: n });
  });
});

describe("selectAction: 選択順序", () => {
  it("createdが古い順に最初の1件だけを返す", () => {
    const older = node({ created: "2026-01-01T00:00:00Z" });
    const newer = node({ created: "2026-01-02T00:00:00Z" });
    const action = selectAction([newer, older]);
    expect(action).toEqual({ type: "execute", node: older });
  });
});

describe("buildIrreversibleGateRequest / buildFailureRecoveryRequest", () => {
  it("approvalゲートは go/skip の2択でリクエストimpact=irreversible", () => {
    const n = node({ approval: true, title: "本番へ反映" });
    const req = buildIrreversibleGateRequest(n);
    expect(req.options.map((o) => o.id)).toEqual(["go", "skip"]);
    expect(req.impact).toBe("irreversible");
    expect(req.context).toContain("本番へ反映");
  });

  it("失敗リカバリは retry/modify/abort の3択", () => {
    const n = node({ title: "何かの処理" });
    const req = buildFailureRecoveryRequest(n, "timeout");
    expect(req.options.map((o) => o.id)).toEqual(["retry", "modify", "abort"]);
    expect(req.context).toContain("timeout");
  });
});

// ルーティーンテンプレートの二重実行防止（回帰テスト）。
// 「ルーティーンであること」はページ先頭のトリガーノードから導出する（docs/design.md 3.4/3.8/3.9）。
// トリガーを持つページのメンバーはプロジェクト側エンジンから除外されなければならない
describe("ルーティーンテンプレートの除外", () => {
  it("トリガーノードを持つページのメンバーはプロジェクト側エンジンに拾われない", () => {
    const page = node({ id: "g1", kind: "goal", executor: "human" });
    // トリガーは status=done にして frontier 条件を満たし、group 除外だけが効くようにする
    const trigger = node({ id: "tr1", kind: "trigger", executor: "script", group: "g1", status: "done" });
    const tmpl = node({
      id: "t1",
      kind: "task",
      executor: "script",
      group: "g1",
      parents: ["tr1"],
      impl: { type: "script", command: "echo x" },
    });
    expect(selectAction([page, trigger, tmpl]).type).toBe("none");
  });
});
