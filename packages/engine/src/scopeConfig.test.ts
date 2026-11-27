import { describe, expect, it } from "vitest";
import { configFor, engineConfig, setScopeNodes } from "./settings.js";

describe("configFor（フォルダごとの AI 設定。3.24）", () => {
  it("フォルダの設定があれば作業場所を置き換え、モデルは ノード > フォルダ > 全体", () => {
    setScopeNodes([
      { id: "shelf", aiDirs: ["D:/work"], aiModel: "sonnet", aiEffort: "high" },
      { id: "page", folder: "shelf" },
      { id: "free", folder: null },
    ]);
    const inShelf = configFor({ id: "t1", group: "page", aiModel: null, aiEffort: null });
    expect(inShelf.addDirs).toEqual(["D:/work"]);
    expect(inShelf.model).toBe("sonnet");
    expect(inShelf.effort).toBe("high");

    const nodeWins = configFor({ id: "t2", group: "page", aiModel: "haiku", aiEffort: "low" });
    expect(nodeWins.model).toBe("haiku");
    expect(nodeWins.effort).toBe("low");

    const outside = configFor({ id: "t3", group: "free", aiModel: null, aiEffort: null });
    expect(outside.addDirs).toEqual(engineConfig.addDirs);
    expect(outside.model).toBe(engineConfig.model);
    setScopeNodes([]);
  });
});
