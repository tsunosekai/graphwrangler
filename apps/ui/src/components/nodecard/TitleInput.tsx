// カードのタイトル編集（NodeCard から切り出し）。編集中だけ実体があり、下書き（draft）と
// フォーカス取りの面倒だけを見る。確定/取り消しは呼び出し側（GraphView のハンドラ）へ返す。
import { useEffect, useRef, useState } from "react";
import type { Node } from "../../types";

export function TitleInput({
  node,
  onCommit,
  onCancel,
}: {
  node: Node;
  onCommit: (id: string, title: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(node.title);
  // 外からタイトルが変わったら下書きも追随する（編集中のカードにだけ実体があるので、
  // マウント時の1回は同値＝何も起きない）
  useEffect(() => {
    setDraft(node.title);
  }, [node.title]);

  // 編集開始時のフォーカス。autoFocus は使わない: マウント直後は React Flow の再計測で
  // ノードが一瞬 visibility:hidden になることがあり、その間の focus() は静かに不発になる
  // （2026-08-07 本人報告「タイトル編集中にフォーカスが外れる」。実測: autoFocus も
  // rAF 1回でも不発だった）。フォーカスが実際に付くまで数フレーム リトライする
  // （編集セッションにつき1回だけ走る。付いたら全選択して終了）
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    let raf = 0;
    let tries = 0;
    const attempt = () => {
      const el = titleInputRef.current;
      if (!el) return; // 編集が終わって input が消えた
      el.focus();
      if (document.activeElement === el) {
        el.select();
        return;
      }
      if (++tries < 30) raf = requestAnimationFrame(attempt); // 最大 ~0.5秒
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <input
      ref={titleInputRef}
      className="nodrag min-w-0 flex-1 rounded-sm border border-border bg-transparent px-1 py-px text-sm text-foreground outline-none focus:border-border-strong"
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(node.id, draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(node.id, draft)}
    />
  );
}
