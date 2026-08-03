// 自動プッシュ（gitsync.ts）のテスト。実際の git（bare リモート + クローン）で
// commit/push・パス限定・gitignore 尊重・冪等を確かめる。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitSync, summarizeChanges } from "../src/gitsync.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** bare リモート + クローン済みワークツリーを作る（署名・フックはローカル設定で無効化） */
function setupRepo(): { tmp: string; bare: string; work: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-gitsync-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");
  execFileSync("git", ["init", "--bare", bare], { encoding: "utf8" });
  execFileSync("git", ["clone", bare, work], { encoding: "utf8", stdio: "pipe" });
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "gw-test");
  git(work, "config", "commit.gpgsign", "false");
  return { tmp, bare, work };
}

function writeWorkspaceFiles(work: string): void {
  fs.writeFileSync(path.join(work, "workflow.gw.json"), '{"format":"graphwrangler-workspace"}\n');
  const sidecar = path.join(work, ".graphwrangler");
  fs.mkdirSync(path.join(sidecar, "threads"), { recursive: true });
  fs.mkdirSync(path.join(sidecar, "runs"), { recursive: true });
  fs.writeFileSync(path.join(sidecar, ".gitignore"), "runs/\nops.jsonl\nsettings.json\nreads.json\n");
  fs.writeFileSync(path.join(sidecar, "threads", "n-1.jsonl"), '{"kind":"say"}\n');
  fs.writeFileSync(path.join(sidecar, "runs", "r-1.json"), "{}\n"); // gitignore 対象＝コミットされない
}

function makeSync(work: string, extraPaths: string[] = []): GitSync {
  return new GitSync({
    root: work,
    paths: ["workflow.gw.json", ".graphwrangler"],
    getConfig: () => ({ autoPush: true, intervalSec: 60, extraPaths }),
    log: () => {},
  });
}

test("runOnce: 対象パスだけ commit して push する（初回は -u で upstream 設定）", async () => {
  const { bare, work } = setupRepo();
  writeWorkspaceFiles(work);
  // 対象外ファイル（ドキュメントリポの人間の作業中ファイル）は巻き込まれないこと
  fs.writeFileSync(path.join(work, "docs.md"), "編集中\n");

  const result = await makeSync(work).runOnce();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.committed, true);
  assert.equal(result.pushed, true);

  // コミット内容: 正データ + threads は入る、gitignore の runs と対象外 docs.md は入らない
  const files = git(work, "ls-tree", "-r", "--name-only", "HEAD").trim().split("\n");
  assert.ok(files.includes("workflow.gw.json"));
  assert.ok(files.includes(".graphwrangler/threads/n-1.jsonl"));
  assert.ok(files.includes(".graphwrangler/.gitignore"));
  assert.ok(!files.some((f) => f.includes("runs/")));
  assert.ok(!files.includes("docs.md"));
  assert.match(git(work, "log", "-1", "--format=%s"), /^gw: /);

  // リモートへ届いている
  const remoteCount = git(bare, "rev-list", "--all", "--count").trim();
  assert.equal(remoteCount, "1");

  // docs.md は untracked のまま残る
  assert.match(git(work, "status", "--porcelain"), /\?\? docs\.md/);
});

test("runOnce: extraPaths のディレクトリも同期し、脱出パスは無視する", async () => {
  const { work } = setupRepo();
  writeWorkspaceFiles(work);
  fs.mkdirSync(path.join(work, "docs", "skills"), { recursive: true });
  fs.writeFileSync(path.join(work, "docs", "skills", "a.md"), "手順\n");
  fs.writeFileSync(path.join(work, "other.md"), "対象外\n");
  const result = await makeSync(work, ["docs/skills", "../escape", "/etc"]).runOnce();
  assert.equal(result.ok, true, result.message);
  const files = git(work, "ls-tree", "-r", "--name-only", "HEAD").trim().split("\n");
  assert.ok(files.includes("docs/skills/a.md"));
  assert.ok(!files.includes("other.md"));
});

test("runOnce: 変更が無ければ何もしない（冪等）", async () => {
  const { work } = setupRepo();
  writeWorkspaceFiles(work);
  const sync = makeSync(work);
  await sync.runOnce();
  const again = await sync.runOnce();
  assert.equal(again.ok, true);
  assert.equal(again.committed, false);
  assert.equal(again.pushed, false);
});

test("runOnce: リモートに他者のコミットがあっても rebase して push できる", async () => {
  const { bare, work } = setupRepo();
  writeWorkspaceFiles(work);
  const sync = makeSync(work);
  await sync.runOnce(); // 初回 push で upstream 確立

  // 他者（別クローン）が docs.md を push する
  const other = path.join(path.dirname(work), "other");
  execFileSync("git", ["clone", bare, other], { encoding: "utf8", stdio: "pipe" });
  git(other, "config", "user.email", "other@example.com");
  git(other, "config", "user.name", "other");
  git(other, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(other, "docs.md"), "他者の編集\n");
  git(other, "add", "docs.md");
  git(other, "commit", "-m", "docs: 他者のコミット");
  git(other, "push");

  // 自分側でグラフを変更 → rebase を挟んで push できる
  fs.writeFileSync(path.join(work, "workflow.gw.json"), '{"format":"graphwrangler-workspace","v":2}\n');
  const result = await sync.runOnce();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.pushed, true);
  const remoteCount = git(bare, "rev-list", "--all", "--count").trim();
  assert.equal(remoteCount, "3"); // 初回 + 他者 + 今回
});

test("runOnce: git リポジトリでないワークスペースではエラーを返す（落ちない）", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-gitsync-nogit-"));
  fs.writeFileSync(path.join(tmp, "workflow.gw.json"), "{}\n");
  const result = await new GitSync({
    root: tmp,
    paths: ["workflow.gw.json"],
    getConfig: () => ({ autoPush: true, intervalSec: 60 }),
    log: () => {},
  }).runOnce();
  assert.equal(result.ok, false);
  assert.match(result.message, /git リポジトリではありません/);
});

test("summarizeChanges: 変更種別の日本語要約", () => {
  assert.equal(
    summarizeChanges([" M workflow.gw.json", "A  .graphwrangler/threads/a.jsonl", "?? .graphwrangler/threads/b.jsonl"]),
    "グラフ・スレッド2件",
  );
  assert.equal(summarizeChanges(["?? .graphwrangler/chats/global.json"]), "チャット履歴");
  assert.equal(summarizeChanges([]), "変更なし");
});
