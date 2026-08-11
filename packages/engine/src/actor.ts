// エンジンが API へ書き込むときの帰属（docs/design.md 3.12）。via=どの玄関から来たか、
// actor=誰が操作したか。executor 名義（executor:script / executor:claude / executor:api）は
// 実行のたびに組み立てるので、ここには置かない。
import type { Actor } from "./types.js";

export const VIA = "engine";
export const ENGINE_ACTOR: Actor = { kind: "agent", name: "engine" };
