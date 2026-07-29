// ダーク/ライト/システム追従のテーマ管理。localStorage(gw.theme) に保存し、既定は system。
// html 要素へ .dark を付け外しするだけの薄い実装（Tailwind v4 の @custom-variant dark が
// .dark 祖先を見るので、他は一切関与不要）。
import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "gw.theme";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveIsDark(mode: ThemeMode): boolean {
  return mode === "system" ? systemPrefersDark() : mode === "dark";
}

/** html.classList を実際の見た目に同期する。main.tsx の初期化と useTheme の両方から呼ぶ */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.classList.toggle("dark", resolveIsDark(mode));
}

export function loadThemeMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

/** TopBar のテーマ切替メニューが使うフック。mode 変更は即座に反映+永続化する */
export function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setModeState] = useState<ThemeMode>(() => loadThemeMode());

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  // system 選択中は OS のテーマ変更にも追従する
  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return [mode, setMode];
}
