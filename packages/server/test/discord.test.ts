// discord.ts のメッセージ組み立て（純粋関数）のテスト。送信（fetch）はテストしない。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAiReplyMessage, buildTurnMessage } from "../src/discord.js";

const USERS = [
  { email: "alice@example.com", displayName: "アリス", discordId: "111111111111111111" },
  { email: "bob@example.com" }, // discordId 未登録
];

test("buildTurnMessage: 担当者あり + discordId 登録済み → その人だけをメンション", () => {
  const m = buildTurnMessage("alice@example.com", USERS, "収録チェック");
  assert.equal(m.content, "<@111111111111111111> あなたの番: 収録チェック");
  assert.deepEqual(m.allowed_mentions, { users: ["111111111111111111"] });
});

test("buildTurnMessage: メールの大文字小文字は無視して一致する", () => {
  const m = buildTurnMessage("Alice@Example.com", USERS, "t");
  assert.ok(m.content.includes("<@111111111111111111>"));
});

test("buildTurnMessage: 担当者あり + 未登録 → メンションせず名前を書く（誤爆防止で @here にしない）", () => {
  const m = buildTurnMessage("bob@example.com", USERS, "台本確認");
  assert.equal(m.content, "bob@example.com さんの番: 台本確認");
  assert.deepEqual(m.allowed_mentions, { parse: [] });
});

test("buildTurnMessage: 担当者なし（全員の番）→ @here（2026-08-07 本人指定）", () => {
  const m = buildTurnMessage(null, USERS, "発火していいですか？");
  assert.equal(m.content, "@here あなたの番: 発火していいですか？");
  assert.deepEqual(m.allowed_mentions, { parse: ["everyone"] });
});

test("buildTurnMessage: extra は2行目に付く（判断リクエストの質問の引用など）", () => {
  const m = buildTurnMessage(null, USERS, "タイトル", "> 質問文");
  assert.equal(m.content, "@here あなたの番: タイトル\n> 質問文");
});

test("buildAiReplyMessage: 担当者あり + discordId 登録済み → その人をメンション", () => {
  const m = buildAiReplyMessage("alice@example.com", USERS, "収録チェック", "了解です");
  assert.equal(m.content, "<@111111111111111111> Task AI が返信: 収録チェック\n> 了解です");
  assert.deepEqual(m.allowed_mentions, { users: ["111111111111111111"] });
});

test("buildAiReplyMessage: 担当者なし → メンションなし（@here は使わない。あなたの番との重みの差）", () => {
  const m = buildAiReplyMessage(null, USERS, "台本確認", "書きました");
  assert.equal(m.content, "Task AI が返信: 台本確認\n> 書きました");
  assert.deepEqual(m.allowed_mentions, { parse: [] });
});

test("buildAiReplyMessage: snippet が空なら引用行を付けない", () => {
  const m = buildAiReplyMessage(null, USERS, "t", "");
  assert.equal(m.content, "Task AI が返信: t");
});
