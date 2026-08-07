// AI モデル/エフォートの表示ラベルと、「既定」が実際に何を指すかの解決
// （2026-08-07 本人指摘「既定って書くときはそれが何なのか書いてほしい。○○（既定）でいい」）。
// セレクタの既定オプションは「既定」とだけ書かず、設定の実値を「Opus 5（既定）」の形で見せる。
import { useEffect, useState } from "react";
import { api } from "./api";

export const MODEL_LABELS: Record<string, string> = {
  fable: "Fable 5",
  opus: "Opus 5",
  sonnet: "Sonnet 5",
  haiku: "Haiku 4.5",
};

export const EFFORT_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

export function modelLabel(v: string | null | undefined): string {
  return v ? (MODEL_LABELS[v] ?? v) : "指定なし";
}

/** null（--effort を渡さない=CLI 側の既定で動く）は「指定なし」と表示する */
export function effortLabel(v: string | null | undefined): string {
  return v ? (EFFORT_LABELS[v] ?? v) : "指定なし";
}

export interface AiDefaults {
  /** チャットAI / Task AI の既定（settings.chat.cliModel / cliEffort） */
  chatModel: string;
  chatEffort: string | null;
  /** 実行AI（エンジン）の既定（settings.engine.model / effort） */
  engineModel: string;
  engineEffort: string | null;
}

// 設定はそう頻繁に変わらないので短い TTL 付きのモジュールキャッシュで共有する
// （コンポーザはノード切替のたびにマウントされるため、毎回 fetch しない）
let cached: { at: number; value: AiDefaults } | null = null;
let inflight: Promise<AiDefaults | null> | null = null;
const TTL_MS = 60 * 1000;

async function fetchDefaults(): Promise<AiDefaults | null> {
  try {
    const s = await api.getSettings();
    const value: AiDefaults = {
      chatModel: s.chat.cliModel,
      chatEffort: s.chat.cliEffort ?? null,
      engineModel: s.engine.model,
      engineEffort: s.engine.effort ?? null,
    };
    cached = { at: Date.now(), value };
    return value;
  } catch {
    return null; // 取れなければ「既定」とだけ出す（利用側のフォールバック）
  } finally {
    inflight = null;
  }
}

/** 設定の既定値（60秒キャッシュ）。取得前・失敗時は null */
export function useAiDefaults(): AiDefaults | null {
  const [value, setValue] = useState<AiDefaults | null>(
    cached && Date.now() - cached.at < TTL_MS ? cached.value : null,
  );
  useEffect(() => {
    if (cached && Date.now() - cached.at < TTL_MS) {
      setValue(cached.value);
      return;
    }
    let cancelled = false;
    inflight = inflight ?? fetchDefaults();
    void inflight.then((v) => {
      if (!cancelled && v) setValue(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return value;
}
