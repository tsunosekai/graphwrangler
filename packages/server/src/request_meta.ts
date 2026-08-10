// リクエストの帰属メタ（actor/via）の取り出し。全ルートモジュールが共用する。
import { ActorSchema, type Actor } from "@graphwrangler/core";
import { currentUserStore } from "./auth.js";

// 操作者メールのリクエストスコープ保持は auth.ts の currentUserStore（chat.ts と共用）
const accessEmailStore = currentUserStore;

/** リクエストボディから帰属メタ（actor/via）を取り出す。既定は human/ui。
 *  body に actor が無い（=UIからの操作）とき、Access のメールが分かれば actor.name に刻む
 *  ——ops・スレッド発言の「誰が」がメールで残る（複数人運用の帰属。design 3.2） */
export function meta(body: Record<string, unknown>): { actor: Actor; via: string; user: string | null } {
  const accessEmail = accessEmailStore.getStore();
  const actor = body.actor
    ? ActorSchema.parse(body.actor)
    : { kind: "human" as const, ...(accessEmail ? { name: accessEmail } : {}) };
  const via = typeof body.via === "string" ? body.via : "ui";
  // user = 操作の背後にいる人間（actor が agent でも保持。addNode の createdBy に刻まれる）
  return { actor, via, user: accessEmail ?? null };
}
