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
  runIdOf,
} from "./schema.js";
import { nextId, nowIso } from "./ids.js";
import { appendJsonl, readJsonl } from "./storage.js";
import { GraphError } from "./graph.js";

export interface PostMeta {
  author?: Actor;
  via?: string;
  /** どのランの記録か（2026-08-08「会話や実行履歴もフォーク」）。null/未指定 =
   *  テンプレート（設計図）側の会話 */
  runId?: string | null;
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

  /**
   * ラン単位に切り出したスレッド（2026-08-08「会話や実行履歴もフォーク」）。
   * runId=null はテンプレート（設計図）側の会話だけ、ラン id ならそのランの会話と実行記録だけ。
   * 1ノード1ファイルのまま、所属ランで切って見せる（保存の形は変えない）。
   *
   * **open な判断カード（decision_request）だけはどのスコープでも見せる**（2026-08-12）:
   * pendingRequest はノード単位の状態（＝ボールは1個）なので、どの画面で見ていても
   * カードが出て答えられるべき。runId で切ると「橙（あなたの番）は付くのにカードが無い」
   * 画面ができる——テンプレート側カードをランのページで（2026-08-12 本人報告）、逆に
   * ラン側カードをテンプレートで、見失う。answered になれば自分のスコープにだけ残る。
   */
  listScoped(nodeId: string, runId: string | null): MaterializedMessage[] {
    return this.list(nodeId).filter(
      (m) =>
        runIdOf(m) === runId ||
        (m.kind === "decision_request" && m.requestStatus === "open"),
    );
  }

  /** 会話・実行ログ・成果物の投稿 */
  post(nodeId: string, input: PostInput): Message {
    return this.append(nodeId, {
      author: input.author ?? { kind: "human" },
      via: input.via ?? "ui",
      kind: input.kind ?? "say",
      body: input.body,
      payload: input.payload ?? null,
      runId: input.runId ?? null,
    });
  }

  /** 判断リクエストを開く。呼び出し側（server）が node.pendingRequest を更新する */
  openRequest(nodeId: string, request: DecisionRequest, meta: PostMeta = {}): Message {
    const parsed = DecisionRequestSchema.parse(request);
    return this.append(nodeId, {
      author: meta.author ?? { kind: "agent" },
      via: meta.via ?? "engine",
      kind: "decision_request",
      body: parsed.question,
      payload: { request: parsed },
      runId: meta.runId ?? null,
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
      // 回答は質問と同じランに属する（質問がテンプレート側ならテンプレート側）
      runId: meta.runId ?? runIdOf(req),
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
