// データモデルの正。docs/design.md セクション5 と対応を保つこと。
import { z } from "zod";

// ---- 共通 ----

export const ActorSchema = z.object({
  kind: z.enum(["human", "agent", "system"]),
  name: z.string().optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

/** どの玄関から来た操作/発言か（ui / mcp / engine / api / discord …） */
export const ViaSchema = z.string().min(1);

// ---- ノード ----

export const NodeKindSchema = z.enum(["goal", "task"]);
export const ExecutorSchema = z.enum(["human", "ai", "script"]);
export const ImpactSchema = z.enum(["safe", "reversible", "irreversible"]);
export const LifecycleSchema = z.enum(["draft", "committed"]);
export const StatusSchema = z.enum(["pending", "running", "waiting", "done", "dropped"]);

export const NodeSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  detail: z.string().nullable(),
  /** 先行ノードid。DAG。空=ルート */
  parents: z.array(z.string()),
  kind: NodeKindSchema,
  executor: ExecutorSchema,
  impact: ImpactSchema,
  lifecycle: LifecycleSchema,
  status: StatusSchema,
  /** 自己改善許可フラグ（アンロックHDA相当） */
  selfImprove: z.boolean(),
  /** open な判断リクエストの message id。open の存在 ⇔ ボールが人間 */
  pendingRequest: z.string().nullable(),
  /** 兄弟内の表示順（小さいほど上）。null は末尾扱い */
  order: z.number().nullable(),
  created: z.string(),
  updated: z.string(),
});
export type Node = z.infer<typeof NodeSchema>;

/** ノード作成時の入力（id/created/updated はエンジンが振る） */
export const NodeInputSchema = z.object({
  title: z.string().min(1),
  detail: z.string().nullable().default(null),
  parents: z.array(z.string()).default([]),
  kind: NodeKindSchema.default("task"),
  executor: ExecutorSchema.default("human"),
  impact: ImpactSchema.default("safe"),
  lifecycle: LifecycleSchema.default("draft"),
  status: StatusSchema.default("pending"),
  selfImprove: z.boolean().default(false),
  order: z.number().nullable().default(null),
});
export type NodeInput = z.input<typeof NodeInputSchema>;

/** 部分更新できるフィールド */
export const NodePatchSchema = NodeSchema.omit({
  id: true,
  created: true,
  updated: true,
}).partial();
export type NodePatch = z.infer<typeof NodePatchSchema>;

// ---- 操作ログ（ops.jsonl の1行） ----

export const OpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("node.add"),
    payload: z.object({ node: NodeSchema }),
  }),
  z.object({
    op: z.literal("node.patch"),
    payload: z.object({ nodeId: z.string(), patch: NodePatchSchema }),
  }),
  z.object({
    op: z.literal("node.remove"),
    payload: z.object({ nodeId: z.string() }),
  }),
]);

export const OpRecordSchema = z
  .object({
    id: z.string(),
    ts: z.string(),
    actor: ActorSchema,
    via: ViaSchema,
  })
  .and(OpSchema);
export type OpRecord = z.infer<typeof OpRecordSchema>;

// ---- 判断リクエスト（docs/design.md 5.4） ----

export const DecisionOptionSchema = z.object({
  id: z.string(),
  label: z.string().min(1),
  /** 選ぶと何が起きるか。then が書けない選択肢は作らない（desk の規律を継承） */
  then: z.string().min(1),
  recommended: z.boolean().optional(),
});

export const DecisionRequestSchema = z.object({
  /** 文脈税: 3行以内の平易な要約。専門用語禁止・ゴールの言葉で */
  context: z.string().min(1),
  question: z.string().min(1),
  options: z.array(DecisionOptionSchema).min(2).max(4),
  /** この判断自体の影響（ノードの impact とは別） */
  impact: ImpactSchema,
  undo: z.string().nullable().default(null),
  /** 期限。null=無期限 */
  expires: z.string().nullable().default(null),
  /** 期限切れ時に自動選択する option id。null=保留のまま */
  on_expire: z.string().nullable().default(null),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export const DecisionAnswerSchema = z.object({
  /** 応答対象の decision_request message id */
  requestId: z.string(),
  /** 選んだ option id。null = 選択肢を選ばず自由文で返した（ラリー継続） */
  option: z.string().nullable(),
  note: z.string().nullable().default(null),
});
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

// ---- ノードスレッド（threads/<node>.jsonl の1行） ----

export const MessageKindSchema = z.enum([
  "say", // 会話
  "decision_request", // 人間への構造化された質問
  "decision_answer", // その回答
  "status", // 実行ログ（desk の history 相当）
  "artifact", // 成果物への参照
]);

export const MessageSchema = z.object({
  id: z.string(),
  node: z.string(),
  ts: z.string(),
  author: ActorSchema,
  via: ViaSchema,
  kind: MessageKindSchema,
  body: z.string(),
  /** kind 固有データ。decision_request → { request: DecisionRequest } /
   *  decision_answer → DecisionAnswer */
  payload: z.unknown().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

/** リスト表示用: decision_request の状態を answers から導出した形 */
export type MaterializedMessage = Message & {
  /** kind=decision_request のときのみ: open / answered */
  requestStatus?: "open" | "answered";
  /** kind=decision_request で answered のとき、対応する decision_answer の id */
  answeredBy?: string;
};
