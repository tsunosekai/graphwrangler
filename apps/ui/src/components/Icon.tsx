// zinsei desk のモノクロ・ストロークSVGアイコンを移植（絵文字不使用）。
// stroke:currentColor なので色は親の color で決まる。
const PATHS: Record<string, string> = {
  cpu: 'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
  user: 'M5 20c.8-3.5 3.5-5 7-5s6.2 1.5 7 5',
  gear: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1',
  laptop: 'M2 19h20',
  send: 'M21 3 10.5 13.5M21 3l-6.5 18-4-8.5L2 8.5z',
  clock: 'M12 7.5V12l3 2',
  check: 'M4.5 12.5 10 18 19.5 6.5',
  x: 'M6 6l12 12M18 6 6 18',
  alert: 'M12 3.5 2.5 20h19zM12 10v4.5M12 17.2v.6',
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H6l-3 3V11.5A8.5 8.5 0 0 1 11.5 3h1A8.5 8.5 0 0 1 21 11.5z',
  plus: 'M12 5v14M5 12h14',
  drop: 'M8.5 12h7',
  trash:
    'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12M10 11v6M14 11v6',
  // 手順ページ（procedure）用。desk の repeat アイコンと同型
  repeat:
    'M4 12a8 8 0 0 1 13.5-5.5L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.5 5.5L4 15M4 20v-5h5',
};

// パスだけでは表せない形状（rect/circle）を含むアイコン
const EXTRA: Record<string, React.ReactNode> = {
  cpu: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" />
    </>
  ),
  user: <circle cx="12" cy="8" r="3.5" />,
  gear: <circle cx="12" cy="12" r="3.5" />,
  laptop: <rect x="4" y="5" width="16" height="11" rx="1.5" />,
  clock: <circle cx="12" cy="12" r="8.5" />,
  drop: <circle cx="12" cy="12" r="8.5" />,
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
