// zinsei desk のモノクロ・ストロークSVGアイコンを移植（絵文字不使用）。
// stroke:currentColor なので色は親の color で決まる。
const PATHS: Record<string, string> = {
  user: 'M5 20c.8-3.5 3.5-5 7-5s6.2 1.5 7 5',
  gear: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1',
  check: 'M4.5 12.5 10 18 19.5 6.5',
  x: 'M6 6l12 12M18 6 6 18',
  alert: 'M12 3.5 2.5 20h19zM12 10v4.5M12 17.2v.6',
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H6l-3 3V11.5A8.5 8.5 0 0 1 11.5 3h1A8.5 8.5 0 0 1 21 11.5z',
  // ルーティーンページ用。desk の repeat アイコンと同型
  repeat:
    'M4 12a8 8 0 0 1 13.5-5.5L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.5 5.5L4 15M4 20v-5h5',
  // 実装形態（impl）バッジ: 手順書（doc）/ スクリプト（code）
  doc: 'M7 3h7l4 4v14H7z M14 3v4h4 M10 12h5M10 16h5',
  code: 'm8 9-4 3 4 3 M16 9l4 3-4 3',
  // 担当アイコン（2026-07-31 本人選定「B. 明快系」）: AI=ロボット顔 / スクリプト=ターミナル >_
  // 形状は Lucide の bot / terminal を移植（cpu/gear は「AI/スクリプトに見えない」ため置換）
  bot: 'M12 8V4H8M2 14h2M20 14h2M15 13v2M9 13v2',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  // 判断（分岐）: 下向きY字+枝先ちょぼ（2026-07-31 本人選定「C」。縦フローで枝が下辺から
  // 割れる実挙動に向きを揃えた自作。GitBranch は上向きで Git 用語の絵だったため置換）
  branch: 'M12 3.5v6.5M12 10 7 16.5M12 10 17 16.5',
};

// パスだけでは表せない形状（rect/circle）を含むアイコン
const EXTRA: Record<string, React.ReactNode> = {
  user: <circle cx="12" cy="8" r="3.5" />,
  gear: <circle cx="12" cy="12" r="3.5" />,
  bot: <rect x="4" y="8" width="16" height="12" rx="2" />,
  branch: (
    <>
      <circle cx="7" cy="19" r="1.6" />
      <circle cx="17" cy="19" r="1.6" />
    </>
  ),
};

export function Icon({ name, size = 13 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <span className="ic" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size} height={size}>
        {EXTRA[name]}
        {PATHS[name] && <path d={PATHS[name]} />}
      </svg>
    </span>
  );
}
