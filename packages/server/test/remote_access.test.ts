// 接続元アドレスによる受け入れ制限（remote_access.ts）のユニットテスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRemoteAllowed, parseAllowRemote } from "../src/remote_access.js";

test("未設定なら制限しない（VPS 運用の従来挙動）", () => {
  assert.equal(parseAllowRemote(undefined), null);
  assert.equal(isRemoteAllowed("203.0.113.5", null), true);
});

test("tailscale: ループバックと Tailscale のアドレスだけ通す", () => {
  const s = parseAllowRemote("tailscale");
  assert.equal(isRemoteAllowed("127.0.0.1", s), true);
  assert.equal(isRemoteAllowed("::1", s), true);
  assert.equal(isRemoteAllowed("100.78.39.78", s), true);
  assert.equal(isRemoteAllowed("::ffff:100.78.39.78", s), true);
  assert.equal(isRemoteAllowed("fd7a:115c:a1e0::1234", s), true);
  // 同じ Wi-Fi の機器・インターネットは断る
  assert.equal(isRemoteAllowed("192.168.1.20", s), false);
  assert.equal(isRemoteAllowed("::ffff:192.168.1.20", s), false);
  assert.equal(isRemoteAllowed("203.0.113.5", s), false);
  // 100.64.0.0/10 の外（100.128.x）は Tailscale ではない
  assert.equal(isRemoteAllowed("100.128.0.1", s), false);
  assert.equal(isRemoteAllowed(undefined, s), false);
});

test("lan を足すとプライベートアドレスも通す", () => {
  const s = parseAllowRemote("tailscale, lan");
  assert.equal(isRemoteAllowed("192.168.1.20", s), true);
  assert.equal(isRemoteAllowed("10.0.0.3", s), true);
  assert.equal(isRemoteAllowed("172.20.1.1", s), true);
  assert.equal(isRemoteAllowed("172.32.1.1", s), false);
  assert.equal(isRemoteAllowed("203.0.113.5", s), false);
});

test("値が空・打ち間違いならループバックのみ（黙って全開にしない）", () => {
  for (const raw of ["", "tailscael"]) {
    const s = parseAllowRemote(raw);
    assert.equal(isRemoteAllowed("127.0.0.1", s), true);
    assert.equal(isRemoteAllowed("100.78.39.78", s), false);
  }
});

test("any は制限なし", () => {
  assert.equal(isRemoteAllowed("203.0.113.5", parseAllowRemote("any")), true);
});
