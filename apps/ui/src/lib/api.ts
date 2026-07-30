// graphwrangler サーバ API の薄いクライアント。エラーは {error:"..."} + 4xx/5xx を前提に、
// 拾ってトースト表示してから re-throw する（呼び出し側は catch して個別UIを止めるだけでよい）。
import type { Message, MaterializedMessage, Node, Run, RunItemStatus, TraceEvent } from "../types";
import { pushToast } from "./toast";

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    const msg = "サーバに接続できません";
    pushToast(msg);
    throw new ApiError(msg);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    pushToast(msg);
    throw new ApiError(msg);
  }
  return data as T;
}

export interface NodeCreateInput {
  title: string;
  detail?: string | null;
  impl?: Node["impl"];
  parents?: string[];
  group?: string | null;
  kind?: Node["kind"];
  executor?: Node["executor"];
  impact?: Node["impact"];
  lifecycle?: Node["lifecycle"];
  status?: Node["status"];
  fixed?: boolean;
  order?: number | null;
}

export type NodePatchInput = Partial<Omit<Node, "id" | "created" | "updated">>;

// ---- AI設定（初回セットアップ + ⚙。実装は packages/server/src/settings.ts） ----

export interface SettingsView {
  chat: {
    /** api = プロバイダのAPIキーで直接呼ぶ / cli = claude 等のヘッドレスCLIを使う */
    mode: "api" | "cli";
    provider: "anthropic" | "openai";
    model: string | null;
    hasApiKey: boolean;
    keySource: "settings" | "env" | "none";
    cliPath: string;
    cliModel: string;
  };
  engine: {
    /** cli = ヘッドレスCLI(claude -p 等)を起動する / api = チャット側のAPIキーで直接呼ぶ */
    mode: "cli" | "api";
    cliPath: string;
    model: string;
    extraArgs: string[];
    apiModel: string | null;
  };
  setupDone: boolean;
}

export interface SettingsPatch {
  chat?: {
    mode?: "api" | "cli";
    provider?: "anthropic" | "openai";
    model?: string | null;
    apiKey?: string | null;
    cliPath?: string;
    cliModel?: string;
  };
  engine?: { mode?: "cli" | "api"; cliPath?: string; model?: string; extraArgs?: string[]; apiModel?: string | null };
  setupDone?: boolean;
}

export const api = {
  // threadMeta: ノードごとの最終メッセージ時刻（未読バッジの判定に使う。QOL-7）
  getState: () => request<{ nodes: Node[]; threadMeta: Record<string, string>; now: string }>("/state"),

  addNode: (input: NodeCreateInput) =>
    request<Node>("/nodes", { method: "POST", body: JSON.stringify(input) }),

  patchNode: (id: string, patch: NodePatchInput) =>
    request<Node>(`/nodes/${id}`, { method: "POST", body: JSON.stringify(patch) }),

  removeNode: (id: string) =>
    request<{ removed: boolean }>(`/nodes/${id}/remove`, { method: "POST", body: "{}" }),

  getThread: (id: string) => request<{ messages: MaterializedMessage[] }>(`/nodes/${id}/thread`),

  postMessage: (id: string, body: string) =>
    request<Message>(`/nodes/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ kind: "say", body }),
    }),

  answer: (id: string, requestId: string, option: string | null, note: string | null = null) =>
    request<{ message: Message; resolved: boolean; node: Node }>(`/nodes/${id}/answer`, {
      method: "POST",
      body: JSON.stringify({ requestId, option, note }),
    }),

  // ---- ルーティーンページ: ラン（実行インスタンス。docs/design.md 3.8） ----

  createRun: (procedureId: string, input: { title?: string; trigger?: string } = {}) =>
    request<Run>(`/procedures/${procedureId}/runs`, { method: "POST", body: JSON.stringify(input) }),

  listRuns: (procedureId: string) => request<{ runs: Run[] }>(`/procedures/${procedureId}/runs`),

  getRun: (runId: string) => request<Run>(`/runs/${runId}`),

  patchRunItem: (runId: string, nodeId: string, input: { status?: RunItemStatus; note?: string | null }) =>
    request<Run>(`/runs/${runId}/items/${nodeId}`, { method: "POST", body: JSON.stringify(input) }),

  cancelRun: (runId: string) =>
    request<Run>(`/runs/${runId}/cancel`, { method: "POST", body: "{}" }),

  getRunTrace: (runId: string) => request<{ events: TraceEvent[] }>(`/runs/${runId}/trace`),

  // ---- 元に戻す / やり直す（B-8。操作ログの補償追記） ----

  undo: () => request<{ undone: { id: string; op: string; ts: string } }>("/undo", {
    method: "POST",
    body: "{}",
  }),

  redo: () => request<{ redone: { id: string; op: string; ts: string } }>("/redo", {
    method: "POST",
    body: "{}",
  }),

  // ---- エンジン稼働インジケータ（QOL-5） ----

  getEngineStatus: () => request<{ alive: boolean; lastSeen: string | null }>("/engine/status"),

  // ---- AI設定 ----

  getSettings: () => request<SettingsView>("/settings"),

  updateSettings: (patch: SettingsPatch) =>
    request<SettingsView>("/settings", { method: "POST", body: JSON.stringify(patch) }),

  /**
   * 内蔵チャット（M4）。UIMessageStream(SSE) の生 body を返す。パースは呼び出し側
   * (ChatDrawer) が行う — この関数は「api キー未設定 400」だけをエラーとして解釈する。
   */
  chatStream: async (
    messages: unknown[],
    pageId: string | null,
    selectedNodeId?: string | null,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> => {
    let res: Response;
    try {
      res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, pageId, selectedNodeId: selectedNodeId ?? null }),
        signal,
      });
    } catch {
      throw new ApiError("サーバに接続できません");
    }
    if (!res.ok) {
      const text = await res.text();
      let msg = `HTTP ${res.status}`;
      try {
        const data = JSON.parse(text);
        if (data && typeof data.error === "string") msg = data.error;
      } catch {
        /* JSONでなければ既定メッセージのまま */
      }
      throw new ApiError(msg);
    }
    if (!res.body) throw new ApiError("ストリームを取得できません");
    return res.body;
  },
};
