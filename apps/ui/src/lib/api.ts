// graphwrangler サーバ API の薄いクライアント。エラーは {error:"..."} + 4xx/5xx を前提に、
// 拾ってトースト表示してから re-throw する（呼び出し側は catch して個別UIを止めるだけでよい）。
import type { Message, MaterializedMessage, Node } from "../types";
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
  parents?: string[];
  kind?: Node["kind"];
  executor?: Node["executor"];
  impact?: Node["impact"];
  lifecycle?: Node["lifecycle"];
  status?: Node["status"];
  selfImprove?: boolean;
  order?: number | null;
}

export type NodePatchInput = Partial<Omit<Node, "id" | "created" | "updated">>;

export const api = {
  getState: () => request<{ nodes: Node[]; now: string }>("/state"),

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
};
