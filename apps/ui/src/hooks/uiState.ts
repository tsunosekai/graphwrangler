// 画面状態の永続化ヘルパ。読めない / 書けない環境（プライベートモード等）でも黙って
// 続ける——永続化は補助機能なので、失敗を呼び出し側に伝えない。

/** localStorage の安全な読み書き（UI状態の永続化。2026-07-31 本人要望
 *  「リロードしても開閉や幅を保持」。幅とテーマ・レール開閉は各コンポーネントで保存済み） */
export function loadUiState(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function saveUiState(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 無視（永続化は補助機能）
  }
}

/** sessionStorage 版。リロードは跨ぐが、タブ/アプリを開き直すと消える */
export function loadTabState(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
export function saveTabState(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // 無視（永続化は補助機能）
  }
}
