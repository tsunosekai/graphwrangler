// GraphWrangler デスクトップ常駐版（2026-11-24）。
//
// やること: サーバ（packages/server）とエンジン（packages/engine）を子プロセスとして抱え、
// トレイに常駐し、ウィンドウで UI を開く。VPS に置いていた常駐プロセス一式を PC の上へ
// 持ってくるための「殻」で、GraphWrangler 本体のコードは変えずにそのまま動かす。
//
// - ログイン時に起動してトレイへ（ウィンドウは出さない）。ウィンドウを閉じても終了しない
// - 子プロセスが落ちたら上げ直す（自動アップデートの exit 75 もここが受ける）
// - スマホからは VPN（Tailscale）越しに同じ UI を開く。待ち受けとアクセス制限は config.mjs
// - PC が止まっていた間のルーティーンは、エンジンが次に起きたとき追い付く（トリガーの catchUp）
//
// いまはリポジトリのチェックアウトから直接動かす形（tsx 実行。インストーラは未作成）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, Tray, app, dialog, ipcMain, nativeImage, shell } from "electron";
import QRCode from "qrcode";
import {
  findTailscaleIp,
  loadConfig,
  restartDelayMs,
  saveConfig,
  serverEnv,
} from "./config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const APP_ID = "co.tsuno.graphwrangler";
const RESTART_EXIT_CODE = 75; // server の selfupdate.ts / engine の selfRestart.ts と同値

app.setName("GraphWrangler");
app.setAppUserModelId(APP_ID); // Windows のトースト通知に必要

const startHidden = process.argv.includes("--hidden");
const configFile = path.join(app.getPath("userData"), "config.json");
const logDir = path.join(app.getPath("userData"), "logs");
let config = loadConfig(configFile);
let port = config.port;
let win = null;
let tray = null;
let quitting = false;

// ---- 子プロセス（サーバ / エンジン） ----

/** name → { child, failures, timer, startedAt } */
const procs = new Map();

/** 殻（このプロセス）自身の記録。いつ・どう起動したか、子の起動と終了、ログが書けなかったこと
 *  （2026-11-27: ログイン時の起動で server/engine のログが1行も残らず、エンジンが止まった理由を
 *  追えなかった）。書けなくても動作は止めない */
function desktopLog(line) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "desktop.log"), `[${new Date().toISOString()}] ${line}
`);
  } catch {
    // 記録できなくても続ける
  }
}

function logStream(name) {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `${name}.log`);
  // 起動のたびに、育ちすぎたログは1世代だけ残して切る
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch {
    // まだ無い
  }
  const stream = fs.createWriteStream(file, { flags: "a" });
  // 開けない・書けないときに 'error' を放置すると殻ごと落ちうる。記録して握る
  stream.on("error", (err) => desktopLog(`${name}.log に書けません: ${String(err)}`));
  return stream;
}

function childSpec(name) {
  const pkg = path.join(repoRoot, "packages", name);
  const entry = name === "server" ? "src/index.ts" : "src/main.ts";
  const env = {
    ...process.env,
    // Electron の実行ファイルを素の Node として使う（PATH の node に頼らない＝ログイン時の
    // 自動起動でも同じものが動く）。tsx はパッケージの node_modules から解決される
    ELECTRON_RUN_AS_NODE: "1",
    GW_SUPERVISED: "desktop",
    GRAPHWRANGLER_URL: `http://127.0.0.1:${port}`,
    ...(name === "server" ? serverEnv(config, port) : {}),
  };
  return { cwd: pkg, args: ["--import", "tsx", entry], env };
}

function startChild(name) {
  if (quitting) return;
  const state = procs.get(name) ?? { child: null, failures: 0, timer: null, startedAt: 0 };
  procs.set(name, state);
  const { cwd, args, env } = childSpec(name);
  const out = logStream(name);
  out.write(`\n---- ${new Date().toISOString()} ${name} 起動 ----\n`);
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  state.child = child;
  state.startedAt = Date.now();
  desktopLog(`${name} を起動 pid=${child.pid}`);
  child.on("error", (err) => desktopLog(`${name} を起動できません: ${String(err)}`));
  child.on("exit", (code) => {
    desktopLog(`${name} が終了 code=${code}`);
    out.end(`---- ${new Date().toISOString()} ${name} 終了 code=${code} ----\n`);
    if (state.child !== child) return; // 意図した再起動で既に次が上がっている
    state.child = null;
    if (quitting) return;
    // 1分以上動いていた・自動アップデートの上げ直し要求は「失敗の連続」に数えない
    const healthy = code === RESTART_EXIT_CODE || Date.now() - state.startedAt > 60_000;
    state.failures = healthy ? 0 : state.failures + 1;
    const delay = code === RESTART_EXIT_CODE ? 500 : restartDelayMs(state.failures);
    state.timer = setTimeout(() => startChild(name), delay);
    refreshTray();
  });
  refreshTray();
}

/** 子プロセスをツリーごと止める（サーバ/エンジンは claude CLI などの孫を持つ） */
function killChild(name) {
  const state = procs.get(name);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  const child = state.child;
  state.child = null;
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

function portFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(p, "127.0.0.1");
  });
}

/** 設定のポートが塞がっていたら次を探す（開発サーバを手で上げたまま、等） */
async function pickPort(preferred) {
  for (let p = preferred; p < preferred + 20; p++) {
    if (await portFree(p)) return p;
  }
  return preferred;
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/workspace`);
      if (res.ok) return true;
    } catch {
      // まだ上がっていない
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function startBackend() {
  fs.mkdirSync(config.workspace, { recursive: true });
  port = await pickPort(config.port);
  startChild("server");
  const ok = await waitForServer();
  startChild("engine"); // サーバが遅れていてもエンジンは自分で再試行する
  return ok;
}

async function restartBackend() {
  killChild("engine");
  killChild("server");
  await new Promise((r) => setTimeout(r, 1500)); // ポートが空くのを待つ
  const ok = await startBackend();
  if (win && !win.isDestroyed()) void win.loadURL(localUrl());
  refreshTray();
  return ok;
}

// ---- ウィンドウ ----

function localUrl() {
  return `http://127.0.0.1:${port}`;
}

function remoteUrl() {
  const ip = findTailscaleIp();
  return ip ? `http://${ip}:${port}` : null;
}

// アプリのアイコン（apps/desktop/assets。scripts/make-icon.py が UI の図柄から起こしたもの）。
// UI 同梱の icon.png は白地に灰色で、タスクバーやトレイでは白い四角に見えて埋もれる
const assetsDir = path.join(appDir, "assets");
const icoFile = path.join(assetsDir, "icon.ico");

/** ウィンドウ・タスクバー用。Windows は複数サイズ入りの .ico を渡す（小さい表示が潰れない） */
function iconImage() {
  return nativeImage.createFromPath(process.platform === "win32" ? icoFile : path.join(assetsDir, "icon.png"));
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    show,
    icon: iconImage(),
    autoHideMenuBar: true,
    // 隠れている間も UI を回し続ける——「あなたの番」のデスクトップ通知は UI 側
    // （useDesktopNotify）が出しているので、トレイに隠れた窓が止まると通知も止まる
    webPreferences: { backgroundThrottling: false, preload: path.join(here, "preload.cjs") },
  });
  // 通知をクリックしたら窓を前に出す。通知は UI が Web の Notification で出しているので、
  // ページ側の Notification を薄く包み、クリックをプリロードの橋（gwDesktop.show）へ流す。
  // UI のコードは変えない（ブラウザで開いたときは橋が無いので何も起きない）
  win.webContents.on("dom-ready", () => {
    void win.webContents
      .executeJavaScript(
        `(() => {
          if (window.__gwNotifyPatched || !window.Notification) return;
          window.__gwNotifyPatched = true;
          const Base = window.Notification;
          window.Notification = class extends Base {
            constructor(title, options) {
              super(title, options);
              this.addEventListener("click", () => window.gwDesktop && window.gwDesktop.show());
            }
          };
        })()`,
      )
      .catch(() => {});
  });
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault(); // 閉じる＝トレイへ隠すだけ。常駐は続く
    win.hide();
  });
  // UI 内の外部リンクは既定のブラウザで開く（アプリの窓を乗っ取らせない）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(localUrl())) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  void win.loadURL(localUrl());
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow(true);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** スマホで開くための URL と QR を出す小窓 */
async function showPhoneWindow() {
  const url = remoteUrl();
  const body = url
    ? `<img src="${await QRCode.toDataURL(url, { width: 240, margin: 1 })}" width="240" height="240" alt="">
       <p class="url">${url}</p>
       <p>スマホで Tailscale をオンにして、この QR を読むか URL を開いてください。<br>
       初回は Windows のファイアウォールが許可を求めることがあります（「許可」を選ぶ）。</p>`
    : `<p>Tailscale のアドレスが見つかりません。<br>この PC で Tailscale を起動・ログインしてから開き直してください。</p>`;
  const html = `<!doctype html><meta charset="utf-8"><title>スマホで開く</title>
    <style>body{font:14px/1.6 system-ui,sans-serif;margin:24px;text-align:center;color:#222;background:#fff}
    .url{font:600 15px ui-monospace,monospace;user-select:all}p{margin:12px 0}</style>${body}`;
  const w = new BrowserWindow({ width: 380, height: 470, resizable: false, autoHideMenuBar: true, icon: iconImage() });
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

// ---- 常駐（ログイン時起動・スタートメニュー） ----

function applyLoginItem() {
  // パッケージ化していないので、electron 本体にアプリのフォルダを渡して起動させる
  app.setLoginItemSettings({
    openAtLogin: config.openAtLogin,
    path: process.execPath,
    args: [appDir, "--hidden"],
  });
}

/** スタートメニューから手で起動できるようにする（Windows）。通知の発信元名もここで決まる */
function ensureStartMenuShortcut() {
  if (process.platform !== "win32") return;
  try {
    const link = path.join(
      app.getPath("appData"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "GraphWrangler.lnk",
    );
    shell.writeShortcutLink(link, fs.existsSync(link) ? "update" : "create", {
      target: process.execPath,
      args: `"${appDir}"`,
      cwd: appDir,
      description: "GraphWrangler",
      icon: icoFile,
      iconIndex: 0,
      appUserModelId: APP_ID,
    });
  } catch {
    // ショートカットが作れなくても動作には関係ない
  }
}

// ---- トレイ ----

function updateConfig(patch) {
  config = { ...config, ...patch };
  saveConfig(configFile, config);
}

function refreshTray() {
  if (!tray) return;
  const alive = (name) => Boolean(procs.get(name)?.child);
  const remote = config.remoteAccess ? remoteUrl() : null;
  tray.setToolTip(
    `GraphWrangler — サーバ${alive("server") ? "稼働中" : "停止"} / エンジン${alive("engine") ? "稼働中" : "停止"}`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "GraphWrangler を開く", click: showWindow },
      { label: "ブラウザで開く", click: () => void shell.openExternal(localUrl()) },
      { type: "separator" },
      {
        label: "スマホからのアクセス（Tailscale）",
        type: "checkbox",
        checked: config.remoteAccess,
        click: (item) => {
          updateConfig({ remoteAccess: item.checked });
          void restartBackend();
        },
      },
      {
        label: remote ? `スマホで開く…（${remote}）` : "スマホで開く…",
        enabled: config.remoteAccess,
        click: () => void showPhoneWindow(),
      },
      { type: "separator" },
      {
        label: "ログイン時に起動する",
        type: "checkbox",
        checked: config.openAtLogin,
        click: (item) => {
          updateConfig({ openAtLogin: item.checked });
          applyLoginItem();
        },
      },
      {
        label: "ログイン時に窓を開く",
        type: "checkbox",
        checked: config.showOnLogin,
        click: (item) => updateConfig({ showOnLogin: item.checked }),
      },
      { label: `ワークスペース: ${config.workspace}`, enabled: false },
      { label: "ワークスペースのフォルダを開く", click: () => void shell.openPath(config.workspace) },
      {
        label: "ワークスペースを変更…",
        click: async () => {
          const r = await dialog.showOpenDialog({
            title: "ワークスペースのフォルダを選ぶ",
            defaultPath: config.workspace,
            properties: ["openDirectory", "createDirectory"],
          });
          if (r.canceled || !r.filePaths[0]) return;
          updateConfig({ workspace: r.filePaths[0] });
          void restartBackend();
        },
      },
      { type: "separator" },
      { label: "サーバとエンジンを再起動", click: () => void restartBackend() },
      { label: "ログのフォルダを開く", click: () => void shell.openPath(logDir) },
      { type: "separator" },
      {
        label: "終了（ルーティーンも止まります）",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

// ---- 起動 ----

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  ipcMain.on("gw:show", showWindow);

  // チャットの実行ボタンと「着手」からの「開く・実行する」（docs/design.md 3.18）。
  // 呼べるのはこのアプリの UI（http://127.0.0.1:<port>）だけ——窓が別のページへ飛ばされても、
  // そのページからは PC のものを開いたりコマンドを走らせたりできない
  const fromOwnUi = (event) => {
    try {
      return new URL(event.senderFrame?.url ?? "").origin === new URL(localUrl()).origin;
    } catch {
      return false;
    }
  };
  ipcMain.handle("gw:open", async (event, target) => {
    if (!fromOwnUi(event)) return { ok: false, error: "このページからは開けません" };
    if (typeof target !== "string" || !target.trim()) return { ok: false, error: "開く対象が空です" };
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target);
      return { ok: true };
    }
    // フォルダ・ファイル。AI は区切りを / で書いてくるので OS の形へ直す。無いものは開かない
    const file = path.normalize(target);
    if (!fs.existsSync(file)) return { ok: false, error: `見つかりません: ${file}` };
    const error = await shell.openPath(file);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle("gw:run", (event, command) => {
    if (!fromOwnUi(event)) return { ok: false, error: "このページからは実行できません" };
    if (typeof command !== "string" || !command.trim()) return { ok: false, error: "コマンドが空です" };
    try {
      // 起動して手を離す（アプリやスクリプトを立ち上げる用途。終了は待たない）。作業場所はワークスペース
      const child = spawn(command, { shell: true, cwd: config.workspace, detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  app.on("window-all-closed", () => {
    // 窓が無くてもトレイで常駐し続ける（何もしない）
  });
  app.on("before-quit", () => {
    quitting = true;
    killChild("engine");
    killChild("server");
  });

  void app.whenReady().then(async () => {
    desktopLog(`---- 起動 pid=${process.pid} argv=${JSON.stringify(process.argv.slice(1))} ----`);
    saveConfig(configFile, config); // 初回起動で既定値を書き出す（手で直せるように）
    applyLoginItem();
    ensureStartMenuShortcut();

    // Windows は .ico をそのまま渡す（画面の拡大率に合うサイズを OS が選ぶ）
    tray = new Tray(
      process.platform === "win32"
        ? icoFile
        : nativeImage.createFromPath(path.join(assetsDir, "tray.png")).resize({ width: 16, height: 16 }),
    );
    tray.on("click", showWindow);
    refreshTray();

    if (!fs.existsSync(path.join(repoRoot, "apps", "ui", "dist", "index.html"))) {
      dialog.showErrorBox(
        "GraphWrangler",
        "UI がビルドされていません。リポジトリで `pnpm --filter ui build` を実行してから起動し直してください。",
      );
    }

    const ok = await startBackend();
    refreshTray();
    if (!ok) {
      dialog.showErrorBox(
        "GraphWrangler",
        `サーバが起動しませんでした。ログを確認してください:\n${path.join(logDir, "server.log")}`,
      );
    }
    desktopLog(`起動完了 hidden=${startHidden} showOnLogin=${config.showOnLogin} port=${port} server=${ok ? "ok" : "応答なし"}`);
    // ログイン時の起動（--hidden）でも、設定が ON なら窓を開く
    createWindow(!startHidden || config.showOnLogin);
    // Tailscale は後から繋がることがある。メニューの URL 表示を追随させる
    setInterval(refreshTray, 60_000).unref();
  });
}
