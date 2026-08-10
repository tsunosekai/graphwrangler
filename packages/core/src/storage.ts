// ファイルストレージの下回り。
// 追記は appendFileSync、スナップショットは tmp → rename のアトミック書き込み
// （desk server.py と同じ規律。書き込み途中クラッシュで正本を壊さない）。
import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function appendJsonl(file: string, record: unknown): void {
  ensureDir(path.dirname(file));
  // 書き込み途中のクラッシュで最終行が改行なしで切れていることがある。そのまま追記すると
  // 壊れた行に新しい記録が連結されて共倒れになるので、末尾が改行でなければ改行を足す
  let prefix = "";
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(1);
        fs.readSync(fd, buf, 0, 1, size - 1);
        if (buf.toString("utf8") !== "\n") prefix = "\n";
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  fs.appendFileSync(file, prefix + JSON.stringify(record) + "\n", "utf8");
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // appendFileSync は書き込み途中のクラッシュで最終行が欠けうる（snapshot と違い
      // tmp→rename で守れない追記型）。jsonl は追記専用の記録であって正データではない
      // ので、壊れた行で起動を止めず警告して読み飛ばす（foldRecords の「記録が
      // 欠けていても止まらない」と同じ扱い）
      console.warn(`[storage] 壊れた行を読み飛ばしました: ${file}:${i + 1}`);
    }
  }
  return out;
}

/** テキストのアトミック書き込み（tmpファイルに書いて rename）。中身の整形は呼び出し側の責務 */
export function writeTextAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, data: unknown): void {
  writeTextAtomic(file, JSON.stringify(data, null, 2));
}

export function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
