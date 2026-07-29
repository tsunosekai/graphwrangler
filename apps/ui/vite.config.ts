import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// tasuki UI: サーバ (packages/server, 既定 :8770) の /api を素通しする。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8770",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
