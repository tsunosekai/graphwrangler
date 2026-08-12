// 「id の集合」で持つ画面の状態（左レールのフォルダ折り畳み・ラン子行の開閉）を
// localStorage に置くための小さなフック。UI状態なので正データ（ノード）には混ぜない。
// 読めない / 書けない環境（プライベートモード等）でも黙って続ける——永続化は補助機能。
import { useState } from "react";
import { loadUiState, saveUiState } from "./uiState";

function loadIdSet(key: string): Set<string> {
  try {
    const raw = JSON.parse(loadUiState(key) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** [集合, その id の出し入れ] を返す。トグルのたびに localStorage へ書き戻す */
export function useIdSetPref(key: string): [Set<string>, (id: string) => void] {
  const [ids, setIds] = useState<Set<string>>(() => loadIdSet(key));
  const toggle = (id: string) =>
    setIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveUiState(key, JSON.stringify([...next]));
      return next;
    });
  return [ids, toggle];
}
