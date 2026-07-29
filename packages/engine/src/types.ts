// packages/core/src/schema.ts の手動ミラー。
// engine は packages/mcp と同じ方針で core に依存しない自己完結パッケージにする
// （server 側のコード変更禁止・HTTP API のみを叩く担当領域のため。pnpm add も禁止なので
// workspace 依存を新設せず、必要な型だけをここに写す）。core のスキーマを変えたら
// ここも手で追随させること。

export type Actor = { kind: "human" | "agent" | "system"; name?: string };

export type NodeKind = "goal" | "task" | "procedure";
export type Executor = "human" | "ai" | "script";
export type Impact = "safe" | "reversible" | "irreversible";
export type Lifecycle = "draft" | "committed";
/** unplanned = やり方未定。依存が揃っていても実行エンジンは拾わない */
export type Status = "unplanned" | "pending" | "running" | "waiting" | "done" | "dropped";

/** doc: 手順書（AI executor が読んで実行）/ script: 決定的スクリプト（script executor が実行） */
export type NodeImpl = { type: "doc"; text: string } | { type: "script"; command: string };

export interface Node {
  id: string;
  title: string;
  detail: string | null;
  impl: NodeImpl | null;
  parents: string[];
  group: string | null;
  kind: NodeKind;
  executor: Executor;
  impact: Impact;
  lifecycle: Lifecycle;
  status: Status;
  selfImprove: boolean;
  pendingRequest: string | null;
  order: number | null;
  /** kind=procedure 用の定期トリガー記述（例 "every 15m" / "daily 09:00"）。null=手動のみ */
  schedule: string | null;
  created: string;
  updated: string;
}

export type NodePatch = Partial<Omit<Node, "id" | "created" | "updated">>;

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
  /** kind=decision_request のときのみ、GET /thread が導出して返す */
  requestStatus?: "open" | "answered";
  answeredBy?: string;
}

export interface DecisionOption {
  id: string;
  label: string;
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

// ---- 手順ページ: ラン（実行インスタンス。docs/design.md 3.7/3.8） ----
// テンプレート（procedure のメンバーノード）自身は status を持たない。
// 実行のたびに生成する Run 側のワークアイテムが status を持つ。

/** skipped = unplanned テンプレート等、その回は対象外だったもの */
export type RunItemStatus = "pending" | "running" | "waiting" | "done" | "dropped" | "skipped";

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
