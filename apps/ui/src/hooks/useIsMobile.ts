// モバイル判定（<768px）。レスポンシブは CSS ではなく「4ビューのどれか1つが画面を専有する」
// 専用設計で行う（2026-08-02 本人指定「ヘッダーを除いて、プロジェクト一覧/グラフ/
// ノード詳細/GraphWrangler AI のどれかが画面を占有」）。App がこのフックでビューを切り替える
import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 767px)";

function subscribe(callback: () => void): () => void {
  const m = window.matchMedia(QUERY);
  m.addEventListener("change", callback);
  return () => m.removeEventListener("change", callback);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches);
}
