// インスタンスのブランディング（サイト名・ファビコン）の受け取りと反映。
// 正本はサーバ側（packages/server/src/branding.ts + settings.branding）で、ここは表示側。
//
// サーバは index.html の <title> と <link rel="icon"> を置換して返すので、**初期表示は
// これを読まなくても正しい**。このモジュールが要るのは (a) ヘッダーやログイン画面の中の
// サイト名 (b) 設定変更直後のリロード無し反映 (c) vite dev（置換の効かない素の index.html）。
// 取得は認証不要の GET /api/branding なので、ログイン画面からも同じ名前が読める。
import { useSyncExternalStore } from "react";

export const DEFAULT_SITE_TITLE = "GraphWrangler";

export interface Branding {
  siteTitle: string;
  /** 0 = 同梱の既定ファビコン。1以上 = インスタンス側の手置き（値はキャッシュバスター） */
  faviconVersion: number;
}

// 初期値はサーバが置換済みの document.title から拾う——取得が返るまでの一瞬、
// ヘッダーに既定名（GraphWrangler）がちらつくのを防ぐ
let current: Branding = {
  siteTitle: document.title || DEFAULT_SITE_TITLE,
  faviconVersion: 0,
};

const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** ヘッダー・ログイン画面などがサイト名を出すためのフック */
export function useBranding(): Branding {
  return useSyncExternalStore(subscribe, () => current);
}

/** document.title と <link rel="icon"> を今の値に合わせる */
function apply(b: Branding): void {
  document.title = b.siteTitle;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) link.setAttribute("href", `/favicon.png?v=${b.faviconVersion}`);
}

/** サーバから読み直して画面へ反映する。起動時と、設定でブランディングを変えた直後に呼ぶ。
 *  失敗しても既定（＝今の見た目）のままにする＝この API を持たない旧サーバでも壊れない */
export async function refreshBranding(): Promise<void> {
  let next: Branding;
  try {
    const res = await fetch("/api/branding", { headers: { "Content-Type": "application/json" } });
    if (!res.ok) return;
    const data = (await res.json()) as Partial<Branding>;
    next = {
      siteTitle:
        typeof data.siteTitle === "string" && data.siteTitle.trim()
          ? data.siteTitle
          : DEFAULT_SITE_TITLE,
      faviconVersion: typeof data.faviconVersion === "number" ? data.faviconVersion : 0,
    };
  } catch {
    return; // ブランディングは補助情報。取れなければ黙って既定のまま
  }
  if (next.siteTitle === current.siteTitle && next.faviconVersion === current.faviconVersion) {
    // ファビコンだけ差し替えて版が据え置き…は起きない（アップロードで必ず +1 される）
    return;
  }
  current = next;
  apply(next);
  for (const l of listeners) l();
}
