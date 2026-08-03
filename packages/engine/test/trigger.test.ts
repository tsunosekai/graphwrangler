import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_CHECK_INTERVAL_MS,
  FIRE_GATE_MARKER,
  buildFireApprovalRequest,
  buildTriggerPrompt,
  findFireGate,
  fireBaseline,
  hasUnconsumedGo,
  isFireableTrigger,
  parseAiFireDecision,
  resolveAiCheckIntervalMs,
  shouldEvaluateAiTrigger,
  shouldFireScriptTrigger,
  type FireGateState,
} from "../src/trigger.js";
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
    kind: partial.kind ?? "trigger",
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
    created: partial.created ?? `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
  };
}

describe("isFireableTrigger", () => {
  it("kind=trigger かつ lifecycle=committed のみ対象", () => {
    expect(isFireableTrigger(node({ kind: "trigger", lifecycle: "committed" }))).toBe(true);
    expect(isFireableTrigger(node({ kind: "trigger", lifecycle: "draft" }))).toBe(false);
    expect(isFireableTrigger(node({ kind: "task", lifecycle: "committed" }))).toBe(false);
  });
});

// 1. script発火判定の流用（schedule.ts の parseSchedule/shouldCreateScheduledRunをそのまま使う）
describe("shouldFireScriptTrigger: script発火判定の流用", () => {
  it("schedule文字列が無ければnull（発火判定できない）", () => {
    expect(shouldFireScriptTrigger(null, null, new Date(), false)).toBeNull();
  });

  it("未対応の書式はnull", () => {
    expect(shouldFireScriptTrigger("every 15", null, new Date(), false)).toBeNull();
  });

  it("'every 15m'で最新ランが無ければtrue（schedule.tsのshouldCreateScheduledRunと同じ判定）", () => {
    const now = new Date("2026-01-01T00:20:00Z");
    expect(shouldFireScriptTrigger("every 15m", null, now, false)).toBe(true);
  });

  it("経過時間がN未満ならfalse", () => {
    const latestRun = { created: "2026-01-01T00:10:00Z" };
    const now = new Date("2026-01-01T00:20:00Z"); // 10分経過 < 15分
    expect(shouldFireScriptTrigger("every 15m", latestRun, now, false)).toBe(false);
  });

  it("実行中ランがあれば常にfalse（重複防止）", () => {
    const now = new Date("2026-01-01T00:20:00Z");
    expect(shouldFireScriptTrigger("every 15m", null, now, true)).toBe(false);
  });
});

// 2. aiチェック間隔判定
describe("resolveAiCheckIntervalMs / shouldEvaluateAiTrigger: aiチェック間隔判定", () => {
  it("schedule無指定は既定1時間", () => {
    expect(resolveAiCheckIntervalMs(null)).toBe(DEFAULT_AI_CHECK_INTERVAL_MS);
  });

  it("every系はそのまま間隔として使う", () => {
    expect(resolveAiCheckIntervalMs("every 30m")).toBe(30 * 60 * 1000);
  });

  it("daily/weekly等every以外は既定1時間にフォールバック（チェック間隔としては無意味なため）", () => {
    expect(resolveAiCheckIntervalMs("daily 09:00")).toBe(DEFAULT_AI_CHECK_INTERVAL_MS);
    expect(resolveAiCheckIntervalMs("nonsense")).toBe(DEFAULT_AI_CHECK_INTERVAL_MS);
  });

  it("lastCheckedAt=nullなら常にtrue（再起動後の即時チェックは許容）", () => {
    expect(shouldEvaluateAiTrigger(60_000, null, Date.now(), false)).toBe(true);
  });

  it("間隔未経過ならfalse、経過していればtrue", () => {
    const interval = 60_000;
    const last = 1_000_000;
    expect(shouldEvaluateAiTrigger(interval, last, last + 30_000, false)).toBe(false);
    expect(shouldEvaluateAiTrigger(interval, last, last + 60_000, false)).toBe(true);
  });

  it("実行中ランがあれば間隔条件を満たしていてもfalse（重複防止）", () => {
    expect(shouldEvaluateAiTrigger(1000, null, Date.now(), true)).toBe(false);
  });
});

// 3. fire/skip パース
describe("parseAiFireDecision: fire/skipパース", () => {
  it("完全一致(大文字小文字無視)", () => {
    expect(parseAiFireDecision("fire")).toBe("fire");
    expect(parseAiFireDecision("SKIP")).toBe("skip");
  });

  it("前後の空白・改行は無視する", () => {
    expect(parseAiFireDecision("  fire  \n")).toBe("fire");
  });

  it("前後に説明が付いた複数行でも、行単位で一致すれば拾う", () => {
    expect(parseAiFireDecision("検討した結果\nfire\nとします")).toBe("fire");
  });

  it("fire/skipのどちらでもない出力はnull（不正出力）", () => {
    expect(parseAiFireDecision("わかりません")).toBeNull();
    expect(parseAiFireDecision("")).toBeNull();
  });
});

// ---- 発火前承認（approval=true のトリガー） ----

function gateRequest(id: string, ts: string, answered: string | null = null): Message {
  return {
    id,
    node: "n-t",
    ts,
    author: { kind: "agent", name: "engine" },
    via: "engine",
    kind: "decision_request",
    body: `発火していいですか？ ${FIRE_GATE_MARKER}`,
    payload: null,
    ...(answered
      ? { requestStatus: "answered" as const, answeredBy: answered }
      : { requestStatus: "open" as const }),
  };
}

function gateAnswer(id: string, requestId: string, option: string | null, ts: string): Message {
  return {
    id,
    node: "n-t",
    ts,
    author: { kind: "human" },
    via: "ui",
    kind: "decision_answer",
    body: "",
    payload: { requestId, option, note: null },
  };
}

describe("buildFireApprovalRequest", () => {
  it("go/skip の2択・リクエストimpact=irreversible・question にマーカーを含む", () => {
    const req = buildFireApprovalRequest({ title: "毎週月曜9時", detail: null });
    expect(req.options.map((o) => o.id)).toEqual(["go", "skip"]);
    expect(req.impact).toBe("irreversible");
    expect(req.question).toContain(FIRE_GATE_MARKER);
    expect(req.context).toContain("毎週月曜9時");
  });
});

describe("findFireGate", () => {
  it("マーカー付きリクエストが無ければ none", () => {
    expect(findFireGate([])).toEqual({ status: "none" });
  });

  it("open なリクエストがあれば open", () => {
    expect(findFireGate([gateRequest("m-1", "2026-01-01T00:00:00Z")])).toEqual({ status: "open" });
  });

  it("回答済みなら answered + option + 回答の ts", () => {
    const msgs = [
      gateRequest("m-1", "2026-01-01T00:00:00Z", "m-2"),
      gateAnswer("m-2", "m-1", "go", "2026-01-01T00:05:00Z"),
    ];
    expect(findFireGate(msgs)).toEqual({ status: "answered", option: "go", ts: "2026-01-01T00:05:00Z" });
  });

  it("複数のゲートがあれば最新のものを見る", () => {
    const msgs = [
      gateRequest("m-1", "2026-01-01T00:00:00Z", "m-2"),
      gateAnswer("m-2", "m-1", "skip", "2026-01-01T00:05:00Z"),
      gateRequest("m-3", "2026-01-02T00:00:00Z"),
    ];
    expect(findFireGate(msgs)).toEqual({ status: "open" });
  });
});

describe("fireBaseline: skip をその回の発火とみなす", () => {
  const skip: FireGateState = { status: "answered", option: "skip", ts: "2026-01-01T09:00:00Z" };

  it("skip 回答が最新ランより新しければ skip の ts が基準になる", () => {
    expect(fireBaseline({ created: "2026-01-01T00:00:00Z" }, skip)).toEqual({
      created: "2026-01-01T09:00:00Z",
    });
  });

  it("最新ランの方が新しければランが基準のまま", () => {
    expect(fireBaseline({ created: "2026-01-02T00:00:00Z" }, skip)).toEqual({
      created: "2026-01-02T00:00:00Z",
    });
  });

  it("ランが無くても skip があれば基準になる（every 系の再確認スパム防止）", () => {
    expect(fireBaseline(null, skip)).toEqual({ created: "2026-01-01T09:00:00Z" });
  });

  it("gate が none/go なら最新ランのまま", () => {
    expect(fireBaseline(null, { status: "none" })).toBeNull();
    const go: FireGateState = { status: "answered", option: "go", ts: "2026-01-01T09:00:00Z" };
    expect(fireBaseline({ created: "2026-01-01T00:00:00Z" }, go)).toEqual({
      created: "2026-01-01T00:00:00Z",
    });
  });
});

describe("hasUnconsumedGo: go 回答は発火1回で消費される", () => {
  it("go 回答が最新ランより新しければ未消費（発火してよい）", () => {
    const go: FireGateState = { status: "answered", option: "go", ts: "2026-01-01T09:00:00Z" };
    expect(hasUnconsumedGo(go, { created: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(hasUnconsumedGo(go, null)).toBe(true);
  });

  it("発火後（最新ランが回答より新しい）は消費済み＝次の周期で改めて承認を求める", () => {
    const go: FireGateState = { status: "answered", option: "go", ts: "2026-01-01T09:00:00Z" };
    expect(hasUnconsumedGo(go, { created: "2026-01-01T09:01:00Z" })).toBe(false);
  });

  it("skip/未回答/未発行は常に false", () => {
    expect(hasUnconsumedGo({ status: "none" }, null)).toBe(false);
    expect(hasUnconsumedGo({ status: "open" }, null)).toBe(false);
    expect(hasUnconsumedGo({ status: "answered", option: "skip", ts: "2026-01-01T09:00:00Z" }, null)).toBe(false);
  });
});

describe("buildTriggerPrompt", () => {
  it("title/detail/impl(doc全文)と現在時刻、fire/skip指示を含む", () => {
    const n = node({
      title: "毎朝の在庫確認",
      detail: "在庫が閾値を割ったら発火",
      impl: { type: "doc", text: "在庫APIを見て50個未満ならfire" },
    });
    const now = new Date("2026-01-01T09:00:00Z");
    const prompt = buildTriggerPrompt(n, now);
    expect(prompt).toContain("毎朝の在庫確認");
    expect(prompt).toContain("在庫が閾値を割ったら発火");
    expect(prompt).toContain("在庫APIを見て50個未満ならfire");
    expect(prompt).toContain(now.toISOString());
    expect(prompt).toContain("fire、見送るなら skip");
  });

  it("impl=null(会話段)ならdoc全文は含めない", () => {
    const n = node({ title: "起点", detail: null, impl: null });
    const prompt = buildTriggerPrompt(n, new Date("2026-01-01T00:00:00Z"));
    expect(prompt).not.toContain("発火条件");
  });
});
