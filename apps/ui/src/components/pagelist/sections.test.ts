// 左レールの節・棚の仕分け（sections.ts）。ここが決めるのは「どの行がどの節に、どの棚の中に、
// どの順で出るか」だけなので、境目（トリガーの有無・節違いの棚・アーカイブ・人フィルタ）を固める。
import { describe, expect, it } from "vitest";
import { makeNode } from "../../lib/testutil";
import type { Node } from "../../types";
import { buildRailSections, isArchivedPage, shelfSectionOf } from "./sections";

/** ページ（goal）と棚（folder）を作るだけの小道具 */
const page = (id: string, o: Partial<Node> = {}) => makeNode({ id, kind: "goal", ...o });
const shelf = (id: string, o: Partial<Node> = {}) => makeNode({ id, kind: "folder", ...o });

/** そのページの直下ノードを引く（buildRailIndex.membersOf と同じ約束） */
const membersOfIn = (nodes: Node[]) => (groupId: string) => nodes.filter((n) => n.group === groupId);
const all = () => true;

describe("shelfSectionOf / isArchivedPage", () => {
  it("folderSection が未指定の棚はプロジェクト節に置く", () => {
    expect(shelfSectionOf(shelf("s", { folderSection: null }))).toBe("project");
    expect(shelfSectionOf(shelf("s", { folderSection: "routine" }))).toBe("routine");
  });

  it("done / dropped のページだけがアーカイブ行き（ルーティーンかどうかは見ない）", () => {
    expect(isArchivedPage(page("p", { status: "done" }))).toBe(true);
    expect(isArchivedPage(page("p", { status: "dropped" }))).toBe(true);
    expect(isArchivedPage(page("p", { status: "pending" }))).toBe(false);
  });
});

describe("buildRailSections", () => {
  it("トリガーを持つページだけがルーティーン節へ行く", () => {
    const nodes = [page("proj"), makeNode({ id: "t1", group: "routine", kind: "trigger" }), page("routine")];
    const s = buildRailSections([nodes[0], nodes[2]], [], membersOfIn(nodes), all);
    expect(s.sectionOf(nodes[0])).toBe("project");
    expect(s.sectionOf(nodes[2])).toBe("routine");
    expect(s.rootProjects.map((f) => f.id)).toEqual(["proj"]);
    expect(s.rootRoutines.map((f) => f.id)).toEqual(["routine"]);
  });

  it("節の違う棚を指す folder は無効（直下扱い）——トリガーを足したページが元の棚に残らない", () => {
    const nodes = [
      page("p", { folder: "shelfP" }),
      makeNode({ id: "t1", group: "p", kind: "trigger" }), // これでルーティーン節へ移る
    ];
    const shelves = [shelf("shelfP"), shelf("shelfR", { folderSection: "routine" })];
    const s = buildRailSections([nodes[0]], shelves, membersOfIn(nodes), all);
    expect(s.sectionOf(nodes[0])).toBe("routine");
    expect(s.folderOf(nodes[0])).toBeNull(); // プロジェクト棚の紐づけは効かない
    expect(s.rootRoutines.map((f) => f.id)).toEqual(["p"]);
    expect(s.inFolder("shelfP")).toEqual([]);
  });

  it("消えた棚を指す folder も直下扱いにする", () => {
    const p = page("p", { folder: "居ない棚" });
    const s = buildRailSections([p], [], membersOfIn([p]), all);
    expect(s.folderOf(p)).toBeNull();
    expect(s.rootProjects.map((f) => f.id)).toEqual(["p"]);
  });

  it("並びは order 昇順（未指定は後ろ）で、棚も同じ規則", () => {
    const pages = [page("b", { order: 1 }), page("noOrder"), page("a", { order: 0 })];
    const shelves = [shelf("s2", { order: 1 }), shelf("s1", { order: 0 })];
    const s = buildRailSections(pages, shelves, membersOfIn(pages), all);
    expect(s.rootProjects.map((f) => f.id)).toEqual(["a", "b", "noOrder"]);
    expect(s.shelvesIn("project").map((f) => f.id)).toEqual(["s1", "s2"]);
  });

  it("アーカイブ節は done/dropped だけを集め、アクティブ側からは消える", () => {
    const pages = [page("live"), page("gone", { status: "done" })];
    const s = buildRailSections(pages, [], membersOfIn(pages), all);
    expect(s.rootProjects.map((f) => f.id)).toEqual(["live"]);
    expect(s.archivedFolders.map((f) => f.id)).toEqual(["gone"]);
  });

  it("人フィルタは節の中身にだけ効き、並べ替えの計算対象（pageIdsIn）は絞り込み前のまま", () => {
    const pages = [page("mine"), page("theirs"), page("archived", { status: "done" })];
    const s = buildRailSections(pages, [], membersOfIn(pages), (f) => f.id === "mine");
    expect(s.rootProjects.map((f) => f.id)).toEqual(["mine"]);
    // 隠れている行も入れ物の一員として数える（相対順序を壊さないため）。アーカイブ済みも同じ
    // （order 未指定・created 同着なので並びは id 順に落ちる。sortRail の最後の手当て）
    expect(s.pageIdsIn("project", null)).toEqual(["archived", "mine", "theirs"]);
  });

  it("inFolder は同じ棚のページを節をまたいで集める（棚は節ごとに分かれている前提）", () => {
    const nodes = [page("p1", { folder: "s", order: 1 }), page("p2", { folder: "s", order: 0 }), page("p3")];
    const s = buildRailSections(nodes, [shelf("s")], membersOfIn(nodes), all);
    expect(s.inFolder("s").map((f) => f.id)).toEqual(["p2", "p1"]);
    expect(s.rootProjects.map((f) => f.id)).toEqual(["p3"]);
    expect(s.pageIdsIn("project", "s")).toEqual(["p2", "p1"]);
  });
});
