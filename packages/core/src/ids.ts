// id 採番: <prefix>-YYYYMMDD-NNNN（当日連番）。desk の流儀を継承。
// 既存 id の最大連番+1 を振る。日付が変われば 0001 から。

function today(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

export function nextId(prefix: string, existing: Iterable<string>): string {
  const date = today();
  const head = `${prefix}-${date}-`;
  let max = 0;
  for (const id of existing) {
    if (id.startsWith(head)) {
      const n = parseInt(id.slice(head.length), 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return `${head}${String(max + 1).padStart(4, "0")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
