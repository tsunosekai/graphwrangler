// discord.ts のメッセージ組み立て（純粋関数）のテスト。送信（fetch）はテストしない。
// 2026-08-08 本人指示の簡略フォーマット（1行目=種別 / 2行目=ページ名 - ノード名 / 3行目=リンク）
// に合わせて全面書き換え。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAiReplyMessage, buildTurnMessage, type NotifyTarget } from "../src/discord.js";

const USERS = [
  { email: "alice@example.com", displayName: "アリス", discordId: "111111111111111111" },
  { email: "bob@example.com" }, // discordId 未登録
];

/** 既定の通知対象（ページあり・ランなし）。テストごとに上書きして使う */
const TARGET: NotifyTarget = {
  pageTitle: "収録",
  nodeId: "n1",
  nodeTitle: "収録チェック",
};

// --- メンション3規則（従来どおり維持） ---

test("buildTurnMessage: 担当者あり + discordId 登録済み → その人だけをメンション", () => {
  const m = buildTurnMessage("alice@example.com", USERS, TARGET, null);
  assert.equal(m.content, "<@111111111111111111> あなたの番です\n収録 - 収録チェック");
  assert.deepEqual(m.allowed_mentions, { users: ["111111111111111111"] });
});

test("buildTurnMessage: メールの大文字小文字は無視して一致する", () => {
  const m = buildTurnMessage("Alice@Example.com", USERS, TARGET, null);
  assert.ok(m.content.includes("<@111111111111111111>"));
});

test("buildTurnMessage: 担当者あり + 未登録 → メンションせず名前を書く（誤爆防止で @here にしない）", () => {
  const m = buildTurnMessage("bob@example.com", USERS, TARGET, null);
  assert.equal(m.content, "bob@example.com さんの番です\n収録 - 収録チェック");
  assert.deepEqual(m.allowed_mentions, { parse: [] });
});

test("buildTurnMessage: 担当者なし（全員の番）→ @here（2026-08-07 本人指定）", () => {
  const m = buildTurnMessage(null, USERS, TARGET, null);
  assert.equal(m.content, "@here あなたの番です\n収録 - 収録チェック");
  assert.deepEqual(m.allowed_mentions, { parse: ["everyone"] });
});

// --- 2行目 subject のバリエーション ---

test("subject: pageTitle が null ならノード名だけ", () => {
  const m = buildTurnMessage(null, USERS, { ...TARGET, pageTitle: null }, null);
  assert.equal(m.content, "@here あなたの番です\n収録チェック");
});

test("subject: runTitle があれば末尾に（ラン: X）が付く", () => {
  const m = buildTurnMessage(null, USERS, { ...TARGET, runTitle: "第3回" }, null);
  assert.equal(m.content, "@here あなたの番です\n収録 - 収録チェック（ラン: 第3回）");
});

// --- 3行目リンク（publicUrl あり・なし） ---

test("link: publicUrl があれば3行目に <publicUrl>/#/n/<nodeId> が付く", () => {
  const m = buildTurnMessage(null, USERS, TARGET, "http://100.86.224.19:8770");
  assert.equal(
    m.content,
    "@here あなたの番です\n収録 - 収録チェック\nhttp://100.86.224.19:8770/#/n/n1",
  );
});

test("link: ラン経由の通知は ?run=<ランid> まで付ける（そのランの進捗ごと開かせる）", () => {
  // ページを開いた既定がテンプレート表示になったため（2026-08-08）、run を載せないと
  // リンクを踏んでも「あなたの番」の回答導線（ランのワークアイテム）に着地しない
  const m = buildTurnMessage(
    null,
    USERS,
    { ...TARGET, runTitle: "第3回", runId: "r-20260808-0003" },
    "http://example.com",
  );
  assert.ok(m.content.endsWith("\nhttp://example.com/#/n/n1?run=r-20260808-0003"));
});

test("link: publicUrl の末尾スラッシュは除去して連結する", () => {
  const m = buildTurnMessage(null, USERS, TARGET, "http://example.com/");
  assert.ok(m.content.endsWith("\nhttp://example.com/#/n/n1"));
});

test("link: publicUrl が null なら3行目ごと省略する", () => {
  const m = buildTurnMessage(null, USERS, TARGET, null);
  assert.equal(m.content.split("\n").length, 2);
});

// --- Task AI 返信通知 ---

test("buildAiReplyMessage: 担当者あり + discordId 登録済み → その人をメンション + リンク", () => {
  const m = buildAiReplyMessage("alice@example.com", USERS, TARGET, "http://example.com");
  assert.equal(
    m.content,
    "<@111111111111111111> AIが返信\n収録 - 収録チェック\nhttp://example.com/#/n/n1",
  );
  assert.deepEqual(m.allowed_mentions, { users: ["111111111111111111"] });
});

test("buildAiReplyMessage: 担当者なし → メンションなし（@here は使わない。あなたの番との重みの差）", () => {
  const m = buildAiReplyMessage(null, USERS, TARGET, null);
  assert.equal(m.content, "AIが返信\n収録 - 収録チェック");
  assert.deepEqual(m.allowed_mentions, { parse: [] });
});

test("buildAiReplyMessage: 担当者あり + 未登録 → メンションなしで種別行のみ（@here にしない）", () => {
  const m = buildAiReplyMessage("bob@example.com", USERS, TARGET, null);
  assert.equal(m.content, "AIが返信\n収録 - 収録チェック");
  assert.ok(!m.content.includes("@here"));
  assert.deepEqual(m.allowed_mentions, { parse: [] });
});
