// GraphWrangler の HTTP API（既定 http://localhost:8770）を薄く叩くクライアント。
// packages/mcp/src/http.ts と同じ方針: server / core のコードには依存せず、
// この HTTP API だけを唯一の統合点にする。
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

/** ノードの部分更新。actor/via で帰属を明示する */
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

/** 分岐ノード(kind=decision)の choice を確定する（POST /api/nodes/:id/decide）。
 *  choice が branches に無い/kind≠decision は ApiError(400) として投げる（docs/design.md 3.9） */
export async function decideNode(
  id: string,
  choice: string,
  actor: Actor,
  via: string,
): Promise<Node> {
  return (await request("POST", `/api/nodes/${id}/decide`, { choice, actor, via })) as Node;
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

// ---- ラン / トリガーノード（kind=trigger。docs/design.md 3.4/3.8/3.9） ----

/** pageId（トリガーノードの group、または他ノードから group として参照されるノードid）に
 *  属するラン一覧（GET /api/pages/:id/runs。server 側で created 降順。全ページを横断する
 *  一覧APIは無いので、呼び出し側がページごとにこれを呼んで束ねる） */
export async function listPageRuns(pageId: string): Promise<Run[]> {
  const res = (await request("GET", `/api/pages/${pageId}/runs`)) as { runs: Run[] };
  return res.runs;
}

/** トリガーノード（kind=trigger）を発火する（POST /api/nodes/:id/fire）。そのノードの
 *  group ページで createFromTrigger によりランが1本作られる。opts.via は発火理由の自由文字列
 *  （"manual" / "schedule:<原文>" / "ai" 等。省略時はサーバ側既定の "manual"）で、
 *  この1フィールドが run.trigger の記録とスレッド投稿の帰属(via)の両方に使われる
 *  （他の書き込みAPIのような actor/via 2引数と違い、このエンドポイントは via を1つしか
 *  持たない。他の関数と同じ形で末尾に別の via を足すと上書きされて事故る＝2026-07-31に
 *  実際に踏んだ穴なので、シグネチャで区別する） */
export async function fireTriggerNode(
  nodeId: string,
  opts: { via?: string } = {},
  actor: Actor,
): Promise<Run> {
  return (await request("POST", `/api/nodes/${nodeId}/fire`, {
    ...opts,
    actor,
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

/** ランのワークアイテム(kind=decision のテンプレート)の choice を確定する
 *  （POST /api/runs/:id/items/:nodeId/decide。docs/design.md 3.9のラン内版） */
export async function decideRunItem(
  runId: string,
  nodeId: string,
  choice: string,
  actor: Actor,
  via: string,
): Promise<Run> {
  return (await request("POST", `/api/runs/${runId}/items/${nodeId}/decide`, {
    choice,
    actor,
    via,
  })) as Run;
}

// ---- AI設定（エンジンAI設定を server 設定から読む） ----

/** GET /api/settings の公開ビュー。engine executor に必要な部分だけ型を持つ
 *  （chat/setupDone 等の他フィールドは無視する。取得失敗時の既定値継続は呼び出し側の責務） */
export async function getSettings(): Promise<{ engine: EngineSettings }> {
  return (await request("GET", "/api/settings")) as { engine: EngineSettings };
}

// ---- engine.mode="api" 用（executors/api.ts） ----

/** POST /api/ai/complete を呼ぶ（チャット設定のプロバイダ/キーでツールなしのテキスト生成）。
 *  キー未設定・プロバイダ側エラー等は ApiError として投げる（呼び出し側が ExecResult に変換する） */
export async function completeAi(prompt: string, maxTokens?: number): Promise<string> {
  const res = (await request("POST", "/api/ai/complete", {
    prompt,
    ...(maxTokens ? { maxTokens } : {}),
  })) as { text: string };
  return res.text;
}

/** UIの稼働インジケータ用ハートビート（POST /api/engine/heartbeat）。失敗は呼び出し側で握りつぶす */
export async function heartbeat(): Promise<void> {
  await request("POST", "/api/engine/heartbeat", {});
}

// ---- ワークスペース=1ファイル化（GET /api/workspace・GET /api/files） ----

export interface WorkspaceInfo {
  mode: "workspace" | "datadir";
  root: string | null;
  file: string | null;
}

/** サーバの動作モードを取得する（GET /api/workspace）。起動時に1回読み、
 *  script executor の cwd 決定と impl={type:"doc",path} の解決に使う */
export async function getWorkspace(): Promise<WorkspaceInfo> {
  return (await request("GET", "/api/workspace")) as WorkspaceInfo;
}

/** ワークスペース内のファイルを読む（GET /api/files?path=）。impl={type:"doc",path} の
 *  本文をプロンプトへインラインするために使う。ワークスペースモード以外・パス脱出・
 *  存在しないファイルは ApiError として投げる（呼び出し側が実行失敗として扱う） */
export async function getFile(relPath: string): Promise<string> {
  const res = (await request("GET", `/api/files?path=${encodeURIComponent(relPath)}`)) as {
    path: string;
    content: string;
  };
  return res.content;
}
