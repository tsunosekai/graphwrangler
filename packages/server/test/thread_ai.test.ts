// thread_ai.ts の純関数（トリガー判定・プロンプト組み立て）のユニットテスト。
// 実際の spawn/claude起動やAPI呼び出しは対象外（機能1の実サーバ検証は統括側で行う）。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildThreadReplyPrompt,
  shouldTriggerThreadAi,
  threadAiNodeContext,
} from "../src/thread_ai.js";
import { sanitizeModelOverride } from "../src/chat_cli.js";

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

  assert.match(prompt, /あなたは Task AI。タスクノードのスレッドで相談に乗る担当/);
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

test("threadAiNodeContext は doc impl の path をプロンプト文脈へ渡す（AI が Read で読むため）", () => {
  const base = { title: "t", detail: null, kind: "task", executor: "ai", status: "pending" } as const;
  const ctx = threadAiNodeContext({ ...base, impl: { type: "doc", path: "docs/手順.md" } });
  assert.deepEqual(ctx.impl, { type: "doc", path: "docs/手順.md" });

  // プロンプトにも path が出る（path 分岐が生きていることの確認）
  const prompt = buildThreadReplyPrompt({
    node: ctx,
    parentTitles: [],
    pageTitle: null,
    history: [],
    newMessage: "手順どおり？",
  });
  assert.match(prompt, /実装\(impl\): あり（doc, path: docs\/手順\.md）/);
});

test("threadAiNodeContext は script impl の command 等を渡さない（有無と種類だけ）", () => {
  const base = { title: "t", detail: null, kind: "task", executor: "ai", status: "pending" } as const;
  const ctx = threadAiNodeContext({ ...base, impl: { type: "script", command: "rm -rf /" } });
  assert.deepEqual(ctx.impl, { type: "script", path: null });
  assert.equal(threadAiNodeContext({ ...base, impl: null }).impl, null);
});

test("ノードの aiModel はサニタイズを通す（空白・フラグ混入は既定モデルへフォールバック）", () => {
  // Windows は shell:true 起動＝空白で argv が割れるため、フラグを仕込んだモデル名は弾く
  assert.equal(sanitizeModelOverride("sonnet --dangerously-skip-permissions"), null);
  assert.equal(sanitizeModelOverride("--effort"), null);
  assert.equal(sanitizeModelOverride(null), null);
  // 正常なモデル名はそのまま通る
  assert.equal(sanitizeModelOverride("claude-sonnet-4-5"), "claude-sonnet-4-5");
  assert.equal(sanitizeModelOverride("opus"), "opus");
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

// --- QUESTION プロトコル（2026-08-11。会話の Task AI も engine と同じ規約で人間を呼ぶ） ---

test("buildThreadReplyPrompt は QUESTION プロトコルと『乱発するな』の歯止めを含める", () => {
  // 「返信のたびに Discord が鳴る」旧仕様を廃止した代わりの経路なので、規約だけ入れて
  // 歯止めを入れないと、軽い聞き返しのたびに人間を呼び出して元の木阿弥になる
  const prompt = buildThreadReplyPrompt({
    node: { title: "t", detail: null, kind: "task", executor: "ai", status: "pending", impl: null },
    parentTitles: [],
    pageTitle: null,
    history: [],
    newMessage: "どう思う？",
  });
  assert.match(prompt, /QUESTION: <人間への質問（1行）>/);
  assert.match(prompt, /\*\*人間を呼び出す\*\*合図/);
  assert.match(prompt, /人間が決めないとこの先へ進めない/);
});
