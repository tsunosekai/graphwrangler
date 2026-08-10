#!/usr/bin/env node
// data-dir モード（ops.jsonl + snapshot.json + threads/ + runs/ + settings.json）から
// ワークスペースモード（ワークスペース=1ファイル化: 正データファイル + サイドカー
// .graphwrangler/）へ一回限り変換する。
//
// 使い方: node scripts/migrate-to-workspace.mjs <dataDir> <canonicalFile>
//   例: node scripts/migrate-to-workspace.mjs ./data ../s-tech/workflow.gw.json
//
// 実装メモ: packages/core は TypeScript ソースをそのまま export しており（ビルド成果物・
// dist が無い）ため、プレーンな node からは import できない（tsx 等のトランスパイラは
// server/engine パッケージの devDependency であり、リポジトリ直下からは解決できない）。
// この一回限りの変換スクリプトを追加ツール無しで動く plain node のまま保つため、
// 正データファイルの書式（決定的シリアライズ・nodes id昇順）は
// packages/core/src/stable-stringify.ts + graph.ts の writeWorkspaceFile と同じロジックを
// このファイル内に複製している。**ロジックを変えたら両方直すこと。**
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

const [, , dataDirArg, canonicalFileArg] = process.argv;
if (!dataDirArg || !canonicalFileArg) {
  fail("使い方: node scripts/migrate-to-workspace.mjs <dataDir> <canonicalFile>");
}

const dataDir = path.resolve(dataDirArg);
const canonicalFile = path.resolve(canonicalFileArg);

if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
  fail(`dataDir が見つかりません（ディレクトリではありません）: ${dataDir}`);
}
if (fs.existsSync(canonicalFile)) {
  fail(`正データファイルが既に存在します（上書きを避けるため中止）: ${canonicalFile}`);
}
if (!canonicalFile.toLowerCase().endsWith(".gw.json")) {
  console.warn(`警告: canonicalFile が ".gw.json" で終わっていません（規約外ですが続行します）: ${canonicalFile}`);
}

const workspaceRoot = path.dirname(canonicalFile);
const sidecarDir = path.join(workspaceRoot, ".graphwrangler");
const GITIGNORE_CONTENT = "ops.jsonl\nruns/\nsettings.json\n";

// ---- 1. snapshot.json → 正データファイル ----
// （packages/core/src/stable-stringify.ts の複製。同じ状態なら常にバイト一致する）

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

function writeTextAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

// NodeSchema の .default() 付きフィールド（packages/core/src/schema.ts が正。**変えたら両方直す**）。
// 旧スキーマ時代の snapshot はこれらのキーを欠いたノードを含みうる。欠いたまま書き出すと、
// サーバ起動時に zod が補完した状態で「次の1コミット目」に全ノードへ一斉付与される
// 無関係な全行diffが出る（2026-07-31 整合レビューで検出）ため、移行時点で補完しておく。
// **正は常に packages/core/src/schema.ts の NodeSchema**——ここは追随するだけの複製なので、
// 突き合わせやすいよう並び順も NodeSchema の宣言順に揃えてある（id/title/created は
// ノード側に必ずあるので既定値を持たない）。
const NODE_DEFAULTS = {
  detail: null,
  impl: null,
  implTrial: null,
  parents: [],
  group: null,
  folder: null,
  folderSection: null,
  order: null,
  kind: "task",
  executor: "human",
  approval: false,
  autonomy: "normal",
  aiModel: null,
  aiEffort: null,
  lifecycle: "draft",
  status: "unplanned",
  fixed: false,
  pendingRequest: null,
  schedule: null,
  branches: null,
  choice: null,
  outputs: null,
  parentOptions: {},
  createdBy: null,
  assignee: null,
  members: [],
};

/** 旧スキーマの値を現行スキーマへ正規化する（waiting は pendingRequest からの導出値に、
 *  impact("safe"|"reversible"|"irreversible") は approval(boolean) に変わった。2026-08-03 改名）。
 *  旧フィールド（updated 等）はサーバ読込時に zod が捨てるためここでは触らない */
function normalizeNode(n) {
  const out = { ...n };
  if (out.status === "waiting") out.status = "pending";
  if ("impact" in out) {
    if (!("approval" in out) || out.approval === undefined) out.approval = out.impact === "irreversible";
    delete out.impact;
  }
  return out;
}

const snapshotPath = path.join(dataDir, "snapshot.json");
let nodes = [];
if (fs.existsSync(snapshotPath)) {
  const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  nodes = Array.isArray(snap.nodes) ? snap.nodes : [];
} else {
  console.warn(`警告: snapshot.json が見つかりません（空グラフとして続行します）: ${snapshotPath}`);
}
// 正規化（旧impact→approval）を先に行う。defaults を先に混ぜると approval:false が
// 旧 impact:"irreversible" より勝ってしまう
nodes = nodes.map((n) => ({ ...NODE_DEFAULTS, ...normalizeNode(n) }));
// graph.ts の sortNodesById と同じ比較（id 昇順）
nodes = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

writeTextAtomic(
  canonicalFile,
  stableStringify({ format: "graphwrangler-workspace", version: 1, nodes }),
);
console.log(`正データファイルを書き出しました: ${canonicalFile}（ノード${nodes.length}件）`);

// ---- 2. サイドカー(.graphwrangler/)の準備 ----

fs.mkdirSync(sidecarDir, { recursive: true });
const gitignorePath = path.join(sidecarDir, ".gitignore");
if (!fs.existsSync(gitignorePath)) {
  fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, "utf8");
  console.log(`.gitignore を作成しました: ${gitignorePath}`);
}

// ---- 3. threads/ runs/ settings.json のコピー ----
// ops.jsonl はコピーしない: ワークスペースモードでは「再生しない・セッション内undo用の
// 作業記録」に格下げされており（docs参照）、data-dirモード時代の操作履歴を持ち込んでも
// canonical と整合する保証が無い。どのみち .gitignore 済みなので、新しいサイドカーで
// 空から始めるのが安全。

function copyDirRecursive(src, dst) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
      count += 1;
    }
  }
  return count;
}

const threadsCopied = copyDirRecursive(path.join(dataDir, "threads"), path.join(sidecarDir, "threads"));
console.log(`threads/ をコピーしました: ${threadsCopied}件`);

const runsCopied = copyDirRecursive(path.join(dataDir, "runs"), path.join(sidecarDir, "runs"));
console.log(`runs/ をコピーしました: ${runsCopied}件`);

const settingsSrc = path.join(dataDir, "settings.json");
if (fs.existsSync(settingsSrc)) {
  fs.copyFileSync(settingsSrc, path.join(sidecarDir, "settings.json"));
  console.log("settings.json をコピーしました");
} else {
  console.log("settings.json は見つかりませんでした（スキップ）");
}

console.log("");
console.log("完了。以降はワークスペースモードでサーバを起動してください:");
console.log(`  GRAPHWRANGLER_WORKSPACE="${canonicalFile}" pnpm --filter @graphwrangler/server start`);
console.log(`  （または --workspace "${canonicalFile}" をCLI引数で渡す）`);
