// Linear 風のステータスサークル（backlog/todo/in-progress/done の円形インジケータの系譜）。
// pending=空円 / running=半分埋まったリング / waiting=中点付き円 / done=塗り円+チェック /
// dropped=×円 / skipped=薄い円+斜線（dropped の×とは区別。docs/design.md 3.9）
import { HINT_TEXT } from "../lib/hints";
import { STATUS_JA } from "../lib/labels";
import type { Status } from "../types";
import { Hint } from "./Hint";

const COLOR: Record<Status, string> = {
  unplanned: "var(--text-lo)",
  pending: "var(--text-lo)",
  running: "var(--ai)",
  waiting: "var(--attention)", // あなたの番（カード右肩の点・レールのドットと同じ橙）
  done: "var(--ok)",
  dropped: "var(--text-lo)",
  skipped: "var(--text-lo)",
};

export function StatusCircle({
  status,
  size = 14,
  mine = true,
  hint = true,
}: {
  status: Status;
  size?: number;
  /** waiting のとき「自分の番」か（チーム化 2026-08-04）。他人の番なら橙(--attention)にせず
   *  人間の席色で「誰かの回答待ち」だけ伝える。waiting 以外では無視される */
  mine?: boolean;
  /** 記号の凡例ヒント（2026-08-05）。既定で全使用箇所に付く。外側が自前の Hint で包む場合
   *  （台帳のセル等）だけ false にして二重吹き出しを避ける */
  hint?: boolean;
}) {
  const c = status === "waiting" && !mine ? "var(--human)" : COLOR[status];
  const label = status === "waiting" && !mine ? "回答待ち（他の人の番）" : STATUS_JA[status];
  const circle = (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      style={{ display: "block", flexShrink: 0 }}
      aria-label={status}
    >
      {status === "done" ? (
        <>
          <circle cx="7" cy="7" r="6" fill={c} />
          <path
            d="M4.2 7.2 6.2 9.2 9.9 4.9"
            stroke="var(--background)"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : status === "dropped" ? (
        <>
          <circle cx="7" cy="7" r="5.4" fill="none" stroke={c} strokeWidth="1.2" />
          <path d="M4.8 4.8l4.4 4.4M9.2 4.8 4.8 9.2" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
        </>
      ) : status === "skipped" ? (
        // 薄い円+斜線1本（dropped の×=対角線2本とは区別。分岐で選ばれなかった枝）
        <>
          <circle cx="7" cy="7" r="5.4" fill="none" stroke={c} strokeWidth="1" opacity="0.7" />
          <path d="M4.2 9.8 9.8 4.2" stroke={c} strokeWidth="1" strokeLinecap="round" opacity="0.7" />
        </>
      ) : status === "running" ? (
        <>
          <circle cx="7" cy="7" r="5.4" fill="none" stroke={c} strokeWidth="1.4" />
          {/* 半分だけ埋まったパイ（進行中） */}
          <path d="M7 3.4 A3.6 3.6 0 0 1 7 10.6 Z" fill={c} />
        </>
      ) : status === "unplanned" ? (
        // Linear の Backlog と同じ破線円（やり方未定）
        <circle
          cx="7"
          cy="7"
          r="5.4"
          fill="none"
          stroke={c}
          strokeWidth="1.4"
          strokeDasharray="2.2 2.2"
        />
      ) : status === "waiting" ? (
        <>
          <circle cx="7" cy="7" r="5.4" fill="none" stroke={c} strokeWidth="1.4" />
          <circle cx="7" cy="7" r="2" fill={c} />
        </>
      ) : (
        <circle cx="7" cy="7" r="5.4" fill="none" stroke={c} strokeWidth="1.4" />
      )}
    </svg>
  );
  if (!hint) return circle;
  return (
    <Hint id="status-legend" always={`状態: ${label}`} text={HINT_TEXT.statusLegend}>
      {circle}
    </Hint>
  );
}
