// UI（http://127.0.0.1:<port>）へ渡す最小限の橋。サンドボックス内のプリロードは CommonJS で書く。
// 渡すのは3つ:
//   show … ウィンドウを前に出す（通知をクリックしたとき、トレイに隠れた窓を出す）
//   open … URL・フォルダ・ファイルを開く ┐ チャットの実行ボタン（gw-actions）と「着手」から呼ぶ
//   run  … コマンドを実行する            ┘ （docs/design.md 3.18。ブラウザやスマホには無い）
// open / run は main.mjs 側で「呼んだのがこのアプリの UI か」を確かめてから実行する。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gwDesktop", {
  show: () => ipcRenderer.send("gw:show"),
  open: (target) => ipcRenderer.invoke("gw:open", String(target)),
  run: (command) => ipcRenderer.invoke("gw:run", String(command)),
});
