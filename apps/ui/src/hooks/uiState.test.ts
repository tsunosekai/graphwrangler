// 画面状態のユーザー別スコープ（2026-08-12 本人要望「それぞれのメンバーの画面に、
// どれを開いていたかとかの影響を及ぼさないように」）。
// テスト環境は node のまま（UI は純関数だけテストする方針で jsdom を入れない）ので、
// localStorage だけ最小のスタブを置く。uiState.ts は呼び出し時にしか global を触らない
import { beforeEach, describe, expect, it } from "vitest";
import { loadUiState, saveUiState, setUiStateScope } from "./uiState";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

// Object.keys(localStorage) で列挙できる必要がある（adoptLegacyKeys が使う）ため、
// Map ではなく素のオブジェクトを Proxy で包む
function enumerableStorage(): Storage {
  const base = memoryStorage();
  return new Proxy(base, {
    ownKeys: () => Array.from({ length: base.length }, (_, i) => base.key(i) as string),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = enumerableStorage();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = enumerableStorage();
});

beforeEach(() => {
  localStorage.clear();
  setUiStateScope(null); // 各テストは匿名から始める
});

describe("setUiStateScope", () => {
  it("ログインユーザーごとに別の値を持つ（他人の開いていたページを引き継がない）", () => {
    setUiStateScope("a@example.com");
    saveUiState("gw.pageId", "n-a");
    setUiStateScope("b@example.com");
    expect(loadUiState("gw.pageId")).toBeNull(); // B は素の既定値から
    saveUiState("gw.pageId", "n-b");
    setUiStateScope("a@example.com");
    expect(loadUiState("gw.pageId")).toBe("n-a"); // A の状態は保たれる
  });

  it("メールの表記ゆれ（大文字）は同じ人として扱う", () => {
    setUiStateScope("a@example.com");
    saveUiState("gw.pageId", "n-a");
    setUiStateScope("A@Example.com");
    expect(loadUiState("gw.pageId")).toBe("n-a");
  });

  it("ログイン無し運用（scope=null）はこれまでどおりのキーで読み書きする", () => {
    saveUiState("gw.pageId", "n-x");
    expect(localStorage.getItem("gw.pageId")).toBe("n-x");
    expect(loadUiState("gw.pageId")).toBe("n-x");
  });

  it("スコープ導入前の値は最初にログインした1人だけが引き継ぎ、2人目は素の状態", () => {
    localStorage.setItem("gw.pageId", "n-legacy"); // 旧バージョンが書いた値
    setUiStateScope("first@example.com");
    expect(loadUiState("gw.pageId")).toBe("n-legacy");
    expect(localStorage.getItem("gw.pageId")).toBeNull(); // 旧キーは引き継ぎ後に消す
    setUiStateScope("second@example.com");
    expect(loadUiState("gw.pageId")).toBeNull();
  });

  it("端末の設定（テーマ・通知許可）は人で分けない＝引き継ぎでも移動しない", () => {
    localStorage.setItem("gw.theme", "dark");
    localStorage.setItem("gw.notify", "1");
    setUiStateScope("first@example.com");
    expect(localStorage.getItem("gw.theme")).toBe("dark");
    expect(localStorage.getItem("gw.notify")).toBe("1");
  });
});
