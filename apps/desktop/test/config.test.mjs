import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  defaultConfig,
  findTailscaleIp,
  normalizeConfig,
  restartDelayMs,
  serverEnv,
} from "../src/config.mjs";

const HOME = path.resolve("/home/u");

test("既定: 空のワークスペース・スマホ公開オン・ログイン時起動オン", () => {
  const c = defaultConfig(HOME);
  assert.equal(c.workspace, path.join(HOME, "GraphWrangler"));
  assert.equal(c.remoteAccess, true);
  assert.equal(c.openAtLogin, true);
});

test("壊れた値は既定へ戻し、正しい値は残す", () => {
  const c = normalizeConfig({ workspace: "", port: 80, remoteAccess: "yes", openAtLogin: false }, HOME);
  assert.equal(c.workspace, path.join(HOME, "GraphWrangler"));
  assert.equal(c.port, 8770);
  assert.equal(c.remoteAccess, true);
  assert.equal(c.openAtLogin, false);
  assert.deepEqual(normalizeConfig(null, HOME), defaultConfig(HOME));
});

test("Tailscale の IPv4 だけを拾う", () => {
  const nics = {
    "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.1.5" }],
    Tailscale: [
      { family: "IPv6", internal: false, address: "fd7a:115c:a1e0::1" },
      { family: "IPv4", internal: false, address: "100.95.143.80" },
    ],
  };
  assert.equal(findTailscaleIp(nics), "100.95.143.80");
  assert.equal(findTailscaleIp({ "Wi-Fi": nics["Wi-Fi"] }), null);
  // 100.128.x は CGNAT の範囲外
  assert.equal(findTailscaleIp({ x: [{ family: "IPv4", internal: false, address: "100.128.0.1" }] }), null);
});

test("スマホ公開オフならループバックだけで待つ", () => {
  const on = serverEnv({ ...defaultConfig(HOME), remoteAccess: true }, 8770);
  assert.equal(on.GRAPHWRANGLER_HOST, "0.0.0.0");
  assert.equal(on.GRAPHWRANGLER_ALLOW_REMOTE, "tailscale");
  const off = serverEnv({ ...defaultConfig(HOME), remoteAccess: false }, 8771);
  assert.equal(off.GRAPHWRANGLER_HOST, "127.0.0.1");
  assert.equal(off.GRAPHWRANGLER_PORT, "8771");
});

test("上げ直しの待ちは倍々で延び、30秒で頭打ち", () => {
  assert.equal(restartDelayMs(1), 1000);
  assert.equal(restartDelayMs(2), 2000);
  assert.equal(restartDelayMs(10), 30_000);
});
