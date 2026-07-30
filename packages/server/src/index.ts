// graphwrangler API サーバ。コアの GraphStore / ThreadStore を HTTP で公開する。
// UI も MCP も将来の executor も、全員がこの API（＝操作ログ）を通る。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  GraphStore,
  ThreadStore,
  RunStore,
  GraphError,
  DecisionRequestSchema,
  NodeInputSchema,
  NodePatchSchema,
  ActorSchema,
  RunItemStatusSchema,
  nowIso,
  type Actor,
} from "@graphwrangler/core";
import { z } from "zod";
import { chatKeyMissing, completeText, handleChat } from "./chat.js";
import { handleChatCli } from "./chat_cli.js";
import { SettingsStore, ChatSettingsSchema, EngineSettingsSchema } from "./settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const dataDir = process.env.GRAPHWRANGLER_DATA ?? path.join(repoRoot, "data");
const port = Number(process.env.GRAPHWRANGLER_PORT ?? 8770);

const graph = new GraphStore(dataDir);
const threads = new ThreadStore(dataDir);
const runs = new RunStore(dataDir);
const settings = new SettingsStore(dataDir);

/** ラン既定タイトル「MM/DD HH:mm のラン」（docs/design.md 3.8） */
function defaultRunTitle(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi} のラン`;
}

const app = new Hono();
app.use("/api/*", cors());

/** リクエストボディから帰属メタ（actor/via）を取り出す。既定は human/ui */
function meta(body: Record<string, unknown>): { actor: Actor; via: string } {
  const actor = body.actor ? ActorSchema.parse(body.actor) : { kind: "human" as const };
  const via = typeof body.via === "string" ? body.via : "ui";
  return { actor, via };
}

app.onError((err, c) => {
  if (err instanceof GraphError) {
    return c.json({ error: err.message }, err.status as 400);
  }
  if (err instanceof z.ZodError) {
    return c.json({ error: err.issues.map((i) => i.message).join("; ") }, 400);
  }
  console.error(err);
  return c.json({ error: String(err) }, 500);
});

// ---- グラフ ----

app.get("/api/state", (c) => {
  // threadMeta: 未読バッジ用にノードごとの最終メッセージ時刻を添える（クライアントが
  // localStorage の既読時刻と比較する）。スレッドファイルは小さいので毎回読んで良い規模
  const threadMeta: Record<string, string> = {};
  for (const n of graph.state().nodes) {
    const msgs = threads.list(n.id);
    if (msgs.length > 0) threadMeta[n.id] = msgs[msgs.length - 1].ts;
  }
  return c.json({ ...graph.state(), threadMeta, now: nowIso() });
});

// ---- エクスポート（バックアップ用の一括JSON。APIキーは含まれない） ----

app.get("/api/export", (c) => {
  const nodes = graph.state().nodes;
  const threadDump: Record<string, unknown> = {};
  const runDump: Record<string, unknown> = {};
  for (const n of nodes) {
    const msgs = threads.list(n.id);
    if (msgs.length > 0) threadDump[n.id] = msgs;
    if (n.kind === "procedure") runDump[n.id] = runs.list(n.id);
  }
  c.header("Content-Disposition", `attachment; filename="graphwrangler-export.json"`);
  return c.json({
    exportedAt: nowIso(),
    nodes,
    threads: threadDump,
    runs: runDump,
    settings: settings.publicView(),
  });
});

// ---- エンジン稼働ハートビート（UIの稼働インジケータ用。メモリ保持のみ） ----

let engineLastSeen: string | null = null;

app.post("/api/engine/heartbeat", (c) => {
  engineLastSeen = nowIso();
  return c.json({ ok: true });
});

app.get("/api/engine/status", (c) => {
  const alive =
    engineLastSeen !== null && Date.now() - new Date(engineLastSeen).getTime() < 20_000;
  return c.json({ alive, lastSeen: engineLastSeen });
});

app.post("/api/nodes", async (c) => {
  const body = await c.req.json();
  const node = graph.addNode(NodeInputSchema.parse(body), meta(body));
  return c.json(node);
});

app.post("/api/nodes/:id", async (c) => {
  const body = await c.req.json();
  const node = graph.patchNode(c.req.param("id"), NodePatchSchema.parse(body), meta(body));
  return c.json(node);
});

app.post("/api/nodes/:id/remove", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  graph.removeNode(c.req.param("id"), meta(body));
  return c.json({ removed: true });
});

// ---- スレッド ----

app.get("/api/nodes/:id/thread", (c) => {
  graph.get(c.req.param("id"));
  return c.json({ messages: threads.list(c.req.param("id")) });
});

const PostMessageSchema = z.object({
  kind: z.enum(["say", "status", "artifact"]).default("say"),
  body: z.string().min(1),
  payload: z.unknown().optional(),
});

app.post("/api/nodes/:id/messages", async (c) => {
  const id = c.req.param("id");
  graph.get(id);
  const body = await c.req.json();
  const input = PostMessageSchema.parse(body);
  const m = meta(body);
  const message = threads.post(id, { ...input, author: m.actor, via: m.via });
  return c.json(message);
});

/** 判断リクエストを開く（主に agent 側が使う）。ノードは waiting になる */
app.post("/api/nodes/:id/request", async (c) => {
  const id = c.req.param("id");
  const node = graph.get(id);
  if (node.pendingRequest) {
    throw new GraphError(`node already has an open request: ${node.pendingRequest}`, 409);
  }
  const body = await c.req.json();
  const m = meta(body);
  const message = threads.openRequest(
    id,
    DecisionRequestSchema.parse(body.request),
    { author: m.actor.kind === "human" ? { kind: "agent" } : m.actor, via: m.via },
  );
  graph.patchNode(
    id,
    { pendingRequest: message.id, status: "waiting" },
    { actor: { kind: "system" }, via: m.via },
  );
  return c.json(message);
});

const AnswerSchema = z.object({
  requestId: z.string(),
  option: z.string().nullable(),
  note: z.string().nullable().default(null),
});

/** 判断リクエストに答える。選択肢を選んだら pendingRequest が解け、ボールが戻る */
app.post("/api/nodes/:id/answer", async (c) => {
  const id = c.req.param("id");
  graph.get(id);
  const body = await c.req.json();
  const m = meta(body);
  const { message, resolved } = threads.answerRequest(id, AnswerSchema.parse(body), {
    author: m.actor,
    via: m.via,
  });
  if (resolved) {
    graph.patchNode(
      id,
      { pendingRequest: null, status: "pending" },
      { actor: { kind: "system" }, via: m.via },
    );
  }
  return c.json({ message, resolved, node: graph.get(id) });
});

// ---- 分岐ノード（kind=decision。docs/design.md 3.9） ----
// choice 確定 + skip伝搬は GraphStore.applyDecision に一任する（1トランザクション=複数patch opsの連続）。
// UI が直接叩く経路とエンジン(executor=script/ai の結果、または human回答後)が叩く経路の両方が正。

const DecideSchema = z.object({ choice: z.string().min(1) });

app.post("/api/nodes/:id/decide", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { choice } = DecideSchema.parse(body);
  const m = meta(body);
  const updated = graph.applyDecision(id, choice, { actor: m.actor, via: m.via });
  const label = updated.branches?.find((b) => b.id === choice)?.label ?? choice;
  threads.post(id, {
    kind: "status",
    body: `分岐: ${label} を選択`,
    payload: { choice },
    author: m.actor,
    via: m.via,
  });
  return c.json(updated);
});

// ---- 手順ページ: ラン（実行インスタンス。docs/design.md 3.7/3.8） ----

const CreateRunSchema = z.object({
  title: z.string().min(1).optional(),
  trigger: z.string().min(1).optional(),
});

/** ラン作成。procedure のメンバー（group=:id）からワークアイテムを組み立てる */
app.post("/api/procedures/:id/runs", async (c) => {
  const id = c.req.param("id");
  const node = graph.get(id);
  if (node.kind !== "procedure") {
    throw new GraphError(`node ${id} is not a procedure (kind=${node.kind})`, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const input = CreateRunSchema.parse(body);
  const members = graph.state().nodes.filter((n) => n.group === id);
  const run = runs.create(id, members, {
    title: input.title ?? defaultRunTitle(),
    trigger: input.trigger ?? "manual",
  });
  const m = meta(body);
  threads.post(id, {
    kind: "status",
    body: `ラン開始: ${run.title}`,
    payload: { runId: run.id },
    author: m.actor,
    via: m.via,
  });
  return c.json(run);
});

app.get("/api/procedures/:id/runs", (c) => {
  const id = c.req.param("id");
  graph.get(id);
  return c.json({ runs: runs.list(id) });
});

app.get("/api/runs/:id", (c) => {
  return c.json(runs.get(c.req.param("id")));
});

const PatchRunItemSchema = z.object({
  status: RunItemStatusSchema.optional(),
  note: z.string().nullable().optional(),
});

/** ワークアイテム更新。テンプレートノードのスレッドへ状態遷移を記録し、
 *  ラン全体が done に転じたら procedure ノードのスレッドにも記録する */
app.post("/api/runs/:id/items/:nodeId", async (c) => {
  const runId = c.req.param("id");
  const nodeId = c.req.param("nodeId");
  const before = runs.get(runId);
  const beforeItem = before.items[nodeId];
  if (!beforeItem) {
    throw new GraphError(`run ${runId} has no work item for node ${nodeId}`, 404);
  }
  const body = await c.req.json();
  const input = PatchRunItemSchema.parse(body);
  const run = runs.patchItem(runId, nodeId, { status: input.status, note: input.note });
  const m = meta(body);
  const node = graph.get(nodeId);
  const fromStatus = beforeItem.status;
  const toStatus = run.items[nodeId].status;
  threads.post(nodeId, {
    kind: "status",
    body: `[ラン ${runId}] ${node.title}: ${fromStatus} → ${toStatus}`,
    payload: { runId },
    author: m.actor,
    via: m.via,
  });
  if (before.status !== "done" && run.status === "done") {
    threads.post(run.procedure, {
      kind: "status",
      body: `ラン完了: ${run.title}`,
      payload: { runId },
      author: { kind: "system" },
      via: m.via,
    });
  }
  return c.json(run);
});

const DecideRunItemSchema = z.object({ choice: z.string().min(1) });

/** ラン内の分岐アイテム(kind=decision)の choice を確定する（docs/design.md 3.9のラン内版）。
 *  templates は procedure の全メンバー（RunStore.applyItemDecision が parentOptions/branches の
 *  定義を引くのに必要。ラン作成時と同じ group=procedure フィルタ） */
app.post("/api/runs/:id/items/:nodeId/decide", async (c) => {
  const runId = c.req.param("id");
  const nodeId = c.req.param("nodeId");
  const run = runs.get(runId);
  const node = graph.get(nodeId);
  const body = await c.req.json();
  const { choice } = DecideRunItemSchema.parse(body);
  const m = meta(body);
  const templates = graph.state().nodes.filter((n) => n.group === run.procedure);
  const updated = runs.applyItemDecision(runId, nodeId, choice, templates);
  const label = node.branches?.find((b) => b.id === choice)?.label ?? choice;
  threads.post(nodeId, {
    kind: "status",
    body: `[ラン ${runId}] 分岐: ${label} を選択`,
    payload: { runId, choice },
    author: m.actor,
    via: m.via,
  });
  if (run.status !== "done" && updated.status === "done") {
    threads.post(run.procedure, {
      kind: "status",
      body: `ラン完了: ${run.title}`,
      payload: { runId },
      author: { kind: "system" },
      via: m.via,
    });
  }
  return c.json(updated);
});

app.post("/api/runs/:id/cancel", (c) => {
  return c.json(runs.cancel(c.req.param("id")));
});

/** トレース再生: procedure ノード+全メンバーのスレッドから payload.runId が一致する
 *  メッセージを集め、ts 昇順で返す（docs/design.md 3.8「トレース」） */
app.get("/api/runs/:id/trace", (c) => {
  const runId = c.req.param("id");
  const run = runs.get(runId);
  const nodeIds = [run.procedure, ...Object.keys(run.items)];
  const events: Array<ReturnType<typeof threads.list>[number] & { nodeTitle: string }> = [];
  for (const nodeId of nodeIds) {
    if (!graph.has(nodeId)) continue;
    const node = graph.get(nodeId);
    for (const msg of threads.list(nodeId)) {
      const payload = msg.payload as { runId?: string } | null;
      if (payload && payload.runId === runId) {
        events.push({ ...msg, nodeTitle: node.title });
      }
    }
  }
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return c.json({ events });
});

// ---- 元に戻す / やり直す（操作ログの補償追記。core の undoLast/redoLast） ----

app.post("/api/undo", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const undone = graph.undoLast(meta(body));
  if (!undone) return c.json({ error: "戻せる操作がありません" }, 400);
  return c.json({ undone: { id: undone.id, op: undone.op, ts: undone.ts } });
});

app.post("/api/redo", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const redone = graph.redoLast(meta(body));
  if (!redone) return c.json({ error: "やり直せる操作がありません" }, 400);
  return c.json({ redone: { id: redone.id, op: redone.op, ts: redone.ts } });
});

// ---- AI設定（初回セットアップ + ⚙。実装は settings.ts。キーの値は返さない） ----

const SettingsPatchSchema = z.object({
  chat: ChatSettingsSchema.partial().optional(),
  engine: EngineSettingsSchema.partial().optional(),
  setupDone: z.boolean().optional(),
});

app.get("/api/settings", (c) => c.json(settings.publicView()));

app.post("/api/settings", async (c) => {
  const body = SettingsPatchSchema.parse(await c.req.json());
  settings.update(body);
  return c.json(settings.publicView());
});

// ---- チャット（M4: グラフ整理の相棒AI。実装は chat.ts / chat_cli.ts） ----
// chat.mode="cli" ならヘッドレスCLI（chat_cli.ts、MCP経由でグラフ操作）へ、
// "api" なら従来どおりプロバイダAPIキー方式（chat.ts）へ分岐する。
// APIキー未設定の400判定は api モードのときだけ行う（cliモードにAPIキーは無関係）。

app.post("/api/chat", async (c) => {
  const body = await c.req.json();
  if (settings.get().chat.mode === "cli") {
    return handleChatCli(graph, settings, body, port);
  }
  const missing = chatKeyMissing(settings);
  if (missing) return c.json({ error: missing }, 400);
  return handleChat(graph, threads, settings, body);
});

// ---- エンジンの API 方式（engine.mode="api"）向け: ツールなしの単発テキスト生成 ----
// engine executor（packages/engine/src/executors/api.ts）がこれを叩く。
// プロバイダ/キーはチャット設定を間借りするため、キー未設定の判定もチャット側で行う。

const AiCompleteSchema = z.object({
  prompt: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
});

app.post("/api/ai/complete", async (c) => {
  const missing = chatKeyMissing(settings);
  if (missing) return c.json({ error: missing }, 400);
  const body = AiCompleteSchema.parse(await c.req.json());
  const text = await completeText(settings, body.prompt, body.maxTokens);
  return c.json({ text });
});

// ---- UI 配信（ビルド済みがあれば） ----

const uiDist = path.join(repoRoot, "apps", "ui", "dist");
if (fs.existsSync(uiDist)) {
  const root = path.relative(process.cwd(), uiDist).split(path.sep).join("/");
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

serve({ fetch: app.fetch, port }, () => {
  console.log(`graphwrangler server: http://localhost:${port} (data: ${dataDir})`);
});
