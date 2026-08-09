// ランの状態（実行中 / 完了 / 中止）の絵。左レールのラン行とグラフ上部のラン選択セレクタで
// 共有する（2026-08-08 本人指摘「上部セレクタのアイコンも▶になってるからそろえて」。
// 同じものを2箇所で別々に書くと必ず乖離するため、ここを唯一の出どころにする）。
//
// 実行中はノードのランボタンと同じ lucide Play。色は付けない——3つとも同じ濃さで、
// 違いは絵で見せる（旧: 実行中だけ青い「▶」の文字）。
import { Check, Play, X } from "lucide-react";
import { cn } from "../lib/utils";
import type { RunStatus } from "../types";

export const RUN_STATUS_JA: Record<RunStatus, string> = {
  running: "実行中",
  done: "完了",
  cancelled: "中止",
};

export function RunStatusIcon({ status, className }: { status: RunStatus; className?: string }) {
  const I = status === "running" ? Play : status === "done" ? Check : X;
  return (
    <span className={cn("inline-flex flex-shrink-0 opacity-70", className)} title={RUN_STATUS_JA[status]}>
      <I className="size-3" />
    </span>
  );
}
