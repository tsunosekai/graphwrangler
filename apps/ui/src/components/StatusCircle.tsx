// Linear 風のステータスサークル（backlog/todo/in-progress/done の円形インジケータの系譜）。
// pending=空円 / running=半分埋まったリング / waiting=中点付き円 / done=塗り円+チェック / dropped=×円
import type { Status } from "../types";

const COLOR: Record<Status, string> = {
  unplanned: "var(--text-lo)",
  pending: "var(--text-lo)",
  running: "var(--ai)",
  waiting: "var(--human)",
  done: "var(--ok)",
  dropped: "var(--text-lo)",
};

export function StatusCircle({ status, size = 14 }: { status: Status; size?: number }) {
  const c = COLOR[status];
  return (
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
            stroke="var(--bg)"
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
}
