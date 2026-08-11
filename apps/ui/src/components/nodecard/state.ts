// カードの「状態 → 表示」の導出（NodeCard から切り出し）。描画も API 呼び出しも持たない純関数で、
// 3つの見え方——素のノード / テンプレート（ラン投影あり・なし）/ ランのページ——の違いを
// ここ1箇所に集める。カード本体はこの結果を並べるだけにする。
import type { NodePatchInput } from "../../lib/api";
import type { RunItemStatus, Status } from "../../types";
import type { NodeCardData } from "./types";

/** ラン投影中の段階式アクション（着手/完了/戻す）。ランのアイテムを更新する */
export interface RunButton {
  label: string;
  status: RunItemStatus;
}
/** カード下部の1個だけ出る計画/進捗ボタン（テンプレートの patchNode を打つ） */
export interface PhaseAction {
  label: string;
  patch: NodePatchInput;
}

export interface CardState {
  /** ラン投影中（テンプレートにアクティブなランのワークアイテムを重ねている） */
  projecting: boolean;
  visualStatus: Status;
  /** 見た目に status を反映してよいか（非テンプレート、または投影中のテンプレート） */
  showStatus: boolean;
  /** 決着済み（完了・中止・スキップ）で薄くする見た目か */
  dimmed: boolean;
  /** 「未計画」の文字を出すか */
  showFoot: boolean;
  runButtons: RunButton[];
  phaseAction: PhaseAction | null;
  /** 「計画済みにする」の逆操作。null = 出さない */
  unplanPatch: NodePatchInput | null;
  /** トリガーの「ラン作成」を出せるか（カードの▶とメニューの「ラン」で共有） */
  canRun: boolean;
  /** 「あなたの番」の右肩ドットを出すか */
  showTurn: boolean;
}

export function deriveCardState(data: NodeCardData): CardState {
  const { node, isTemplate, runItem } = data;
  // ラン投影（docs/design.md 3.8）: テンプレート自身は status を持たないが、アクティブな
  // ラン（status==="running" の最新1本）がある間だけ、そのワークアイテムの進捗を
  // カードへ投影する（プロジェクトと同じ見た目・同じ操作にする）。ランが閉じたら
  // （runItem が無くなったら）素のテンプレート表示に戻る
  const projecting = !!(isTemplate && runItem);
  // 保険: 質問が開いている（pendingRequest あり）間は、status が何であれ「あなたの番」を
  // 優先して実行中アニメーション/スピナーを出さない（waiting は本来 pendingRequest から
  // 導出できる派生状態。docs/design.md ステータス注記）。status との食い違いは旧プロセスの
  // 取り残し等で起こり得るため、見た目はこちらを正とする（2026-07-31 本人指摘）。
  // 投影中はランアイテムの status をそのまま使う（ランアイテムに pendingRequest 概念はない）
  const visualStatus: Status = projecting ? runItem.status : node.pendingRequest ? "waiting" : node.status;
  const showStatus = !isTemplate || projecting;
  const dimmed =
    showStatus && (visualStatus === "done" || visualStatus === "dropped" || visualStatus === "skipped");

  // 人間に名前で見せる状態は「未計画」だけ（2026-07-31 本人方針: 人間の語彙は未計画かdoneかだけ。
  // 実行中=スピナー/回答待ち=橙ドット/完了=チェック/スキップ=斜線円と、他は絵で伝わっている）
  const showFoot = !isTemplate && node.status === "unplanned";

  // ラン内の段階式アクション（docs/design.md 3.8）: 担当が human の task アイテムだけ
  // （分岐(decision)は「分岐を選ぶ」が唯一の決着経路。choice を経ずに done にしない）。
  // pending+ラン内フロンティア→「着手」「完了」、running→「完了」「戻す」（戻す=pending）。
  // ボタンはランのアイテムを更新する（テンプレートの patchNode は使わない）
  const runButtons: RunButton[] =
    projecting && node.executor === "human" && node.kind === "task"
      ? // waiting = エンジンが「あなたの番」へ上げた状態（2026-08-08）。pending と同じ操作を出す
        (runItem.status === "pending" || runItem.status === "waiting") && data.isRunFrontier
        ? [
            { label: "着手", status: "running" },
            { label: "完了", status: "done" },
          ]
        : runItem.status === "running"
          ? [
              { label: "完了", status: "done" },
              { label: "戻す", status: "pending" },
            ]
          : []
      : [];

  // 「プラン済みにする」は進捗ではなく計画（lifecycle）の操作なので、テンプレートでも
  // 順番未到達（frontier前）でも出す（committed でないノードはエンジンが実行しないため、
  // 確定の導線が無いと詰む。2026-08-01 本人指摘）。「完了」は実行フェーズの操作なので
  // 従来どおり非テンプレート・frontier・task のみ
  const canCommit = node.status === "unplanned" || node.lifecycle === "draft";
  const phaseAction: PhaseAction | null = data.inRunPage
    ? null // ランのページではテンプレートの計画操作を出さない（2026-08-08）
    : node.kind === "trigger" && node.lifecycle === "draft"
      ? { label: "計画済みにする", patch: { lifecycle: "committed" } }
      : node.kind !== "trigger" && canCommit
        ? { label: "計画済みにする", patch: { status: "pending", lifecycle: "committed" } }
        : !isTemplate && data.isFrontier && node.kind === "task" && node.status === "pending"
          ? { label: "完了", patch: { status: "done" } }
          : null;

  // 「計画済みにする」の逆操作（NodePanel の status-unplan と同じ patch）。カードにボタンは
  // 無いが、計画の語彙として対が無いと行き止まりになるのでメニューには出す。
  // ラン投影中/ランのページでは出さない——実行中のランの進捗操作と混ざるため
  const unplanPatch: NodePatchInput | null = data.inRunPage
    ? null
    : node.kind === "trigger"
      ? node.lifecycle === "committed"
        ? { lifecycle: "draft" }
        : null
      : isTemplate
        ? node.lifecycle === "committed" && node.status !== "unplanned" && !projecting
          ? { status: "unplanned", lifecycle: "draft" }
          : null
        : node.status === "pending"
          ? { status: "unplanned" }
          : null;

  // トリガーの「ラン作成」（カードの▶と同じハンドラ）。ラン表示中は▶と同じく出さない
  const canRun = node.kind === "trigger" && !projecting && !data.inRunPage;

  // 「あなたの番」の右肩ドット。非テンプレートは pendingRequest、投影中はランアイテムの
  // waiting をそのまま使う（ランアイテムに pendingRequest 概念はない。docs/design.md 3.8）
  const showTurn = !!((!isTemplate && node.pendingRequest) || (projecting && visualStatus === "waiting"));

  return {
    projecting,
    visualStatus,
    showStatus,
    dimmed,
    showFoot,
    runButtons,
    phaseAction,
    unplanPatch,
    canRun,
    showTurn,
  };
}
