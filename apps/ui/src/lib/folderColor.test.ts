import { describe, expect, it } from "vitest";
import { FOLDER_COLORS, assignFolderColors } from "./folderColor";

describe("assignFolderColors", () => {
  it("選んでいない棚にも、棚ごとに違う色が付く", () => {
    const folders = Array.from({ length: FOLDER_COLORS.length }, (_, i) => ({ id: `n-20261124-00${10 + i}` }));
    const m = assignFolderColors(folders);
    expect(new Set([...m.values()].map((c) => c.key)).size).toBe(FOLDER_COLORS.length);
  });

  it("同じ棚はいつも同じ色（渡す順に依らない）", () => {
    const a = [{ id: "n-1" }, { id: "n-2" }, { id: "n-3" }];
    const m1 = assignFolderColors(a);
    const m2 = assignFolderColors([...a].reverse());
    for (const f of a) expect(m2.get(f.id)?.key).toBe(m1.get(f.id)?.key);
  });

  it("選んだ色はそのまま使い、自動の棚はその色を避ける", () => {
    const auto = assignFolderColors([{ id: "n-1" }]).get("n-1")?.key as string;
    const m = assignFolderColors([{ id: "n-1" }, { id: "n-2", color: auto }]);
    expect(m.get("n-2")?.key).toBe(auto);
    expect(m.get("n-1")?.key).not.toBe(auto);
  });

  it("知らない色の名前は自動として扱う", () => {
    const m = assignFolderColors([{ id: "n-1", color: "nazo" }]);
    expect(FOLDER_COLORS.some((c) => c.key === m.get("n-1")?.key)).toBe(true);
  });

  it("色数より棚が多くても全部に色が付く", () => {
    const folders = Array.from({ length: FOLDER_COLORS.length + 3 }, (_, i) => ({ id: `f${i}` }));
    expect(assignFolderColors(folders).size).toBe(folders.length);
  });
});
