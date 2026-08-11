// サーバ設定への追随（エンジンAI設定とワークスペースモード）。どちらも「起動時+10分ごとに
// 取得し、失敗したら前回値のまま継続する」同じ作法なのでここに束ねる。
import { getSettings, getWorkspace } from "./api.js";
import { log } from "./log.js";
import type { ClaudeExecutorConfig } from "./executors/claude.js";
import type { Node } from "./types.js";

// ---- エンジンAI設定（サーバ設定を起動時+10分ごとに読む） ----
// env GW_ENGINE_CLAUDE_MODEL があれば model はそれを優先する（取得失敗時は既定値で継続）。
const SETTINGS_REFRESH_MS = 10 * 60 * 1000; // 10分

const DEFAULT_ENGINE_CONFIG: ClaudeExecutorConfig = {
  cliPath: "claude",
  model: process.env.GW_ENGINE_CLAUDE_MODEL ?? "opus",
  effort: null,
  extraArgs: [],
  extraTools: [],
  addDirs: [],
};

/** ノード側の aiModel/aiEffort（2026-08-07 切替機能）を設定の既定へ重ねた実行時設定。
 *  null（未指定）のフィールドだけ engineConfig に従う */
export function configFor(node: Pick<Node, "aiModel" | "aiEffort">): ClaudeExecutorConfig {
  return {
    ...engineConfig,
    model: node.aiModel ?? engineConfig.model,
    effort: node.aiEffort ?? engineConfig.effort,
  };
}

// engineConfig / engineMode / workspaceRoot は「今の値」を読む側が多い（実行のたびに参照する）。
// ESM のライブバインディングでそのまま export し、代入はこのモジュールだけが行う
export let engineConfig: ClaudeExecutorConfig = DEFAULT_ENGINE_CONFIG;
// engine.mode（"cli"=claude -p 等のヘッドレスCLI起動 / "api"=サーバの /api/ai/complete を呼ぶ）。
// 取得失敗時は前回値のまま継続する（既定は安全側の "cli"）
export let engineMode: "cli" | "api" = "cli";
let lastSettingsFetchAt = 0;

/** GET /api/settings から engine executor の設定を反映する。10分未満は何もしない
 *  （force=true なら起動時など強制的に取得する）。取得失敗時は前回値のまま継続し、
 *  次 tick で再試行する（起動直後にサーバがまだ立っていないレースで10分間
 *  既定値のまま走らないため。refreshWorkspaceInfo と同じ方式） */
export async function refreshEngineConfig(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSettingsFetchAt < SETTINGS_REFRESH_MS) return;
  try {
    const settings = await getSettings();
    lastSettingsFetchAt = now;
    const modelFromEnv = process.env.GW_ENGINE_CLAUDE_MODEL;
    engineMode = settings.engine.mode === "api" ? "api" : "cli";
    engineConfig = {
      cliPath: settings.engine.cliPath || DEFAULT_ENGINE_CONFIG.cliPath,
      model: modelFromEnv ?? settings.engine.model ?? DEFAULT_ENGINE_CONFIG.model,
      effort: settings.engine.effort ?? null,
      extraArgs: Array.isArray(settings.engine.extraArgs) ? settings.engine.extraArgs : [],
      extraTools: Array.isArray(settings.engine.cliExtraTools) ? settings.engine.cliExtraTools : [],
      addDirs: Array.isArray(settings.ai?.addDirs) ? settings.ai.addDirs : [],
    };
    log(
      `エンジン設定を反映: mode=${engineMode} cliPath=${engineConfig.cliPath} model=${engineConfig.model} extraArgs=${JSON.stringify(engineConfig.extraArgs)} extraTools=${JSON.stringify(engineConfig.extraTools)} addDirs=${JSON.stringify(engineConfig.addDirs)}`,
    );
  } catch (err) {
    log(`設定取得に失敗（前回値のまま継続、次tickで再試行）: ${String(err)}`);
  }
}

// ---- ワークスペースモード: サーバの動作モード ----
// script/AI executor の cwd 決定（workspace root を渡す）と impl={type:"doc",path} の解決に使う。
// 取得失敗時は null のまま（従来の data-dir モードと同じ挙動で継続する）。
// 起動時1回きりだとエンジンがサーバより先に起動したとき恒久的に null 固定になるため
// （2026-07-31 整合レビューで検出）、未取得の間は毎 tick 再試行し、成功後は
// refreshEngineConfig と同じ 10 分間隔で追随する（サーバのモード切替再起動にも追従）

export let workspaceRoot: string | null = null;
let workspaceFetchedOk = false;
let lastWorkspaceFetchAt = 0;

export async function refreshWorkspaceInfo(): Promise<void> {
  const now = Date.now();
  if (workspaceFetchedOk && now - lastWorkspaceFetchAt < SETTINGS_REFRESH_MS) return;
  try {
    const info = await getWorkspace();
    workspaceFetchedOk = true;
    lastWorkspaceFetchAt = now;
    const prev = workspaceRoot;
    workspaceRoot = info.mode === "workspace" ? info.root : null;
    if (workspaceRoot && workspaceRoot !== prev) log(`ワークスペースモードで接続: root=${workspaceRoot}`);
  } catch (err) {
    log(`ワークスペース情報の取得に失敗（data-dirモード相当で継続）: ${String(err)}`);
  }
}
