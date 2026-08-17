// 進捗ボタンのご褒美アニメーション（2026-08-17 本人要望「押すことがちょっとした報酬になるように、
// チェックマークとかがアニメーションで出て気持ち良い感じに」）。
// 押した場所（ボタン/セル）の上に、到達した状態の記号（StatusCircle と同じ図像）が
// バネっぽくポップし、完了だけは紙吹雪の粒が飛ぶ。DOM 直組み + Web Animations API で
// React ツリーの外に描く——ボタン自体は楽観更新で即座に消えたり入れ替わったりするため、
// アニメーションはそれと独立に生き残る必要がある。
export type CelebrateKind = "plan" | "start" | "done";

const SVG_NS = "http://www.w3.org/2000/svg";

/** ばね風イージング（少し行き過ぎて戻る） */
const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";

interface KindConf {
  /** 記号・波紋・粒の色（CSS 変数で書く。ライト/ダーク両テーマに追従） */
  color: string;
  /** 記号の直径 px */
  size: number;
  /** 飛ばす粒の数（0 = 無し） */
  particles: number;
}

const CONF: Record<CelebrateKind, KindConf> = {
  // 計画済み: 控えめ（青リングのポップ）。何度も押す操作なのでうるさくしない
  plan: { color: "var(--ai)", size: 26, particles: 0 },
  // 着手: 進行中の半円パイ（StatusCircle の running と同じ絵）が青でポップ
  start: { color: "var(--ai)", size: 30, particles: 0 },
  // 完了: 緑の塗り円+チェックが描かれ、波紋と粒が飛ぶ（いちばんのご褒美）
  done: { color: "var(--ok)", size: 38, particles: 10 },
};

/** anchor（押したボタン/セル）の中心に kind の記号をポップさせる。
 *  失敗しても本処理に影響しないよう、例外はすべて握り潰す */
export function celebrate(anchor: Element | null | undefined, kind: CelebrateKind): void {
  try {
    if (typeof window === "undefined" || !anchor) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof anchor.animate !== "function" && typeof document.body.animate !== "function") return;
    const rect = anchor.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return; // 既に消えた要素
    render(rect.left + rect.width / 2, rect.top + rect.height / 2, kind);
  } catch {
    // 演出は本処理（PATCH・状態遷移）と無関係。静かに諦める
  }
}

function render(cx: number, cy: number, kind: CelebrateKind): void {
  const conf = CONF[kind];
  const root = document.createElement("div");
  root.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;width:0;height:0;overflow:visible;pointer-events:none;z-index:9999;color:${conf.color}`;
  document.body.appendChild(root);

  // ---- 波紋（全種共通。plan/start は小さめ） ----
  const ringSize = conf.size * (kind === "done" ? 1.6 : 1.2);
  const ring = document.createElement("div");
  ring.style.cssText = `position:absolute;left:${-ringSize / 2}px;top:${-ringSize / 2}px;width:${ringSize}px;height:${ringSize}px;border-radius:50%;border:2px solid currentColor;`;
  root.appendChild(ring);
  ring.animate(
    [
      { transform: "scale(0.4)", opacity: 0.9 },
      { transform: "scale(1.5)", opacity: 0 },
    ],
    { duration: kind === "done" ? 520 : 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
  );

  // ---- 記号本体（StatusCircle と同じ 14x14 の viewBox で描く） ----
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("width", String(conf.size));
  svg.setAttribute("height", String(conf.size));
  svg.style.cssText = `position:absolute;left:${-conf.size / 2}px;top:${-conf.size / 2}px;display:block;overflow:visible;`;
  if (kind === "done") {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "7");
    circle.setAttribute("cy", "7");
    circle.setAttribute("r", "6");
    circle.setAttribute("fill", "currentColor");
    svg.appendChild(circle);
    const check = document.createElementNS(SVG_NS, "path");
    check.setAttribute("d", "M4.2 7.2 6.2 9.2 9.9 4.9");
    check.setAttribute("stroke", "var(--background)");
    check.setAttribute("stroke-width", "1.6");
    check.setAttribute("fill", "none");
    check.setAttribute("stroke-linecap", "round");
    check.setAttribute("stroke-linejoin", "round");
    svg.appendChild(check);
    // チェックは左から「描かれる」（stroke-dash の定番）
    const len = 9; // パス長のおおよそ（getTotalLength は描画前だと 0 になる環境がある）
    check.style.strokeDasharray = String(len);
    check.style.strokeDashoffset = String(len);
    check.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], {
      duration: 260,
      delay: 140,
      easing: "ease-out",
      fill: "forwards",
    });
  } else if (kind === "start") {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "7");
    circle.setAttribute("cy", "7");
    circle.setAttribute("r", "5.4");
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", "currentColor");
    circle.setAttribute("stroke-width", "1.4");
    svg.appendChild(circle);
    const pie = document.createElementNS(SVG_NS, "path");
    pie.setAttribute("d", "M7 3.4 A3.6 3.6 0 0 1 7 10.6 Z");
    pie.setAttribute("fill", "currentColor");
    svg.appendChild(pie);
  } else {
    // plan: 実線円（未計画の破線 → 実線になった、の絵）
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "7");
    circle.setAttribute("cy", "7");
    circle.setAttribute("r", "5.4");
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", "currentColor");
    circle.setAttribute("stroke-width", "1.6");
    svg.appendChild(circle);
  }
  root.appendChild(svg);
  svg.animate(
    [
      { transform: "scale(0.2)", opacity: 0 },
      { transform: "scale(1.15)", opacity: 1, offset: 0.45 },
      { transform: "scale(1)", opacity: 1, offset: 0.7 },
      { transform: "scale(1)", opacity: 0 },
    ],
    { duration: kind === "done" ? 700 : 520, easing: SPRING, fill: "forwards" },
  );

  // ---- 粒（完了のみ）。中心から放射状に飛んで減速しながら消える ----
  for (let i = 0; i < conf.particles; i++) {
    const p = document.createElement("div");
    const s = 3 + Math.random() * 3;
    p.style.cssText = `position:absolute;left:${-s / 2}px;top:${-s / 2}px;width:${s}px;height:${s}px;border-radius:50%;background:currentColor;opacity:0;`;
    root.appendChild(p);
    const angle = (i / conf.particles) * Math.PI * 2 + Math.random() * 0.7;
    const dist = conf.size * (0.8 + Math.random() * 0.7);
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    p.animate(
      [
        { transform: "translate(0,0) scale(1)", opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0 },
      ],
      {
        duration: 450 + Math.random() * 200,
        delay: 60,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "forwards",
      },
    );
  }

  window.setTimeout(() => root.remove(), 900);
}
