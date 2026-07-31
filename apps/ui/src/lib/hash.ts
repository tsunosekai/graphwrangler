// 試走ゲート（docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）のハッシュ鮮度チェックを
// UI 側でも行うためのユーティリティ。packages/server/src/trial.ts の sha256Hex（node:crypto の
// createHash("sha256")）と同じ値を返す。**アルゴリズムを変えたら両方直す**。
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
