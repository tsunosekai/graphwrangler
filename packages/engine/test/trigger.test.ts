import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_CHECK_INTERVAL_MS,
  buildTriggerPrompt,
  isFireableTrigger,
  parseAiFireDecision,
  resolveAiCheckIntervalMs,
  shouldEvaluateAiTrigger,
  shouldFireScriptTrigger,
} from "../src/trigger.js";
import type { Node } from "../src/types.js";

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
    impact: partial.impact ?? "safe",
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
