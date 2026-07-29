// ノードスレッド。1ノード1ストリーム（会話・判断・実行ログ・成果物が同じ時系列、
// docs/design.md 5.3）。ファイルは追記専用。decision_request の open/answered は
// 後続の decision_answer から導出する（過去行の書き換えをしない）。
import path from "node:path";
import {
  ActorSchema,
  type Actor,
  type DecisionAnswer,
  DecisionAnswerSchema,
  type DecisionRequest,
  DecisionRequestSchema,
  type MaterializedMessage,
  type Message,
  MessageSchema,
} from "./schema.js";
import { nextId, nowIso } from "./ids.js";
import { appendJsonl, readJsonl } from "./storage.js";
import { GraphError } from "./graph.js";

export interface PostMeta {
  author?: Actor;
  via?: string;
}

export interface PostInput extends PostMeta {
  kind?: "say" | "status" | "artifact";
  body: string;
  payload?: unknown;
}

export class ThreadStore {
  constructor(private dataDir: string) {}

  private file(nodeId: string): string {
    return path.join(this.dataDir, "threads", `${nodeId}.jsonl`);
  }

  list(nodeId: string): MaterializedMessage[] {
    const messages = readJsonl<Message>(this.file(nodeId));
    // decision_answer(option != null) を持つ request を answered に導出
    const answeredBy = new Map<string, string>();
    for (const m of messages) {
      if (m.kind === "decision_answer" && m.payload) {
        const ans = m.payload as DecisionAnswer;
        if (ans.option !== null) answeredBy.set(ans.requestId, m.id);
      }
    }
    return messages.map((m) => {
      if (m.kind !== "decision_request") return m;
      const by = answeredBy.get(m.id);
      return by
        ? { ...m, requestStatus: "answered" as const, answeredBy: by }
        : { ...m, requestStatus: "open" as const };
    });
  }

  /** 会話・実行ログ・成果物の投稿 */
  post(nodeId: string, input: PostInput): Message {
    return this.append(nodeId, {
      author: input.author ?? { kind: "human" },
      via: input.via ?? "ui",
      kind: input.kind ?? "say",
      body: input.body,
      payload: input.payload ?? null,
    });
  }

  /** 判断リクエストを開く。呼び出し側（server）が node.pendingRequest を更新する */
  openRequest(nodeId: string, request: DecisionRequest, meta: PostMeta = {}): Message {
    const parsed = DecisionRequestSchema.parse(request);
    for (const opt of [parsed.on_expire].filter((x): x is string => x !== null)) {
      if (!parsed.options.some((o) => o.id === opt)) {
        throw new GraphError(`on_expire references unknown option: ${opt}`);
      }
    }
    return this.append(nodeId, {
      author: meta.author ?? { kind: "agent" },
      via: meta.via ?? "engine",
      kind: "decision_request",
      body: parsed.question,
      payload: { request: parsed },
    });
  }

  /**
   * 判断リクエストへの回答。option=null は「選択肢を選ばず言葉を返した」＝
   * ラリー継続で、リクエストは open のまま（docs/design.md 4-④）。
   */
  answerRequest(
    nodeId: string,
    answer: DecisionAnswer,
    meta: PostMeta = {},
  ): { message: Message; resolved: boolean } {
    const parsed = DecisionAnswerSchema.parse(answer);
    const messages = this.list(nodeId);
    const req = messages.find((m) => m.id === parsed.requestId);
    if (!req || req.kind !== "decision_request") {
      throw new GraphError(`decision_request not found: ${parsed.requestId}`, 404);
    }
    if (req.requestStatus === "answered") {
      throw new GraphError(`request already answered: ${parsed.requestId}`, 409);
    }
    if (parsed.option !== null) {
      const { request } = req.payload as { request: DecisionRequest };
      if (!request.options.some((o) => o.id === parsed.option)) {
        throw new GraphError(`unknown option: ${parsed.option}`);
      }
    }
    const message = this.append(nodeId, {
      author: meta.author ?? { kind: "human" },
      via: meta.via ?? "ui",
      kind: "decision_answer",
      body: parsed.note ?? "",
      payload: parsed,
    });
    return { message, resolved: parsed.option !== null };
  }

  private append(
    nodeId: string,
    partial: Omit<Message, "id" | "node" | "ts">,
  ): Message {
    const existing = readJsonl<Message>(this.file(nodeId)).map((m) => m.id);
    const message = MessageSchema.parse({
      ...partial,
      id: nextId("m", existing),
      node: nodeId,
      ts: nowIso(),
      author: ActorSchema.parse(partial.author),
    });
    appendJsonl(this.file(nodeId), message);
    return message;
  }
}
