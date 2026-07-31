// thread_ai.ts の純関数（トリガー判定・プロンプト組み立て）のユニットテスト。
// 実際の spawn/claude起動やAPI呼び出しは対象外（機能1の実サーバ検証は統括側で行う）。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThreadReplyPrompt, shouldTriggerThreadAi } from "../src/thread_ai.js";

test("人間の say かつ open な判断リクエストが無ければトリガーする", () => {
  assert.equal(
    shouldTriggerThreadAi({ kind: "say", actor: { kind: "human" }, pendingRequest: null }),
    true,
  );
});

test("open な判断リクエストがあるノードはトリガーしない（/answer のラリーに任せる）", () => {
  assert.equal(
    shouldTriggerThreadAi({ kind: "say", actor: { kind: "human" }, pendingRequest: "m1" }),
    false,
  );
});

test("kind=status/artifact など say 以外はトリガーしない", () => {
  assert.equal(
    shouldTriggerThreadAi({ kind: "status", actor: { kind: "human" }, pendingRequest: null }),
    false,
  );
});

test("エンジン等（actor.kind !== human）の投稿はトリガーしない（無限ループ防止）", () => {
  assert.equal(
    shouldTriggerThreadAi({ kind: "say", actor: { kind: "agent" }, pendingRequest: null }),
    false,
  );
  assert.equal(
    shouldTriggerThreadAi({ kind: "say", actor: { kind: "system" }, pendingRequest: null }),
    false,
  );
});

test("buildThreadReplyPrompt はノード文脈・履歴・新しい発言を含める", () => {
  const prompt = buildThreadReplyPrompt({
    node: {
      title: "設計を詰める",
      detail: "M4のUI設計",
      kind: "task",
      executor: "ai",
      status: "pending",
      impl: { type: "doc" },
    },
    parentTitles: ["親タスク"],
    pageTitle: "プロジェクトX",
    history: [
      { kind: "say", body: "前回の話" },
      { kind: "decision_request", body: "どっちにする？" },
    ],
    newMessage: "この方針で進めていい？",
  });

  assert.match(prompt, /あなたは Wrangler AI。タスクノードのスレッドで相談に乗る相棒/);
  assert.match(prompt, /ノード: 設計を詰める/);
  assert.match(prompt, /詳細: M4のUI設計/);
  assert.match(prompt, /種別\(kind\): task/);
  assert.match(prompt, /実行者\(executor\): ai/);
  assert.match(prompt, /状態\(status\): pending/);
  assert.match(prompt, /実装\(impl\): あり（doc）/);
  assert.match(prompt, /親ノード: 親タスク/);
  assert.match(prompt, /ページ: プロジェクトX/);
  assert.match(prompt, /say: 前回の話/);
  assert.match(prompt, /decision_request: どっちにする？/);
  assert.match(prompt, /人間: この方針で進めていい？/);
});

test("buildThreadReplyPrompt は履歴を最大20件に切り詰める", () => {
  const history = Array.from({ length: 25 }, (_, i) => ({ kind: "say", body: `msg${i}` }));
  const prompt = buildThreadReplyPrompt({
    node: { title: "t", detail: null, kind: "task", executor: "human", status: "pending", impl: null },
    parentTitles: [],
    pageTitle: null,
    history,
    newMessage: "new",
  });

  // 直近20件（msg5〜msg24）だけが含まれ、切り捨てられた古いもの（msg0〜msg4）は含まれない
  assert.match(prompt, /msg24/);
  assert.match(prompt, /msg5/);
  assert.doesNotMatch(prompt, /msg4\b/);
  assert.doesNotMatch(prompt, /msg0\b/);
});
