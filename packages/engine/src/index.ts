// graphwrangler 実行エンジンのオーケストレーション。1 tick で「どの層を・どの順で見るか」
// だけを持ち、各層の中身は tickTrigger / tickProject / tickDecision / tickRun にある。
// docs/design.md 3.4/3.5/3.8/3.9 が設計の正。
// 常駐ループ・プロセス終了はエントリの main.ts が持つ（このモジュールは import しても
// 何も起きない＝テストから tick を直接呼べる状態に保つこと）。
import { getState, heartbeat } from "./api.js";
import { refreshEngineConfig, refreshWorkspaceInfo } from "./settings.js";
import { noteServerVersion } from "./selfRestart.js";
import { tickProjectPrep } from "./prep.js";
import { tickDecision } from "./tickDecision.js";
import { tickProject } from "./tickProject.js";
import { tickRunItem } from "./tickRun.js";
import { triggerTick } from "./tickTrigger.js";
import { tickWait } from "./tickWait.js";

export async function tick(): Promise<void> {
  await refreshEngineConfig(); // 成功後は10分ごと、失敗中は毎tick再試行（内部で throttle）
  await refreshWorkspaceInfo(); // 未取得なら毎tick再試行、取得後は10分ごと（内部で throttle）

  // UIの稼働インジケータ用ハートビート（失敗しても実行は続ける）。
  // ついでにサーバ側アプリの版（HEAD sha）を見て、自動アップデートで入れ替わっていたら
  // 自分も降りる——エンジンは別プロセスなので、放っておくと古いコードのまま回り続ける
  // （プロセス管理が無い環境では降りない。selfupdate.ts と同じ原則。2026-08-05）
  void heartbeat()
    .then(({ version }) => noteServerVersion(version))
    .catch(() => {});

  const { nodes } = await getState();

  await triggerTick(nodes);

  // 待ちノード（3.17）。実行を伴わず軽いので「1tick=1件」の枠の外で毎周まとめて見る
  // （下の層が長い AI 実行で塞がっていても、待ち明けが後回しにならないように）
  await tickWait(nodes);

  // タスク優先→分岐→ラン。上の層が1件処理したらこの周はそこで終わる（1tick=1件）
  if (await tickProject(nodes)) return;

  // プロジェクト層の人間ノードの前準備（3.18）。AI を呼ぶ仕事なので「1tick=1件」の枠に入れる
  if (await tickProjectPrep(nodes)) return;

  if (await tickDecision(nodes)) return;

  await tickRunItem(nodes);
}
