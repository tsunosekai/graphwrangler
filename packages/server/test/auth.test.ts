// 内蔵ログイン（auth.ts）のユニットテスト。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SESSION_TTL_MS,
  createSession,
  ensureSecret,
  hashPassword,
  loadUsers,
  verifyPassword,
  verifySession,
} from "../src/auth.js";

test("hashPassword/verifyPassword: 正しいパスワードだけ通る", () => {
  const { hash, salt } = hashPassword("correct horse");
  const user = { email: "a@example.com", hash, salt };
  assert.equal(verifyPassword(user, "correct horse"), true);
  assert.equal(verifyPassword(user, "wrong"), false);
  assert.equal(verifyPassword(user, ""), false);
});

test("セッション: 往復・改ざん・期限切れ", () => {
  const secret = "s".repeat(64);
  const token = createSession("a@example.com", secret);
  assert.equal(verifySession(token, secret), "a@example.com");
  // 改ざん（署名部を壊す）
  assert.equal(verifySession(token.slice(0, -2) + "xx", secret), null);
  // 別の鍵
  assert.equal(verifySession(token, "t".repeat(64)), null);
  // 期限切れ
  const old = createSession("a@example.com", secret, Date.now() - SESSION_TTL_MS - 1000);
  assert.equal(verifySession(old, secret), null);
  // 形式不正
  assert.equal(verifySession("garbage", secret), null);
});

test("ensureSecret: 生成した鍵が永続し、2回目は同じ値を返す", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-auth-"));
  const file = path.join(dir, "auth-secret");
  const first = ensureSecret(file);
  const second = ensureSecret(file);
  assert.equal(first, second);
  assert.ok(first.length >= 32);
});

test("loadUsers: 無い/壊れているファイルは空配列（ログイン全拒否側に倒れる）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-auth-"));
  assert.deepEqual(loadUsers(path.join(dir, "none.json")), []);
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{not json");
  assert.deepEqual(loadUsers(broken), []);
  const ok = path.join(dir, "users.json");
  fs.writeFileSync(ok, JSON.stringify({ users: [{ email: "a@b", hash: "aa", salt: "bb" }] }));
  assert.equal(loadUsers(ok).length, 1);
});
