// 既読時刻（reads.ts。docs/design.md 3.11）のユニットテスト。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ReadsStore,
  advanceReads,
  mergeReads,
  parseReadsFile,
  sanitizeMarks,
  type ReadsFile,
} from "../src/reads.js";

const T1 = "2026-08-01T00:00:00.000Z";
const T2 = "2026-08-02T00:00:00.000Z";
const T3 = "2026-08-03T00:00:00.000Z";

function tmpReadsFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gw-reads-")), "reads.json");
}

// ---- sanitizeMarks ----

test("sanitizeMarks は文字列でない値を落とす", () => {
  assert.deepEqual(sanitizeMarks({ a: T1, b: 3, c: null, d: { x: 1 } }), { a: T1 });
});

test("sanitizeMarks は object 以外・配列を空オブジェクトにする", () => {
  assert.deepEqual(sanitizeMarks(null), {});
  assert.deepEqual(sanitizeMarks("x"), {});
  assert.deepEqual(sanitizeMarks([T1]), {});
});

// ---- parseReadsFile ----

test("parseReadsFile は v2 形式を shared/users に読み分ける", () => {
  const file = parseReadsFile({
    version: 2,
    shared: { n1: T1 },
    users: { "a@example.com": { n2: T2 } },
  });
  assert.deepEqual(file, { shared: { n1: T1 }, users: { "a@example.com": { n2: T2 } } });
});

test("parseReadsFile は旧フラット形式 {nodeId: ts} を shared として読み替える", () => {
  assert.deepEqual(parseReadsFile({ n1: T1, n2: T2 }), {
    shared: { n1: T1, n2: T2 },
    users: {},
  });
});

test("parseReadsFile は壊れた中身を空から始める", () => {
  assert.deepEqual(parseReadsFile(null), { shared: {}, users: {} });
  assert.deepEqual(parseReadsFile([1, 2]), { shared: {}, users: {} });
});

test("parseReadsFile は v2 の users 配下の不正な値も落とす", () => {
  const file = parseReadsFile({
    version: 2,
    shared: { n1: 1 },
    users: { "a@example.com": { n2: T2, n3: false } },
  });
  assert.deepEqual(file, { shared: {}, users: { "a@example.com": { n2: T2 } } });
});

// ---- mergeReads（読み） ----

test("mergeReads は匿名（email=null）には shared だけを返す", () => {
  const file: ReadsFile = { shared: { n1: T1 }, users: { "a@example.com": { n2: T2 } } };
  assert.deepEqual(mergeReads(file, null), { n1: T1 });
});

test("mergeReads は shared と自分のバケツを max マージする", () => {
  const file: ReadsFile = {
    shared: { n1: T2, n2: T1 },
    users: { "a@example.com": { n1: T1, n2: T3, n3: T1 } },
  };
  // n1: shared の方が新しい / n2: 自分の方が新しい / n3: 自分だけが持つ
  assert.deepEqual(mergeReads(file, "a@example.com"), { n1: T2, n2: T3, n3: T1 });
});

test("mergeReads に他人のバケツは混ざらない", () => {
  const file: ReadsFile = {
    shared: {},
    users: { "a@example.com": { n1: T1 }, "b@example.com": { n2: T2 } },
  };
  assert.deepEqual(mergeReads(file, "a@example.com"), { n1: T1 });
});

// ---- advanceReads（書き） ----

test("advanceReads は匿名なら shared を進める", () => {
  const { next, changed } = advanceReads({ shared: { n1: T1 }, users: {} }, null, { n1: T2 });
  assert.equal(changed, true);
  assert.deepEqual(next.shared, { n1: T2 });
});

test("advanceReads はログイン中なら自分のバケツだけを進める（shared は触らない）", () => {
  const { next, changed } = advanceReads({ shared: { n1: T1 }, users: {} }, "a@example.com", {
    n1: T2,
  });
  assert.equal(changed, true);
  assert.deepEqual(next.shared, { n1: T1 });
  assert.deepEqual(next.users, { "a@example.com": { n1: T2 } });
});

test("advanceReads は既読を巻き戻さない（古い ts は無視して changed=false）", () => {
  const before: ReadsFile = { shared: {}, users: { "a@example.com": { n1: T2 } } };
  const { next, changed } = advanceReads(before, "a@example.com", { n1: T1 });
  assert.equal(changed, false);
  assert.equal(next, before); // 変更なしなら同じ参照をそのまま返す
});

test("advanceReads は shared で既読済みの範囲を自分のバケツへ複製しない", () => {
  const before: ReadsFile = { shared: { n1: T2 }, users: {} };
  const { next, changed } = advanceReads(before, "a@example.com", { n1: T1 });
  assert.equal(changed, false);
  assert.deepEqual(next.users, {});
});

test("advanceReads は shared より進む分だけ自分のバケツへ書く", () => {
  const before: ReadsFile = { shared: { n1: T1 }, users: { "a@example.com": { n1: T2 } } };
  const { next, changed } = advanceReads(before, "a@example.com", { n1: T3 });
  assert.equal(changed, true);
  assert.deepEqual(next.users["a@example.com"], { n1: T3 });
});

test("advanceReads は文字列でない・空の ts を無視する", () => {
  const before: ReadsFile = { shared: {}, users: {} };
  const marks = { n1: "", n2: 5 } as unknown as Record<string, string>;
  const { changed } = advanceReads(before, null, marks);
  assert.equal(changed, false);
});

test("advanceReads は他ユーザーのバケツを保つ", () => {
  const before: ReadsFile = { shared: {}, users: { "b@example.com": { n9: T1 } } };
  const { next } = advanceReads(before, "a@example.com", { n1: T1 });
  assert.deepEqual(next.users["b@example.com"], { n9: T1 });
});

// ---- ReadsStore（永続化） ----

test("ReadsStore は未作成のファイルでも空の既読として動く", () => {
  const store = new ReadsStore(tmpReadsFile());
  assert.deepEqual(store.loadReads(null), {});
});

test("ReadsStore は markRead した内容を loadReads で読み返せる", () => {
  const store = new ReadsStore(tmpReadsFile());
  assert.equal(store.markRead("a@example.com", { n1: T1 }), true);
  assert.deepEqual(store.loadReads("a@example.com"), { n1: T1 });
  // 匿名から見えるのは shared だけ＝ログインユーザーの既読は見えない
  assert.deepEqual(store.loadReads(null), {});
});

test("ReadsStore は v2 形式で保存し、別インスタンスから同じ既読を読める", () => {
  const file = tmpReadsFile();
  const store = new ReadsStore(file);
  store.markRead(null, { n1: T1 });
  store.markRead("a@example.com", { n2: T2 });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.version, 2);
  const reopened = new ReadsStore(file);
  assert.deepEqual(reopened.loadReads("a@example.com"), { n1: T1, n2: T2 });
});

test("ReadsStore は巻き戻す markRead で false を返しファイルを書き換えない", () => {
  const file = tmpReadsFile();
  const store = new ReadsStore(file);
  store.markRead(null, { n1: T2 });
  const before = fs.readFileSync(file, "utf8");
  assert.equal(store.markRead(null, { n1: T1 }), false);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("ReadsStore は旧フラット形式のファイルを shared として引き継ぐ", () => {
  const file = tmpReadsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ n1: T1 }), "utf8");
  const store = new ReadsStore(file);
  assert.deepEqual(store.loadReads(null), { n1: T1 });
  assert.deepEqual(store.loadReads("a@example.com"), { n1: T1 });
});
