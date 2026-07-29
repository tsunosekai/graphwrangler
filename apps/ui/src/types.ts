// データモデルの正は packages/core/src/schema.ts（docs/design.md セクション5 と対応）。
// ここではその形を UI 側で複製する（workspace の @tasuki/core を tsc の project reference
// なしに直接 import すると、core 側の tsconfig（"types":["node"]）が適用されず
// ui 側の compilerOptions（DOM のみ）で core の .ts が型チェックされてしまい、
// "node:path" 等が解決できず壊れるため。値は常にサーバ経由でしか来ないので、
// ここでの型は「形が一致していること」の表明であり、ランタイム検証は持たない）。

export interface Actor {
  kind: "human" | "agent" | "system";
  name?: string;
}

export type NodeKind = "goal" | "task";
export type Executor = "human" | "ai" | "script";
export type Impact = "safe" | "reversible" | "irreversible";
export type Lifecycle = "draft" | "committed";
export type Status = "pending" | "running" | "waiting" | "done" | "dropped";

export interface Node {
  id: string;
  title: string;
  detail: string | null;
  parents: string[];
  kind: NodeKind;
  executor: Executor;
  impact: Impact;
  lifecycle: Lifecycle;
  status: Status;
  selfImprove: boolean;
  pendingRequest: string | null;
  order: number | null;
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
