import { describe, expect, it } from "vitest";
import {
  MAX_AUTO_RETRIES,
  autonomyPromptLines,
  buildAiQuestionRequest,
  buildThreadContextLines,
  parseAiQuestion,
  shouldAutoRetry,
} from "../src/ask.js";
import { runGateMarker } from "../src/approval.js";
import { buildAiPrompt } from "../src/executors/claude.js";
import type { DecisionRequest, Message, Node } from "../src/types.js";

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
    // 左レールの整理棚と並び順（2026-08-05）。エンジンは見ないが型のため埋める
    folder: partial.folder ?? null,
    order: partial.order ?? null,
    kind: partial.kind ?? "task",
    executor: partial.executor ?? "ai",
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
    created: partial.created ?? `2026-01-01T00:00:${String(nodeSeq).padStart(2, "0")}Z`,
  };
}

let msgSeq = 0;
function message(partial: Partial<Message>): Message {
  msgSeq += 1;
  return {
    id: partial.id ?? `m-${msgSeq}`,
    node: partial.node ?? "n-1",
    ts: partial.ts ?? `2026-01-01T00:01:${String(msgSeq).padStart(2, "0")}Z`,
    author: partial.author ?? { kind: "agent", name: "executor:claude" },
    via: partial.via ?? "engine",
    kind: partial.kind ?? "say",
    body: partial.body ?? "",
    payload: partial.payload ?? null,
    ...(partial.requestStatus !== undefined ? { requestStatus: partial.requestStatus } : {}),
    ...(partial.answeredBy !== undefined ? { answeredBy: partial.answeredBy } : {}),
  };
}

describe("parseAiQuestion", () => {
  it("QUESTION 行から質問・選択肢・補足を取り出す", () => {
    const q = parseAiQuestion(
      [
        "QUESTION: 文体はどちらにしますか？",
        "OPTION: です・ます調",
        "OPTION: だ・である調",
        "対象読者が社内なので砕けた文体もありです。",
      ].join("\n"),
    );
    expect(q).not.toBeNull();
    expect(q!.question).toBe("文体はどちらにしますか？");
    expect(q!.options).toEqual(["です・ます調", "だ・である調"]);
    expect(q!.context).toBe("対象読者が社内なので砕けた文体もありです。");
  });

  it("全角コロン・小文字・前後の空白も受け付ける", () => {
    const q = parseAiQuestion("\n  question： どうしますか？\noption： A\n");
    expect(q).not.toBeNull();
    expect(q!.question).toBe("どうしますか？");
    expect(q!.options).toEqual(["A"]);
  });

  it("通常の作業成果は null", () => {
    expect(parseAiQuestion("作業が完了しました。結果は…")).toBeNull();
    expect(parseAiQuestion("")).toBeNull();
    // QUESTION が1行目でなければ質問扱いしない（成果テキスト中の引用を誤検知しない）
    expect(parseAiQuestion("結果:\nQUESTION: これは質問ではない")).toBeNull();
  });
});

describe("buildAiQuestionRequest", () => {
  it("AI選択肢を ai:N で並べ、末尾に必ず中止(abort)を付ける", () => {
    const req = buildAiQuestionRequest(node({ title: "記事を書く" }), {
      question: "文体は？",
      options: ["です・ます", "だ・である"],
      context: "",
    });
    expect(req.options.map((o) => o.id)).toEqual(["ai:1", "ai:2", "abort"]);
    expect(req.question).toBe("文体は？");
    expect(req.impact).toBe("safe");
  });

  it("選択肢が無ければ「おまかせで続行」を補って2択以上にする", () => {
    const req = buildAiQuestionRequest(node(), { question: "Q", options: [], context: "" });
    expect(req.options.map((o) => o.id)).toEqual(["ai:proceed", "abort"]);
  });

  it("選択肢は最大3個+中止で4個に収める（スキーマの max 4）", () => {
    const req = buildAiQuestionRequest(node(), {
      question: "Q",
      options: ["a", "b", "c", "d", "e"],
      context: "",
    });
    expect(req.options).toHaveLength(4);
    expect(req.options[3].id).toBe("abort");
  });

  it("runId を渡すと question にランのマーカーが入る（approval.ts の findRunGate が拾える）", () => {
    const req = buildAiQuestionRequest(node(), { question: "Q", options: [], context: "" }, "r-9");
    expect(req.question).toContain(runGateMarker("r-9"));
  });
});

describe("shouldAutoRetry", () => {
  it("high のみ・上限まで", () => {
    expect(shouldAutoRetry("high", 0)).toBe(true);
    expect(shouldAutoRetry("high", MAX_AUTO_RETRIES - 1)).toBe(true);
    expect(shouldAutoRetry("high", MAX_AUTO_RETRIES)).toBe(false);
    expect(shouldAutoRetry("normal", 0)).toBe(false);
    expect(shouldAutoRetry("low", 0)).toBe(false);
  });
});

describe("autonomyPromptLines / buildAiPrompt", () => {
  it("high は質問規約なし・聞かずに進む指示あり", () => {
    const lines = autonomyPromptLines("high").join("\n");
    expect(lines).not.toContain("QUESTION:");
    expect(lines).toContain("人間に判断を仰がず");
  });

  it("normal/low は QUESTION 規約を含み、low は質問に倒す指示", () => {
    expect(autonomyPromptLines("normal").join("\n")).toContain("QUESTION:");
    const low = autonomyPromptLines("low").join("\n");
    expect(low).toContain("QUESTION:");
    expect(low).toContain("迷ったら質問");
  });

  it("buildAiPrompt が autonomy とスレッド経緯を反映する", () => {
    const base = { node: node({ title: "t" }), goal: null, parentSayMessages: [] };
    const high = buildAiPrompt({ ...base, autonomy: "high" });
    expect(high.prompt).not.toContain("QUESTION:");
    const normal = buildAiPrompt({ ...base, autonomy: "normal" });
    expect(normal.prompt).toContain("QUESTION:");
    const withCtx = buildAiPrompt({ ...base, threadContext: ["人間の回答: だ・である調"] });
    expect(withCtx.prompt).toContain("これまでの経緯");
    expect(withCtx.prompt).toContain("だ・である調");
    expect(withCtx.sources).toContain("スレッドの経緯");
  });
});

describe("buildThreadContextLines", () => {
  const request: DecisionRequest = {
    context: "c",
    question: `文体は？ ${runGateMarker("r-1")}`,
    options: [
      { id: "ai:1", label: "です・ます", then: "続行" },
      { id: "abort", label: "中止", then: "中止" },
    ],
    impact: "safe",
    undo: null,
  };

  it("回答済みのAI質問をQ&Aとして拾い、ランのマーカーを外す", () => {
    const messages = [
      message({ id: "req-1", kind: "decision_request", body: "文体は？", payload: { request }, requestStatus: "answered" }),
      message({
        kind: "decision_answer",
        payload: { requestId: "req-1", option: "ai:1", note: "少し砕けてよい" },
      }),
    ];
    const lines = buildThreadContextLines(messages);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("文体は？");
    expect(lines[0]).not.toContain("[ラン");
    expect(lines[0]).toContain("です・ます");
    expect(lines[0]).toContain("少し砕けてよい");
  });

  it("未回答の質問・AI以外のリクエスト（承認ゲート等）は拾わない", () => {
    const gateRequest: DecisionRequest = { ...request, options: [
      { id: "go", label: "実行して", then: "実行" },
      { id: "skip", label: "やめる", then: "中止" },
    ] };
    const messages = [
      message({ id: "req-2", kind: "decision_request", body: "q", payload: { request }, requestStatus: "open" }),
      message({ id: "req-3", kind: "decision_request", body: "q", payload: { request: gateRequest }, requestStatus: "answered" }),
      message({ kind: "decision_answer", payload: { requestId: "req-3", option: "go", note: null } }),
    ];
    expect(buildThreadContextLines(messages)).toHaveLength(0);
  });

  it("末尾が実行失敗の status なら失敗文脈を足す（成功で上書きされていれば足さない）", () => {
    const fail = [message({ kind: "status", body: "実行失敗（自律リトライ 1/2）: timeout" })];
    expect(buildThreadContextLines(fail).join("\n")).toContain("timeout");
    const recovered = [
      message({ kind: "status", body: "実行失敗: x" }),
      message({ kind: "status", body: "実行成功: ok" }),
    ];
    expect(buildThreadContextLines(recovered)).toHaveLength(0);
  });
});
