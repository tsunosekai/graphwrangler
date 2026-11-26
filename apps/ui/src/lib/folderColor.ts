// 棚（フォルダ）の色（docs/design.md 3.20d）。予定カレンダーの予定を棚ごとに色分けする。
//
// 2026-11-26 本人要望「カレンダーの予定（の色）をフォルダごとに変えられるようにして。適当に
// 作っても色が良い感じに変わるようにしておいて」:
// - 何も選ばなくても棚ごとに違う色が付く（棚の id から決まるので、開くたびに変わらない。
//   ほかの棚と同じ色に当たったら空いている色へずらす）
// - 選んだ色は棚（node.color）に持つ——端末をまたいで同じ色
// 色は名前（キー）で持ち、実際の色は表示側が決める（ライト・ダークの両方で読めるように）。
export interface FolderColor {
  key: string;
  label: string;
  /** 色相（hsl の H） */
  hue: number;
}

/** 隣どうしが見分けやすい順（色相を飛び飛びに並べる）。自動の割り当てはこの並びを使う */
export const FOLDER_COLORS: readonly FolderColor[] = [
  { key: "blue", label: "青", hue: 215 },
  { key: "orange", label: "橙", hue: 28 },
  { key: "green", label: "緑", hue: 145 },
  { key: "pink", label: "桃", hue: 328 },
  { key: "teal", label: "青緑", hue: 178 },
  { key: "amber", label: "黄", hue: 46 },
  { key: "violet", label: "紫", hue: 268 },
  { key: "red", label: "赤", hue: 2 },
  { key: "lime", label: "黄緑", hue: 88 },
  { key: "sky", label: "水色", hue: 198 },
];

const BY_KEY = new Map(FOLDER_COLORS.map((c) => [c.key, c]));

export function isFolderColorKey(key: string | null | undefined): key is string {
  return !!key && BY_KEY.has(key);
}

/** 文字列から決まる安定した数（FNV-1a）。棚の id → 色の出発点 */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 棚ごとの色を決める。選んである色（color）はそのまま。選んでいない棚は id から決め、
 * すでに使われている色に当たったら空いている次の色へずらす（色数を超えたら重なってよい）。
 * 結果は渡した順に依らない（id 順に割り当てる）。
 */
export function assignFolderColors(
  folders: ReadonlyArray<{ id: string; color?: string | null }>,
): Map<string, FolderColor> {
  const out = new Map<string, FolderColor>();
  const used = new Set<string>();
  for (const f of folders) {
    if (isFolderColorKey(f.color)) {
      out.set(f.id, BY_KEY.get(f.color) as FolderColor);
      used.add(f.color);
    }
  }
  const rest = folders.filter((f) => !out.has(f.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = FOLDER_COLORS.length;
  for (const f of rest) {
    let i = hash(f.id) % n;
    if (used.size > 0 && used.size < n) {
      // すでに使われている色から、色相がいちばん離れている空きの色を選ぶ（緑と青緑のような
      // 似た色が隣り合わないように）。同点なら id から決めた出発点に近いほう
      const usedHues = [...used].map((k) => (BY_KEY.get(k) as FolderColor).hue);
      const dist = (h: number) => Math.min(...usedHues.map((u) => Math.min(Math.abs(h - u), 360 - Math.abs(h - u))));
      let best = -1;
      let bestDist = -1;
      for (let step = 0; step < n; step++) {
        const j = (i + step) % n;
        if (used.has(FOLDER_COLORS[j].key)) continue;
        const d = dist(FOLDER_COLORS[j].hue);
        if (d > bestDist) {
          best = j;
          bestDist = d;
        }
      }
      i = best;
    }
    out.set(f.id, FOLDER_COLORS[i]);
    used.add(FOLDER_COLORS[i].key);
  }
  return out;
}

/** 予定のチップに当てる色（淡い地 + 濃い左線）。背景が明るくても暗くても文字が読める濃さ */
export function folderColorStyle(c: FolderColor): { backgroundColor: string; borderLeftColor: string } {
  return {
    backgroundColor: `hsl(${c.hue} 75% 52% / 0.2)`,
    borderLeftColor: `hsl(${c.hue} 75% 52%)`,
  };
}

/** 色の見本（丸）に当てる色 */
export function folderColorSolid(c: FolderColor): string {
  return `hsl(${c.hue} 75% 52%)`;
}
