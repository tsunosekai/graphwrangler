// 「あなたの番」重複通知の抑止（src/open_request.ts）のテスト。
// 発生源②（ランアイテムの waiting 遷移）が鳴らした後、発生源①（判断カードを開く）が
// 同じボールでもう1通重ねない——isTurnAlreadyAnnounced が true のとき①は黙る。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTurnAlreadyAnnounced } from "../src/open_request.js";

test("実行中ランのアイテムが waiting なら通知済み（エンジンの2段構えの2通目を抑止）", () => {
  const runs = [{ status: "running", items: { n1: { status: "waiting" } } }];
  assert.equal(isTurnAlreadyAnnounced(runs, "n1"), true);
});

test("waiting でも実行中でないラン（done/dropped）は数えない", () => {
  const runs = [{ status: "done", items: { n1: { status: "waiting" } } }];
  assert.equal(isTurnAlreadyAnnounced(runs, "n1"), false);
});

test("別ノードの waiting は関係ない", () => {
  const runs = [{ status: "running", items: { other: { status: "waiting" } } }];
  assert.equal(isTurnAlreadyAnnounced(runs, "n1"), false);
});

test("ランが無い・アイテムが waiting でないなら未通知（①がそのまま鳴らす）", () => {
  assert.equal(isTurnAlreadyAnnounced([], "n1"), false);
  const runs = [{ status: "running", items: { n1: { status: "running" } } }];
  assert.equal(isTurnAlreadyAnnounced(runs, "n1"), false);
});

test("並列ランのどれか1本でも waiting なら通知済みとみなす", () => {
  const runs = [
    { status: "running", items: { n1: { status: "done" } } },
    { status: "running", items: { n1: { status: "waiting" } } },
  ];
  assert.equal(isTurnAlreadyAnnounced(runs, "n1"), true);
});
