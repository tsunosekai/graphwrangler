// discord.ts のメッセージ組み立て（純粋関数）のテスト。送信（fetch）はテストしない。
// 2026-08-11 全面改訂: 宛先が assignee 1本から「関係者」（recipients.ts）へ変わり、
// ノードURLが必須になった（URL が作れなければ null = 送らない）。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTurnMessage,
  clearDuplicateGuard,
  mentionOf,
  notifyTurn,
  type NotifyTarget,
  type NotifyUser,
} from "../src/discord.js";

const ALICE: NotifyUser = {
  email: "alice@example.com",
  displayName: "アリス",
  discordId: "111111111111111111",
};
const BOB: NotifyUser = { email: "bob@example.com", displayName: "ボブ" }; // discordId 未登録
const CAROL: NotifyUser = {
  email: "carol@example.com",
  displayName: "キャロル",
  discordId: "222222222222222222",
};

/** 既定の通知対象（ページあり・ランなし）。テストごとに上書きして使う */
const TARGET: NotifyTarget = {
  pageTitle: "収録",
  nodeId: "n1",
  nodeTitle: "収録チェック",
};

const URL = "http://example.com";

// --- メンションの組み立て（宛先が複数になった 2026-08-11 以降の中心） ---

test("mentionOf: discordId 登録済みは <@id> で実際に鳴らす", () => {
  const m = mentionOf([ALICE]);
  assert.equal(m.text, "<@111111111111111111>");
  assert.deepEqual(m.allowed, { users: ["111111111111111111"] });
});

test("mentionOf: 複数の関係者を並べて全員鳴らす", () => {
  const m = mentionOf([ALICE, CAROL]);
  assert.equal(m.text, "<@111111111111111111> <@222222222222222222>");
  assert.deepEqual(m.allowed, { users: ["111111111111111111", "222222222222222222"] });
});

test("mentionOf: 未登録の人は名前で書くだけ（鳴らないが誰宛かは分かる）", () => {
  const m = mentionOf([ALICE, BOB]);
  assert.equal(m.text, "<@111111111111111111> ボブさん");
  // 鳴らすのは登録済みの1人だけ。未登録者のぶんで @here に格上げしない
  assert.deepEqual(m.allowed, { users: ["111111111111111111"] });
});

test("mentionOf: 全員未登録ならメンションは一切鳴らさない（誤爆防止）", () => {
  const m = mentionOf([BOB]);
  assert.equal(m.text, "ボブさん");
  assert.deepEqual(m.allowed, { parse: [] });
});

test("mentionOf: 表示名が無ければメールで書く", () => {
  const m = mentionOf([{ email: "dave@example.com" }]);
  assert.equal(m.text, "dave@example.comさん");
});

test("mentionOf: 宛先が1人も解決できなかったときだけ @here（本当の「全員の番」）", () => {
  const m = mentionOf([]);
  assert.equal(m.text, "@here");
  assert.deepEqual(m.allowed, { parse: ["everyone"] });
});

// --- 3行の本文 ---

test("buildTurnMessage: メンション + ページ名/ノード名 + URL の3行", () => {
  const m = buildTurnMessage([ALICE], TARGET, URL);
  assert.equal(
    m?.content,
    "<@111111111111111111> あなたの番です\n収録 - 収録チェック\nhttp://example.com/#/n/n1",
  );
  assert.deepEqual(m?.allowed_mentions, { users: ["111111111111111111"] });
});

test("subject: pageTitle が null ならノード名だけ", () => {
  const m = buildTurnMessage([], { ...TARGET, pageTitle: null }, URL);
  assert.equal(m?.content.split("\n")[1], "収録チェック");
});

test("subject: runTitle があれば末尾に（ラン: X）が付く", () => {
  const m = buildTurnMessage([], { ...TARGET, runTitle: "第3回" }, URL);
  assert.equal(m?.content.split("\n")[1], "収録 - 収録チェック（ラン: 第3回）");
});

// --- リンク（2026-08-11 必須化） ---

test("link: ラン経由の通知は #/r/<ランid>/n/<ノードid>（そのランの進捗ごと開かせる）", () => {
  // ページを開いた既定がテンプレート表示になったため（2026-08-08）、ランを載せないと
  // リンクを踏んでも「あなたの番」の回答導線（ランのワークアイテム）に着地しない
  const m = buildTurnMessage([], { ...TARGET, runTitle: "第3回", runId: "r-20260808-0003" }, URL);
  assert.ok(m?.content.endsWith("\nhttp://example.com/#/r/r-20260808-0003/n/n1"));
});

test("link: publicUrl の末尾スラッシュは除去して連結する", () => {
  const m = buildTurnMessage([], TARGET, "http://example.com/");
  assert.ok(m?.content.endsWith("\nhttp://example.com/#/n/n1"));
});

test("link: publicUrl が無ければ null を返す＝通知そのものを出さない（URL 必須化）", () => {
  // 「何の話か分からないからノードURLは絶対にのせる」（2026-08-11 本人要望）。
  // 3行目を省いて鳴らすのではなく、鳴らさないほうを選ぶ
  assert.equal(buildTurnMessage([ALICE], TARGET, null), null);
  assert.equal(buildTurnMessage([ALICE], TARGET, ""), null);
});

// --- 同一本文の間引き（2026-08-11。retry ループ等で同じ通知が連投されるのを止める） ---

test("notifyTurn: まったく同じ本文の連投は2通目以降を間引く", async () => {
  clearDuplicateGuard();
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body).content);
    return new Response("", { status: 204 });
  }) as unknown as typeof fetch;
  try {
    const cfg = { discordEnabled: true, discordWebhookUrl: "https://hook", publicUrl: URL };
    notifyTurn(cfg, [ALICE], TARGET);
    notifyTurn(cfg, [ALICE], TARGET);
    // 別のノード＝別の本文なので通る（「同じノードは N 分に1回」ではないことの担保）
    notifyTurn(cfg, [ALICE], { ...TARGET, nodeId: "n2", nodeTitle: "別の用件" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 2);
    assert.ok(sent[1].includes("別の用件"));
  } finally {
    globalThis.fetch = realFetch;
    clearDuplicateGuard();
  }
});
