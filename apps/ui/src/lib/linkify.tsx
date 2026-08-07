// URL の自動リンク化（2026-08-07 本人要望「チャット欄で URL リンクを出せるように」）。
// - マークダウン描画（react-markdown）には mdComponents を渡す。remark-gfm が裸 URL も
//   <a> にしてくれるが、既定はアプリと同じタブで開いてしまうため新しいタブに逃がす
// - プレーンテキスト（ユーザー発言・人間/システムのスレッド発言）は Linkify で
//   URL 部分だけを <a> にする（マークダウン解釈はしない——入力そのままの原則を保つ）
import type { Components } from "react-markdown";

/** react-markdown に渡す components。リンクは新しいタブで開く（SPA の画面を奪わない） */
export const mdComponents: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

// 全角括弧・引用符・空白で切る。文末の句読点や閉じ括弧は URL に含めがちなので後で剥がす
const URL_RE = /https?:\/\/[^\s<>「」（）『』""'']+/g;

function stripTrailingPunct(url: string): string {
  return url.replace(/[),.;:!?。、．，）\]]+$/, "");
}

/** プレーンテキスト中の URL をクリック可能なリンクにして描画する */
export function Linkify({ text }: { text: string }) {
  const parts: Array<string | { url: string }> = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0];
    const url = stripTrailingPunct(raw);
    const start = m.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push({ url });
    last = start + url.length; // 剥がした句読点はテキスト側に戻す
  }
  if (last < text.length) parts.push(text.slice(last));
  if (parts.length === 1 && typeof parts[0] === "string") return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <a
            key={i}
            href={p.url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-ai underline"
          >
            {p.url}
          </a>
        ),
      )}
    </>
  );
}
