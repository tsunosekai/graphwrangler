// GraphWrangler の HTTP API（既定 http://localhost:8770）を薄く叩くクライアント。
// packages/mcp/src/http.ts と同じ方針: server / core のコードには依存せず、
// この HTTP API だけを唯一の統合点にする（docs/agent-contracts.md 担当領域）。
import type {
  Actor,
  DecisionRequest,
  EngineSettings,
  Message,
  Node,
  NodePatch,
  Run,
  RunItemStatus,
} from "./types.js";

const baseUrl = (process.env.GRAPHWRANGLER_URL ?? "http://localhost:8770").replace(/\/+$/, "");

/** HTTP API がエラー（4xx/5xx の {error}）を返したとき、または接続自体に失敗したときに投げる */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, `graphwrangler server (${baseUrl}) に接続できません: ${String(err)}`);
  }

  const text = await res.text();
  const json = text.length > 0 ? JSON.parse(text) : {};

  if (!res.ok) {
    const message =
      typeof json === "object" && json !== null && "error" in json
        ? String((json as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return json;
}

export async function getState(): Promise<{ nodes: Node[]; now: string }> {
  return (await request("GET", "/api/state")) as { nodes: Node[]; now: string };
}

/** ノードの部分更新。actor/via で帰属を明示する（docs/agent-contracts.md の帰属の規約） */
export async function patchNode(
  id: string,
  patch: NodePatch,
  actor: Actor,
  via: string,
): Promise<Node> {
  return (await request("POST", `/api/nodes/${id}`, { ...patch, actor, via })) as Node;
}

export async function getThread(id: string): Promise<{ messages: Message[] }> {
  return (await request("GET", `/api/nodes/${id}/thread`)) as { messages: Message[] };
}

export async function postMessage(
  id: string,
  input: { kind: "say" | "status" | "artifact"; body: string; payload?: unknown },
  actor: Actor,
  via: string,
): Promise<Message> {
  return (await request("POST", `/api/nodes/${id}/messages`, { ...input, actor, via })) as Message;
}

/** 判断リクエストを開く。ノードは server 側で自動的に waiting + pendingRequest になる */
export async function openRequest(
  id: string,
  decisionRequest: DecisionRequest,
  actor: Actor,
  via: string,
): Promise<Message> {
  return (await request("POST", `/api/nodes/${id}/request`, {
    request: decisionRequest,
    actor,
    via,
  })) as Message;
}

// ---- 手順ページ: ラン（M6）----

/** procedureId に属するラン一覧（server 側で created 降順。全 procedure を横断する
 *  一覧APIは無いので、呼び出し側が procedure ノードごとにこれを呼んで束ねる） */
export async function listProcedureRuns(procedureId: string): Promise<Run[]> {
  const res = (await request("GET", `/api/procedures/${procedureId}/runs`)) as { runs: Run[] };
  return res.runs;
}

/** ランを作成する（手動 or スケジュール）。trigger 省略時は server 側で "manual" */
export async function createRun(
  procedureId: string,
  opts: { title?: string; trigger?: string } = {},
  actor?: Actor,
  via?: string,
): Promise<Run> {
  return (await request("POST", `/api/procedures/${procedureId}/runs`, {
    ...opts,
    ...(actor ? { actor } : {}),
    ...(via ? { via } : {}),
  })) as Run;
}

/** ランのワークアイテムを部分更新する。actor/via で帰属を明示する */
export async function patchRunItem(
  runId: string,
  nodeId: string,
  patch: { status?: RunItemStatus; note?: string | null },
  actor: Actor,
  via: string,
): Promise<Run> {
  return (await request("POST", `/api/runs/${runId}/items/${nodeId}`, {
    ...patch,
    actor,
    via,
  })) as Run;
}

// ---- AI設定（M7: エンジンAI設定を server 設定から読む） ----

/** GET /api/settings の公開ビュー。engine executor に必要な部分だけ型を持つ
 *  （chat/setupDone 等の他フィールドは無視する。取得失敗時の既定値継続は呼び出し側の責務） */
export async function getSettings(): Promise<{ engine: EngineSettings }> {
  return (await request("GET", "/api/settings")) as { engine: EngineSettings };
}
