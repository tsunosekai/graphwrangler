// 画面に出る日本語ラベルの唯一の正（2026-08-11 集約）。
// 担当（executor）・進捗（status）・種別（kind）は複数の画面（カード／パネル／一括／レール）で
// 同じ語彙を出す。各所に同じマップを置くと必ず片方だけ直されて表記ゆれになるため、
// ここを唯一の出どころにする（RunStatusIcon の RUN_STATUS_JA と同じ流儀）。
import type { Executor, NodeKind, Status } from "../types";

/** 担当（docs/design.md 3.5）。値の並びは human → ai → script（Object.keys で選択肢を作る側が居る） */
export const EXECUTOR_JA: Record<Executor, string> = {
  human: "人間",
  ai: "AI",
  script: "スクリプト",
};

/** 進捗の人間向け語彙（docs/design.md 3.9「未計画 →[プラン済みにする]→ 待ち →[着手]→ 進行中 →[完了]」）。
 *  waiting は保存値でなく導出値（pendingRequest あり / ランアイテムの waiting） */
export const STATUS_JA: Record<Status, string> = {
  unplanned: "未計画",
  pending: "待ち",
  running: "進行中",
  waiting: "あなたの番（回答待ち）",
  done: "完了",
  dropped: "中止",
  skipped: "スキップ",
};

/** 種別。goal / folder はノードカードとしては描かれないが型のため網羅
 *  （2026-08-08 本人指摘「タスクとノードの表記ゆれ」で task=「実行」に統一済み） */
export const KIND_JA: Record<NodeKind, string> = {
  task: "実行",
  decision: "判断",
  trigger: "トリガー",
  goal: "プロジェクト/ルーティーン（ページ）",
  folder: "フォルダ",
};
