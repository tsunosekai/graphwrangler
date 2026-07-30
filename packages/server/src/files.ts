// ワークスペースモード（ワークスペース=1ファイル化）の GET /api/files が使う
// パス解決ガード。root（正データファイルのあるディレクトリ）の外に出るパスは弾く。
// Windows ではドライブ文字が絡むケース（別ドライブ指定・絶対パス）があるため、
// path.relative の結果が ".." で始まる、または絶対パスになる（＝root と共通の
// 親を持てない＝別ドライブ等）の両方を「脱出」とみなす。文字列の前方一致比較は
// 大文字小文字の扱いを誤りやすいので使わず、path.resolve/path.relative の結果だけで判定する。
import path from "node:path";

/**
 * relPath を root 基準で解決する。ルート外に出る場合（絶対パス指定・".." での脱出・
 * 別ドライブ指定・root 自身の指定）は null を返す。戻り値は絶対パス。
 */
export function resolveWorkspacePath(root: string, relPath: string): string | null {
  if (!relPath || path.isAbsolute(relPath)) return null;
  const absolute = path.resolve(root, relPath);
  const rel = path.relative(root, absolute);
  // rel === "" は root 自身（ディレクトリ）を指しており、ファイルとしては返せない。
  // ".." 判定は startsWith("..") ではなく `".."` 完全一致 / `".." + セパレータ` 前方一致で行う
  // ——"..hidden" のような正当なファイル名を誤って脱出扱いにしないため
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return absolute;
}
