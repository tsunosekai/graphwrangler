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

export type NodeKind = "goal" | "task" | "procedure";

/** ノードの実装形態（Fix3段階の後ろ2つ）。null = 会話段（AIの裁量で実行） */
export type NodeImpl = { type: "doc"; text: string } | { type: "script"; command: string };
export type Executor = "human" | "ai" | "script";
export type Impact = "safe" | "reversible" | "irreversible";
export type Lifecycle = "draft" | "committed";
/** unplanned = やり方未定（実行エンジンは拾わない） */
export type Status = "unplanned" | "pending" | "running" | "waiting" | "done" | "dropped";

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
  /** kind=procedure 用の定期トリガー記述（自由文字列。v1では解釈しない） */
  schedule: string | null;
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
}

export type RunStatus = "running" | "done" | "cancelled";

export interface Run {
  id: string;
  /** kind=procedure のノード id */
  procedure: string;
  title: string;
  /** "manual" ほか自由文字列（"schedule:daily 09:00" 等） */
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
