#!/usr/bin/env node
// 既存インスタンスのデータを現行スキーマへ変換する（2026-08-11。後方互換レイヤの撤去に伴う一回限りの移行）。
//
// 使い方:
//   node scripts/migrate-legacy-data.mjs <workflow.gw.json か データディレクトリ> [--dry-run]
//   例（ワークスペース）: node scripts/migrate-legacy-data.mjs ../../s-tech/s-tech-workflow/workflow.gw.json
//   例（データディレクトリ）: node scripts/migrate-legacy-data.mjs ./data
//
// 何を直すか（どれも該当が無ければ素通り。冪等＝2回流しても壊れない）:
//   1. ノードの旧 impact("safe"|"irreversible") → approval(boolean)。2026-08-03 の改名。
//      互換レイヤが消えたので、変換しないと irreversible の実行前承認が黙って外れる
//   2. ラン の procedure → pageId。実態がページidなのに互換で旧名のままだったのを改名
//   3. ラン の context / snapshot の欠落を補う。どちらも必須になった。
//      snapshot（ラン作成時のグラフ）が無い旧ランは、**現在のテンプレート**から合成する
//      ——旧実装が snapshot 不在時に「現在の中身」へフォールバックしていたのと同じ意味
//   4. スレッドの旧キー payload.fireEvent → runEvent、旧マーカー "[発火前承認]" → "[ラン前承認]"
//   5. 既読の旧フラット形式 {nodeId: ts} → {version:2, shared:{...}, users:{}}
//   6. 操作ログ（ops.jsonl）のノード payload も 1 と同じ読み替え（履歴の再生で承認が落ちないように）。
//      あわせて保存されなくなった status="waiting"（現在は pendingRequest から導出）を running へ
//      ——これが残っているとサーバが起動時の操作ログ読み込みで落ちる
//
// 変換後、現行の zod スキーマで検証して結果を出す（通らなければ非ゼロ終了）。
// 元ファイルは <name>.bak-<日時> に退避する（--dry-run なら書き込まない）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// スキーマは本体の正（コピーを持つと必ずドリフトする）。TypeScript を読むので tsx で起動すること:
//   pnpm --filter @graphwrangler/server exec tsx scripts/migrate-legacy-data.mjs <対象>
const { NodeSchema, OpSchema, RunSchema } = await import(
  pathToFileURL(path.join(here, "..", "packages", "core", "src", "schema.ts")).href
);

const RUN_GATE_MARKER = "[ラン前承認]";
const LEGACY_RUN_GATE_MARKER = "[発火前承認]";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("使い方: node scripts/migrate-legacy-data.mjs <workflow.gw.json か データディレクトリ> [--dry-run]");
  process.exit(2);
}

/** 正データの置き場を判別する。ワークスペース（<repo>/workflow.gw.json + <repo>/.graphwrangler/）と
 *  データディレクトリ（<dir>/snapshot.json + <dir>/ops.jsonl + <dir>/runs/）の2モード */
function resolveLayout(t) {
  const stat = fs.statSync(t);
  if (stat.isDirectory()) {
    return { mode: "datadir", nodesFile: path.join(t, "snapshot.json"), sidecar: t };
  }
  return { mode: "workspace", nodesFile: t, sidecar: path.join(path.dirname(t), ".graphwrangler") };
}

const layout = resolveLayout(target);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const changes = [];
let touched = 0;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 元を .bak-<日時> へ退避してから書く（--dry-run では何もしない） */
function writeJson(file, value) {
  if (dryRun) return;
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${stamp}`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(file, text) {
  if (dryRun) return;
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${stamp}`);
  fs.writeFileSync(file, text, "utf8");
}

// ---- 1. ノード: impact → approval ----

/** 旧 impact を approval へ読み替えて impact キーを落とす（approval があればそちらが勝つ） */
function migrateNode(n) {
  if (!("impact" in n)) return n;
  const { impact, ...rest } = n;
  if ("approval" in rest) return rest;
  return { ...rest, approval: impact === "irreversible" };
}

const doc = readJson(layout.nodesFile);
const nodeList = Array.isArray(doc) ? doc : doc.nodes;
if (!Array.isArray(nodeList)) {
  console.error(`ノード配列が見つかりません: ${layout.nodesFile}`);
  process.exit(2);
}
const migratedNodes = nodeList.map(migrateNode);
const impactCount = nodeList.filter((n) => "impact" in n).length;
if (impactCount > 0) {
  const gated = nodeList.filter((n) => n.impact === "irreversible").length;
  changes.push(`ノード: impact → approval を ${impactCount} 件（うち実行前承認あり ${gated} 件）`);
  const next = Array.isArray(doc) ? migratedNodes : { ...doc, nodes: migratedNodes };
  writeJson(layout.nodesFile, next);
  touched += 1;
}

// ノードは id で引けるようにしておく（snapshot 合成に使う）
const nodeById = new Map(migratedNodes.map((n) => [n.id, n]));

// ---- 2-3. ラン: procedure → pageId、context / snapshot の補完 ----

/** ラン作成時のグラフが無い旧ラン向けに、現在のテンプレートから snapshot を合成する。
 *  旧実装が snapshot 不在時に「現在の中身」を見せていたのと同じ意味（当時の姿は復元できない） */
/** スナップショット1ノードを現行の NodeSnapshot の形に整える。既に焼かれている古い
 *  スナップショットにも使う——後から足されたフィールド（outputs 等）は当時のランには
 *  無く、既定が外れて必須になったぶんをここで埋める（当時の値は復元できないので既定値） */
function normalizeSnapshotNode(n) {
  return {
    id: n.id,
    title: n.title,
    detail: n.detail ?? null,
    impl: n.impl ?? null,
    parents: n.parents ?? [],
    group: n.group ?? null,
    kind: n.kind,
    executor: n.executor,
    approval: n.approval ?? (n.impact === "irreversible"),
    autonomy: n.autonomy ?? "normal",
    aiModel: n.aiModel ?? null,
    aiEffort: n.aiEffort ?? null,
    lifecycle: n.lifecycle,
    status: n.status,
    fixed: n.fixed ?? false,
    schedule: n.schedule ?? null,
    branches: n.branches ?? null,
    outputs: n.outputs ?? null,
    parentOptions: n.parentOptions ?? {},
    assignee: n.assignee ?? null,
  };
}

function snapshotFromCurrent(pageId, capturedAt) {
  const page = nodeById.get(pageId);
  const members = migratedNodes.filter((n) => n.group === pageId);
  const source = page ? [page, ...members] : members;
  return { capturedAt, nodes: source.map(normalizeSnapshotNode) };
}

const runsDir = path.join(layout.sidecar, "runs");
/** 検証は**変換後の値**に対して行う（ドライランではディスクが元のままなので、
 *  読み直すと「変換すれば直る不備」を落ちたことにしてしまう） */
const convertedRuns = [];
let renamedRuns = 0;
let filledContext = 0;
let synthesizedSnapshots = 0;
let normalizedSnapshots = 0;
if (fs.existsSync(runsDir)) {
  for (const file of fs.readdirSync(runsDir).filter((f) => f.endsWith(".json"))) {
    const full = path.join(runsDir, file);
    const run = readJson(full);
    let next = run;
    let dirty = false;

    if ("procedure" in next && !("pageId" in next)) {
      const { procedure, ...rest } = next;
      next = { pageId: procedure, ...rest };
      renamedRuns += 1;
      dirty = true;
    }
    if (!next.context) {
      next = { ...next, context: {} };
      filledContext += 1;
      dirty = true;
    }
    if (!next.snapshot) {
      next = { ...next, snapshot: snapshotFromCurrent(next.pageId, next.created) };
      synthesizedSnapshots += 1;
      dirty = true;
    } else {
      // 既に焼かれているスナップショットも、後から必須になったフィールドを埋める
      const nodes = next.snapshot.nodes.map(normalizeSnapshotNode);
      if (JSON.stringify(nodes) !== JSON.stringify(next.snapshot.nodes)) {
        next = { ...next, snapshot: { ...next.snapshot, nodes } };
        normalizedSnapshots += 1;
        dirty = true;
      }
    }
    // 現行スキーマに無い旧キー（updated 等）は落とす
    for (const key of Object.keys(next)) {
      if (!RunSchema.shape[key]) {
        const { [key]: _drop, ...rest } = next;
        next = rest;
        dirty = true;
      }
    }
    convertedRuns.push({ file, value: next });
    if (dirty) {
      writeJson(full, next);
      touched += 1;
    }
  }
}
if (renamedRuns) changes.push(`ラン: procedure → pageId を ${renamedRuns} 件`);
if (filledContext) changes.push(`ラン: context の欠落を ${filledContext} 件補完`);
if (synthesizedSnapshots)
  changes.push(`ラン: snapshot の無い旧ラン ${synthesizedSnapshots} 件を現在のテンプレートから合成`);
if (normalizedSnapshots)
  changes.push(`ラン: 既存 snapshot ${normalizedSnapshots} 件に、後から必須になったフィールドを補完`);

// ---- 4. スレッド: 旧キー・旧マーカー ----

const threadsDir = path.join(layout.sidecar, "threads");
let fixedThreadFiles = 0;
if (fs.existsSync(threadsDir)) {
  for (const file of fs.readdirSync(threadsDir).filter((f) => f.endsWith(".jsonl"))) {
    const full = path.join(threadsDir, file);
    const raw = fs.readFileSync(full, "utf8");
    if (!raw.includes("fireEvent") && !raw.includes(LEGACY_RUN_GATE_MARKER)) continue;
    const lines = raw.split("\n");
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // 壊れた行は落とす（本体の readJsonl と同じ扱い）
      }
      if (msg.payload && typeof msg.payload === "object" && "fireEvent" in msg.payload) {
        const { fireEvent, ...rest } = msg.payload;
        msg.payload = { ...rest, runEvent: msg.payload.runEvent ?? fireEvent };
      }
      if (typeof msg.body === "string" && msg.body.includes(LEGACY_RUN_GATE_MARKER)) {
        msg.body = msg.body.split(LEGACY_RUN_GATE_MARKER).join(RUN_GATE_MARKER);
      }
      out.push(JSON.stringify(msg));
    }
    writeText(full, `${out.join("\n")}\n`);
    fixedThreadFiles += 1;
    touched += 1;
  }
}
if (fixedThreadFiles) changes.push(`スレッド: 旧キー/旧マーカーを ${fixedThreadFiles} ファイルで置換`);

// ---- 5. 既読: 旧フラット形式 → v2 ----

const readsFile = path.join(layout.sidecar, "reads.json");
if (fs.existsSync(readsFile)) {
  const reads = readJson(readsFile);
  if (reads && typeof reads === "object" && reads.version !== 2) {
    // 旧形式は「誰の既読か」を持たないので、全員で共有していた既読として shared に入れる
    writeJson(readsFile, { version: 2, shared: reads, users: {} });
    changes.push(`既読: 旧フラット形式 ${Object.keys(reads).length} 件を v2 の shared へ`);
    touched += 1;
  }
}

// ---- 6. 操作ログ: ノード payload の impact → approval ----

const opsFile = path.join(layout.sidecar, "ops.jsonl");
const opsProblems = [];
if (fs.existsSync(opsFile)) {
  const out = [];
  let convertedImpact = 0;
  let convertedWaiting = 0;
  for (const [i, line] of fs.readFileSync(opsFile, "utf8").split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // 壊れた行は落とす（本体の readJsonl と同じ扱い）
    }
    // ノードの実体は payload.node（追加）と payload.patch（更新）に入る
    for (const key of ["node", "patch"]) {
      const body = rec.payload?.[key];
      if (!body || typeof body !== "object") continue;
      if ("impact" in body) {
        rec.payload[key] = migrateNode(body);
        convertedImpact += 1;
      }
      // waiting は「あなたの番」の導出値になり、保存する status から外れた。
      // 当時この値で記録された patch は、実行中（running）として残す
      if (rec.payload[key].status === "waiting") {
        rec.payload[key].status = "running";
        convertedWaiting += 1;
      }
    }
    const parsed = OpSchema.safeParse(rec);
    if (!parsed.success) {
      opsProblems.push(
        `操作ログ ${i + 1}行目 (${rec.op}): ${parsed.error.issues.map((s) => `${s.path.join(".")} ${s.message}`).join(" / ")}`,
      );
    }
    out.push(JSON.stringify(rec));
  }
  if (convertedImpact > 0 || convertedWaiting > 0) {
    writeText(opsFile, `${out.join("\n")}\n`);
    if (convertedImpact) changes.push(`操作ログ: ノード payload の impact → approval を ${convertedImpact} 件`);
    if (convertedWaiting) changes.push(`操作ログ: 保存されなくなった status="waiting" を running へ ${convertedWaiting} 件`);
    touched += 1;
  }
}

// ---- 検証: 現行スキーマを通す ----

const problems = [];
for (const n of migratedNodes) {
  const r = NodeSchema.safeParse(n);
  if (!r.success) problems.push(`ノード ${n.id}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" / ")}`);
}
for (const { file, value } of convertedRuns) {
  const r = RunSchema.safeParse(value);
  if (!r.success) problems.push(`ラン ${file}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" / ")}`);
}

console.log(`対象: ${target}（${layout.mode} モード）${dryRun ? " ※ドライラン（書き込みなし）" : ""}`);
if (changes.length === 0) console.log("  変換の必要はありませんでした");
for (const c of changes) console.log(`  - ${c}`);
if (!dryRun && touched > 0) console.log(`  元ファイルは *.bak-${stamp} に退避しました`);

problems.push(...opsProblems);
if (problems.length > 0) {
  console.error(`\n現行スキーマで通らないデータが ${problems.length} 件あります:`);
  for (const p of problems.slice(0, 20)) console.error(`  ! ${p}`);
  process.exit(1);
}
console.log(dryRun ? "検証: 変換後の想定データは現行スキーマを通ります" : "検証: 現行スキーマを通りました");
