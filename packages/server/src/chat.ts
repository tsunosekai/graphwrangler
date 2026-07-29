// 内蔵チャット（M4: グラフ整理の相棒AI）。
// Vercel AI SDK の streamText + tool-calling を使い、AIは人間のUI操作と同じ書き込み経路
// （GraphStore/ThreadStore を直接呼ぶ）でグラフを変更する。帰属は docs/agent-contracts.md の
// 規約どおり via:"chat" / actor:{kind:"agent", name:"chat:<model>"} に統一する。
// 会話履歴はステートレス（クライアントが毎回全履歴を送る。永続化はしない、design.md M4）。
import { streamText, stepCountIs, convertToModelMessages, tool, type UIMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import {
  GraphStore,
  ThreadStore,
  NodeKindSchema,
  ExecutorSchema,
  ImpactSchema,
  LifecycleSchema,
  StatusSchema,
  type Actor,
} from "@graphwrangler/core";

const VIA = "chat";

function provider(): "anthropic" | "openai" {
  return process.env.GW_CHAT_PROVIDER === "openai" ? "openai" : "anthropic";
}

function modelId(): string {
  if (process.env.GW_CHAT_MODEL) return process.env.GW_CHAT_MODEL;
  return provider() === "openai" ? "gpt-5" : "claude-sonnet-5";
}

/** APIキー未設定なら案内文を返す（ある場合は null）。index.ts のルートが 400 に変換する */
export function chatKeyMissing(): string | null {
  const hasKey = provider() === "openai" ? !!process.env.OPENAI_API_KEY : !!process.env.ANTHROPIC_API_KEY;
  if (hasKey) return null;
  return "チャットには ANTHROPIC_API_KEY（または OPENAI_API_KEY + GW_CHAT_PROVIDER=openai）を設定してください";
}

function resolveModel() {
  return provider() === "openai" ? openai(modelId()) : anthropic(modelId());
}

/** ノード要約（get_state ツール用）。フルノードでなく整理判断に要る最小フィールドだけ渡す */
function summarizeNodes(graph: GraphStore) {
  return graph.state().nodes.map((n) => ({
    id: n.id,
    title: n.title,
    kind: n.kind,
    executor: n.executor,
    status: n.status,
    group: n.group,
    parents: n.parents,
  }));
}

function systemPrompt(graph: GraphStore, pageId: string | null): string {
  let pageTitle = "(なし)";
  if (pageId && graph.has(pageId)) pageTitle = graph.get(pageId).title;
  else if (pageId) pageTitle = pageId;
  return [
    "あなたはタスクグラフ整理の相棒。ユーザーと会話しながらノードを作成・整理する。",
    "勝手に大量のノードを作らず、分解は3〜8個の人間粒度で行うこと。",
    "ユーザーが明示した手順を勝手に変えない。削除は確認してから実行すること。",
    `現在表示中のページ: ${pageTitle}`,
    "新規ノードは原則そのページ（group=現在のページ）に作ること。",
  ].join("\n");
}

function buildTools(graph: GraphStore, threads: ThreadStore, pageId: string | null, actor: Actor) {
  return {
    get_state: tool({
      description:
        "現在のグラフ全体の要約（各ノードの id/title/kind/executor/status/group/parents のみ）を取得する",
      inputSchema: z.object({}),
      execute: async () => summarizeNodes(graph),
    }),
    add_node: tool({
      description:
        "ノードを新規作成する。group を省略すると現在表示中のページに作られる。人間粒度で、勝手に大量には作らない",
      inputSchema: z.object({
        title: z.string().min(1),
        detail: z.string().nullable().optional(),
        parents: z.array(z.string()).optional(),
        group: z.string().nullable().optional(),
        kind: NodeKindSchema.optional(),
        executor: ExecutorSchema.optional(),
        impact: ImpactSchema.optional(),
        lifecycle: LifecycleSchema.optional(),
        status: StatusSchema.optional(),
        order: z.number().nullable().optional(),
      }),
      execute: async (input) =>
        graph.addNode({ ...input, group: input.group ?? pageId ?? null }, { actor, via: VIA }),
    }),
    patch_node: tool({
      description: "既存ノードを部分更新する（id 指定必須、他は変更したいフィールドだけ渡す）",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().min(1).optional(),
        detail: z.string().nullable().optional(),
        parents: z.array(z.string()).optional(),
        group: z.string().nullable().optional(),
        kind: NodeKindSchema.optional(),
        executor: ExecutorSchema.optional(),
        impact: ImpactSchema.optional(),
        lifecycle: LifecycleSchema.optional(),
        status: StatusSchema.optional(),
        order: z.number().nullable().optional(),
      }),
      execute: async ({ id, ...patch }) => graph.patchNode(id, patch, { actor, via: VIA }),
    }),
    remove_node: tool({
      description:
        "ノードを削除する。子ノードや group メンバーを持つノードは消せない。実行前に必ずユーザーへ確認すること",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        graph.removeNode(id, { actor, via: VIA });
        return { removed: true, id };
      },
    }),
    get_thread: tool({
      description: "ノードのスレッド（会話・判断・実行履歴・成果物）を取得する",
      inputSchema: z.object({ nodeId: z.string() }),
      execute: async ({ nodeId }) => threads.list(nodeId),
    }),
    post_message: tool({
      description: "ノードのスレッドに発言を投稿する",
      inputSchema: z.object({ nodeId: z.string(), body: z.string().min(1) }),
      execute: async ({ nodeId, body }) => threads.post(nodeId, { body, author: actor, via: VIA }),
    }),
  };
}

export interface ChatRequestBody {
  messages: UIMessage[];
  pageId?: string | null;
}

/** POST /api/chat のハンドラ本体。呼び出し側（index.ts）が chatKeyMissing() を先に見て 400 を返す */
export async function handleChat(
  graph: GraphStore,
  threads: ThreadStore,
  body: ChatRequestBody,
): Promise<Response> {
  const pageId = body.pageId ?? null;
  const actor: Actor = { kind: "agent", name: `chat:${modelId()}` };

  const result = streamText({
    model: resolveModel(),
    system: systemPrompt(graph, pageId),
    messages: await convertToModelMessages(body.messages ?? []),
    tools: buildTools(graph, threads, pageId, actor),
    stopWhen: stepCountIs(8),
  });

  return result.toUIMessageStreamResponse();
}
