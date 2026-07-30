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
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as T);
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
