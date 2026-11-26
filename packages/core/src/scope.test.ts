import { describe, expect, it } from "vitest";
import { NO_FOLDER_SCOPE, folderAiScope, type ScopeNode } from "./scope.js";

const graph = (nodes: ScopeNode[]) => {
  const m = new Map(nodes.map((n) => [n.id, n]));
  return (id: string) => m.get(id);
};

describe("folderAiScope", () => {
  it("ブラウザの操作は、いちばん近い設定のあるフォルダが true のときだけ付く", () => {
    const byId = graph([
      { id: "outer", aiBrowser: true },
      { id: "inner", folder: "outer" },
      { id: "off", folder: "outer", aiBrowser: false },
      { id: "p1", folder: "inner" },
      { id: "p2", folder: "off" },
      { id: "p3", folder: null },
      { id: "t1", group: "p1" },
    ]);
    expect(folderAiScope(byId("t1"), byId).browser).toBe(true);
    expect(folderAiScope(byId("p2"), byId).browser).toBeUndefined();
    expect(folderAiScope(byId("p3"), byId).browser).toBeUndefined();
  });

  it("フォルダに入っていない、または設定の無いフォルダなら、全部「全体の設定に従う」", () => {
    const byId = graph([
      { id: "page", folder: null },
      { id: "task", group: "page" },
      { id: "shelf" },
      { id: "page2", folder: "shelf" },
      { id: "task2", group: "page2" },
    ]);
    expect(folderAiScope(byId("task"), byId)).toEqual(NO_FOLDER_SCOPE);
    expect(folderAiScope(byId("task2"), byId)).toEqual(NO_FOLDER_SCOPE);
    expect(folderAiScope(null, byId)).toEqual(NO_FOLDER_SCOPE);
  });

  it("ノード → ページ → フォルダと辿って、フォルダの設定を返す", () => {
    const byId = graph([
      { id: "shelf", aiDirs: ["D:/work"], aiTools: ["mcp__linear__*"], aiModel: "sonnet", aiEffort: "high" },
      { id: "page", folder: "shelf" },
      { id: "task", group: "page" },
      { id: "sub", group: "task" },
    ]);
    const want = { dirs: ["D:/work"], tools: ["mcp__linear__*"], model: "sonnet", effort: "high" };
    expect(folderAiScope(byId("sub"), byId)).toEqual(want);
    expect(folderAiScope(byId("page"), byId)).toEqual(want);
  });

  it("空の配列は「設定あり・追加なし」で、未設定（null）とは別", () => {
    const byId = graph([{ id: "shelf", aiDirs: [] }, { id: "page", folder: "shelf" }]);
    expect(folderAiScope(byId("page"), byId).dirs).toEqual([]);
    expect(folderAiScope(byId("page"), byId).tools).toBeNull();
  });

  it("入れ子のフォルダは、項目ごとにいちばん近い設定を使う", () => {
    const byId = graph([
      { id: "outer", aiDirs: ["D:/outer"], aiModel: "opus" },
      { id: "inner", folder: "outer", aiDirs: ["D:/inner"] },
      { id: "page", folder: "inner" },
    ]);
    expect(folderAiScope(byId("page"), byId)).toEqual({ dirs: ["D:/inner"], tools: null, model: "opus", effort: null });
  });

  it("フラグに見える値・形のおかしいモデル名・知らない深さは使わない", () => {
    const byId = graph([
      {
        id: "shelf",
        aiDirs: ["--dangerously-skip-permissions", " D:/ok ", ""],
        aiTools: ["-x", "mcp__a__*"],
        aiModel: "opus --dangerously-skip-permissions",
        aiEffort: "ultra",
      },
      { id: "page", folder: "shelf" },
    ]);
    expect(folderAiScope(byId("page"), byId)).toEqual({ dirs: ["D:/ok"], tools: ["mcp__a__*"], model: null, effort: null });
  });
});
