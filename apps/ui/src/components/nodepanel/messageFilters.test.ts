// 会話の発言者（メンバー）フィルタ（2026-08-12 本人要望「会話履歴をメンバーで
// フィルタリング」）の純関数。
import { describe, expect, it } from "vitest";
import {
  AUTHOR_AI,
  AUTHOR_ALL,
  AUTHOR_HUMAN,
  authorKeyOf,
  collectAuthorKeys,
  matchesAuthor,
} from "./messageFilters";
import type { MaterializedMessage } from "../../types";

let seq = 0;
function msg(
  author: MaterializedMessage["author"],
  kind: MaterializedMessage["kind"] = "say",
): MaterializedMessage {
  seq += 1;
  return {
    id: `m-${seq}`,
    node: "n-1",
    ts: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    author,
    via: "ui",
    kind,
    body: "本文",
    payload: null,
    runId: null,
  } as MaterializedMessage;
}

const tsuno = msg({ kind: "human", name: "tsunosekai@gmail.com" });
const other = msg({ kind: "human", name: "Other@Example.com" });
const ai = msg({ kind: "agent", name: "executor:claude" });
const system = msg({ kind: "system" }, "status");
const anon = msg({ kind: "human" });

describe("authorKeyOf", () => {
  it("人間はメール小文字・名無しは human・それ以外（AI/システム）は ai", () => {
    expect(authorKeyOf(tsuno)).toBe("tsunosekai@gmail.com");
    expect(authorKeyOf(other)).toBe("other@example.com"); // 表記ゆれは小文字化で吸収
    expect(authorKeyOf(ai)).toBe(AUTHOR_AI);
    expect(authorKeyOf(system)).toBe(AUTHOR_AI);
    expect(authorKeyOf(anon)).toBe(AUTHOR_HUMAN); // 名無しの人間を AI 側へ寄せない
  });
});

describe("matchesAuthor", () => {
  it("全員は素通し", () => {
    for (const m of [tsuno, ai, anon]) expect(matchesAuthor(m, AUTHOR_ALL)).toBe(true);
  });

  it("メール指定はその人だけ（大文字小文字を区別しない）", () => {
    expect(matchesAuthor(tsuno, "tsunosekai@gmail.com")).toBe(true);
    expect(matchesAuthor(tsuno, "TsunoSekai@Gmail.com")).toBe(true);
    expect(matchesAuthor(other, "tsunosekai@gmail.com")).toBe(false);
    expect(matchesAuthor(ai, "tsunosekai@gmail.com")).toBe(false);
  });

  it("ai は人間以外をまとめる（名無しの人間は含まない）", () => {
    expect(matchesAuthor(ai, AUTHOR_AI)).toBe(true);
    expect(matchesAuthor(system, AUTHOR_AI)).toBe(true);
    expect(matchesAuthor(anon, AUTHOR_AI)).toBe(false);
    expect(matchesAuthor(tsuno, AUTHOR_AI)).toBe(false);
  });
});

describe("collectAuthorKeys: フィルタの選択肢はスレッドに登場した人だけ", () => {
  it("登場順で重複なく返す", () => {
    expect(collectAuthorKeys([tsuno, ai, tsuno, other])).toEqual([
      "tsunosekai@gmail.com",
      AUTHOR_AI,
      "other@example.com",
    ]);
  });

  it("1人しか居なければ1件（呼び出し側はこれでフィルタUIを出さない）", () => {
    expect(collectAuthorKeys([tsuno, tsuno])).toEqual(["tsunosekai@gmail.com"]);
    expect(collectAuthorKeys([])).toEqual([]);
  });
});
