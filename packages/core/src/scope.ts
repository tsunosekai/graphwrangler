// フォルダ（棚）ごとの AI の設定（docs/design.md 3.24）。
//
// 2026-11-26 本人要望「AI の作業範囲をフォルダごとに分けられるようにしてほしい。その他の設定でも
// フォルダごとにした方がいいものはそうしたい」。仕事のフォルダの AI に私用のファイルを触らせない、
// といった分け方をするためのもの。
//
// フォルダのノードに持つ値（どれも未設定＝null・無しなら「全体の設定に従う」）:
//   - aiDirs  … AI がファイルを読み書きできる追加の場所（ワークスペースの外）。**設定したら
//                全体の設定の代わりにこれだけを使う**（足し算ではない——足し算だと絞れない）。
//                空の配列は「ワークスペースの中だけ」
//   - aiModel / aiEffort … 中のノードの既定のモデル・思考の深さ（ノード自身の指定が優先）
//
// （aiTools＝追加許可ツール と aiBrowser＝ブラウザ操作 は 2026-11-27 に廃止。三役とも常に
//  全ツール許可・ブラウザ接続ありで起動する）
//
// 入れ子のフォルダは、項目ごとに「いちばん近い、設定のあるフォルダ」の値を使う。
// 実行AI（engine）・ノードの会話の AI・全体チャットの3つが同じこの関数で決める。

export interface ScopeNode {
  id: string;
  group?: string | null;
  folder?: string | null;
  aiDirs?: string[] | null;
  aiModel?: string | null;
  aiEffort?: string | null;
}

export interface FolderAiScope {
  /** 追加の作業場所。null = フォルダの設定なし（全体の設定に従う） */
  dirs: string[] | null;
  model: string | null;
  effort: string | null;
}

export const NO_FOLDER_SCOPE: FolderAiScope = { dirs: null, model: null, effort: null };

// モデル名はコマンドの引数になる。空白や記号が入ると別の引数として解釈されうるので形を絞る
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,80}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** "-" 始まり（コマンドのフラグとして解釈される）と空を落とす */
function cleanList(list: string[] | null | undefined): string[] | null {
  if (!Array.isArray(list)) return null;
  return list.map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s !== "" && !s.startsWith("-"));
}

/**
 * そのノード（またはページ）に効くフォルダの AI 設定を返す。
 * ノード → ページ（入れ子グループは外側へ）→ フォルダ（入れ子は外側へ）と辿る。
 */
export function folderAiScope(
  node: ScopeNode | null | undefined,
  byId: (id: string) => ScopeNode | undefined,
): FolderAiScope {
  if (!node) return NO_FOLDER_SCOPE;
  let page: ScopeNode | undefined = node;
  for (let i = 0; i < 20 && page?.group; i++) page = byId(page.group);
  if (!page) return NO_FOLDER_SCOPE;

  const out: FolderAiScope = { dirs: null, model: null, effort: null };
  let shelf = page.folder ? byId(page.folder) : undefined;
  for (let i = 0; i < 20 && shelf; i++) {
    if (out.dirs === null) out.dirs = cleanList(shelf.aiDirs);
    if (out.model === null && typeof shelf.aiModel === "string" && MODEL_RE.test(shelf.aiModel)) out.model = shelf.aiModel;
    if (out.effort === null && typeof shelf.aiEffort === "string" && EFFORTS.has(shelf.aiEffort)) out.effort = shelf.aiEffort;
    shelf = shelf.folder ? byId(shelf.folder) : undefined;
  }
  return out;
}
