// 決定的シリアライズ。オブジェクトのキーを再帰的に辞書順ソートしてから
// JSON.stringify(x, null, 2) する。同じ状態なら常にバイト一致する出力になるので、
// 正データファイル（ワークスペース=1ファイル化）の git diff が「意味のある差分」になる。
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}
