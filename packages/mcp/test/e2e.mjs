// GraphWrangler MCP サーバの E2E テスト。
// 自分専用の HTTP サーバ（GRAPHWRANGLER_PORT/GRAPHWRANGLER_DATA で分離）を立てた上で、
// MCP サーバプロセスの stdin/stdout に JSON-RPC を直接流して全ツールの動作を確認する。
//
// 使い方: node packages/mcp/test/e2e.mjs
//   env GW_SERVER_PORT / GW_DATA_DIR / GW_SERVER_CMD で調整可（既定は下記）。

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const serverDir = path.join(repoRoot, "packages", "server");
const mcpEntry = path.join(repoRoot, "packages", "mcp", "src", "index.ts");

const port = process.env.GW_SERVER_PORT ?? "8771";
const dataDir =
  process.env.GW_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "gw-mcp-e2e-"));

function log(...args) {
  console.log("[e2e]", ...args);
}

/** サブプロセスの起動と、standard streams からのログ収集をまとめる小さなヘルパー。
 *  Windows では pnpm が .cmd 経由のため shell:true が必要 */
function spawnProc(cmd, args, opts) {
  const proc = spawn(cmd, args, { ...opts, shell: process.platform === "win32" });
  proc.stderr.on("data", (d) => process.stderr.write(`[stderr:${cmd}] ${d}`));
  return proc;
}

/** 起動したサブプロセスを確実に終わらせる。Windows では shell:true 経由なので実体
 *  （tsx の node）は cmd.exe の下にぶら下がっており、proc.kill() では cmd.exe しか死なず、
 *  サーバがポートを掴んだまま残る。プロセスツリーごと落とす */
function killTree(proc) {
  if (proc.exitCode !== null || !proc.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    proc.kill();
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

// ---- 1. HTTP サーバをバックグラウンド起動 ----

log(`starting graphwrangler server on :${port} (data=${dataDir})`);
const serverProc = spawnProc("pnpm", ["exec", "tsx", "src/index.ts"], {
  cwd: serverDir,
  env: { ...process.env, GRAPHWRANGLER_PORT: port, GRAPHWRANGLER_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverReady = false;
serverProc.stdout.on("data", (d) => {
  process.stdout.write(`[server] ${d}`);
  if (String(d).includes("graphwrangler server")) serverReady = true;
});

await waitFor(() => serverReady, 20_000, "server ready log line");
log("server ready");

// ---- 2. MCP サーバをサブプロセスとして起動し、stdio で JSON-RPC を話す ----

const mcpProc = spawnProc("pnpm", ["exec", "tsx", mcpEntry], {
  cwd: path.join(repoRoot, "packages", "mcp"),
  env: { ...process.env, GRAPHWRANGLER_URL: `http://localhost:${port}` },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map();
let nextId = 1;

mcpProc.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  for (let idx = buf.indexOf("\n"); idx >= 0; idx = buf.indexOf("\n")) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("failed to parse line:", line);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => {
      if (msg.error) reject(new Error(`RPC error [${method}]: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    mcpProc.stdin.write(JSON.stringify(payload) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`RPC timeout [${method}]`));
      }
    }, 10_000);
  });
}

function notify(method, params) {
  mcpProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function toolResultJson(result) {
  assert.ok(result?.content?.[0]?.text, `tool result にテキストが無い: ${JSON.stringify(result)}`);
  return JSON.parse(result.content[0].text);
}

let failures = 0;
async function step(label, fn) {
  try {
    await fn();
    log(`OK   ${label}`);
  } catch (err) {
    failures++;
    log(`FAIL ${label}:`, err.message);
  }
}

try {
  // 3. initialize
  await step("initialize", async () => {
    const result = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.1" },
    });
    assert.equal(result.serverInfo.name, "graphwrangler");
    notify("notifications/initialized", {});
  });

  // 4. tools/list
  let toolNames = [];
  await step("tools/list", async () => {
    const result = await rpc("tools/list", {});
    toolNames = result.tools.map((t) => t.name);
    const expected = [
      "state_get",
      "node_get",
      "node_add",
      "node_patch",
      "node_remove",
      "thread_get",
      "message_post",
      "request_open",
      "request_answer",
      "trigger_run",
      "run_context_set",
      "run_list",
      "run_get",
      "run_item_patch",
      "run_cancel",
      "run_trace",
      "undo",
      "redo",
    ];
    for (const name of expected) {
      assert.ok(toolNames.includes(name), `tool missing: ${name}`);
    }
  });

  // 5. node_add でゴールノードとタスクノードを作成
  let goalId, taskId;
  await step("tools/call node_add (goal)", async () => {
    const result = await rpc("tools/call", {
      name: "node_add",
      arguments: { title: "E2Eテストゴール", kind: "goal" },
    });
    const node = toolResultJson(result);
    assert.equal(node.title, "E2Eテストゴール");
    assert.equal(node.kind, "goal");
    goalId = node.id;
  });

  await step("tools/call node_add (task, groupあり)", async () => {
    const result = await rpc("tools/call", {
      name: "node_add",
      arguments: { title: "E2Eテストタスク", group: goalId, executor: "ai", approval: true },
    });
    const node = toolResultJson(result);
    assert.equal(node.group, goalId);
    assert.equal(node.executor, "ai");
    taskId = node.id;
  });

  // 5.5 node_add: branches / parentOptions / fixed が入力スキーマを通ってサーバへ届くこと
  await step("tools/call node_add (decision: branches/parentOptions/fixed)", async () => {
    const decision = toolResultJson(
      await rpc("tools/call", {
        name: "node_add",
        arguments: {
          title: "E2Eテスト分岐",
          kind: "decision",
          group: goalId,
          branches: [
            { id: "go", label: "進む", then: "そのまま進める" },
            { id: "back", label: "戻す", then: "前段からやり直す" },
          ],
          fixed: true,
        },
      }),
    );
    assert.equal(decision.kind, "decision");
    assert.equal(decision.fixed, true);
    assert.deepEqual(
      (decision.branches ?? []).map((b) => b.id),
      ["go", "back"],
      "branches がそのまま保存されている",
    );

    const child = toolResultJson(
      await rpc("tools/call", {
        name: "node_add",
        arguments: {
          title: "E2Eテスト分岐の子",
          group: goalId,
          parents: [decision.id],
          parentOptions: { [decision.id]: "go" },
        },
      }),
    );
    assert.deepEqual(child.parentOptions, { [decision.id]: "go" });

    // 後片付け（fixed 済みの decision は force が要る）
    toolResultJson(await rpc("tools/call", { name: "node_remove", arguments: { nodeId: child.id } }));
    toolResultJson(
      await rpc("tools/call", { name: "node_remove", arguments: { nodeId: decision.id, force: true } }),
    );
  });

  // 6. state_get: 要約形であること
  await step("tools/call state_get", async () => {
    const result = await rpc("tools/call", { name: "state_get", arguments: {} });
    const state = toolResultJson(result);
    assert.ok(state.nodeCount >= 2, "nodeCount should include the two new nodes");
    assert.ok(state.pages.some((p) => p.id === goalId), "goal should appear as a page");
    const taskSummary = state.nodes.find((n) => n.id === taskId);
    assert.ok(taskSummary, "task should appear in nodes summary");
    assert.equal(taskSummary.detail, undefined, "summary must not include detail");
    assert.equal(taskSummary.impl, undefined, "summary must not include impl");
  });

  // 7. node_get: 全フィールド
  await step("tools/call node_get", async () => {
    const result = await rpc("tools/call", { name: "node_get", arguments: { nodeId: taskId } });
    const node = toolResultJson(result);
    assert.equal(node.id, taskId);
    assert.ok("detail" in node, "node_get should include detail");
    assert.ok("created" in node, "node_get should include created");

    // node_get はサーバのノード1件取得（GET /api/nodes/:id）経由。グラフ全体を返す
    // state_get と同じノードが見えていることを、要約フィールドの一致で確かめる
    const state = toolResultJson(await rpc("tools/call", { name: "state_get", arguments: {} }));
    const summary = state.nodes.find((n) => n.id === taskId);
    assert.ok(summary, "state_get にも同じノードが居る");
    for (const [key, value] of Object.entries(summary)) {
      assert.deepEqual(node[key], value, `${key} が state_get の要約と一致する`);
    }
  });

  // 8. node_patch
  await step("tools/call node_patch", async () => {
    const result = await rpc("tools/call", {
      name: "node_patch",
      arguments: { nodeId: taskId, patch: { status: "running", detail: "実行中にした" } },
    });
    const node = toolResultJson(result);
    assert.equal(node.status, "running");
    assert.equal(node.detail, "実行中にした");
  });

  // 9. message_post + thread_get
  await step("tools/call message_post + thread_get", async () => {
    const posted = toolResultJson(
      await rpc("tools/call", {
        name: "message_post",
        arguments: { nodeId: taskId, body: "作業を開始します", kind: "say" },
      }),
    );
    assert.equal(posted.body, "作業を開始します");
    assert.equal(posted.via, "mcp");
    assert.equal(posted.author.name, "mcp");

    const thread = toolResultJson(
      await rpc("tools/call", { name: "thread_get", arguments: { nodeId: taskId } }),
    );
    assert.ok(thread.messages.some((m) => m.id === posted.id), "posted message should be in thread");
  });

  // 10. request_open
  let requestMsgId;
  await step("tools/call request_open", async () => {
    const message = toolResultJson(
      await rpc("tools/call", {
        name: "request_open",
        arguments: {
          nodeId: taskId,
          request: {
            context: "E2Eテスト用の判断リクエスト",
            question: "続けますか？",
            options: [
              { id: "go", label: "続ける", then: "そのまま完了させる", recommended: true },
              { id: "stop", label: "止める", then: "ここで中断する" },
            ],
            impact: "reversible",
            undo: "いつでも取り消せる",
          },
        },
      }),
    );
    assert.equal(message.kind, "decision_request");
    requestMsgId = message.id;

    // 「あなたの番」は status ではなく pendingRequest で表す（status は変わらない）
    const node = toolResultJson(await rpc("tools/call", { name: "node_get", arguments: { nodeId: taskId } }));
    assert.equal(node.status, "running");
    assert.equal(node.pendingRequest, requestMsgId);
  });

  // 10.5 二重オープンは失敗すること（isError 経路の確認）
  await step("tools/call request_open (二重オープンはisError)", async () => {
    const result = await rpc("tools/call", {
      name: "request_open",
      arguments: {
        nodeId: taskId,
        request: {
          context: "二重オープンテスト",
          question: "?",
          options: [
            { id: "a", label: "a", then: "a" },
            { id: "b", label: "b", then: "b" },
          ],
          impact: "safe",
        },
      },
    });
    assert.equal(result.isError, true, "should be isError");
    assert.ok(result.content[0].text.includes("already has an open request"));
  });

  // 11. request_answer
  await step("tools/call request_answer", async () => {
    const result = toolResultJson(
      await rpc("tools/call", {
        name: "request_answer",
        arguments: { nodeId: taskId, requestId: requestMsgId, option: "go", note: "OK" },
      }),
    );
    assert.equal(result.resolved, true);
    assert.equal(result.node.pendingRequest, null);
    assert.equal(result.node.status, "pending");
  });

  // 12. 存在しないノードへの操作は isError になること（プロセスは落ちない）
  await step("tools/call node_get (存在しないid はisError)", async () => {
    const result = await rpc("tools/call", { name: "node_get", arguments: { nodeId: "n-does-not-exist" } });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("node not found: n-does-not-exist"));
  });

  // 12.5 ラン操作系: ルーティーンページ（goal + trigger + committed メンバー）を作ってラン一式を回す
  let pageId, triggerId, memberId, runId;
  await step("tools/call node_add (ルーティーンページ=goal)", async () => {
    const node = toolResultJson(
      await rpc("tools/call", {
        name: "node_add",
        arguments: { title: "E2Eテストルーティーン", kind: "goal" },
      }),
    );
    assert.equal(node.kind, "goal");
    pageId = node.id;
  });

  await step("tools/call node_add (trigger)", async () => {
    const node = toolResultJson(
      await rpc("tools/call", {
        name: "node_add",
        arguments: {
          title: "E2Eテスト起点",
          kind: "trigger",
          group: pageId,
          lifecycle: "committed",
          schedule: "every 15m",
        },
      }),
    );
    assert.equal(node.kind, "trigger");
    assert.equal(node.schedule, "every 15m", "schedule が入力スキーマを通って保存される");
    triggerId = node.id;
  });

  await step("tools/call node_add (メンバー, committed)", async () => {
    const node = toolResultJson(
      await rpc("tools/call", {
        name: "node_add",
        arguments: {
          title: "E2Eテスト手順アイテム",
          group: pageId,
          parents: [triggerId],
          lifecycle: "committed",
        },
      }),
    );
    assert.equal(node.group, pageId);
    assert.equal(node.lifecycle, "committed");
    memberId = node.id;
  });

  await step("tools/call trigger_run", async () => {
    const run = toolResultJson(
      await rpc("tools/call", { name: "trigger_run", arguments: { nodeId: triggerId } }),
    );
    assert.equal(run.pageId, pageId);
    assert.equal(run.status, "running");
    assert.equal(run.items[memberId].status, "pending");
    // via 省略時は withMeta の既定 "mcp" が run.trigger に刻まれる
    assert.equal(run.trigger, `trigger:${triggerId}:mcp`);
    runId = run.id;
  });

  await step("tools/call trigger_run (via指定が既定より優先される)", async () => {
    const run = toolResultJson(
      await rpc("tools/call", {
        name: "trigger_run",
        arguments: { nodeId: triggerId, via: "e2e-external" },
      }),
    );
    assert.equal(run.trigger, `trigger:${triggerId}:e2e-external`);
    // 後続の「全アイテムdoneでラン自動完了」を乱さないよう閉じておく
    toolResultJson(await rpc("tools/call", { name: "run_cancel", arguments: { runId: run.id } }));
  });

  await step("tools/call run_list (要約形であること)", async () => {
    const result = toolResultJson(
      await rpc("tools/call", { name: "run_list", arguments: { pageId } }),
    );
    const summary = result.runs.find((r) => r.id === runId);
    assert.ok(summary, "作成したランが一覧に出る");
    assert.equal(summary.itemCounts.pending, 1);
    assert.equal(summary.items, undefined, "run_list はitems詳細を含まない（要約のみ）");
  });

  await step("tools/call run_get (詳細形であること)", async () => {
    const run = toolResultJson(await rpc("tools/call", { name: "run_get", arguments: { runId } }));
    assert.equal(run.id, runId);
    assert.ok(run.items[memberId], "run_get はitems詳細を含む");
    // snapshot はページ構成まるごとではなく {capturedAt, nodeCount} の要約で返る
    assert.ok(run.snapshot, "新しいランには snapshot 要約が付く");
    assert.equal(run.snapshot.nodes, undefined, "snapshot のノード本体は含まない（要約のみ）");
    assert.ok(typeof run.snapshot.capturedAt === "string", "capturedAt を含む");
    assert.equal(run.snapshot.nodeCount, 3, "ページ自身+trigger+メンバーの3ノードぶん");
  });

  await step("tools/call run_context_set (mergeされ、監査statusがトレースに乗る)", async () => {
    const first = toolResultJson(
      await rpc("tools/call", {
        name: "run_context_set",
        arguments: { runId, set: { remix: "RMX-1", memo: "初回" } },
      }),
    );
    assert.equal(first.id, runId);
    assert.deepEqual(first.context, { remix: "RMX-1", memo: "初回" });

    // 同一ラン内は last-write-wins の merge（既存キーは上書き、触れないキーは残る）
    const merged = toolResultJson(
      await rpc("tools/call", {
        name: "run_context_set",
        arguments: { runId, set: { remix: "RMX-2" }, nodeId: memberId },
      }),
    );
    assert.deepEqual(merged.context, { remix: "RMX-2", memo: "初回" });

    const run = toolResultJson(await rpc("tools/call", { name: "run_get", arguments: { runId } }));
    assert.deepEqual(run.context, { remix: "RMX-2", memo: "初回" }, "run_get から読み直しても同じ");

    // nodeId 指定ぶんはワークアイテムのスレッドへ積まれるのでラントレースに乗る
    // （nodeId 省略ぶんはトリガーノード宛＝トレース対象外。server の /api/runs/:id/context）
    const trace = toolResultJson(await rpc("tools/call", { name: "run_trace", arguments: { runId } }));
    assert.ok(
      trace.events.some((e) => e.body === "コンテキスト更新: remix=RMX-2"),
      "コンテキスト更新の監査statusがトレースに乗る",
    );
  });

  await step("tools/call run_context_set (存在しないランは isError)", async () => {
    const result = await rpc("tools/call", {
      name: "run_context_set",
      arguments: { runId: "run-does-not-exist", set: { a: "1" } },
    });
    assert.equal(result.isError, true);
  });

  await step("tools/call run_item_patch (全アイテムdoneでラン自動完了)", async () => {
    const run = toolResultJson(
      await rpc("tools/call", {
        name: "run_item_patch",
        arguments: { runId, nodeId: memberId, status: "done", note: "E2Eで完了扱いにした" },
      }),
    );
    assert.equal(run.items[memberId].status, "done");
    assert.equal(run.items[memberId].note, "E2Eで完了扱いにした");
    assert.equal(run.status, "done", "唯一のアイテムがdoneになったのでラン全体もdoneになるはず");
  });

  await step("tools/call run_trace (紐づくメッセージが時系列で返る)", async () => {
    const result = toolResultJson(await rpc("tools/call", { name: "run_trace", arguments: { runId } }));
    assert.ok(Array.isArray(result.events) && result.events.length > 0, "trace にイベントがある");
    // トレースは body 文言ではなく payload.runId で紐づく（server の /api/runs/:id/trace）
    assert.ok(
      result.events.every((e) => e.payload?.runId === runId),
      "全イベントがこのランに紐づく",
    );
    assert.ok(
      result.events.some((e) => typeof e.body === "string" && e.body.includes("pending → done")),
      "ワークアイテムの状態遷移がトレースに乗る",
    );
    const timestamps = result.events.map((e) => e.ts);
    assert.deepEqual(timestamps, [...timestamps].sort(), "ts 昇順で返る");
  });

  await step("tools/call run_cancel (2本目のランを中断)", async () => {
    const secondRun = toolResultJson(
      await rpc("tools/call", { name: "trigger_run", arguments: { nodeId: triggerId } }),
    );
    const cancelled = toolResultJson(
      await rpc("tools/call", { name: "run_cancel", arguments: { runId: secondRun.id } }),
    );
    assert.equal(cancelled.status, "cancelled");
  });

  // 12.6 undo / redo: グラフ本体の操作ログのみが対象（スレッド/ランは対象外）
  await step("tools/call undo + redo (直近のnode_addを取り消し→やり直す)", async () => {
    const scratch = toolResultJson(
      await rpc("tools/call", { name: "node_add", arguments: { title: "undo/redo用の使い捨てノード" } }),
    );
    const undone = toolResultJson(await rpc("tools/call", { name: "undo", arguments: {} }));
    // undo/redo が返す op は「打ち消した対象そのもの」の op（GraphStore.compensate の target。
    // 内部で追記する補償opそのものではない）。node_add を取り消した → 対象は node.add
    assert.equal(undone.undone.op, "node.add");

    const afterUndo = await rpc("tools/call", { name: "node_get", arguments: { nodeId: scratch.id } });
    assert.equal(afterUndo.isError, true, "undo後はノードが消えているはず");

    const redone = toolResultJson(await rpc("tools/call", { name: "redo", arguments: {} }));
    // redo の対象は「直前の undo が追記した node.remove（補償op）」自身なので op は node.remove
    assert.equal(redone.redone.op, "node.remove");

    const afterRedo = toolResultJson(
      await rpc("tools/call", { name: "node_get", arguments: { nodeId: scratch.id } }),
    );
    assert.equal(afterRedo.id, scratch.id, "redo後はノードが復活しているはず");

    // 後片付け
    toolResultJson(await rpc("tools/call", { name: "node_remove", arguments: { nodeId: scratch.id } }));
  });

  // 12.7 後片付け: ルーティーンページまわり
  await step("tools/call node_remove (メンバー+trigger+ページ の後片付け)", async () => {
    toolResultJson(await rpc("tools/call", { name: "node_remove", arguments: { nodeId: memberId } }));
    toolResultJson(await rpc("tools/call", { name: "node_remove", arguments: { nodeId: triggerId } }));
    toolResultJson(await rpc("tools/call", { name: "node_remove", arguments: { nodeId: pageId } }));
  });

  // 13. node_remove
  await step("tools/call node_remove", async () => {
    const result = toolResultJson(
      await rpc("tools/call", { name: "node_remove", arguments: { nodeId: taskId } }),
    );
    assert.equal(result.removed, true);
  });
  await step("tools/call node_remove (goal も掃除)", async () => {
    const result = toolResultJson(
      await rpc("tools/call", { name: "node_remove", arguments: { nodeId: goalId } }),
    );
    assert.equal(result.removed, true);
  });
} finally {
  killTree(mcpProc);
  killTree(serverProc);
}

if (failures > 0) {
  log(`${failures} 件失敗`);
  process.exit(1);
} else {
  log("全ツール確認 OK");
  process.exit(0);
}
