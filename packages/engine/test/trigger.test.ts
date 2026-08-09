import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_CHECK_INTERVAL_MS,
  FIRE_GATE_MARKER,
  buildFireApprovalRequest,
  buildTriggerPrompt,
  describeFireEvent,
  findFireGate,
  findLatestFireEvent,
  fireBaseline,
  hasUnconsumedGo,
  isDetectScriptTrigger,
  isFireableTrigger,
  parseAiFireDecision,
  parseDetectEmitLines,
  resolveAiCheckIntervalMs,
  shouldEvaluateAiTrigger,
  shouldFireScriptTrigger,
  shouldRunDetectScript,
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
    // 左レールの整理棚と並び順（2026-08-05）。エンジンは見ないが型のため埋める
    folder: partial.folder ?? null,
    folderSection: partial.folderSection ?? null,
    order: partial.order ?? null,
    kind: partial.kind ?? "trigger",
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
    outputs: partial.outputs ?? null,
    parentOptions: partial.parentOptions ?? {},
    createdBy: partial.createdBy ?? null,
    assignee: partial.assignee ?? null,
    members: partial.members ?? [],
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
    expect(shouldFireScriptTrigger(null, null, new Date())).toBeNull();
  });

  it("未対応の書式はnull", () => {
    expect(shouldFireScriptTrigger("every 15", null, new Date())).toBeNull();
  });

  it("'every 15m'で最新ランが無ければtrue（schedule.tsのshouldCreateScheduledRunと同じ判定）", () => {
    const now = new Date("2026-01-01T00:20:00Z");
    expect(shouldFireScriptTrigger("every 15m", null, now)).toBe(true);
  });

  it("経過時間がN未満ならfalse", () => {
    const latestRun = { created: "2026-01-01T00:10:00Z" };
    const now = new Date("2026-01-01T00:20:00Z"); // 10分経過 < 15分
    expect(shouldFireScriptTrigger("every 15m", latestRun, now)).toBe(false);
  });

  it("実行中ランがあっても定刻ぶんは発火する（2026-08-08 修正。旧仕様では常にfalseだった）", () => {
    const now = new Date("2026-01-01T00:20:00Z");
    expect(shouldFireScriptTrigger("every 15m", null, now)).toBe(true);
  });
});

// 1.5 検知スクリプト（impl.command のある script トリガー。docs/design.md 3.8/3.15）
describe("isDetectScriptTrigger", () => {
  it("executor=script かつ impl.type=script（command あり）のみ検知スクリプト", () => {
    expect(isDetectScriptTrigger(node({ executor: "script", impl: { type: "script", command: "node d.mjs" } }))).toBe(true);
    expect(isDetectScriptTrigger(node({ executor: "script", impl: null }))).toBe(false);
    expect(isDetectScriptTrigger(node({ executor: "script", impl: { type: "doc", text: "手順" } }))).toBe(false);
    expect(isDetectScriptTrigger(node({ executor: "ai", impl: { type: "script", command: "node d.mjs" } }))).toBe(false);
  });
});

describe("shouldRunDetectScript: schedule をチェック間隔として使う", () => {
  it("schedule無指定は既定1時間の間隔チェック", () => {
    const base = 1_000_000;
    expect(shouldRunDetectScript(null, null, new Date(base))).toBe(true);
    expect(shouldRunDetectScript(null, base, new Date(base + DEFAULT_AI_CHECK_INTERVAL_MS - 1))).toBe(false);
    expect(shouldRunDetectScript(null, base, new Date(base + DEFAULT_AI_CHECK_INTERVAL_MS))).toBe(true);
  });

  it("every 系はその間隔", () => {
    const base = 1_000_000;
    expect(shouldRunDetectScript("every 5m", base, new Date(base + 4 * 60_000))).toBe(false);
    expect(shouldRunDetectScript("every 5m", base, new Date(base + 5 * 60_000))).toBe(true);
  });

  it("daily は shouldCreateScheduledRun を lastCheckedAt 基準で流用（同じ暦日にチェック済みなら false）", () => {
    const now = new Date("2026-01-02T10:00:00");
    expect(shouldRunDetectScript("daily 09:00", null, now)).toBe(true);
    // 今日すでにチェック済み
    expect(shouldRunDetectScript("daily 09:00", new Date("2026-01-02T09:00:30").getTime(), now)).toBe(false);
    // 前日のチェックなら今日ぶんを実行する
    expect(shouldRunDetectScript("daily 09:00", new Date("2026-01-01T09:00:30").getTime(), now)).toBe(true);
    // 目標時刻前は実行しない
    expect(shouldRunDetectScript("daily 09:00", null, new Date("2026-01-02T08:00:00"))).toBe(false);
  });

  it("未対応の書式は既定1時間へフォールバック", () => {
    expect(shouldRunDetectScript("nonsense", null, new Date())).toBe(true);
  });
});

describe("parseDetectEmitLines: emit 行のパース", () => {
  it("'{' で始まる各行を {context, title} として読む（1行=1ラン）", () => {
    const out = '{"context":{"remix":"RMX-1"},"title":"作品A"}\n{"context":{"remix":"RMX-2"}}';
    const r = parseDetectEmitLines(out);
    expect(r.events).toEqual([
      { context: { remix: "RMX-1" }, title: "作品A" },
      { context: { remix: "RMX-2" }, title: null },
    ]);
    expect(r.invalidLines).toEqual([]);
  });

  it("'{' 以外で始まる行はログとして無視する", () => {
    const r = parseDetectEmitLines("checking...\n件数: 0\n");
    expect(r.events).toEqual([]);
    expect(r.invalidLines).toEqual([]);
  });

  it("空出力は発火なし", () => {
    expect(parseDetectEmitLines("")).toEqual({ events: [], invalidLines: [] });
  });

  it("'{' 始まりでパース不能・形が不正な行は invalidLines に入る", () => {
    const r = parseDetectEmitLines('{壊れてる\n{"context":"not-a-record"}\n{"title":123}');
    expect(r.events).toEqual([]);
    expect(r.invalidLines).toHaveLength(3);
  });

  it("context も title も無い {} は空イベントとして発火できる（値は下流が確定させる設計もある）", () => {
    expect(parseDetectEmitLines("{}").events).toEqual([{ context: {}, title: null }]);
  });

  it("context の数値・真偽値は文字列化する", () => {
    const r = parseDetectEmitLines('{"context":{"count":3}}');
    expect(r.events).toEqual([{ context: { count: "3" }, title: null }]);
  });
});

describe("describeFireEvent", () => {
  it("title と context を人間向けの1行にする", () => {
    expect(describeFireEvent({ context: { a: "1" }, title: "作品A" })).toBe("作品A（a=1）");
    expect(describeFireEvent({ context: {}, title: "作品A" })).toBe("作品A");
    expect(describeFireEvent({ context: { a: "1", b: "2" }, title: null })).toBe("a=1, b=2");
    expect(describeFireEvent({ context: {}, title: null })).toBe("(内容なし)");
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
    expect(shouldEvaluateAiTrigger(60_000, null, Date.now())).toBe(true);
  });

  it("間隔未経過ならfalse、経過していればtrue", () => {
    const interval = 60_000;
    const last = 1_000_000;
    expect(shouldEvaluateAiTrigger(interval, last, last + 30_000)).toBe(false);
    expect(shouldEvaluateAiTrigger(interval, last, last + 60_000)).toBe(true);
  });

  it("実行中ランの有無は判定に影響しない（2026-08-08 修正。旧仕様ではfalseだった）", () => {
    expect(shouldEvaluateAiTrigger(1000, null, Date.now())).toBe(true);
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
    body: `開始していいですか？ ${FIRE_GATE_MARKER}`,
    runId: null,
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
    runId: null,
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

  it("検知イベントがあれば内容を文面に含める（機械可読な本体は payload.fireEvent 側）", () => {
    const req = buildFireApprovalRequest(
      { title: "新着検知", detail: null },
      { context: { remix: "RMX-1" }, title: "作品A" },
    );
    expect(req.context).toContain("検知イベント");
    expect(req.context).toContain("作品A");
    expect(req.context).toContain("remix=RMX-1");
  });
});

describe("findLatestFireEvent: 承認カードに対応する検知イベントの復元", () => {
  function fireEventMessage(id: string, ts: string, fireEvent: unknown): Message {
    return {
      id,
      node: "n-t",
      ts,
      author: { kind: "agent", name: "engine" },
      via: "engine",
      kind: "status",
      body: "検知イベント: …",
      runId: null,
      payload: { fireEvent },
    };
  }

  it("payload.fireEvent 付きの最新メッセージから復元する", () => {
    const msgs = [
      fireEventMessage("m-1", "2026-01-01T00:00:00Z", { context: { a: "1" }, title: "古い" }),
      fireEventMessage("m-2", "2026-01-02T00:00:00Z", { context: { a: "2" }, title: "新しい" }),
    ];
    expect(findLatestFireEvent(msgs, null)).toEqual({ context: { a: "2" }, title: "新しい" });
  });

  it("最新ラン以前の ts のものは消費済みとみなして使わない", () => {
    const msgs = [fireEventMessage("m-1", "2026-01-01T00:00:00Z", { context: { a: "1" }, title: null })];
    expect(findLatestFireEvent(msgs, { created: "2026-01-01T01:00:00Z" })).toBeNull();
    expect(findLatestFireEvent(msgs, { created: "2026-01-01T00:00:00Z" })).toBeNull(); // 同時刻も消費済み
  });

  it("fireEvent が無ければ null。形が壊れていても null", () => {
    expect(findLatestFireEvent([], null)).toBeNull();
    const broken = [fireEventMessage("m-1", "2026-01-01T00:00:00Z", { context: [1, 2] })];
    expect(findLatestFireEvent(broken, null)).toBeNull();
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

  it("outputs 宣言があれば ##gw マーカーで context を出せる指示を含める（3.15）", () => {
    const n = node({
      title: "新着検知",
      outputs: [{ name: "remix", label: "リミックスID", example: "RMX-0231" }],
    });
    const prompt = buildTriggerPrompt(n, new Date("2026-01-01T00:00:00Z"));
    expect(prompt).toContain("##gw");
    expect(prompt).toContain("remix");
    expect(prompt).toContain("リミックスID");
    expect(prompt).toContain("RMX-0231");
  });

  it("outputs が無ければ ##gw の指示は含めない", () => {
    const prompt = buildTriggerPrompt(node({ title: "起点" }), new Date("2026-01-01T00:00:00Z"));
    expect(prompt).not.toContain("##gw");
  });
});
