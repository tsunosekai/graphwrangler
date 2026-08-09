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

/** goal=プロジェクトページ（ノード群のフォルダ） / task=作業 /
 *  decision=分岐ノード（完了時に選択肢を1つ選ぶ。docs/design.md 3.9） /
 *  trigger=起点ノード（Rx の Observable のソース。発火するとそのページ(group)でランが
 *  生成される。docs/design.md 3.4/3.8/3.9。parents を持てない=グラフの起点であることを
 *  構造的に保証する） /
 *  folder=左レールの整理棚（2026-08-05）。ページを束ねるだけの入れ物で、グラフ・実行・
 *  ランには一切関与しない（エンジンは kind=task しか拾わない）。ページの所属は group では
 *  なく folder フィールドで表す——group（包含）を使うと「メンバーを持つノード＝ページ」の
 *  導出や巻き添え削除にフォルダが乗ってしまうため。
 *  「ルーティーンであること」はページ種別ではなく、trigger ノードを
 *  メンバーに持つかどうかから導出する */
export const NodeKindSchema = z.enum(["goal", "task", "decision", "trigger", "folder"]);
export const ExecutorSchema = z.enum(["human", "ai", "script"]);
/** AI executor の自律度（2026-08-03 本人指示。UI名「自律度」）。
 *  - high: 人間に判断を仰がず、合理的な仮定を置いて最後まで進む。実行失敗も
 *    まず自動リトライし、尽きて初めて失敗リカバリカードを開く
 *  - normal: 基本は自分で判断し、本当に必要なときだけ QUESTION 形式で人間に質問する
 *  - low: 前提が曖昧・選択肢の優劣が明確でない場面では自分で決めず積極的に質問する
 *  executor=ai の kind=task でのみ意味を持つ（script は決定的、decision/trigger は別の判断系）。
 *  approval（実行前承認ゲート）は autonomy では外れない（安全装置はノード属性で
 *  無効化できない。ゲートを外したければ approval を false に戻す＝別の明示操作） */
export const AutonomySchema = z.enum(["high", "normal", "low"]);
/** 判断リクエスト自身の影響度（5.4）。ノードの approval（実行前承認ゲートの有無）とは
 *  別の軸で、中間の reversible（戻せるが軽くない）を持つ */
export const RequestImpactSchema = z.enum(["safe", "reversible", "irreversible"]);
export const LifecycleSchema = z.enum(["draft", "committed"]);
/** unplanned = やり方未定（「ここだけまだ考えてない」）。依存が揃っていても実行エンジンは拾わない。
 *  skipped = 分岐で選ばれなかった枝を通ったため、その回は対象外になった正常状態（dropped=中止とは別物）。
 *  「あなたの番（waiting）」は保存しない: pendingRequest の有無から導出する（open な
 *  リクエストの存在 ⇔ ボールが人間。ランのワークアイテムは別で、RunItemStatus が waiting を持つ） */
export const StatusSchema = z.enum([
  "unplanned",
  "pending",
  "running",
  "done",
  "dropped",
  "skipped",
]);

/** スクリプトのパラメータ宣言（2026-07-31 実装。docs/design.md 3.5.1）。
 *  宣言（name/label/example）は GraphWrangler AI が書き、値（value）は人間がパネルで入力する。
 *  command 中の `{name}` プレースホルダに対応する（server: substituteParams / engine: 複製、
 *  UI: NodePanel が同じ規約で表示・編集する）。value が null/空文字のままだと未入力扱い */
export const ScriptParamSchema = z.object({
  name: z.string().min(1),
  label: z.string().nullable().optional(),
  example: z.string().nullable().optional(),
  value: z.string().nullable().optional(),
});
export type ScriptParam = z.infer<typeof ScriptParamSchema>;

/** ランのコンテキストへの出力宣言（2026-08-09。docs/design.md 3.15）。
 *  「このノードはランのキー name を出力する」の宣言で、値は持たない（値はランの進行中に
 *  run.context へ書かれる）。kind=trigger では発火フォームの項目 / 検知スクリプトの
 *  emit 契約になる。ScriptParam と違い value フィールドが無いのが本質的な差
 *  （宣言と値の置き場を分けるのがこの設計の骨子） */
export const OutputParamSchema = z.object({
  name: z.string().min(1),
  label: z.string().nullable().optional(),
  example: z.string().nullable().optional(),
});
export type OutputParam = z.infer<typeof OutputParamSchema>;

/** ノードの実装形態（Fix3段階の後ろ2つ。null=会話段=AIの裁量で実行）
 *  - doc: 手順書。AI executor がこれを読んで実行する。text はインライン本文、path は
 *    ワークスペースモード（ワークスペース=1ファイル化）でリポジトリ内ファイルを指す相対パス
 *    （docs/design.md 「ワークスペース=1ファイル化」仕様）。どちらか片方があれば良く、
 *    両方あるときは text を優先する（engine 側の規約）。両方 null は実装未記入と同義で、
 *    既存データ（text だけ）はそのまま通る後方互換を維持する
 *  - script: 決定的スクリプト（シェルコマンド）。script executor が実行する。command は
 *    パラメータ宣言があれば `{name}` プレースホルダ入りのテンプレートになる。params は
 *    無し/空配列/未指定のいずれでも旧データ互換で通る（既存データに params フィールドは無い） */
export const NodeImplSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("doc"),
    text: z.string().min(1).nullable().optional(),
    path: z.string().min(1).nullable().optional(),
  }),
  z.object({
    type: z.literal("script"),
    command: z.string().min(1),
    params: z.array(ScriptParamSchema).nullable().optional(),
  }),
]);
export type NodeImpl = z.infer<typeof NodeImplSchema>;

/** スクリプト試走（試走ゲート。docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）の記録。
 *  hash は試走時点の impl.command の sha256 hex（鮮度チェック用: command を変更後は
 *  再試走するまで stale 扱いになる）。success は最後の試走の成否、ts は試走時刻。
 *  null = 未試走。impl.type!=="script" のノードでは常に null（意味を持たない） */
export const ImplTrialSchema = z
  .object({
    hash: z.string().min(1),
    success: z.boolean(),
    ts: z.string(),
  })
  .nullable();
export type ImplTrial = z.infer<typeof ImplTrialSchema>;

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
  /** impl.type==="script" の試走記録（試走ゲート。docs/design.md 3.5 近く）。
   *  既存データ互換のため default null（旧データには無いフィールド） */
  implTrial: ImplTrialSchema.default(null),
  /** 先行ノードid。DAG。空=ルート。依存（順序）を表す */
  parents: z.array(z.string()),
  /** 所属するグループ（フォルダ）ノードの id。包含を表す。依存(parents)とは独立。
   *  ゴールはグラフの先頭ノードではなく「ノード群のフォルダ」（Houdiniのネットワークボックス） */
  group: z.string().nullable(),
  /** 左レールの整理用フォルダ（kind=folder ノードの id）。null = 直下（フォルダ無し）。
   *  包含(group)・依存(parents)とは独立した「見せ方だけ」の軸で、実行にもラン生成にも
   *  関与しない（2026-08-05 追加）。ページ（kind=goal）とフォルダ自身が持ちうる
   *  （フォルダの入れ子も型としては可能。UIは現状1階層で使う）。既存データ互換で default null */
  folder: z.string().nullable().default(null),
  /** kind=folder のみ意味を持つ「どの節の棚か」（左レール）。null = プロジェクト節
   *  （既存フォルダの互換）。2026-08-08 本人要望「ルーティーンにもフォルダを作れるように」 */
  folderSection: z.enum(["project", "routine"]).nullable().default(null),
  /** 左レールでの手動並び順（昇順。同じ入れ物の中でだけ意味を持つ）。null = 未指定で、
   *  指定済みより後ろに落ちて created 昇順で並ぶ。整数を詰め直す運用（UI が並べ替えのたびに
   *  変わったノードだけ patch する）。既存データ互換で default null */
  order: z.number().nullable().default(null),
  kind: NodeKindSchema,
  executor: ExecutorSchema,
  /** 実行前承認（trigger では発火前承認）。true = 実行の直前に人間の承認ゲートを通る。
   *  旧名 impact("safe"|"irreversible")（2026-08-03 改名。impl と紛らわしい・
   *  「承認ゲートの有無」の実態と名前がズレていた・判断リクエストの impact と同名衝突、
   *  の3点を解消。旧データは *CompatSchema の読み替えレイヤで受ける） */
  approval: z.boolean().default(false),
  /** AI executor の自律度。既存データ互換のため default "normal"（旧データには無いフィールド） */
  autonomy: AutonomySchema.default("normal"),
  /** このノードのAI（実行AI・Task AI）が使うモデルの上書き（例: "opus" "sonnet" "haiku"）。
   *  null = 設定（engine.model / chat.cliModel）の既定に従う（2026-08-07 本人要望
   *  「AI実行ノードとAI会話のモデルとエフォートを切り替えられるように」）。既存データ互換で default null */
  aiModel: z.string().nullable().default(null),
  /** 同エフォート（思考の深さ。claude CLI の --effort）。null = 設定の既定に従う */
  aiEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().default(null),
  lifecycle: LifecycleSchema,
  status: StatusSchema,
  /** Fix フラグ（= Houdini のロック）。true = やり方が確定し、AIは impl を書き換えない。
   *  中身がスクリプトでも手順書でも「人間が判断する」でもよい — Fix はやり方の確定であって
   *  スクリプト化ではない（2026-07-31 本人定義）。ノードは未Fix（改善中）で生まれる */
  fixed: z.boolean(),
  /** open な判断リクエストの message id。open の存在 ⇔ ボールが人間（=「あなたの番」）。
   *  UI・エンジンはこれの有無から waiting 表示/実行除外を導出する */
  pendingRequest: z.string().nullable(),
  /** kind=trigger 用の起動方式記述（"every 15m" / "daily 09:00" / "weekly mon 09:00" 等）。
   *  executor=script なら cron 的な発火判定にそのまま使う。executor=ai なら「AIに発火要否を
   *  判定させる間隔」として使う（every系のみ解釈、無指定は既定1時間）。executor=human では
   *  使わない（手動発火のみ）。書式は自由文字列で、パースできないものは無視される */
  schedule: z.string().nullable(),
  /** kind=decision のみ意味を持つ選択肢一覧（最低2個。elseなし・単一選択。docs/design.md 3.9）。
   *  それ以外の kind では null */
  branches: z.array(NodeBranchSchema).nullable().default(null),
  /** 決定済みの枝id（プロジェクト層。kind=decision が完了すると入る）。ラン側は RunItem.choice */
  choice: z.string().nullable().default(null),
  /** ランのコンテキストへの出力宣言（3.15）。null=宣言なし。trigger では発火フォームの
   *  項目 / emit 契約になる。既存データ互換で default null */
  outputs: z.array(OutputParamSchema).nullable().default(null),
  /** 子側: どの親decisionのどの枝から生えるか（親decisionId → 枝id）。
   *  検証: キーが parents に含まれ、その親が kind=decision であること。値がその親の branches に存在すること */
  parentOptions: z.record(z.string(), z.string()).default({}),
  /** 作成者（ログインユーザーのメール）。作成時にサーバが刻む不変の記録で、以後 patch しない。
   *  ログイン無し運用・エンジン/MCP 経由（操作者メール不明）では null（docs/design.md 3.11）。
   *  既存データ互換のため default null */
  createdBy: z.string().nullable().default(null),
  /** 担当者（メール）。executor=human のノードで「人間の誰がやるか」。単数・nullable
   *  （null = 未割当 = 全員宛。Linear の assignee と同じ思想で、複数人で分ける作業は
   *  ノード分割で表現する）。Fix の保護対象外（誰がやるかは「やり方」ではない） */
  assignee: z.string().nullable().default(null),
  /** 関係者（メール配列）。ページ（kind=goal / メンバー持ち）でのみ意味を持つ。
   *  左レールの人フィルタと「自分の関係分」判定に使う。作成者は自動で関係者扱いなので
   *  ここへ重複して入れる必要はない */
  members: z.array(z.string()).default([]),
  created: z.string(),
});
export type Node = z.infer<typeof NodeSchema>;

/** ノード作成時の入力（id/created/updated はエンジンが振る） */
export const NodeInputSchema = z.object({
  title: z.string().default(""),
  detail: z.string().nullable().default(null),
  impl: NodeImplSchema.nullable().default(null),
  parents: z.array(z.string()).default([]),
  group: z.string().nullable().default(null),
  folder: z.string().nullable().default(null),
  folderSection: z.enum(["project", "routine"]).nullable().default(null),
  order: z.number().nullable().default(null),
  kind: NodeKindSchema.default("task"),
  executor: ExecutorSchema.default("human"),
  approval: z.boolean().default(false),
  autonomy: AutonomySchema.default("normal"),
  aiModel: z.string().nullable().default(null),
  aiEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().default(null),
  lifecycle: LifecycleSchema.default("draft"),
  status: StatusSchema.default("pending"),
  fixed: z.boolean().default(false),
  schedule: z.string().nullable().default(null),
  branches: z.array(NodeBranchSchema).nullable().default(null),
  choice: z.string().nullable().default(null),
  outputs: z.array(OutputParamSchema).nullable().default(null),
  parentOptions: z.record(z.string(), z.string()).default({}),
  /** createdBy は入力に含めない（サーバが操作者から刻む。クライアントに詐称させない） */
  assignee: z.string().nullable().default(null),
  members: z.array(z.string()).default([]),
});
export type NodeInput = z.input<typeof NodeInputSchema>;

/** 部分更新できるフィールド（createdBy は不変の記録なので patch 不可） */
export const NodePatchSchema = NodeSchema.omit({
  id: true,
  created: true,
  createdBy: true,
}).partial();
export type NodePatch = z.infer<typeof NodePatchSchema>;

// ---- 旧フィールド互換（2026-08-03 impact → approval 改名） ----

/** 旧 impact("safe"|"irreversible") を approval(boolean) へ読み替える。保存済みノード・
 *  過去の ops.jsonl・古いクライアントの入力を無停止で受けるための互換レイヤ。
 *  approval が明示されていればそちらが勝ち、余った impact キーは zod が落とす */
function legacyApprovalPreprocess(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (!("approval" in o) && (o.impact === "irreversible" || o.impact === "safe")) {
      return { ...o, approval: o.impact === "irreversible" };
    }
  }
  return v;
}

/** 保存データ・opsログ・API入力の読み込みにはこちらを使う（出力型は素のスキーマと同じ）。
 *  素の NodeSchema/NodePatchSchema は .omit/.shape 派生用に ZodObject のまま残す */
export const NodeCompatSchema = z.preprocess(legacyApprovalPreprocess, NodeSchema);
export const NodeInputCompatSchema = z.preprocess(legacyApprovalPreprocess, NodeInputSchema);
export const NodePatchCompatSchema = z.preprocess(legacyApprovalPreprocess, NodePatchSchema);

// ---- 操作ログ（ops.jsonl の1行） ----

export const OpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("node.add"),
    payload: z.object({ node: NodeCompatSchema }),
  }),
  z.object({
    op: z.literal("node.patch"),
    payload: z.object({ nodeId: z.string(), patch: NodePatchCompatSchema }),
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
    /** 記録の辻褄合わせでシステムが追記した行（2026-08-08）。GraphWrangler を通さない
     *  正データファイルの書き換え（移行データの流し込み・git pull・他エージェントの直接編集）は
     *  操作ログに載らないため、起動時に「正データ vs ログ再生」の差分をこの印付きで追記して
     *  ログを実態に合わせる。人間の操作ではないので undo/redo の対象から外す */
    system: z.boolean().default(false),
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
  /** この判断自体の影響（ノードの impact とは別の3値） */
  impact: RequestImpactSchema,
  /** 戻し方の説明。null=特になし */
  undo: z.string().nullable().default(null),
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
  /**
   * どのランの発言/記録か（2026-08-08 本人指定「会話や実行履歴もフォーク」）。
   * null = テンプレート（設計図）側の会話。ランのページで書いた発言・そのランの実行記録は
   * ここにラン id が入り、テンプレートの会話とは混ざらない。
   *
   * 既存データ互換: この機能より前のラン記録は payload.runId にだけ入っている。
   * 読み出し側は runIdOf(message) を使うこと（フィールド → payload の順に見る）。
   */
  runId: z.string().nullable().default(null),
});
export type Message = z.infer<typeof MessageSchema>;

/** メッセージの所属ラン。旧データ（payload.runId だけ持つ）も拾う */
export function runIdOf(m: Pick<Message, "runId" | "payload">): string | null {
  if (m.runId) return m.runId;
  const payload = m.payload as { runId?: unknown } | null;
  return payload && typeof payload.runId === "string" ? payload.runId : null;
}

// ---- 実行の内訳（AI実行ノードの内部サブステップ） ----
// AI 実行中に実際に行われた操作（ツール呼び出し）を1件ずつ記録したもの。
// 実行成功/失敗の status メッセージの payload.subSteps に配列で載る。
// 「ノード内ノード」の実体であり、展開（ノードをこの内訳の実ノード連鎖で
// 置き換える POST /api/nodes/:id/expand）の素材になる。
export const SubStepSchema = z.object({
  /** ツール呼び出し id（tool_use.id）。展開時のノード id とは無関係 */
  id: z.string(),
  /** 実行順（0始まり） */
  index: z.number().int().min(0),
  /** ツール名。例: "Bash" "Read" "Edit" "Task" */
  tool: z.string(),
  /** 表示名。Bash は description/コマンド先頭、他は主要引数の要約 */
  title: z.string(),
  /** tool=Bash のときの実コマンド。展開時に script impl になる */
  command: z.string().nullable().default(null),
  /** 入力の要約（JSON文字列。保存前に切り詰め済み） */
  input: z.string().nullable().default(null),
  /** 結果の要約（切り詰め済み） */
  output: z.string().nullable().default(null),
  status: z.enum(["ok", "error"]),
});
export type SubStep = z.infer<typeof SubStepSchema>;

/** payload から subSteps を安全に取り出す（無ければ空配列） */
export function subStepsOf(payload: unknown): SubStep[] {
  const raw = (payload as { subSteps?: unknown } | null)?.subSteps;
  if (!Array.isArray(raw)) return [];
  const parsed = z.array(SubStepSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/** リスト表示用: decision_request の状態を answers から導出した形 */
export type MaterializedMessage = Message & {
  /** kind=decision_request のときのみ: open / answered */
  requestStatus?: "open" | "answered";
  /** kind=decision_request で answered のとき、対応する decision_answer の id */
  answeredBy?: string;
};

// ---- ラン（実行インスタンス。docs/design.md 3.8） ----
// テンプレート（ルーティーンページのメンバーノード）自身は status を持たない。
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
  /** テンプレートが kind=decision のとき、そのランで確定した枝id。それ以外は null */
  choice: z.string().nullable().default(null),
  /** script 実行時に実際に解決された {name: 値}（3.15。2026-08-09）。ランページの
   *  引数欄はこの値入り（読み取り専用）で表示し、現在の run.context とずれていたら
   *  「古い値で実行済み」を出す。null = 未実行 / この機能より前の記録 */
  resolvedParams: z.record(z.string(), z.string()).nullable().default(null),
});
export type RunItem = z.infer<typeof RunItemSchema>;

export const RunStatusSchema = z.enum(["running", "done", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * 発火時点のノードの中身（2026-08-08 本人要望「その時のノードの状態を見れるように」）。
 *
 * テンプレートノードはランをまたいで共有されるため、後からタイトルや手順書を書き換えると
 * 過去のランを見返しても**今の文面**しか出ない。ランの当時を再現できるように、発火時点の
 * 中身をランへ焼いて残す。id と、後から書き換わりうる表示・実行に関わるフィールドだけを持つ
 * （created/createdBy のような不変値、order/folder のような見せ方だけの値は入れない）。
 */
export const NodeSnapshotSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  impl: NodeImplSchema.nullable(),
  parents: z.array(z.string()),
  group: z.string().nullable(),
  kind: NodeKindSchema,
  executor: ExecutorSchema,
  approval: z.boolean(),
  autonomy: AutonomySchema,
  aiModel: z.string().nullable(),
  aiEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable(),
  lifecycle: LifecycleSchema,
  /** 発火時点の**テンプレート**の status（ランの進捗は RunItem.status が持つ） */
  status: StatusSchema,
  fixed: z.boolean(),
  schedule: z.string().nullable(),
  branches: z.array(NodeBranchSchema).nullable(),
  /** 出力宣言（3.15）。この機能より前のランのスナップショットには無いため default null */
  outputs: z.array(OutputParamSchema).nullable().default(null),
  parentOptions: z.record(z.string(), z.string()),
  assignee: z.string().nullable(),
});
export type NodeSnapshot = z.infer<typeof NodeSnapshotSchema>;

export const RunSchema = z.object({
  id: z.string(),
  /** ランが属するページ(group)のid。既存ランファイルとの互換のためキー名は procedure のまま */
  procedure: z.string(),
  title: z.string().min(1),
  /** 発火元の記録。"trigger:<triggerノードid>:<via>" の形
   *  （via は "manual" / "schedule:<原文>" / "ai" 等の自由文字列） */
  trigger: z.string().min(1),
  status: RunStatusSchema,
  /** テンプレートノード id → ワークアイテム */
  items: z.record(z.string(), RunItemSchema),
  /** ランのコンテキスト（3.15。2026-08-09）。発火時の初期値が入り、ランの進行中に
   *  ノード（##gw マーカー / 完了フォーム / API）が書き足す。last-write-wins。
   *  旧ランファイル互換で default {} */
  context: z.record(z.string(), z.string()).default({}),
  /** 発火時点のページ構成（ページ自身 + メンバー全部。トリガーや items に入らないノードも含む）。
   *  null = この機能より前のラン。その場合は ops.jsonl の再生で当時を復元する
   *  （GraphStore.nodesAt。サーバの GET /api/runs/:id/graph が両者を束ねる） */
  snapshot: z
    .object({
      capturedAt: z.string(),
      nodes: z.array(NodeSnapshotSchema),
    })
    .nullable()
    .default(null),
  created: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

// ---- ワークスペースモード: 正データファイル（<repo>/workflow.gw.json 等。
// docs「ワークスペース=1ファイル化」仕様）----

/** 正データファイルの形。nodes は id 昇順・決定的シリアライズ（stableStringify）で書く
 *  ことで git diff が意味のある差分になる（本ファイルはその形の検証にのみ使う） */
export const WorkspaceFileSchema = z.object({
  format: z.literal("graphwrangler-workspace"),
  version: z.literal(1),
  nodes: z.array(NodeCompatSchema),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;
