// 既読時刻（端末をまたいで共有する。2026-08-02 localStorage から移行、
// 2026-08-03 チーム運用のため per-user 化。docs/design.md 3.11）
//
// ファイル形式 v2: { version: 2, shared: {nodeId: ts}, users: { email: {nodeId: ts} } }
// - shared  … ログイン無し（匿名）運用の既読置き場。旧フラット形式はここへ読み替える
//             （zinsei の一人運用は従来どおり「端末をまたいで共有」の挙動のまま）
// - users   … ログインユーザーごとの既読。ユーザーの見る既読 = shared と自分の max マージ
//             （per-user 化の導入時に、それまで共有だった既読が急に未読へ戻らないため）
// 書き込みは、匿名なら shared へ、ログイン中なら自分のバケツへ。
import fs from "node:fs";
import path from "node:path";

export interface ReadsFile {
  shared: Record<string, string>;
  users: Record<string, Record<string, string>>;
}

export function sanitizeMarks(v: unknown): Record<string, string> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([, t]) => typeof t === "string"),
      ) as Record<string, string>)
    : {};
}

/** パース済み JSON を ReadsFile（v2 形式）へ読み替える。旧フラット形式 {nodeId: ts} は
 *  shared として読み替え（次回保存で v2 になる）。形が壊れていれば空から始める */
export function parseReadsFile(parsed: unknown): ReadsFile {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (o.version === 2) {
      const users: Record<string, Record<string, string>> = {};
      for (const [email, marks] of Object.entries(
        o.users && typeof o.users === "object" ? (o.users as Record<string, unknown>) : {},
      )) {
        users[email] = sanitizeMarks(marks);
      }
      return { shared: sanitizeMarks(o.shared), users };
    }
    // 旧フラット形式 {nodeId: ts} → shared として読み替え（次回保存で v2 になる）
    return { shared: sanitizeMarks(parsed), users: {} };
  }
  return { shared: {}, users: {} };
}

/** 操作者から見た既読 = shared と自分のバケツの max マージ（匿名は shared のみ） */
export function mergeReads(file: ReadsFile, email: string | null): Record<string, string> {
  const own = email ? (file.users[email] ?? {}) : {};
  const merged: Record<string, string> = { ...file.shared };
  for (const [nodeId, ts] of Object.entries(own)) {
    if (!merged[nodeId] || merged[nodeId] < ts) merged[nodeId] = ts;
  }
  return merged;
}

/** 既読を進める。**巻き戻さない**（別端末が先に進めた既読を、遅れて届いた古い ts で
 *  戻すと未読が復活するため）。1件でも更新があれば changed=true と更新後のファイル内容を返す */
export function advanceReads(
  file: ReadsFile,
  email: string | null,
  marks: Record<string, string>,
): { next: ReadsFile; changed: boolean } {
  const bucket = email ? { ...(file.users[email] ?? {}) } : { ...file.shared };
  const baseline = email ? file.shared : {};
  let changed = false;
  for (const [nodeId, ts] of Object.entries(marks)) {
    if (typeof ts !== "string" || !ts) continue;
    // 操作者から見た現在の既読 = max(shared, 自分のバケツ)。それより進む分だけ書く
    // （shared で既読済みの範囲を自分のバケツへ複製しない）
    const own = bucket[nodeId];
    const shared = baseline[nodeId];
    const effective = own && shared ? (own > shared ? own : shared) : (own ?? shared);
    if (!effective || effective < ts) {
      bucket[nodeId] = ts;
      changed = true;
    }
  }
  if (!changed) return { next: file, changed: false };
  return {
    next: email
      ? { ...file, users: { ...file.users, [email]: bucket } }
      : { ...file, shared: bucket },
    changed: true,
  };
}

/** 既読ファイル（sidecar/reads.json）の読み書き。マージ・前進の規則は上の純関数が持つ */
export class ReadsStore {
  /** メモリ上のキャッシュ。プロセス内で唯一の書き手なので、読むたびに読み直す必要はない */
  private cache: ReadsFile | null = null;

  constructor(private readsFile: string) {}

  private load(): ReadsFile {
    if (this.cache) return this.cache;
    try {
      const raw = fs.readFileSync(this.readsFile, "utf8");
      this.cache = parseReadsFile(JSON.parse(raw));
    } catch {
      // 未作成・壊れている場合は空から始める（既読は補助情報なので落とさない）
      this.cache = { shared: {}, users: {} };
    }
    return this.cache;
  }

  private save(next: ReadsFile): void {
    this.cache = next;
    fs.mkdirSync(path.dirname(this.readsFile), { recursive: true });
    fs.writeFileSync(this.readsFile, JSON.stringify({ version: 2, ...next }, null, 2), "utf8");
  }

  /** 今の操作者から見た既読 = shared と自分のバケツの max マージ（匿名は shared のみ） */
  loadReads(email: string | null): Record<string, string> {
    return mergeReads(this.load(), email);
  }

  /** 既読を進める。**巻き戻さない**。1件でも更新があれば true */
  markRead(email: string | null, marks: Record<string, string>): boolean {
    const { next, changed } = advanceReads(this.load(), email, marks);
    if (changed) this.save(next);
    return changed;
  }
}
