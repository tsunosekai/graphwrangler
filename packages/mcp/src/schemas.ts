// ツール入力の zod スキーマ。packages/core への依存を持たない自己完結パッケージなので、
// docs/agent-contracts.md / packages/core/src/schema.ts のノードの形を手動でミラーしている。
// core のスキーマを変えたらここも追随が必要（apps/ui/src/types.ts と同じ既知の妥協）。
import { z } from "zod";

export const NodeKindSchema = z.enum(["goal", "task", "procedure"]);
export const ExecutorSchema = z.enum(["human", "ai", "script"]);
export const ImpactSchema = z.enum(["safe", "reversible", "irreversible"]);
export const LifecycleSchema = z.enum(["draft", "committed"]);
export const StatusSchema = z.enum([
  "unplanned",
  "pending",
  "running",
  "waiting",
  "done",
  "dropped",
]);

export const NodeImplSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("doc"), text: z.string().min(1) }),
    z.object({ type: z.literal("script"), command: z.string().min(1) }),
  ])
  .nullable();

export const DecisionOptionSchema = z.object({
  id: z.string(),
  label: z.string().min(1),
  then: z.string().min(1),
  recommended: z.boolean().optional(),
});

export const DecisionRequestSchema = z.object({
  context: z.string().min(1),
  question: z.string().min(1),
  options: z.array(DecisionOptionSchema).min(2).max(4),
  impact: ImpactSchema,
  undo: z.string().nullable().optional(),
  expires: z.string().nullable().optional(),
  on_expire: z.string().nullable().optional(),
});

/** node_patch の patch フィールド。NodePatchSchema（core）と同じ集合を手動ミラー */
export const NodePatchShape = {
  title: z.string().min(1).optional(),
  detail: z.string().nullable().optional(),
  impl: NodeImplSchema.optional(),
  parents: z.array(z.string()).optional(),
  group: z.string().nullable().optional(),
  kind: NodeKindSchema.optional(),
  executor: ExecutorSchema.optional(),
  impact: ImpactSchema.optional(),
  lifecycle: LifecycleSchema.optional(),
  status: StatusSchema.optional(),
  selfImprove: z.boolean().optional(),
  pendingRequest: z.string().nullable().optional(),
  order: z.number().nullable().optional(),
};
