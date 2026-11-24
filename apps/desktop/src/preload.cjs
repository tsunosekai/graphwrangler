// UI（http://127.0.0.1:<port>）へ渡す最小限の橋。サンドボックス内のプリロードは CommonJS で書く。
// 渡すのは「ウィンドウを前に出して」の合図1つだけ——通知をクリックしたとき、トレイに隠れた
// 窓を出すために使う（main.mjs が通知のクリックにこれを結ぶ）。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gwDesktop", {
  show: () => ipcRenderer.send("gw:show"),
});
