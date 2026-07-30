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

/** goal=プロジェクトページ（一回きりのDAG） / task=作業 /
 *  procedure=手順ページ（繰り返し、ランが流れる）。@deprecated 2026-07-31
 *  「ルーティーンであること」はページ種別ではなく先頭の trigger ノードから導出するモデルへ
 *  移行した（docs/design.md 3.8）。後方互換のため enum には残すが、新規作成 UI からは
 *  使わない想定 /
 *  decision=分岐ノード（完了時に選択肢を1つ選ぶ。docs/design.md 3.9） /
 *  trigger=起点ノード（Rx の Observable のソース。発火するとそのページ(group)でランが
 *  生成される。docs/design.md 3.4/3.8/3.9。parents を持てない=グラフの起点であることを
 *  構造的に保証する） */
export const NodeKindSchema = z.enum(["goal", "task", "procedure", "decision", "trigger"]);
export const ExecutorSchema = z.enum(["human", "ai", "script"]);
export const ImpactSchema = z.enum(["safe", "reversible", "irreversible"]);
export const LifecycleSchema = z.enum(["draft", "committed"]);
/** unplanned = やり方未定（「ここだけまだ考えてない」）。依存が揃っていても実行エンジンは拾わない。
 *  skipped = 分岐で選ばれなかった枝を通ったため、その回は対象外になった正常状態（dropped=中止とは別物） */
export const StatusSchema = z.enum([
  "unplanned",
  "pending",
  "running",
  "waiting",
  "done",
  "dropped",
  "skipped",
]);

/** ノードの実装形態（Fix3段階の後ろ2つ。null=会話段=AIの裁量で実行）
 *  - doc: 手順書。AI executor がこれを読んで実行する。text はインライン本文、path は
 *    ワークスペースモード（ワークスペース=1ファイル化）でリポジトリ内ファイルを指す相対パス
 *    （docs/design.md 「ワークスペース=1ファイル化」仕様）。どちらか片方があれば良く、
 *    両方あるときは text を優先する（engine 側の規約）。両方 null は実装未記入と同義で、
 *    既存データ（text だけ）はそのまま通る後方互換を維持する
 *  - script: 決定的スクリプト（シェルコマンド）。script executor が実行する */
export const NodeImplSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("doc"),
    text: z.string().min(1).nullable().optional(),
    path: z.string().min(1).nullable().optional(),
  }),
  z.object({ type: z.literal("script"), command: z.string().min(1) }),
]);
export type NodeImpl = z.infer<typeof NodeImplSchema>;

/** 分岐ノード(kind=decision)の選択肢。判断リクエストの options と同形だが、
 *  then は省略可（人間向けリクエストに変換するときは既定文言で補う。docs/design.md 3.9） */
export const NodeBranchSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  then: z.string().optional(),
});
export type NodeBranch = z.infer<typeof NodeBranchSchema>;

export const NodeSchema = z.object({
  id: z.string(),
  /** 空文字を許す（UIの「作って即リネーム」フローが空タイトルで作成するため。表示側は「（無題）」） */
  title: z.string(),
  detail: z.string().nullable(),
  /** 実装形態（3.5 Fixライフサイクル）。null = 会話段 */
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
  /** Fix フラグ（= Houdini のロック）。true = やり方が確定し、AIは impl を書き換えない。
   *  中身がスクリプトでも手順書でも「人間が判断する」でもよい — Fix はやり方の確定であって
   *  スクリプト化ではない（2026-07-31 本人定義）。ノードは未Fix（改善中）で生まれる */
  fixed: z.boolean(),
  /** open な判断リクエストの message id。open の存在 ⇔ ボールが人間 */
  pendingRequest: z.string().nullable(),
  /** 兄弟内の表示順（小さいほど上）。null は末尾扱い */
  order: z.number().nullable(),
  /** kind=trigger 用の起動方式記述（"every 15m" / "daily 09:00" / "weekly mon 09:00" 等）。
   *  executor=script なら cron 的な発火判定にそのまま使う。executor=ai なら「AIに発火要否を
   *  判定させる間隔」として使う（every系のみ解釈、無指定は既定1時間）。executor=human では
   *  使わない（手動発火のみ）。kind=procedure（非推奨）でも旧来どおり同じ書式で解釈される。
   *  書式は自由文字列で、パースできないものは無視される（ラン生成のtrigger文字列に転記されるだけ） */
  schedule: z.string().nullable(),
  /** kind=decision のみ意味を持つ選択肢一覧（最低2個。elseなし・単一選択。docs/design.md 3.9）。
   *  それ以外の kind では null */
  branches: z.array(NodeBranchSchema).nullable().default(null),
  /** 決定済みの枝id（プロジェクト層。kind=decision が完了すると入る）。ラン側は RunItem.choice */
  choice: z.string().nullable().default(null),
  /** 子側: どの親decisionのどの枝から生えるか（親decisionId → 枝id）。
   *  検証: キーが parents に含まれ、その親が kind=decision であること。値がその親の branches に存在すること */
  parentOptions: z.record(z.string(), z.string()).default({}),
  created: z.string(),
  updated: z.string(),
});
export type Node = z.infer<typeof NodeSchema>;

/** ノード作成時の入力（id/created/updated はエンジンが振る） */
export const NodeInputSchema = z.object({
  title: z.string().default(""),
  detail: z.string().nullable().default(null),
  impl: NodeImplSchema.nullable().default(null),
  parents: z.array(z.string()).default([]),
  group: z.string().nullable().default(null),
  kind: NodeKindSchema.default("task"),
  executor: ExecutorSchema.default("human"),
  impact: ImpactSchema.default("safe"),
  lifecycle: LifecycleSchema.default("draft"),
  status: StatusSchema.default("pending"),
  fixed: z.boolean().default(false),
  order: z.number().nullable().default(null),
  schedule: z.string().nullable().default(null),
  branches: z.array(NodeBranchSchema).nullable().default(null),
  choice: z.string().nullable().default(null),
  parentOptions: z.record(z.string(), z.string()).default({}),
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
    /** この操作が打ち消した操作の id（undo の補償操作にだけ付く）。
     *  undo は過去行を書き換えず、逆操作を追記することで実現する */
    undoes: z.string().optional(),
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

/** ワークアイテムの状態。skipped = unplanned テンプレート等、その回は対象外だったもの
 *  （分岐で選ばれなかった枝もここに乗る） */
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
  /** テンプレートが kind=decision のとき、そのランで確定した枝id。それ以外は null */
  choice: z.string().nullable().default(null),
});
export type RunItem = z.infer<typeof RunItemSchema>;

export const RunStatusSchema = z.enum(["running", "done", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: z.string(),
  /** ランが属するページ(group)のid。旧モデルでは常に kind=procedure のノード id だったが、
   *  新モデル（trigger起点。docs/design.md 3.8）では任意のページ(goal等)のidになりうる。
   *  フィールド名は後方互換のため procedure のまま残す */
  procedure: z.string(),
  title: z.string().min(1),
  /** 発火元の記録。新モデルでは "trigger:<triggerノードid>:<via>" の形
   *  （via は "manual" / "schedule:<原文>" / "ai" 等）。旧モデル互換の "manual" 単体や
   *  "schedule:daily 09:00" もそのまま許容する自由文字列 */
  trigger: z.string().min(1),
  status: RunStatusSchema,
  /** テンプレートノード id → ワークアイテム */
  items: z.record(z.string(), RunItemSchema),
  created: z.string(),
  updated: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

// ---- ワークスペースモード: 正データファイル（<repo>/workflow.gw.json 等。
// docs「ワークスペース=1ファイル化」仕様）----

/** 正データファイルの形。nodes は id 昇順・決定的シリアライズ（stableStringify）で書く
 *  ことで git diff が意味のある差分になる（本ファイルはその形の検証にのみ使う） */
export const WorkspaceFileSchema = z.object({
  format: z.literal("graphwrangler-workspace"),
  version: z.literal(1),
  nodes: z.array(NodeSchema),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;
