// データモデルの正は packages/core/src/schema.ts（docs/design.md セクション5 と対応）。
// ここではその形を UI 側で複製する（workspace の @graphwrangler/core を tsc の project reference
// なしに直接 import すると、core 側の tsconfig（"types":["node"]）が適用されず
// ui 側の compilerOptions（DOM のみ）で core の .ts が型チェックされてしまい、
// "node:path" 等が解決できず壊れるため。値は常にサーバ経由でしか来ないので、
// ここでの型は「形が一致していること」の表明であり、ランタイム検証は持たない）。

export interface Actor {
  kind: "human" | "agent" | "system";
  name?: string;
}

/** goal=プロジェクトページ（ノード群のフォルダ） / task=作業 /
 *  decision=分岐ノード（完了時に選択肢を1つ選ぶ。docs/design.md 3.9） /
 *  trigger=起点ノード（ランを作るとそのページ(group)でランが生成される。3.4/3.8/3.9。
 *  parents を持てない=グラフの起点であることを構造的に保証する） /
 *  folder=左レールの整理棚（2026-08-05）。ページを束ねるだけでグラフ・実行には関与しない */
export type NodeKind = "goal" | "task" | "decision" | "trigger" | "folder";

/** スクリプトのパラメータ宣言（2026-07-31 実装。docs/design.md 3.5.1）。
 *  宣言（name/label/example）は GraphWrangler AI が書き、値（value）は人間がパネルで入力する。
 *  command 中の `{name}` プレースホルダに対応する（packages/core/src/schema.ts ScriptParamSchema と同形） */
export interface ScriptParam {
  name: string;
  label?: string | null;
  example?: string | null;
  value?: string | null;
}

/** ノードの実装形態（Fix3段階の後ろ2つ）。null = 会話段（AIの裁量で実行）。
 *  doc は text（インライン本文）/ path（ワークスペース内ファイルへの相対パス）のどちらか
 *  片方があればよい（両方あれば text 優先。packages/core/src/schema.ts NodeImplSchema と同形） */
export type NodeImpl =
  | { type: "doc"; text?: string | null; path?: string | null }
  | { type: "script"; command: string; params?: ScriptParam[] | null };
export type Executor = "human" | "ai" | "script";
/** AI executor の自律度（UI名「自律度」）。high=人間に聞かず進む（失敗も自動リトライ）/
 *  normal=必要なときだけ質問 / low=迷ったら質問に倒す。executor=ai の kind=task でのみ意味を持つ */
export type Autonomy = "high" | "normal" | "low";
/** 判断リクエスト自身の影響度（ノードの approval とは別の3値） */
export type RequestImpact = "safe" | "reversible" | "irreversible";
export type Lifecycle = "draft" | "committed";
/** unplanned = やり方未定（実行エンジンは拾わない）。
 *  skipped = 分岐で選ばれなかった枝を通ったため、その回は対象外になった正常状態（dropped=中止とは別物）。
 *  「あなたの番（waiting）」は保存されない: pendingRequest の有無から導出する */
export type NodeStatus = "unplanned" | "pending" | "running" | "done" | "dropped" | "skipped";
/** 表示用ステータス。ノードの保存値（NodeStatus）に、導出値の waiting
 *  （pendingRequest あり / ランアイテムの waiting）を加えた和集合 */
export type Status = NodeStatus | "waiting";

/** 分岐ノード(kind=decision)の選択肢。判断リクエストの options と同形だが、
 *  then は省略可（docs/design.md 3.9） */
export interface NodeBranch {
  id: string;
  label: string;
  then?: string;
}

/** ランのコンテキストへの出力宣言（docs/design.md 3.15）。宣言のみで値は持たない
 *  （値は実行時に run.context へ載る）。トリガーの outputs は特別扱いで「ラン作成時に入る
 *  初期キー」＝手動▶のラン作成フォームの項目 / 検知スクリプトの emit 契約になる
 *  （packages/core/src/schema.ts OutputParamSchema と同形） */
export interface OutputParam {
  name: string;
  label?: string | null;
  example?: string | null;
}

/** スクリプト試走（試走ゲート。docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）の記録。
 *  hash は試走時点の impl.command の sha256 hex。null = 未試走 */
export interface ImplTrial {
  hash: string;
  success: boolean;
  ts: string;
}

export interface Node {
  id: string;
  title: string;
  detail: string | null;
  impl: NodeImpl | null;
  /** impl.type==="script" の試走記録。impl が script でないノードでは常に null */
  implTrial: ImplTrial | null;
  parents: string[];
  /** 所属グループ（フォルダ）ノードの id。包含であり依存(parents)とは独立 */
  group: string | null;
  /** 左レールの整理用フォルダ（kind=folder ノードの id）。null = 直下。
   *  包含(group)・依存(parents)とは独立した「見せ方だけ」の軸（2026-08-05） */
  folder: string | null;
  /** kind=folder のみ: どの節の棚か（左レール）。null = プロジェクト節（2026-08-08） */
  folderSection: "project" | "routine" | null;
  /** 左レールでの手動並び順（昇順。同じ入れ物の中でだけ意味を持つ）。null = 未指定＝後ろ */
  order: number | null;
  kind: NodeKind;
  executor: Executor;
  /** 実行前承認（trigger ではラン前承認）。true = 実行の直前に人間の承認ゲートを通る。
   *  旧名 impact("safe"|"irreversible")、2026-08-03 改名 */
  approval: boolean;
  /** AI executor の自律度。AI以外の担当では使われない（値は常に持つ。既定 normal） */
  autonomy: Autonomy;
  /** このノードのAI（実行AI・Task AI）のモデル上書き（例: opus/sonnet/haiku）。null=設定の既定 */
  aiModel: string | null;
  /** 同エフォート（思考の深さ）。null=設定の既定（2026-08-07） */
  aiEffort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  lifecycle: Lifecycle;
  status: NodeStatus;
  /** Fix（=ロック）。やり方が確定したか。AIは fixed ノードの impl を書き換えない */
  fixed: boolean;
  /** open な判断リクエストの message id。あれば「あなたの番」（waiting 表示を導出する） */
  pendingRequest: string | null;
  /** kind=trigger 用の起動方式記述（"every 15m" / "daily 09:00" / "weekly mon 09:00" 等）。
   *  executor=script なら cron 的なラン作成の判定、executor=ai なら「ラン作成要否を判定させる間隔」
   *  （everyのみ解釈、無指定は既定1時間）、executor=human では使わない（手動でランを作る操作のみ） */
  schedule: string | null;
  /** ランのコンテキストへの出力宣言（docs/design.md 3.15）。null = 宣言なし。
   *  トリガーではラン作成フォームの項目、task では「このノードがランに書き足すキー」の宣言 */
  outputs: OutputParam[] | null;
  /** kind=decision のみ意味を持つ選択肢一覧（最低2個）。それ以外の kind では null */
  branches: NodeBranch[] | null;
  /** 決定済みの枝id（プロジェクト層。kind=decision が完了すると入る）。ラン側は RunItem.choice */
  choice: string | null;
  /** 子側: どの親decisionのどの枝から生えるか（親decisionId → 枝id） */
  parentOptions: Record<string, string>;
  /** 作成者メール（チーム化 2026-08-04）。サーバが作成時に刻む不変値で patch 不可。
   *  ログイン無し運用では null */
  createdBy: string | null;
  /** 担当者メール（単数）。executor=human の「人間の誰がやるか」。null = 未割当 */
  assignee: string | null;
  /** 関係者メール配列。ページ（kind=goal / メンバー持ち）でのみ意味を持つ */
  members: string[];
  created: string;
}

export interface DecisionOption {
  id: string;
  label: string;
  /** 選ぶと何が起きるか */
  then: string;
  recommended?: boolean;
}

export interface DecisionRequest {
  context: string;
  question: string;
  options: DecisionOption[];
  impact: RequestImpact;
  undo: string | null;
}

export interface DecisionAnswer {
  requestId: string;
  option: string | null;
  note: string | null;
}

export type MessageKind = "say" | "decision_request" | "decision_answer" | "status" | "artifact";

export interface Message {
  id: string;
  node: string;
  ts: string;
  author: Actor;
  via: string;
  kind: MessageKind;
  body: string;
  payload: unknown;
}

export type MaterializedMessage = Message & {
  requestStatus?: "open" | "answered";
  answeredBy?: string;
};

// ---- ルーティーンページ: ラン（実行インスタンス。docs/design.md 3.8） ----
// テンプレート（ルーティーンページのメンバーノード）自身は status を持たず、
// 実行のたびに生成する Run 側のワークアイテムが status を持つ。

export type RunItemStatus =
  | "pending"
  | "running"
  | "waiting"
  | "done"
  | "dropped"
  | "skipped";

export interface RunItem {
  status: RunItemStatus;
  note: string | null;
  /** テンプレートが kind=decision のとき、そのランで確定した枝id。それ以外は null */
  choice: string | null;
  /** script 実行時に解決された {name: 値}（docs/design.md 3.15）。実行済みの記録なので
   *  以後 run.context が変わっても書き換わらない——ずれたら UI が「古い値で実行済み」を出す */
  resolvedParams: Record<string, string> | null;
}

export type RunStatus = "running" | "done" | "cancelled";

export interface Run {
  id: string;
  /** ランが属するページ(group)のid */
  pageId: string;
  title: string;
  /** ラン作成元の記録。"trigger:<triggerノードid>:<via>" の形（via は "manual" /
   *  "schedule:<原文>" / "ai" 等の自由文字列） — 固定書式を仮定せず生表示する */
  trigger: string;
  status: RunStatus;
  /** テンプレートノード id → ワークアイテム */
  items: Record<string, RunItem>;
  /** ランのコンテキスト（docs/design.md 3.15）。ラン作成時の初期値 + ノードが ##gw / API で
   *  書き足す key→現在値。同一ラン内は last-write-wins */
  context: Record<string, string>;
  created: string;
}

// ---- 配線チェック（GET /api/pages/:id/wiring。docs/design.md 3.15） ----

/** 参照矢印の1本: producer（出力宣言）→ consumer（コマンド中の {name} 参照） */
export interface WiringReference {
  producerId: string;
  consumerId: string;
  name: string;
}

/** 配線の警告。missing=供給元なし / not-ancestor=祖先でないproducer /
 *  branch-dependent=経路依存 / duplicate=重複producer。message は日本語の説明文 */
export interface WiringWarning {
  nodeId: string;
  name: string;
  kind: "missing" | "not-ancestor" | "branch-dependent" | "duplicate";
  message: string;
}

/** 実行の内訳（AI実行ノードの内部サブステップ。packages/core/src/schema.ts SubStepSchema と同形）。
 *  実行成功/失敗の status メッセージの payload.subSteps に配列で載る。
 *  「ノード内ノードに展開」（POST /api/nodes/:id/expand）の素材になる */
export interface SubStep {
  /** ツール呼び出し id（tool_use.id）。展開時のノード id とは無関係 */
  id: string;
  /** 実行順（0始まり） */
  index: number;
  /** ツール名。例: "Bash" "Read" "Edit" "Task" */
  tool: string;
  /** 表示名。Bash は description/コマンド先頭、他は主要引数の要約 */
  title: string;
  /** tool=Bash のときの実コマンド。展開時に script impl になる */
  command: string | null;
  /** 入力の要約（JSON文字列。保存前に切り詰め済み） */
  input: string | null;
  /** 結果の要約（切り詰め済み） */
  output: string | null;
  status: "ok" | "error";
}

/** payload から subSteps を安全に取り出す（無ければ空配列。core の同名関数と同じ役割だが
 *  ここは zod を持たないので緩い形チェック——tool/title が string で status が ok/error であること
 *  だけ見る。壊れた要素は個別に弾く（1件おかしくても他は出す） */
export function subStepsOf(payload: unknown): SubStep[] {
  const raw = (payload as { subSteps?: unknown } | null)?.subSteps;
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is SubStep => {
    if (!s || typeof s !== "object") return false;
    const o = s as Record<string, unknown>;
    return (
      typeof o.id === "string" &&
      typeof o.index === "number" &&
      typeof o.tool === "string" &&
      typeof o.title === "string" &&
      (o.status === "ok" || o.status === "error")
    );
  });
}

/** トレース再生（GET /api/runs/:id/trace の1件）。ノードスレッドのメッセージに
 *  そのメッセージが属するノードのタイトルを添えたもの */
export type TraceEvent = MaterializedMessage & { nodeTitle: string };

/**
 * ランの時点のノード（GET /api/runs/:id/graph の1件。2026-08-08）。
 * source = その中身の出どころ:
 *   snapshot ラン作成時にランへ焼いたもの（最も確か）
 *   replay   操作ログをラン作成時刻まで再生して復元したもの
 *   current  当時の記録が無く、現在の中身で代用（当時と違う可能性がある）
 */
export type RunGraphNode = Partial<Node> & {
  id: string;
  title: string;
  source: "snapshot" | "replay" | "current";
};
