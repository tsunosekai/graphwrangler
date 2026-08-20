// 「あなたの番」通知を鳴らすかの判定（src/open_request.ts）のテスト。
// 前半は重複通知の抑止、後半は shouldNotifyTurn（連続する人間作業の消音 × 個人設定）。
// 連続判定そのものの仕様は @graphwrangler/core の turn.test.ts が持つ。
// 発生源②（ランアイテムの waiting 遷移）が鳴らした後、発生源①（判断カードを開く）が
// 同じボールでもう1通重ねない——isTurnAlreadyAnnounced が true のとき①は黙る。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTurnAlreadyAnnounced, shouldNotifyTurn } from "../src/open_request.js";
import type { TurnParent } from "@graphwrangler/core";

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

// ---- shouldNotifyTurn（連続する人間作業の消音 × 担当者の個人設定）----

const humanTask = (assignee: string | null = null): TurnParent => ({
  kind: "task",
  executor: "human",
  assignee,
  ran: true,
});
/** 人間ノード（親1本つき）。既定は未割当＝全員宛 */
const turnNode = (assignee: string | null = null) => ({
  kind: "task",
  executor: "human",
  assignee,
  parents: ["p1"],
});
const noParents = () => undefined;
const allOn = () => true;

test("直前が同じ人の人間作業なら鳴らさない（設定オン）", () => {
  const notify = shouldNotifyTurn(turnNode(), () => humanTask(), {
    quietConsecutive: true,
    turnNotifyOf: allOn,
  });
  assert.equal(notify, false);
});

test("設定オフなら連続でも従来どおり鳴らす", () => {
  const notify = shouldNotifyTurn(turnNode(), () => humanTask(), {
    quietConsecutive: false,
    turnNotifyOf: allOn,
  });
  assert.equal(notify, true);
});

test("区間の先頭（親が引けない）は鳴らす", () => {
  assert.equal(
    shouldNotifyTurn(turnNode(), noParents, { quietConsecutive: true, turnNotifyOf: allOn }),
    true,
  );
});

test("担当者が通知を切っていれば連続でなくても鳴らさない（個人設定は従来どおり効く）", () => {
  const notify = shouldNotifyTurn(turnNode("a@example.com"), noParents, {
    quietConsecutive: true,
    turnNotifyOf: () => false,
  });
  assert.equal(notify, false);
});

test("未割当（全員宛）は担当者の個人設定を見ない", () => {
  assert.equal(
    shouldNotifyTurn(turnNode(), noParents, { quietConsecutive: true, turnNotifyOf: () => false }),
    true,
  );
});
