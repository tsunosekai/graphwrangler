import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { TooltipProvider } from "./components/ui/tooltip";
import { applyTheme, loadThemeMode } from "./lib/theme";
import "@fontsource-variable/inter";
import "./index.css";

// 初回描画前にテーマを確定させる（React マウント後だとダーク→ライトのちらつきが出るため）
applyTheme(loadThemeMode());

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
