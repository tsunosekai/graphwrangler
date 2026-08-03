// packages/core/src/schema.ts の型を re-export する（型のみ。ランタイムimportはしない）。
// 以前はここに core スキーマの手動ミラーを書いていたが、core を変えるたびに手で追随する
// 二重管理になっていたため、@graphwrangler/core への型のみの依存に切り替えた
// （package.json に "@graphwrangler/core": "workspace:*" を追加。実行時コードは
// 相変わらず HTTP API のみを叩き、core の実装（GraphStore 等）には依存しない）。
//
// core は enum 系（NodeKind/Executor/Lifecycle/Status/MessageKind/DecisionOption）に
// ついて型エイリアスを export しておらず Schema（zod オブジェクト）しか export していないため、
// それらは z.infer で導出する（import type なのでランタイムには残らない）。
import type { z } from "zod";
import type {
  NodeKindSchema,
  ExecutorSchema,
  AutonomySchema,
  LifecycleSchema,
  StatusSchema,
  MessageKindSchema,
  DecisionOptionSchema,
} from "@graphwrangler/core";

export type NodeKind = z.infer<typeof NodeKindSchema>;
export type Executor = z.infer<typeof ExecutorSchema>;
export type Autonomy = z.infer<typeof AutonomySchema>;
export type Lifecycle = z.infer<typeof LifecycleSchema>;
export type Status = z.infer<typeof StatusSchema>;
export type MessageKind = z.infer<typeof MessageKindSchema>;
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export type {
  Actor,
  NodeImpl,
  Node,
  NodePatch,
  DecisionRequest,
  DecisionAnswer,
  RunItemStatus,
  RunItem,
  RunStatus,
  Run,
  ScriptParam,
} from "@graphwrangler/core";

// engine 側は GET /thread が返す MaterializedMessage（requestStatus/answeredBy 導出済み）を
// そのまま "Message" として使う（従来のミラーがこの2つを合成した形だったため、名前を合わせる）
export type { MaterializedMessage as Message } from "@graphwrangler/core";

// ---- engine 固有の型（core には存在しない） ----

/** server settings.ts の EngineSettingsSchema の手動ミラー。
 *  GET /api/settings の公開ビューのうち engine executor に関係する部分だけ型を持つ。
 *  mode="cli" なら cliPath/model/extraArgs で claude -p 等を起動、mode="api" なら
 *  apiModel（null=チャット既定）でサーバの /api/ai/complete を呼ぶ */
export interface EngineSettings {
  mode: "cli" | "api";
  cliPath: string;
  model: string;
  extraArgs: string[];
  apiModel: string | null;
}
