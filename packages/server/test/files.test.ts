// resolveWorkspacePath（GET /api/files のパス脱出ガード）のユニットテスト。
// server パッケージには vitest 等のテストランナーが入っていないため、Node 標準の
// node:test を tsx 経由で直接実行する。
// 実行: `pnpm --filter @graphwrangler/server test`（package.json 参照）
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveWorkspacePath } from "../src/files.js";

const root = path.resolve(process.platform === "win32" ? "C:\\repo" : "/repo");

test("通常の相対パスは root 配下として解決できる", () => {
  const got = resolveWorkspacePath(root, "docs/spec.md");
  assert.equal(got, path.join(root, "docs", "spec.md"));
});

test("ネストした相対パスも解決できる", () => {
  const got = resolveWorkspacePath(root, "a/b/c.txt");
  assert.equal(got, path.join(root, "a", "b", "c.txt"));
});

test("'..' による脱出は拒否する", () => {
  assert.equal(resolveWorkspacePath(root, ".."), null);
  assert.equal(resolveWorkspacePath(root, "../secret.txt"), null);
  assert.equal(resolveWorkspacePath(root, "../../etc/passwd"), null);
  assert.equal(resolveWorkspacePath(root, "docs/../../secret.txt"), null);
});

test("'..' で始まる正当なファイル名は誤検知しない", () => {
  // ".." の前方一致だけで弾くと "..hidden" のような実在しうるファイル名を誤って拒否してしまう
  const got = resolveWorkspacePath(root, "..hidden");
  assert.equal(got, path.join(root, "..hidden"));
});

test("絶対パス指定は拒否する", () => {
  assert.equal(resolveWorkspacePath(root, process.platform === "win32" ? "C:\\Windows\\System32" : "/etc/passwd"), null);
});

test("別ドライブ指定は拒否する（Windows）", { skip: process.platform !== "win32" }, () => {
  assert.equal(resolveWorkspacePath(root, "D:\\secret.txt"), null);
});

test("root 自身（空/'.'）は拒否する", () => {
  assert.equal(resolveWorkspacePath(root, ""), null);
  assert.equal(resolveWorkspacePath(root, "."), null);
});
