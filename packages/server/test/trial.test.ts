// スクリプト試走（試走ゲート）まわりの純関数のユニットテスト。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { GraphError } from "@graphwrangler/core";
import type { Node } from "@graphwrangler/core";
import {
  assertTrialAllowed,
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
    approval: false,
    autonomy: "normal",
    lifecycle: "draft",
    status: "pending",
    fixed: false,
    pendingRequest: null,
    schedule: null,
    branches: null,
    choice: null,
    parentOptions: {},
    createdBy: null,
    assignee: null,
    members: [],
    created: "2026-01-01T00:00:00.000Z",
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

// ---- assertTrialAllowed（試走ガード） ----

test("assertTrialAllowed: script かつ safe/reversible なら通る", () => {
  assert.doesNotThrow(() =>
    assertTrialAllowed(fixedNode({ impl: { type: "script", command: "echo hi" }, approval: false })),
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

test("assertTrialAllowed: approval=true でも試走できる（試走=常に--dry-runの予告編。2026-07-31 旧ルール撤廃）", () => {
  assert.doesNotThrow(() =>
    assertTrialAllowed(
      fixedNode({ impl: { type: "script", command: "echo hi" }, approval: true }),
    ),
  );
});

// ---- substituteParams（パラメータ宣言の置換。docs/design.md 3.5.1。
//      2026-08-09 ランのコンテキスト解決を追加。docs/design.md 3.15） ----

test("substituteParams: 宣言なし・プレースホルダなしのcommandはそのまま通る", () => {
  const result = substituteParams("echo hi", null);
  assert.deepEqual(result, { ok: true, command: "echo hi", resolved: {} });
});

test("substituteParams: {name} を対応する value に置換し、二重引用符で囲む", () => {
  const result = substituteParams("node run.mjs {target}", [
    { name: "target", value: "foo" },
  ]);
  assert.deepEqual(result, {
    ok: true,
    command: 'node run.mjs "foo"',
    resolved: { target: "foo" },
  });
});

test("substituteParams: 複数のプレースホルダをそれぞれ置換する", () => {
  const result = substituteParams("cp {src} {dest}", [
    { name: "src", value: "a.txt" },
    { name: "dest", value: "b.txt" },
  ]);
  assert.deepEqual(result, {
    ok: true,
    command: 'cp "a.txt" "b.txt"',
    resolved: { src: "a.txt", dest: "b.txt" },
  });
});

test("substituteParams: value 内の二重引用符は \\\" にエスケープする", () => {
  const result = substituteParams("echo {msg}", [{ name: "msg", value: 'say "hi"' }]);
  assert.deepEqual(result, {
    ok: true,
    command: 'echo "say \\"hi\\""',
    resolved: { msg: 'say "hi"' },
  });
});

/** ok:false（missing）の検証ヘルパ。reason は文言全文でなく骨子だけ見る */
function assertMissing(result: ReturnType<typeof substituteParams>, missing: string[]) {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "missing");
  if (result.kind !== "missing") return;
  assert.deepEqual(result.missing, missing);
  assert.match(result.reason, /パラメータが未入力です/);
}

test("substituteParams: value が未入力（null）の宣言が残っていれば missing に入る", () => {
  assertMissing(
    substituteParams("node run.mjs {target}", [{ name: "target", value: null }]),
    ["target"],
  );
});

test("substituteParams: value が空文字の宣言も未入力扱い", () => {
  assertMissing(
    substituteParams("node run.mjs {target}", [{ name: "target", value: "" }]),
    ["target"],
  );
});

test("substituteParams: 宣言に無い {xxx} は missing に入る", () => {
  assertMissing(substituteParams("node run.mjs {target}", []), ["target"]);
});

test("substituteParams: missing は重複しない（同名プレースホルダが複数回出ても1回）", () => {
  assertMissing(substituteParams("echo {a} {a}", []), ["a"]);
});

test("substituteParams: 未入力と成功が混在するときは未入力の名前だけ集める", () => {
  assertMissing(substituteParams("cp {src} {dest}", [{ name: "src", value: "a.txt" }]), ["dest"]);
});

// ---- substituteParams のランコンテキスト解決（3.15。実体は core/src/params.ts で
//      engine と共用。試走は context を渡さないが、窓口経由の挙動検証をこちらでも持つ） ----

/** ok:false（unsafe）の検証ヘルパ。reason は GW_PARAM_* への誘導が入っていることだけ見る */
function assertUnsafe(result: ReturnType<typeof substituteParams>, unsafe: string[]) {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "unsafe");
  if (result.kind !== "unsafe") return;
  assert.deepEqual(result.unsafe, unsafe);
  assert.match(result.reason, /GW_PARAM_/);
}

test("substituteParams: run.context が impl.params のデフォルト値より優先される（解決順①→②）", () => {
  const result = substituteParams(
    "node run.mjs {target}",
    [{ name: "target", value: "既定" }],
    { target: "ラン値" },
  );
  assert.deepEqual(result, {
    ok: true,
    command: 'node run.mjs "ラン値"',
    resolved: { target: "ラン値" },
  });
});

test("substituteParams: context に無いキーはデフォルト値へ降格する", () => {
  const result = substituteParams(
    "cp {src} {dest}",
    [{ name: "dest", value: "b.txt" }],
    { src: "a.txt" },
  );
  assert.deepEqual(result, {
    ok: true,
    command: 'cp "a.txt" "b.txt"',
    resolved: { src: "a.txt", dest: "b.txt" },
  });
});

test("substituteParams: context 由来の値がシェルメタ文字を含むと unsafe（置換せず失敗）", () => {
  assertUnsafe(substituteParams("echo {msg}", [], { msg: "a; rm -rf /" }), ["msg"]);
});

test("substituteParams: バッククォート・$・改行なども unsafe（ガードの代表例）", () => {
  for (const bad of ["`whoami`", "$HOME", 'say "hi"', "a\nb", "a|b", "(x)", "{x}"]) {
    assertUnsafe(substituteParams("echo {msg}", [], { msg: bad }), ["msg"]);
  }
});

test("substituteParams: テンプレートのデフォルト値（人間のUI入力）はメタ文字ガードの対象外", () => {
  const result = substituteParams("echo {msg}", [{ name: "msg", value: "括弧(入り)タイトル" }]);
  assert.deepEqual(result, {
    ok: true,
    command: 'echo "括弧(入り)タイトル"',
    resolved: { msg: "括弧(入り)タイトル" },
  });
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
