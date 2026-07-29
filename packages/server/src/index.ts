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
  GraphError,
  DecisionRequestSchema,
  NodeInputSchema,
  NodePatchSchema,
  ActorSchema,
  nowIso,
  type Actor,
} from "@graphwrangler/core";
import { z } from "zod";
import { chatKeyMissing, handleChat } from "./chat.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const dataDir = process.env.GRAPHWRANGLER_DATA ?? path.join(repoRoot, "data");
const port = Number(process.env.GRAPHWRANGLER_PORT ?? 8770);

const graph = new GraphStore(dataDir);
const threads = new ThreadStore(dataDir);

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
  return c.json({ ...graph.state(), now: nowIso() });
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

// ---- チャット（M4: グラフ整理の相棒AI。実装は chat.ts） ----

app.post("/api/chat", async (c) => {
  const missing = chatKeyMissing();
  if (missing) return c.json({ error: missing }, 400);
  const body = await c.req.json();
  return handleChat(graph, threads, body);
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
