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

/** goal=プロジェクトページ（一回きりのDAG） / task=作業 /
 *  procedure=手順ページ（繰り返し、ランが流れる）。@deprecated 2026-07-31
 *  「ルーティーンであること」はページ種別ではなく先頭の trigger ノードから導出するモデルへ
 *  移行した（docs/design.md 3.8）。後方互換のため型には残すが、新規作成 UI からは使わない /
 *  decision=分岐ノード（完了時に選択肢を1つ選ぶ。docs/design.md 3.9） /
 *  trigger=起点ノード（発火するとそのページ(group)でランが生成される。3.4/3.8/3.9。
 *  parents を持てない=グラフの起点であることを構造的に保証する） */
export type NodeKind = "goal" | "task" | "procedure" | "decision" | "trigger";

/** ノードの実装形態（Fix3段階の後ろ2つ）。null = 会話段（AIの裁量で実行） */
export type NodeImpl = { type: "doc"; text: string } | { type: "script"; command: string };
export type Executor = "human" | "ai" | "script";
export type Impact = "safe" | "reversible" | "irreversible";
export type Lifecycle = "draft" | "committed";
/** unplanned = やり方未定（実行エンジンは拾わない）。
 *  skipped = 分岐で選ばれなかった枝を通ったため、その回は対象外になった正常状態（dropped=中止とは別物） */
export type Status = "unplanned" | "pending" | "running" | "waiting" | "done" | "dropped" | "skipped";

/** 分岐ノード(kind=decision)の選択肢。判断リクエストの options と同形だが、
 *  then は省略可（docs/design.md 3.9） */
export interface NodeBranch {
  id: string;
  label: string;
  then?: string;
}

export interface Node {
  id: string;
  title: string;
  detail: string | null;
  impl: NodeImpl | null;
  parents: string[];
  /** 所属グループ（フォルダ）ノードの id。包含であり依存(parents)とは独立 */
  group: string | null;
  kind: NodeKind;
  executor: Executor;
  impact: Impact;
  lifecycle: Lifecycle;
  status: Status;
  /** Fix（=ロック）。やり方が確定したか。AIは fixed ノードの impl を書き換えない */
  fixed: boolean;
  pendingRequest: string | null;
  order: number | null;
  /** kind=trigger 用の起動方式記述（"every 15m" / "daily 09:00" / "weekly mon 09:00" 等）。
   *  executor=script なら cron 的な発火判定、executor=ai なら「発火要否を判定させる間隔」
   *  （everyのみ解釈、無指定は既定1時間）、executor=human では使わない（手動発火のみ）。
   *  kind=procedure（非推奨）でも旧来どおり同じ書式で解釈される */
  schedule: string | null;
  /** kind=decision のみ意味を持つ選択肢一覧（最低2個）。それ以外の kind では null */
  branches: NodeBranch[] | null;
  /** 決定済みの枝id（プロジェクト層。kind=decision が完了すると入る）。ラン側は RunItem.choice */
  choice: string | null;
  /** 子側: どの親decisionのどの枝から生えるか（親decisionId → 枝id） */
  parentOptions: Record<string, string>;
  created: string;
  updated: string;
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
  impact: Impact;
  undo: string | null;
  expires: string | null;
  on_expire: string | null;
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

// ---- ルーティーンページ: ラン（実行インスタンス。docs/design.md 3.7/3.8） ----
// テンプレート（procedure のメンバーノード）自身は status を持たず、
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
  updated: string;
  /** テンプレートが kind=decision のとき、そのランで確定した枝id。それ以外は null */
  choice: string | null;
}

export type RunStatus = "running" | "done" | "cancelled";

export interface Run {
  id: string;
  /** ランが属するページ(group)のid。新モデルでは任意のページ(goal等)のidになりうる。
   *  フィールド名は後方互換のため procedure のまま */
  procedure: string;
  title: string;
  /** 発火元の記録。新モデルでは "trigger:<triggerノードid>:<via>" の形
   *  （via は "manual" / "schedule:<原文>" / "ai"）。旧モデル互換の "manual" 単体や
   *  "schedule:daily 09:00" もそのまま許容する自由文字列 — 固定書式を仮定せず生表示する */
  trigger: string;
  status: RunStatus;
  /** テンプレートノード id → ワークアイテム */
  items: Record<string, RunItem>;
  created: string;
  updated: string;
}

/** トレース再生（GET /api/runs/:id/trace の1件）。ノードスレッドのメッセージに
 *  そのメッセージが属するノードのタイトルを添えたもの */
export type TraceEvent = MaterializedMessage & { nodeTitle: string };
