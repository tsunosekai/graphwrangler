// 棚（フォルダ）の色（docs/design.md 3.20d）。予定カレンダーの予定を棚ごとに色分けする。
//
// 2026-11-26 本人要望「カレンダーの予定（の色）をフォルダごとに変えられるようにして。適当に
// 作っても色が良い感じに変わるようにしておいて」:
// - 何も選ばなくても棚ごとに違う色が付く（棚の id から決まるので、開くたびに変わらない。
//   ほかの棚と同じ色に当たったら空いている色へずらす）
// - 選んだ色は棚（node.color）に持つ——端末をまたいで同じ色
// 色は名前（キー）で持ち、実際の色は表示側が決める（ライト・ダークの両方で読めるように）。
// 見本に無い色を使いたいときは、カラーピッカーで選んだ色をそのまま（"#rrggbb"）持つ
// （同日「カラーピッカー実装して」）。
export interface FolderColor {
  key: string;
  label: string;
  /** 色相（hsl の H） */
  hue: number;
  /** 自由に選んだ色（"#rrggbb"）。見本の色には無い */
  hex?: string;
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

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** 自由に選んだ色（"#rrggbb"）か */
export function isCustomFolderColor(key: string | null | undefined): key is string {
  return !!key && HEX_RE.test(key);
}

/** 棚に保存してよい色か（見本の名前か "#rrggbb"） */
export function isFolderColorKey(key: string | null | undefined): key is string {
  return !!key && (BY_KEY.has(key) || HEX_RE.test(key));
}

/** "#rrggbb" の色相（0〜359。無彩色は 0） */
export function hueOfHex(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

/** 保存されている色（名前か "#rrggbb"）→ 表示用の色。知らない値は null（＝自動） */
export function resolveFolderColor(key: string | null | undefined): FolderColor | null {
  if (!key) return null;
  const named = BY_KEY.get(key);
  if (named) return named;
  if (HEX_RE.test(key)) {
    const hex = key.toLowerCase();
    return { key: hex, label: hex, hue: hueOfHex(hex), hex };
  }
  return null;
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
  const usedHues: number[] = [];
  for (const f of folders) {
    const c = resolveFolderColor(f.color);
    if (c) {
      out.set(f.id, c);
      used.add(c.key);
      usedHues.push(c.hue);
    }
  }
  const rest = folders.filter((f) => !out.has(f.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = FOLDER_COLORS.length;
  for (const f of rest) {
    let i = hash(f.id) % n;
    if (usedHues.length > 0 && FOLDER_COLORS.some((c) => !used.has(c.key))) {
      // すでに使われている色から、色相がいちばん離れている空きの色を選ぶ（緑と青緑のような
      // 似た色が隣り合わないように）。同点なら id から決めた出発点に近いほう
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
    usedHues.push(FOLDER_COLORS[i].hue);
  }
  return out;
}

/** 予定のチップに当てる色（淡い地 + 濃い左線）。背景が明るくても暗くても文字が読める濃さ */
export function folderColorStyle(c: FolderColor): { backgroundColor: string; borderLeftColor: string } {
  if (c.hex) {
    return { backgroundColor: `color-mix(in srgb, ${c.hex} 22%, transparent)`, borderLeftColor: c.hex };
  }
  return {
    backgroundColor: `hsl(${c.hue} 75% 52% / 0.2)`,
    borderLeftColor: `hsl(${c.hue} 75% 52%)`,
  };
}

/** 色の見本（丸）に当てる色 */
export function folderColorSolid(c: FolderColor): string {
  return c.hex ?? `hsl(${c.hue} 75% 52%)`;
}
