// デスクトップ版の設定（Electron に依存しない純粋な部分。node --test で検証する）。
// 保存先は <userData>/config.json。サーバ側の settings.json（AI設定・通知など）とは別物で、
// ここに置くのは「殻」の設定だけ——どのワークスペースを開くか・どのポートで待つか・
// スマホに開くか・ログイン時に起動するか。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 8770;

/** 既定のワークスペース。空のフォルダから始める（VPS のデータは持ち込まない。2026-11-24 本人指示
 *  「一旦データに関しては空にしておいて、欲しいものだけあとで移植する」） */
export function defaultWorkspace(home = os.homedir()) {
  return path.join(home, "GraphWrangler");
}

export function defaultConfig(home = os.homedir()) {
  return {
    /** ワークスペースのフォルダ（workflow.gw.json と .graphwrangler/ が置かれる） */
    workspace: defaultWorkspace(home),
    port: DEFAULT_PORT,
    /** スマホなど他の端末から VPN（Tailscale）越しに開けるようにする */
    remoteAccess: true,
    /** ログイン時に起動する（常駐） */
    openAtLogin: true,
  };
}

/** 保存値を既定に重ねる。壊れた値・知らないキーは既定へ戻す（設定ファイルの手編集で起動不能にしない） */
export function normalizeConfig(raw, home = os.homedir()) {
  const base = defaultConfig(home);
  if (!raw || typeof raw !== "object") return base;
  const port = Number(raw.port);
  return {
    workspace: typeof raw.workspace === "string" && raw.workspace.trim() ? raw.workspace : base.workspace,
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : base.port,
    remoteAccess: typeof raw.remoteAccess === "boolean" ? raw.remoteAccess : base.remoteAccess,
    openAtLogin: typeof raw.openAtLogin === "boolean" ? raw.openAtLogin : base.openAtLogin,
  };
}

export function loadConfig(file, home = os.homedir()) {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(file, "utf8")), home);
  } catch {
    return defaultConfig(home);
  }
}

export function saveConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Tailscale の IPv4（100.64.0.0/10）を探す。無ければ null（未接続・未導入） */
export function findTailscaleIp(interfaces = os.networkInterfaces()) {
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      const [a, b] = info.address.split(".").map(Number);
      if (a === 100 && b >= 64 && b <= 127) return info.address;
    }
  }
  return null;
}

/** サーバ子プロセスへ渡す環境変数（待ち受け先とアクセス制限）。
 *  スマホ公開オン: 全インターフェイスで待ち、接続元を Tailscale に絞る（server の remote_access.ts）。
 *  オフ: ループバックだけで待つ */
export function serverEnv(config, port) {
  return {
    GRAPHWRANGLER_PORT: String(port),
    GRAPHWRANGLER_WORKSPACE: config.workspace,
    GRAPHWRANGLER_HOST: config.remoteAccess ? "0.0.0.0" : "127.0.0.1",
    GRAPHWRANGLER_ALLOW_REMOTE: config.remoteAccess ? "tailscale" : "",
    GW_SUPERVISED: "desktop",
  };
}

/** 子プロセスが落ちたときの上げ直し待ち（ms）。連続で落ちるほど延ばし、30秒で頭打ち */
export function restartDelayMs(consecutiveFailures) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, consecutiveFailures - 1));
}
