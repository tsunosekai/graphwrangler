// branding.ts の純粋関数（種別判定 / index.html 置換）のテスト。ファイル入出力はテストしない。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFaviconType, escapeHtml, renderIndexHtml } from "../src/branding.js";

/** 最小の PNG（マジックバイト + IHDR チャンク見出しまで） */
function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]), // IHDR の長さ
    Buffer.from("IHDR", "latin1"),
    Buffer.alloc(13),
  ]);
}

test("detectFaviconType: PNG はマジックバイト + IHDR で通す", () => {
  assert.equal(detectFaviconType(pngBytes()), "png");
});

test("detectFaviconType: マジックバイトだけ合っていて IHDR でない偽装は弾く", () => {
  const fake = pngBytes();
  fake.write("EVIL", 12, "latin1");
  assert.equal(detectFaviconType(fake), null);
});

test("detectFaviconType: SVG は XML宣言・コメント・DOCTYPE を跨いでも見つける", () => {
  const svg = `<?xml version="1.0"?>\n<!-- made by someone -->\n<!DOCTYPE svg>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>`;
  assert.equal(detectFaviconType(Buffer.from(svg, "utf8")), "svg");
});

test("detectFaviconType: BOM 付きの SVG も通す", () => {
  assert.equal(detectFaviconType(Buffer.from("\uFEFF<svg></svg>", "utf8")), "svg");
});

test("detectFaviconType: 画像でないもの（HTML・スクリプト・空）は null", () => {
  // Content-Type を信じないので、ここが最後の砦
  assert.equal(detectFaviconType(Buffer.from("<html><script>alert(1)</script></html>")), null);
  assert.equal(detectFaviconType(Buffer.from("GIF89a")), null);
  assert.equal(detectFaviconType(Buffer.alloc(0)), null);
});

test("detectFaviconType: <svgfoo> のような別要素を SVG と誤認しない", () => {
  assert.equal(detectFaviconType(Buffer.from("<svgish></svgish>")), null);
});

const HTML = `<!doctype html>
<html lang="ja">
  <head>
    <title>GraphWrangler</title>
    <link rel="icon" type="image/png" sizes="64x64" href="/favicon.png" />
    <link rel="apple-touch-icon" href="/icon-256.png" />
  </head>
  <body><div id="root"></div></body>
</html>`;

test("renderIndexHtml: title とファビコンの href を差し替える", () => {
  const out = renderIndexHtml(HTML, "ARK タスクグラフ", 3);
  assert.match(out, /<title>ARK タスクグラフ<\/title>/);
  assert.match(out, /<link rel="icon" href="\/favicon\.png\?v=3" \/>/);
  // apple-touch-icon（別の rel）は触らない
  assert.match(out, /rel="apple-touch-icon" href="\/icon-256\.png"/);
});

test("renderIndexHtml: サイト名は必ずエスケープする（</title> や < で壊れない・注入にならない）", () => {
  const out = renderIndexHtml(HTML, `</title><script>alert(1)</script>`, 0);
  assert.equal(out.includes("<script>alert(1)</script>"), false);
  assert.match(out, /<title>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
});

test("renderIndexHtml: $& など置換文字列の特殊記号をそのまま出す", () => {
  const out = renderIndexHtml(HTML, "A $& B", 0);
  assert.match(out, /<title>A \$&amp; B<\/title>/);
});

test("escapeHtml: 5文字を実体参照へ", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});
