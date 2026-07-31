// スクリプト試走（試走ゲート）まわりの純関数のユニットテスト。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { GraphError } from "@graphwrangler/core";
import type { Node } from "@graphwrangler/core";
import {
  assertTrialAllowed,
  implStatus,
  runTrial,
  sha256Hex,
  substituteParams,
  trialCwd,
} from "../src/trial.js";

/** テスト用の完全な Node フィクスチャ。必要なフィールドだけ上書きして使う */
function fixedNode(overrides: Partial<Node> = {}): Node {
  return {
    id: "n-20260101-0001",
    title: "テストノード",
    detail: null,
    impl: null,
    implTrial: null,
    parents: [],
    group: null,
    kind: "task",
    executor: "script",
    impact: "safe",
    lifecycle: "draft",
    status: "pending",
    fixed: false,
    pendingRequest: null,
    order: null,
    schedule: null,
    branches: null,
    choice: null,
    parentOptions: {},
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---- sha256Hex ----

test("sha256Hex は同じ入力に対し常に同じ値を返す（決定的）", () => {
  assert.equal(sha256Hex("echo hi"), sha256Hex("echo hi"));
});

test("sha256Hex は既知の入力に対し既知のハッシュを返す", () => {
  // echo -n "" | sha256sum 相当（空文字列のSHA-256は広く知られた定数）
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("sha256Hex は入力が変われば値も変わる", () => {
  assert.notEqual(sha256Hex("echo hi"), sha256Hex("echo hi2"));
});

// ---- implStatus ----

test("implStatus: impl が null なら not-script", () => {
  assert.equal(implStatus(fixedNode({ impl: null })), "not-script");
});

test("implStatus: impl.type が doc なら not-script", () => {
  assert.equal(implStatus(fixedNode({ impl: { type: "doc", text: "手順" } })), "not-script");
});

test("implStatus: script だが implTrial が無ければ unverified", () => {
  assert.equal(
    implStatus(fixedNode({ impl: { type: "script", command: "echo hi" }, implTrial: null })),
    "unverified",
  );
});

test("implStatus: hash が一致し成功していれば ok", () => {
  const command = "echo hi";
  const node = fixedNode({
    impl: { type: "script", command },
    implTrial: { hash: sha256Hex(command), success: true, ts: "2026-01-01T00:00:00.000Z" },
  });
  assert.equal(implStatus(node), "ok");
});

test("implStatus: hash が一致しても失敗していれば unverified（成功が未証明）", () => {
  const command = "echo hi";
  const node = fixedNode({
    impl: { type: "script", command },
    implTrial: { hash: sha256Hex(command), success: false, ts: "2026-01-01T00:00:00.000Z" },
  });
  assert.equal(implStatus(node), "unverified");
});

test("implStatus: command が変わって hash が不一致なら stale（success の値によらず）", () => {
  const node = fixedNode({
    impl: { type: "script", command: "echo changed" },
    implTrial: { hash: sha256Hex("echo original"), success: true, ts: "2026-01-01T00:00:00.000Z" },
  });
  assert.equal(implStatus(node), "stale");
});

// ---- assertTrialAllowed（試走ガード） ----

test("assertTrialAllowed: script かつ safe/reversible なら通る", () => {
  assert.doesNotThrow(() =>
    assertTrialAllowed(fixedNode({ impl: { type: "script", command: "echo hi" }, impact: "safe" })),
  );
});

test("assertTrialAllowed: impl が null なら 400", () => {
  assert.throws(() => assertTrialAllowed(fixedNode({ impl: null })), (err: unknown) => {
    assert.ok(err instanceof GraphError);
    assert.equal(err.status, 400);
    return true;
  });
});

test("assertTrialAllowed: impl.type が doc なら 400", () => {
  assert.throws(
    () => assertTrialAllowed(fixedNode({ impl: { type: "doc", text: "手順" } })),
    (err: unknown) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test("assertTrialAllowed: impact が irreversible なら 400（不可逆ノードは試走できない）", () => {
  assert.throws(
    () =>
      assertTrialAllowed(
        fixedNode({ impl: { type: "script", command: "echo hi" }, impact: "irreversible" }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.status, 400);
      assert.match((err as GraphError).message, /不可逆/);
      return true;
    },
  );
});

// ---- substituteParams（パラメータ宣言の置換。docs/design.md 3.5.1） ----

test("substituteParams: 宣言なし・プレースホルダなしのcommandはそのまま通る", () => {
  const result = substituteParams("echo hi", null);
  assert.deepEqual(result, { ok: true, command: "echo hi" });
});

test("substituteParams: {name} を対応する value に置換し、二重引用符で囲む", () => {
  const result = substituteParams("node run.mjs {target}", [
    { name: "target", value: "foo" },
  ]);
  assert.deepEqual(result, { ok: true, command: 'node run.mjs "foo"' });
});

test("substituteParams: 複数のプレースホルダをそれぞれ置換する", () => {
  const result = substituteParams("cp {src} {dest}", [
    { name: "src", value: "a.txt" },
    { name: "dest", value: "b.txt" },
  ]);
  assert.deepEqual(result, { ok: true, command: 'cp "a.txt" "b.txt"' });
});

test("substituteParams: value 内の二重引用符は \\\" にエスケープする", () => {
  const result = substituteParams("echo {msg}", [{ name: "msg", value: 'say "hi"' }]);
  assert.deepEqual(result, { ok: true, command: 'echo "say \\"hi\\""' });
});

test("substituteParams: value が未入力（null）の宣言が残っていれば missing に入る", () => {
  const result = substituteParams("node run.mjs {target}", [{ name: "target", value: null }]);
  assert.deepEqual(result, { ok: false, missing: ["target"] });
});

test("substituteParams: value が空文字の宣言も未入力扱い", () => {
  const result = substituteParams("node run.mjs {target}", [{ name: "target", value: "" }]);
  assert.deepEqual(result, { ok: false, missing: ["target"] });
});

test("substituteParams: 宣言に無い {xxx} は missing に入る", () => {
  const result = substituteParams("node run.mjs {target}", []);
  assert.deepEqual(result, { ok: false, missing: ["target"] });
});

test("substituteParams: missing は重複しない（同名プレースホルダが複数回出ても1回）", () => {
  const result = substituteParams("echo {a} {a}", []);
  assert.deepEqual(result, { ok: false, missing: ["a"] });
});

test("substituteParams: 未入力と成功が混在するときは未入力の名前だけ集める", () => {
  const result = substituteParams("cp {src} {dest}", [{ name: "src", value: "a.txt" }]);
  assert.deepEqual(result, { ok: false, missing: ["dest"] });
});

// ---- trialCwd ----

test("trialCwd: workspaceRoot が無ければ os.tmpdir() を返す", () => {
  assert.equal(trialCwd(null), os.tmpdir());
});

test("trialCwd: workspaceRoot があればそれを返す", () => {
  assert.equal(trialCwd("/some/workspace"), "/some/workspace");
});

// ---- runTrial（実際に子プロセスを1回動かす簡易な結合テスト。node 自体をコマンドに使う） ----

test("runTrial: 成功するコマンドは success:true・exitCode:0 を返す", async () => {
  const result = await runTrial('node -e "console.log(1+1)"', os.tmpdir());
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /2/);
});

test("runTrial: 失敗するコマンドは success:false・exitCode!==0 を返す", async () => {
  const result = await runTrial('node -e "process.exit(3)"', os.tmpdir());
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 3);
});
