// ツール入力の zod スキーマ。ノードの形は @graphwrangler/core/schema（zod のみで node 依存が無い
// サブパス）から import することで、手動ミラーを解消した（このパッケージ自体は core の他の実装
// = GraphStore/RunStore 等には依存せず、HTTP API を叩くだけの自己完結を保つ）。
// ここに残すのは MCP 固有の形（core 側と定義が微妙に違う NodeImplSchema の null 許容ラップ、
// NodePatchShape の raw shape 切り出し）だけ。
import {
  NodeKindSchema,
  ExecutorSchema,
  ImpactSchema,
  AutonomySchema,
  LifecycleSchema,
  StatusSchema,
  NodeImplSchema as CoreNodeImplSchema,
  NodePatchSchema,
  DecisionRequestSchema,
  RunItemStatusSchema,
} from "@graphwrangler/core/schema";

export {
  NodeKindSchema,
  ExecutorSchema,
  ImpactSchema,
  AutonomySchema,
  LifecycleSchema,
  StatusSchema,
  DecisionRequestSchema,
  RunItemStatusSchema,
};

/** ノードの impl フィールドは null（会話段）を許す。core 側では NodeImplSchema 自体は
 *  non-null（discriminatedUnion）で、NodeSchema/NodeInputSchema 側で個別に .nullable() を
 *  付けている流儀なので、ここで同じラップをして揃える。 */
export const NodeImplSchema = CoreNodeImplSchema.nullable();

/** node_patch の patch フィールドの raw shape。core の NodePatchSchema
 *  （NodeSchema.omit({id,created,updated}).partial()）と同じ集合をそのまま再利用する。 */
export const NodePatchShape = NodePatchSchema.shape;
