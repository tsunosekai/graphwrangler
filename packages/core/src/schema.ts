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

/** goal=プロジェクトページ（一回きりのDAG） / task=作業 / procedure=手順ページ（繰り返し、ランが流れる） */
export const NodeKindSchema = z.enum(["goal", "task", "procedure"]);
export const ExecutorSchema = z.enum(["human", "ai", "script"]);
export const ImpactSchema = z.enum(["safe", "reversible", "irreversible"]);
export const LifecycleSchema = z.enum(["draft", "committed"]);
/** unplanned = やり方未定（「ここだけまだ考えてない」）。依存が揃っていても実行エンジンは拾わない */
export const StatusSchema = z.enum([
  "unplanned",
  "pending",
  "running",
  "waiting",
  "done",
  "dropped",
]);

/** ノードの実装形態（硬化3段階の後ろ2つ。null=会話段=AIの裁量で実行）
 *  - doc: 手順書。AI executor がこれを読んで実行する
 *  - script: 決定的スクリプト（シェルコマンド）。script executor が実行する */
export const NodeImplSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("doc"), text: z.string().min(1) }),
  z.object({ type: z.literal("script"), command: z.string().min(1) }),
]);
export type NodeImpl = z.infer<typeof NodeImplSchema>;

export const NodeSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  detail: z.string().nullable(),
  /** 実装形態（3.5 硬化ライフサイクル）。null = 会話段 */
  impl: NodeImplSchema.nullable(),
  /** 先行ノードid。DAG。空=ルート。依存（順序）を表す */
  parents: z.array(z.string()),
  /** 所属するグループ（フォルダ）ノードの id。包含を表す。依存(parents)とは独立。
   *  ゴールはグラフの先頭ノードではなく「ノード群のフォルダ」（Houdiniのネットワーク
   *  ボックス、将来の入れ子ノード=HDAの土台） */
  group: z.string().nullable(),
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
  /** kind=procedure 用の定期トリガー記述（"schedule:daily 09:00" 等）。
   *  書式は自由文字列で、v1 では解釈しない（ラン生成のトリガー文字列に転記されるだけ） */
  schedule: z.string().nullable(),
  created: z.string(),
  updated: z.string(),
});
export type Node = z.infer<typeof NodeSchema>;

/** ノード作成時の入力（id/created/updated はエンジンが振る） */
export const NodeInputSchema = z.object({
  title: z.string().min(1),
  detail: z.string().nullable().default(null),
  impl: NodeImplSchema.nullable().default(null),
  parents: z.array(z.string()).default([]),
  group: z.string().nullable().default(null),
  kind: NodeKindSchema.default("task"),
  executor: ExecutorSchema.default("human"),
  impact: ImpactSchema.default("safe"),
  lifecycle: LifecycleSchema.default("draft"),
  status: StatusSchema.default("pending"),
  selfImprove: z.boolean().default(false),
  order: z.number().nullable().default(null),
  schedule: z.string().nullable().default(null),
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

// ---- 手順ページ: ラン（実行インスタンス。docs/design.md 3.7/3.8） ----
// テンプレート（procedure のメンバーノード）自身は status を持たない。
// 実行のたびに生成する Run 側のワークアイテムが status を持つ。

/** ワークアイテムの状態。skipped = unplanned テンプレート等、その回は対象外だったもの */
export const RunItemStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "done",
  "dropped",
  "skipped",
]);
export type RunItemStatus = z.infer<typeof RunItemStatusSchema>;

export const RunItemSchema = z.object({
  status: RunItemStatusSchema,
  note: z.string().nullable(),
  updated: z.string(),
});
export type RunItem = z.infer<typeof RunItemSchema>;

export const RunStatusSchema = z.enum(["running", "done", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: z.string(),
  /** kind=procedure のノード id */
  procedure: z.string(),
  title: z.string().min(1),
  /** "manual" ほか自由文字列（"schedule:daily 09:00" 等） */
  trigger: z.string().min(1),
  status: RunStatusSchema,
  /** テンプレートノード id → ワークアイテム */
  items: z.record(z.string(), RunItemSchema),
  created: z.string(),
  updated: z.string(),
});
export type Run = z.infer<typeof RunSchema>;
