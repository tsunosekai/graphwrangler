// 画面状態の永続化ヘルパ。読めない / 書けない環境（プライベートモード等）でも黙って
// 続ける——永続化は補助機能なので、失敗を呼び出し側に伝えない。
//
// **保存はログインユーザーごとに分ける**（2026-08-12 本人要望「それぞれのメンバーの画面に、
// どれを開いていたかとかの影響を及ぼさないように」）。同じブラウザで別アカウントへ
// ログインし直す運用でも、開いていたページ・選択ノード・パネルの開閉・タブ・幅・テーマ・
// ヒントの既読が他人へ引き継がれない。
// **内容（グラフ・会話・ラン・既読）はサーバ側**なので、同じものを開けば従来どおり同期される
// ——ここで分けるのは「誰が何を開いて、どう見ていたか」だけ（本人指示の後半「同じのを
// 見てるときはむしろ同期されてほしい」を壊さない）。
// ログイン無しの運用（zinsei の一人運用）はスコープ空文字＝これまでと同じキーのまま。

/** 現在の保存領域の前置き（"" = 匿名／ログイン無し運用） */
let scope = "";

/**
 * 保存領域をログインユーザーで切り替える。App のログインゲートが**本体をマウントする前**に
 * 呼ぶ（各コンポーネントの useState 初期化子が loadUiState を読むため、後から変えても遅い）。
 */
export function setUiStateScope(email: string | null): void {
  const next = email ? `u:${email.trim().toLowerCase()}:` : "";
  if (next === scope) return;
  scope = next;
  if (scope) adoptLegacyKeys();
}

/**
 * スコープ導入前（＝全ユーザー共通だった頃）の "gw.*" を、最初にログインした1人へ引き継ぐ。
 * 引き継ぎ後に旧キーを消すので、あとから同じブラウザで別アカウントへログインした人は
 * 素の既定値から始まる（＝他人の画面状態を引き継がない）。
 */
/** 人ではなく**端末**の設定なので分けないキー: テーマ（起動時＝ログイン判定より前に適用する
 *  ので分けると初回描画で色が飛ぶ）、デスクトップ通知の許可（ブラウザ権限と対になる） */
const DEVICE_KEYS = new Set(["gw.theme", "gw.notify"]);

function adoptLegacyKeys(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("gw.") || DEVICE_KEYS.has(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null && localStorage.getItem(scope + key) === null) {
        localStorage.setItem(scope + key, value);
      }
      localStorage.removeItem(key);
    }
  } catch {
    // 無視（永続化は補助機能）
  }
}

/** localStorage の安全な読み書き（UI状態の永続化。2026-07-31 本人要望
 *  「リロードしても開閉や幅を保持」。幅とテーマ・レール開閉は各コンポーネントで保存済み） */
export function loadUiState(key: string): string | null {
  try {
    return localStorage.getItem(scope + key);
  } catch {
    return null;
  }
}
export function saveUiState(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(scope + key);
    else localStorage.setItem(scope + key, value);
  } catch {
    // 無視（永続化は補助機能）
  }
}

/** sessionStorage 版。リロードは跨ぐが、タブ/アプリを開き直すと消える */
export function loadTabState(key: string): string | null {
  try {
    return sessionStorage.getItem(scope + key);
  } catch {
    return null;
  }
}
export function saveTabState(key: string, value: string): void {
  try {
    sessionStorage.setItem(scope + key, value);
  } catch {
    // 無視（永続化は補助機能）
  }
}
