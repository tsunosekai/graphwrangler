// 宛先（関係者）解決のテスト（recipients.ts の純粋関数）。2026-08-11 本人要望
// 「『関係者』を見て適切にメンションしてほしい」。
// 肝は「**最初に取れた段で打ち切る**」——全段を合算すると実質全員通知に戻り、
// メンションの重みが消える。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { humanAuthorsOf, resolveRecipientEmails, toRecipients } from "../src/recipients.js";
import type { NotifyUser } from "../src/discord.js";

const EMPTY = { assignee: null, createdBy: null, page: null, threadAuthors: [] };

test("段1: assignee が居ればその人だけ（下の段へ広げない）", () => {
  const emails = resolveRecipientEmails({
    assignee: "alice@example.com",
    createdBy: "bob@example.com",
    page: { members: ["carol@example.com"], createdBy: "dave@example.com" },
    threadAuthors: ["eve@example.com"],
  });
  assert.deepEqual(emails, ["alice@example.com"]);
});

test("段2: 担当未設定なら、そのノードを立てた人", () => {
  const emails = resolveRecipientEmails({
    ...EMPTY,
    createdBy: "bob@example.com",
    page: { members: ["carol@example.com"], createdBy: null },
  });
  assert.deepEqual(emails, ["bob@example.com"]);
});

test("段3: ノード単位で決まらなければページの関係者 + ページ作成者", () => {
  const emails = resolveRecipientEmails({
    ...EMPTY,
    page: { members: ["carol@example.com"], createdBy: "dave@example.com" },
    threadAuthors: ["eve@example.com"],
  });
  assert.deepEqual(emails, ["carol@example.com", "dave@example.com"]);
});

test("段4: それも空なら、直近スレッドで実際に話していた人", () => {
  const emails = resolveRecipientEmails({ ...EMPTY, threadAuthors: ["eve@example.com"] });
  assert.deepEqual(emails, ["eve@example.com"]);
});

test("全段空なら [] （呼び出し側が @here にする＝本当の「全員の番」）", () => {
  assert.deepEqual(resolveRecipientEmails(EMPTY), []);
});

test("空のページ（関係者も作成者も無い）は段3を飛ばして段4へ落ちる", () => {
  const emails = resolveRecipientEmails({
    ...EMPTY,
    page: { members: [], createdBy: null },
    threadAuthors: ["eve@example.com"],
  });
  assert.deepEqual(emails, ["eve@example.com"]);
});

test("同じ段の重複は潰す（ページ作成者が関係者にも入っている場合）", () => {
  const emails = resolveRecipientEmails({
    ...EMPTY,
    page: { members: ["carol@example.com", "Carol@Example.com"], createdBy: "carol@example.com" },
  });
  assert.deepEqual(emails, ["carol@example.com"]);
});

// --- users.json への引き当て ---

const USERS: NotifyUser[] = [
  { email: "alice@example.com", displayName: "アリス", discordId: "111111111111111111" },
];

test("toRecipients: メールの大文字小文字を無視して引き当てる", () => {
  assert.deepEqual(toRecipients(["Alice@Example.com"], USERS), [USERS[0]]);
});

test("toRecipients: 未登録のメールも落とさず返す（宛先不明と区別が付かなくなるため）", () => {
  assert.deepEqual(toRecipients(["ghost@example.com"], USERS), [{ email: "ghost@example.com" }]);
});

// --- スレッド発言者の抽出 ---

const msg = (kind: "human" | "agent" | "system", name?: string) =>
  ({ author: { kind, name } }) as Parameters<typeof humanAuthorsOf>[0][number];

test("humanAuthorsOf: 人間の発言者だけを重複なしで拾う（AI・システムは当事者ではない）", () => {
  const authors = humanAuthorsOf([
    msg("human", "alice@example.com"),
    msg("agent", "task-ai:opus"),
    msg("system"),
    msg("human", "alice@example.com"),
    msg("human", "bob@example.com"),
  ]);
  assert.deepEqual(authors, ["alice@example.com", "bob@example.com"]);
});

test("humanAuthorsOf: 名前の無い human は宛先にできないので落とす", () => {
  assert.deepEqual(humanAuthorsOf([msg("human")]), []);
});
