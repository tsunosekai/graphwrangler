// 日本の祝日カレンダー（2026-08-14 本人要望「トリガーに平日を設定できるように」）。
// schedule の "weekday HH:MM"（平日 = 月〜金かつ祝日でない日）が唯一の利用者で、エンジンの
// ラン作成判定と UI のカレンダー表示が同じ答えを出すためにここ1箇所に置く。
//
// **ネットワークも外部データも使わない**（トリガー判定は5秒間隔で回るエンジンの内側で、
// VPS がオフラインでも同じ答えを返す必要があるため）。祝日は法律どおりに計算する:
//   - 日付固定の祝日（元日・建国記念の日・天皇誕生日・昭和の日・憲法記念日・みどりの日・
//     こどもの日・山の日・文化の日・勤労感謝の日）
//   - ハッピーマンデー（成人の日=1月第2月曜 / 海の日=7月第3月曜 / 敬老の日=9月第3月曜 /
//     スポーツの日=10月第2月曜）
//   - 春分の日・秋分の日（天文計算の近似式。下記のとおり適用範囲がある）
//   - 振替休日（祝日が日曜なら、その後の「祝日でない最初の日」が休日）
//   - 国民の休日（前日と翌日が祝日で自身は祝日でない平日。例: 敬老の日と秋分の日に挟まれた日）
//
// 適用範囲と割り切り:
//   - **現行法（2020年以降）の並びで全年を計算する**。天皇誕生日の12/23時代、体育の日、
//     2019年の即位礼・2020/2021年の五輪特例といった過去の一度きりの改正は再現しない。
//     トリガーは常に「これから」の日付しか判定しないので、過去の再現性は要らない
//   - 春分・秋分の近似式は **1980〜2099年**でのみ正しい。この外は日付がずれ得る
//     （官報の告示は前年2月なので、そもそもどんな実装でも遠い将来は確定しない）
//   - 会社の休業日（年末年始・夏季休暇）は祝日ではないので**含めない**。必要になったら
//     設定として別に持つ（ここは法律の写しに保つ）

/** その年の祝日（"M-D" → 名称）。年ごとに一度だけ計算して使い回す */
const cache = new Map<number, Map<string, string>>();

const key = (month: number, day: number) => `${month}-${day}`;

/** year年 month月(1-12) の第nth 月曜の日番号（ハッピーマンデー用） */
function nthMondayOfMonth(year: number, month: number, nth: number): number {
  const first = new Date(year, month - 1, 1);
  const offset = (1 - first.getDay() + 7) % 7; // 1 = 月曜
  return 1 + offset + (nth - 1) * 7;
}

/** 春分の日（3月）の日番号。1980〜2099年で正しい近似式 */
function vernalEquinoxDay(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** 秋分の日（9月）の日番号。1980〜2099年で正しい近似式 */
function autumnalEquinoxDay(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** その年の祝日表を作る（振替休日・国民の休日まで解決済み） */
function buildYear(year: number): Map<string, string> {
  // まず「国民の祝日」そのもの。振替休日・国民の休日の判定はこの集合を見る
  // （振替休日の翌日がさらに振替になる、といった連鎖は法律上起きない）
  const base = new Map<string, string>([
    [key(1, 1), "元日"],
    [key(1, nthMondayOfMonth(year, 1, 2)), "成人の日"],
    [key(2, 11), "建国記念の日"],
    [key(2, 23), "天皇誕生日"],
    [key(3, vernalEquinoxDay(year)), "春分の日"],
    [key(4, 29), "昭和の日"],
    [key(5, 3), "憲法記念日"],
    [key(5, 4), "みどりの日"],
    [key(5, 5), "こどもの日"],
    [key(7, nthMondayOfMonth(year, 7, 3)), "海の日"],
    [key(8, 11), "山の日"],
    [key(9, nthMondayOfMonth(year, 9, 3)), "敬老の日"],
    [key(9, autumnalEquinoxDay(year)), "秋分の日"],
    [key(10, nthMondayOfMonth(year, 10, 2)), "スポーツの日"],
    [key(11, 3), "文化の日"],
    [key(11, 23), "勤労感謝の日"],
  ]);

  const all = new Map(base);

  // 振替休日: 日曜と重なった祝日の「後の、祝日でない最初の日」（2007年以降の現行規定。
  // 5/3 が日曜なら 5/4・5/5 を飛ばして 5/6 になる）
  for (const k of base.keys()) {
    const [month, day] = k.split("-").map(Number);
    if (new Date(year, month - 1, day).getDay() !== 0) continue;
    const next = new Date(year, month - 1, day);
    do {
      next.setDate(next.getDate() + 1);
    } while (base.has(key(next.getMonth() + 1, next.getDate())));
    // 年跨ぎ（12月末の祝日が日曜）は現行法では起き得ないが、表は年単位なので同年内だけ入れる
    if (next.getFullYear() === year) all.set(key(next.getMonth() + 1, next.getDate()), "振替休日");
  }

  // 国民の休日: 前日と翌日がともに祝日で、自身は祝日でも日曜でもない日
  for (const k of base.keys()) {
    const [month, day] = k.split("-").map(Number);
    const mid = new Date(year, month - 1, day + 1);
    if (mid.getFullYear() !== year || mid.getDay() === 0) continue;
    const midKey = key(mid.getMonth() + 1, mid.getDate());
    if (all.has(midKey)) continue; // 祝日そのもの、または既に振替休日
    const after = new Date(mid.getFullYear(), mid.getMonth(), mid.getDate() + 1);
    if (!base.has(key(after.getMonth() + 1, after.getDate()))) continue;
    all.set(midKey, "国民の休日");
  }

  return all;
}

/** その日の祝日名（振替休日・国民の休日を含む）。祝日でなければ null。判定はローカル暦 */
export function japaneseHolidayName(date: Date): string | null {
  const year = date.getFullYear();
  let table = cache.get(year);
  if (!table) {
    table = buildYear(year);
    cache.set(year, table);
  }
  return table.get(key(date.getMonth() + 1, date.getDate())) ?? null;
}

/** その日が祝日（振替休日・国民の休日を含む）か */
export function isJapaneseHoliday(date: Date): boolean {
  return japaneseHolidayName(date) !== null;
}

/** その日が平日か = 月〜金 かつ 祝日でない。schedule の "weekday HH:MM" の定義そのもの */
export function isJapaneseBusinessDay(date: Date): boolean {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  return !isJapaneseHoliday(date);
}
