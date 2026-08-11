// graphwrangler 実行エンジンのエントリポイント（package.json の start / dev の入口）。
// 起動時の設定読み込み・常駐ループ・プロセス終了はここだけが持ち、オーケストレーション本体
// （index.ts の tick）は import しても何も起きない副作用なしのモジュールに保つ
// （そうしないと tick 系の配線がテストから触れない）。
import { tick } from "./index.js";
import { log } from "./log.js";
import { engineConfig, engineMode, refreshEngineConfig, refreshWorkspaceInfo } from "./settings.js";

const INTERVAL_MS = Number(process.env.GW_ENGINE_INTERVAL_MS ?? 5000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const url = process.env.GRAPHWRANGLER_URL ?? "http://localhost:8770";
  await refreshEngineConfig(true); // 起動時は必ず一度取得する
  await refreshWorkspaceInfo(); // 起動時に1回、サーバの動作モード（workspace/datadir）を読む
  log(
    `graphwrangler engine 起動: url=${url} interval=${INTERVAL_MS}ms mode=${engineMode} cliPath=${engineConfig.cliPath} model=${engineConfig.model}`,
  );
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log(`tick失敗（次周に持ち越し）: ${String(err)}`);
    }
    await sleep(INTERVAL_MS);
  }
}

main();
