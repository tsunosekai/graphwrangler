// 左レールのドット（ちょぼ）の規則: ノード1つ = 点1つ。並び順（席）と色と説明文。
// 色ルールの正文は 2026-08-08 本人指定——色は常に担当(executor)の色、唯一の例外が
// 「あなたの番」= 橙。終わったノード（完了・中止・スキップ）は色を変えず**薄く**する。
// ページ行（テンプレート構成）とラン子行（ラン進捗）が同じ規則を共有するので、
// 描画（PageList）から純粋な判定だけをここへ置く。
import type { Node, Status } from "../types";

/** ドットの「席」（並び順の判定用）。決着済みは末尾へ沈める */
export type Seat = "attention" | "human" | "ai" | "script" | "done";
export function seatOf(status: Status, executor: Node["executor"]): Seat {
  if (status === "done" || status === "dropped" || status === "skipped") return "done";
  if (status === "waiting") return "attention";
  return executor;
}
/** 点の色は常に担当(executor)の色。唯一の例外が「あなたの番」= 橙（--attention。
 *  カード右肩の橙点と同じ）。終わったノードは色を塗り替えず、薄く（isSettled → opacity）する
 *  （2026-08-08 本人指定の色ルール明確化。旧: done/dropped 専用の沈み色に塗り替えていて、
 *  何の担当だったかが点から消えていた） */
export function seatColor(status: Status, executor: Node["executor"]): string {
  if (status === "waiting") return "var(--attention)";
  return executor === "human" ? "var(--human)" : executor === "ai" ? "var(--ai)" : "var(--script)";
}
export const isSettled = (st: Status) => st === "done" || st === "dropped" || st === "skipped";
// 目に入るべき順: あなたの番 → 人間の席 → AI → スクリプト → 完了系
export const SEAT_ORDER: Seat[] = ["attention", "human", "ai", "script", "done"];
/** ドットの共通ヒント文。色ルールの正文はここ */
export const DOTS_HINT =
  "ノード1つ=点1つ。色は担当の色（黄緑=人間 青=AI 灰=スクリプト）で、橙=あなたの番だけ例外。薄い点=完了・中止・スキップ";

/** ドット1粒。dim = 終わったノード（色は担当色のまま薄くする） */
export interface Dot {
  key: string;
  title: string;
  color: string;
  dim: boolean;
}
