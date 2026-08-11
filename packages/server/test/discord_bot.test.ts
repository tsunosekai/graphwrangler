// 業務連絡（指定チャンネルへの投稿）の本文組み立てのテスト。送信（fetch）は対象外。
// グラフ通知（discord.test.ts）との違いが要点: 出し元の接頭辞が付き、宛先ゼロでも
// @here にしない。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE_PREFIX, buildReportMessage, clearChannelCache } from "../src/discord_bot.js";
import type { NotifyTarget, NotifyUser } from "../src/discord.js";

const ALICE: NotifyUser = { email: "a@example.com", displayName: "アリス", discordId: "111" };
const TARGET: NotifyTarget = { pageTitle: "サークル調査", nodeId: "n1", nodeTitle: "営業担当者に報告" };
const URL = "https://gw.example.com";

test("先頭に [Graph Wrangler] が付く（他アプリと共用の Bot なので出し元を示す）", () => {
  const m = buildReportMessage("今週はスキップです。", [ALICE], TARGET, URL);
  assert.ok(m?.content.startsWith(`${SOURCE_PREFIX} <@111>`));
});

test("本文・件名・ノードURL がこの順で並ぶ（URLは必ず載る）", () => {
  const m = buildReportMessage("今週はスキップです。", [ALICE], TARGET, URL);
  assert.deepEqual(m?.content.split("\n"), [
    "[Graph Wrangler] <@111>",
    "今週はスキップです。",
    "サークル調査 - 営業担当者に報告",
    "https://gw.example.com/#/n/n1",
  ]);
});

test("宛先が解決できなければメンション行ごと省く（グラフ通知と違い @here にしない）", () => {
  // ここはグラフの外へ向けた連絡なので、全員を鳴らす理由が無い
  const m = buildReportMessage("報告です。", [], TARGET, URL);
  assert.equal(m?.content.split("\n")[0], SOURCE_PREFIX);
  assert.ok(!m?.content.includes("@here"));
  assert.deepEqual(m?.allowed_mentions, { parse: [] });
});

test("publicUrl が無ければ null＝投稿しない（URL 必須）", () => {
  assert.equal(buildReportMessage("報告です。", [ALICE], TARGET, null), null);
});

test("ページ無所属ならノード名だけを件名にする", () => {
  const m = buildReportMessage("報告です。", [], { ...TARGET, pageTitle: null }, URL);
  assert.equal(m?.content.split("\n")[2], "営業担当者に報告");
});

test("clearChannelCache は例外を投げずに呼べる（設定変更時の取り直し用）", () => {
  assert.doesNotThrow(() => clearChannelCache());
});
