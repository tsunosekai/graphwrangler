// --- モバイルのブラウザ「戻る」統合（2026-08-02 本人報告「スマホの戻るで戻りすぎる」） ---
// SPA なので履歴が1件も積まれず、戻る=即アプリ外に出てしまっていた。ビュー切替と
// 設定画面を history に積み、戻るは「1つ前のビューへ」になる（履歴を遡り切ったら
// 従来どおりページを離れる）
import { useEffect, useRef } from "react";
import type { MobileView } from "../components/MobileNav";

export interface MobileBackNavOptions {
  isMobile: boolean;
  mobileView: MobileView;
  setMobileView: (view: MobileView) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
}

export function useMobileBackNav({
  isMobile,
  mobileView,
  setMobileView,
  settingsOpen,
  setSettingsOpen,
}: MobileBackNavOptions): void {
  const popNavRef = useRef(false);
  const firstViewPushRef = useRef(true);
  const settingsOpenRef = useRef(false);
  useEffect(() => {
    if (!isMobile) return;
    if (firstViewPushRef.current) {
      // 初期エントリに現在ビューを刻む（戻り切ったときの復元先）
      firstViewPushRef.current = false;
      window.history.replaceState({ gwView: mobileView }, "");
      return;
    }
    if (popNavRef.current) {
      popNavRef.current = false; // popstate 由来の setMobileView では積まない
      return;
    }
    window.history.pushState({ gwView: mobileView }, "");
  }, [mobileView, isMobile]);
  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
    if (!isMobile || !settingsOpen) return;
    window.history.pushState({ gwSettings: true }, "");
  }, [settingsOpen, isMobile]);
  useEffect(() => {
    if (!isMobile) return;
    const onPop = (e: PopStateEvent) => {
      if (settingsOpenRef.current) {
        setSettingsOpen(false); // 設定が開いていたら「戻る」はまず設定を閉じる
        return;
      }
      const st = e.state as { gwView?: MobileView } | null;
      popNavRef.current = true;
      setMobileView(st?.gwView ?? "graph");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [isMobile, setMobileView, setSettingsOpen]);
}
