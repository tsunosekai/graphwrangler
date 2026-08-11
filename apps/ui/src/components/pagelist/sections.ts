// 左レールの「節」と「棚」の仕分け（PageList から切り出し）。描画は持たず、
// 「どの行がどの節・どの棚に、どの順で並ぶか」だけを一度に決める導出。
// - 節 = プロジェクト（トリガー無し）/ ルーティーン（トリガー有り）のビュー的な分類。
//   ルーティーン化はトリガーを置く/外すだけの1操作で、節をまたぐのはその副作用として
//   自然に起きる（docs/design.md 3.8「プロジェクト/ルーティーンはトリガーの有無の別名」）
// - 棚 = kind=folder のノード。ページを束ねるだけで、グラフ・実行・ランには関与しない
//   （docs/design.md 3.1「整理（folder / order）は構造ではなく見せ方」）
import type { Section } from "../../hooks/useRailDnd";
import { sortRail } from "../../lib/rail";
import { isRoutinePage } from "../../lib/routine";
import type { Node } from "../../types";

/** status が done|dropped のページをアーカイブ節へ回す。**ルーティーンも同じ**
 *  （2026-08-09 本人報告の不具合の修正）: 以前はルーティーンを「常にアクティブ扱い」として
 *  除外していたため、完了にしたルーティーンがルーティーン節に居座り、アーカイブへ行かず、
 *  右クリックにも出し入れが出ない行き止まりになっていた（さらにエンジンは所属ページの
 *  status を見ないので裏でラン作成し続けていた——engine の isClosedPage で併せて止めた）。
 *  「繰り返しには終わりが無い」のは既定の話で、人が終いだと宣言したものまで
 *  畳めなくする理由にはならない */
export const isArchivedPage = (f: Node): boolean => f.status === "done" || f.status === "dropped";

/** 棚がどちらの節のものか。null = プロジェクト節（addFolder もプロジェクト棚は null で作る。2026-08-08） */
export const shelfSectionOf = (f: Node): Section => (f.folderSection === "routine" ? "routine" : "project");

export interface RailSections {
  /** その節の棚（並び順つき） */
  shelvesIn(section: Section): Node[];
  /** ページがどちらの節か（トリガーの有無から導出） */
  sectionOf(f: Node): Section;
  /** ページの所属フォルダ（無効な紐づけは null＝直下扱い。下記） */
  folderOf(f: Node): string | null;
  /** その棚の中のページ（人フィルタ適用後） */
  inFolder(folderId: string): Node[];
  /** 並べ替えの計算対象の id 列（**絞り込み前の全ページ**） */
  pageIdsIn(section: Section, folderId: string | null): string[];
  /** 節の直下（棚に入っていない）ページ。人フィルタ適用後 */
  rootProjects: Node[];
  rootRoutines: Node[];
  /** ルーティーン節のページ全部（棚の中も含む）。節ごと出すかの判定に使う */
  routineFolders: Node[];
  /** アーカイブ節のページ（人フィルタは掛けない＝従来どおり全部出す） */
  archivedFolders: Node[];
}

/**
 * folders = ページ（ゴール/ルーティーン）、folderNodes = 整理用の棚（kind=folder）。
 * byPerson = 人フィルタの述語（PersonFilter が作る。フィルタ無しなら常に true）。
 */
export function buildRailSections(
  folders: Node[],
  folderNodes: Node[],
  membersOf: (groupId: string) => Node[],
  byPerson: (f: Node) => boolean,
): RailSections {
  const activeFolders = folders.filter((f) => !isArchivedPage(f));
  const archivedFolders = sortRail(folders.filter(isArchivedPage));

  const folderList = sortRail(folderNodes);
  const shelvesIn = (section: Section) => folderList.filter((f) => shelfSectionOf(f) === section);
  const shelfById = new Map(folderNodes.map((f) => [f.id, f]));
  const sectionOf = (f: Node): Section => (isRoutinePage(f, membersOf(f.id)) ? "routine" : "project");
  /** ページの所属フォルダ。次のどちらかなら直下扱いにする:
   *  - 消えたフォルダを指している
   *  - **節の違う棚**を指している（2026-08-09 本人報告の不具合）。ページにトリガーを足すと
   *    プロジェクト → ルーティーンへ節が変わるが、folder は元の節の棚を指したまま残るので、
   *    そのままだと元の棚の中に居座って「ルーティーンの方に移らない」。棚は節ごとに分かれて
   *    いる（folderSection）ので、節が合わない紐づけは無効とみなし、その節の直下へ出す。
   *    データ（node.folder）は書き換えない——トリガーを外して戻ったときに元の棚へ帰るし、
   *    描画のたびに書き込むと複数クライアントで競合するため */
  const folderOf = (f: Node): string | null => {
    if (!f.folder) return null;
    const shelf = shelfById.get(f.folder);
    if (!shelf) return null;
    return shelfSectionOf(shelf) === sectionOf(f) ? f.folder : null;
  };

  // プロジェクト（トリガー無し）/ ルーティーン（トリガー有り）のビュー的な分類（本人指定）。
  // 人フィルタ中はプロジェクト節・ルーティーン節の両方に同じ述語（byPerson）を適用する
  // （チーム化 2026-08-04）
  const projectFolders = sortRail(activeFolders.filter((f) => sectionOf(f) === "project" && byPerson(f)));
  const routineFolders = sortRail(activeFolders.filter((f) => sectionOf(f) === "routine" && byPerson(f)));
  /** 表示用: 節の直下にあるページ / 棚 id → その中のページ（2026-08-08 ルーティーンにも対応） */
  const rootProjects = projectFolders.filter((f) => folderOf(f) === null);
  const rootRoutines = routineFolders.filter((f) => folderOf(f) === null);
  const inFolder = (folderId: string) =>
    [...projectFolders, ...routineFolders].filter((f) => folderOf(f) === folderId);

  /** 並べ替えの計算対象は**絞り込み前の全ページ**にする（フィルタで隠れている行の
   *  相対順序を壊さないため）。アーカイブ済みも同じ入れ物として一緒に数える */
  const pageIdsIn = (section: Section, folderId: string | null): string[] =>
    sortRail(folders.filter((f) => sectionOf(f) === section && folderOf(f) === folderId)).map((f) => f.id);

  return {
    shelvesIn,
    sectionOf,
    folderOf,
    inFolder,
    pageIdsIn,
    rootProjects,
    rootRoutines,
    routineFolders,
    archivedFolders,
  };
}
