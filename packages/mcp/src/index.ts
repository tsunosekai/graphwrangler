#!/usr/bin/env node
// GraphWrangler MCP サーバ。stdio トランスポートで待ち受け、実体は
// GraphWrangler HTTP API（既定 http://localhost:8770、env GRAPHWRANGLER_URL で変更可）への薄いプロキシ。
// 全書き込みは via:"mcp" / actor:{kind:"agent",name:"mcp"} を付けて送る（docs/agent-contracts.md）。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { apiGet, apiPost, ApiError } from "./http.js";
import { DecisionRequestSchema, NodeImplSchema, NodePatchShape } from "./schemas.js";

const MCP_ACTOR = { kind: "agent" as const, name: "mcp" };
const MCP_VIA = "mcp";

/** 書き込み系リクエストの body に共通の帰属情報を付与する */
function withMeta(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, actor: MCP_ACTOR, via: MCP_VIA };
}

type NodeSummary = {
  id: unknown;
  title: unknown;
  kind: unknown;
  executor: unknown;
  status: unknown;
  impact: unknown;
  lifecycle: unknown;
  group: unknown;
  parents: unknown;
  pendingRequest: unknown;
};

/** ノード1件から要約フィールドだけを抜き出す（detail/impl は含めない = トークン節約） */
function summarize(node: Record<string, unknown>): NodeSummary {
  return {
    id: node.id,
    title: node.title,
    kind: node.kind,
    executor: node.executor,
    status: node.status,
    impact: node.impact,
    lifecycle: node.lifecycle,
    group: node.group,
    parents: node.parents,
    pendingRequest: node.pendingRequest,
  };
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof ApiError ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

/** ツールハンドラを HTTP 呼び出しでラップし、ApiError を isError の CallToolResult に変換する。
 *  プロセスは落とさない（docs/agent-contracts.md の要求）。 */
function safe<Args extends unknown[], T>(fn: (...args: Args) => Promise<T>) {
  return async (...args: Args) => {
    try {
      const result = await fn(...args);
      return textResult(result);
    } catch (err) {
      return errorResult(err);
    }
  };
}

const server = new McpServer({
  name: "graphwrangler",
  version: "0.1.0",
});

// ---- 1. state_get ----

server.registerTool(
  "state_get",
  {
    description:
      "グラフ全体の要約を取得する。ノード数、ページ（kind=goal/procedureのノード、または他ノードのgroupとして参照されている=メンバーを持つノード）の一覧、" +
      "各ノードの {id,title,kind,executor,status,impact,lifecycle,group,parents,pendingRequest} を返す。" +
      "detail/impl は含まない（トークン節約のため）。特定ノードの全フィールドが必要なら node_get を使うこと。",
    inputSchema: {},
  },
  safe(async () => {
    const state = (await apiGet("/api/state")) as { nodes: Record<string, unknown>[]; now: string };
    const nodes = state.nodes ?? [];
    const groupIds = new Set(nodes.map((n) => n.group).filter((g): g is string => typeof g === "string"));
    const pages = nodes
      .filter((n) => n.kind === "goal" || n.kind === "procedure" || groupIds.has(n.id as string))
      .map((n) => ({ id: n.id, title: n.title, kind: n.kind }));
    return {
      now: state.now,
      nodeCount: nodes.length,
      pages,
      nodes: nodes.map(summarize),
    };
  }),
);

// ---- 2. node_get ----

server.registerTool(
  "node_get",
  {
    description: "指定した1ノードの全フィールド（detail/impl を含む）を取得する。ノードidは state_get の一覧から得る。",
    inputSchema: { nodeId: z.string().describe("取得したいノードのid") },
  },
  safe(async ({ nodeId }: { nodeId: string }) => {
    const state = (await apiGet("/api/state")) as { nodes: Record<string, unknown>[] };
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) throw new ApiError(404, `node not found: ${nodeId}`);
    return node;
  }),
);

// ---- 3. node_add ----

server.registerTool(
  "node_add",
  {
    description:
      "新しいノードを作成する。title以外は省略可でサーバ側の既定値が使われる" +
      "（kind=task, executor=human, impact=safe, lifecycle=draft, status=pending）。" +
      "group は所属ページ(ゴール)のノードid。ページ直下に作るならそのゴールノードのidを渡す（省略時はどのページにも属さない）。" +
      "parents は先行ノードid（依存/順序、DAG）。impl は実装形態: null=会話段（AIの裁量）、" +
      "{type:'doc',text}=手順書、{type:'script',command}=決定的スクリプト。",
    inputSchema: {
      title: z.string().min(1).describe("人間粒度の作業名"),
      detail: z.string().nullable().optional().describe("補足・文脈"),
      kind: z
        .enum(["goal", "task", "procedure"])
        .optional()
        .describe("goal=プロジェクトページ(ルート意図) / task=作業 / procedure=手順ページ(繰り返し)。既定 task"),
      executor: z.enum(["human", "ai", "script"]).optional().describe("誰にディスパッチするか。既定 human"),
      impact: z
        .enum(["safe", "reversible", "irreversible"])
        .optional()
        .describe("不可逆な外部副作用は承認ゲートを通す。既定 safe"),
      lifecycle: z
        .enum(["draft", "committed"])
        .optional()
        .describe("draft=審議中/committed=実行対象。既定 draft"),
      status: z
        .enum(["unplanned", "pending", "running", "waiting", "done", "dropped"])
        .optional()
        .describe("既定 pending。unplanned=やり方未定"),
      parents: z.array(z.string()).optional().describe("先行ノードid配列。空=ルート"),
      group: z.string().nullable().optional().describe("所属ページ(ゴール)のノードid。ページ直下に作るならそのidを渡す"),
      impl: NodeImplSchema.optional().describe(
        "実装形態。null=会話段、{type:'doc',text}=手順書、{type:'script',command}=シェルコマンド",
      ),
    },
  },
  safe(async (input: Record<string, unknown>) => apiPost("/api/nodes", withMeta(input))),
);

// ---- 4. node_patch ----

server.registerTool(
  "node_patch",
  {
    description:
      "既存ノードを部分更新する。patch には変えたいフィールドだけを渡す（title/detail/impl/parents/group/kind/" +
      "executor/impact/lifecycle/status/selfImprove/pendingRequest/order の部分集合）。更新後のノードを返す。",
    inputSchema: {
      nodeId: z.string().describe("更新対象のノードid"),
      patch: z.object(NodePatchShape).describe("変更したいフィールドだけを含む部分オブジェクト"),
    },
  },
  safe(async ({ nodeId, patch }: { nodeId: string; patch: Record<string, unknown> }) =>
    apiPost(`/api/nodes/${encodeURIComponent(nodeId)}`, withMeta(patch)),
  ),
);

// ---- 5. node_remove ----

server.registerTool(
  "node_remove",
  {
    description: "ノードを削除する。子ノード（このノードをparentsに含むノード）が存在する場合は失敗する（MVP仕様）。",
    inputSchema: { nodeId: z.string().describe("削除するノードid") },
  },
  safe(async ({ nodeId }: { nodeId: string }) =>
    apiPost(`/api/nodes/${encodeURIComponent(nodeId)}/remove`, withMeta({})),
  ),
);

// ---- 6. thread_get ----

server.registerTool(
  "thread_get",
  {
    description: "指定ノードのスレッド（会話・判断リクエスト・実行ログ・成果物が時系列に並ぶ）のメッセージ一覧を取得する。",
    inputSchema: { nodeId: z.string().describe("対象ノードid") },
  },
  safe(async ({ nodeId }: { nodeId: string }) => apiGet(`/api/nodes/${encodeURIComponent(nodeId)}/thread`)),
);

// ---- 7. message_post ----

server.registerTool(
  "message_post",
  {
    description:
      "ノードのスレッドにメッセージを投稿する。kind: say=通常の発言（既定）、status=実行ログ、artifact=成果物への参照。" +
      "判断を仰ぎたい場合はこれではなく request_open を使うこと。",
    inputSchema: {
      nodeId: z.string().describe("投稿先ノードid"),
      kind: z.enum(["say", "status", "artifact"]).optional().describe("メッセージ種別。既定 say"),
      body: z.string().min(1).describe("本文"),
      payload: z.unknown().optional().describe("kind固有の追加データ（artifactの参照先など）"),
    },
  },
  safe(async ({ nodeId, ...rest }: { nodeId: string; [key: string]: unknown }) =>
    apiPost(`/api/nodes/${encodeURIComponent(nodeId)}/messages`, withMeta(rest)),
  ),
);

// ---- 8. request_open ----

server.registerTool(
  "request_open",
  {
    description:
      "人間への構造化された判断リクエストを開く。ノードは waiting になり pendingRequest がセットされる（=ボールが人間に渡る）。" +
      "context は3行以内・専門用語禁止でゴールの言葉での要約（文脈税）。options は2〜4個、各選択肢に" +
      "「選ぶと何が起きるか(then)」を必ず書く。impact はこの判断自体の影響、undo は戻し方（無ければnull）、" +
      "expires はISO8601の期限（無期限ならnull）、on_expire は期限切れ時に自動選択するoption id（保留のままならnull）。" +
      "同一ノードに既に open なリクエストがある場合は失敗する。",
    inputSchema: {
      nodeId: z.string().describe("判断を仰ぐノードid"),
      request: DecisionRequestSchema.describe(
        "{context, question, options:[{id,label,then,recommended?}], impact, undo?, expires?, on_expire?}",
      ),
    },
  },
  safe(async ({ nodeId, request }: { nodeId: string; request: unknown }) =>
    apiPost(`/api/nodes/${encodeURIComponent(nodeId)}/request`, withMeta({ request })),
  ),
);

// ---- 9. request_answer ----

server.registerTool(
  "request_answer",
  {
    description:
      "開いている判断リクエストに回答する。option に選択肢idを渡すと決着し、ノードのpendingRequestが解けてstatusがpendingに戻る。" +
      "option を null にすると選択肢を選ばず自由文(note)で返す＝ラリー継続（リクエストはopenのまま）。",
    inputSchema: {
      nodeId: z.string().describe("対象ノードid"),
      requestId: z.string().describe("回答対象の decision_request メッセージid"),
      option: z.string().nullable().describe("選ぶ選択肢のid。null=選ばずラリー継続"),
      note: z.string().nullable().optional().describe("自由文の補足（ラリー時は実質必須）"),
    },
  },
  safe(async ({ nodeId, ...rest }: { nodeId: string; [key: string]: unknown }) =>
    apiPost(`/api/nodes/${encodeURIComponent(nodeId)}/answer`, withMeta(rest)),
  ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
