import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// UI の純関数テスト用の設定。React コンポーネントはテストしない方針（jsdom 等の
// 重い基盤は入れない）ので environment は node のまま。
// vite.config.ts とは意図的に分ける: あちらの plugins（react / tailwindcss）や
// proxy 設定はテスト実行に不要で、vitest はこのファイルがあると vite.config.ts を読まない。
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
