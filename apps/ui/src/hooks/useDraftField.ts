import { useEffect, useState } from "react";

/** 「編集中は自分のdraftを見る」流儀（title/detail/BranchRow などで共通）の draft +
 *  focused + blur 確定パターン。focused の間は外部値の変化で draft を上書きせず、
 *  blur（setFocused(false)）後は外部値へ追随する。確定（コミット）の条件・整形は
 *  呼び出し側の onBlur が持つ（フィールドごとに trim や空チェックが違うため） */
export function useDraftField<T>(source: T) {
  const [draft, setDraft] = useState<T>(source);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(source);
  }, [source, focused]);
  return { draft, setDraft, focused, setFocused };
}
