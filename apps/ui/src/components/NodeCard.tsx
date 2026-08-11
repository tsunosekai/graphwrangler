// グラフのノード1枚（React Flow の nodeType）。カードは「いまどう見えるか」を state.ts の
// 導出に任せ、ここは骨格（枠・ハンドル・各パーツの配置）と、押されたときに打つ API だけを持つ。
// 中身は components/nodecard/ に分けてある:
// - types.ts        NodeCardData / NodeMenuActions（GraphView・useNodeMenu との契約。下で re-export）
// - state.ts        状態 → 表示の導出（投影中か・何色か・どのボタンを出すか）
// - CardHead.tsx    上段（担当・種別・タイトル・impl/⚠/未読）
// - badges.tsx      外周の印（完了/処理中・▶・Fix・あなたの番）
// - BottomPorts.tsx 下辺の出力（分岐の枝ポート or 単一ハンドル）
// - NodeMenu.tsx    右クリックメニュー（第0層）
import { useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { describeSchedule, parseSchedule } from "@graphwrangler/core/schedule";
import { api } from "../lib/api";
import { runTrigger } from "../lib/run";
import { HINT_TEXT } from "../lib/hints";
import { STATUS_JA } from "../lib/labels";
import { cn } from "../lib/utils";
import type { RunItemStatus } from "../types";
import { Hint } from "./Hint";
import { SideBadges, StatusBadge, TurnDot } from "./nodecard/badges";
import { BottomPorts } from "./nodecard/BottomPorts";
import { CardHead } from "./nodecard/CardHead";
import { NodeMenu } from "./nodecard/NodeMenu";
import { deriveCardState } from "./nodecard/state";
import type { NodeCardData } from "./nodecard/types";

// 呼び出し側（GraphView / hooks/useNodeMenu）は従来どおりここから型を取れる
export type { NodeCardData, NodeMenuActions } from "./nodecard/types";

// selected は React Flow が rfNode.selected から自動で渡す（複数選択・矩形選択の見た目用）。
// data.selected は App が追跡する「主選択」1件のための既存フラグ。どちらか点灯でリングを出す
export function NodeCard({ data, selected }: { data: NodeCardData; selected?: boolean }) {
  const { node, runItem } = data;
  const [firing, setFiring] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const ringOn = data.selected || selected;
  const {
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
  } = deriveCardState(data);

  const patchRunItemStatus = async (status: RunItemStatus) => {
    if (!runItem || runBusy) return;
    setRunBusy(true);
    try {
      await api.patchRunItem(runItem.runId, node.id, { status });
    } catch {
      // api() 側でトースト表示済み
    } finally {
      setRunBusy(false);
    }
  };

  // トリガー手動でランを作る操作（human executor はこれが唯一のラン作成経路。script/aiは手動上書きとして使える。
  // docs/design.md 3.8「human = 手動でランを作る操作（トリガー上の▶）」）。
  // フォーム・確認文・トーストは lib/run.ts が一箇所で持つ（左レールの「ラン作成」・台帳の
  // 開始ボタンと同じもの）。ここは▶の多重押し防止と、生まれたランへの移動だけを持つ
  const createRun = async () => {
    if (firing) return;
    setFiring(true);
    try {
      const run = await runTrigger(node, {
        runningRunCount: data.runningRunCount,
        lastRunContext: data.lastRunContext,
      });
      if (run) data.onRunStarted?.(run.id); // 生まれたランのページへ移る
    } finally {
      setFiring(false);
    }
  };

  // カードのボタンと右クリックメニューで同じ処理を呼ぶための切り出し（挙動の二重管理を避ける）
  const applyPhaseAction = async () => {
    if (phaseAction) await api.patchNode(node.id, phaseAction.patch);
  };
  const toggleFixed = async () => {
    await api.patchNode(node.id, { fixed: !node.fixed });
  };

  // ---- 右クリックメニュー（第0層）へ渡す材料 ----
  const menu = data.menu;
  // ランのページ（記録）ではテンプレートを書き換える項目を出さない（2026-08-08 のフォーク）
  const canEditTemplate = !data.inRunPage;
  // 進捗: カードのボタンと同じ語彙・同じハンドラ。分岐(decision)に実行系（着手/完了/戻す）が
  // 出ないのは phaseAction / runButtons の条件（kind==="task"）がそのまま担保する
  // （docs/design.md 3.9「決着経路は分岐を選ぶのみ」。計画系は NodePanel と同じく残す）
  const progressItems: { label: string; run: () => void }[] = [];
  if (phaseAction) progressItems.push({ label: phaseAction.label, run: () => void applyPhaseAction() });
  for (const b of runButtons)
    progressItems.push({ label: b.label, run: () => void patchRunItemStatus(b.status) });
  if (unplanPatch) {
    progressItems.push({ label: "未計画に戻す", run: () => void api.patchNode(node.id, unplanPatch) });
  }
  const descendants = menu ? menu.descendantCount(node.id) : 0;

  const card = (
    <div
      className={cn(
        // marker クラス（exec-*/status-*/lifecycle-*）は index.css のパルスアニメーション・
        // 下書きの粗い破線背景に使う。見た目の大半は Tailwind ユーティリティで組む
        // 枠の濃さは破線（draft）時代の明るい方に統一（本人指定）。hover での色変化は
        // ベースが既に strong なので廃止
        "node-card relative w-[220px] rounded-md border border-border-strong bg-card p-3 shadow-xs transition-colors",
        `exec-${node.executor}`,
        `lifecycle-${node.lifecycle}`,
        showStatus && `status-${visualStatus}`,
        dimmed && "opacity-90",
        ringOn && "is-selected border-border-strong shadow-[0_0_0_1px_var(--border-strong)]",
      )}
      onClick={() => data.onSelect(node.id)}
      // Fix済み（やり方確定）のノードはタイトルのダブルクリック編集も無効にする
      // （docs/design.md 3.5 実効化。編集してもサーバの409で弾かれるが、UI側でも入口を塞ぐ）
      onDoubleClick={() => {
        if (!node.fixed) data.onDoubleClick(node.id);
      }}
    >
      {/* 担当の丸タブ（本人選定 2026-07-31: 帯(A)は「ダサい」→ 形案2へ変更）:
          左辺中央の小さな舌片。色は exec-* クラスの --active-color を継承 */}
      <span
        aria-hidden
        className="pointer-events-none absolute -left-[3px] top-1/2 h-[22px] w-[6px] -translate-y-1/2 rounded-[4px]"
        style={{ background: "var(--active-color)" }}
      />
      {/* trigger は parents を持てない=グラフの起点（docs/design.md 3.4）。
          入力ハンドルを構造的に持たせないことで、他ノードの後続へドラッグ接続できないようにする */}
      {node.kind !== "trigger" && <Handle type="target" position={Position.Top} />}
      {/* 完了/中止/処理中のバッジ。テンプレートには出さない——ただしアクティブなランの
          投影中は item.status で描く（docs/design.md 3.8） */}
      {showStatus && <StatusBadge visualStatus={visualStatus} />}
      <SideBadges
        node={node}
        projecting={projecting}
        firing={firing}
        onCreateRun={() => void createRun()}
        onToggleFixed={toggleFixed}
      />
      {showTurn && <TurnDot node={node} />}
      <CardHead data={data} dimmed={dimmed} />
      {(showFoot || phaseAction || runButtons.length > 0) && (
        <div className="mt-1.5 flex items-center gap-2">
          {showFoot && <span className="text-xs text-muted-foreground">{STATUS_JA[node.status]}</span>}
          {phaseAction && (
            <Hint
              id="commit-plan"
              // 「完了」ボタンのときは text なし=ヒント自体を出さない（自明）
              text={phaseAction.label === "計画済みにする" ? HINT_TEXT.commitPlan : undefined}
            >
              <button
                type="button"
                className="nodrag rounded-sm border border-border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
                onClick={async (e) => {
                  e.stopPropagation();
                  await applyPhaseAction();
                }}
              >
                {phaseAction.label}
              </button>
            </Hint>
          )}
          {/* ラン投影の段階ボタン（docs/design.md 3.8）。担当が human のワークアイテムのみ。
              テンプレートの patchNode ではなく、ランのアイテムを更新する（api.patchRunItem） */}
          {runButtons.map((b) => (
            <button
              key={b.label}
              type="button"
              className="nodrag rounded-sm border border-border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-40"
              disabled={runBusy}
              onClick={async (e) => {
                e.stopPropagation();
                await patchRunItemStatus(b.status);
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
      {/* トリガーの起動方式（docs/design.md 3.8）。script=cron的なランを作る条件、ai=ラン作成要否を判定させる間隔。
          human はここには何も出さない（▶ボタンが唯一のラン作成経路のため） */}
      {node.kind === "trigger" && node.executor === "script" && (
        <div className="mt-1.5 text-xs">
          {node.schedule ? (
            <Hint
              id="schedule"
              text="スクリプト・トリガーの自動開始条件。パネルの起動方式欄（間隔ごと / 毎日 / 毎週 / cron式）で変更する"
            >
              {/* 読み下し（describeSchedule）を優先。解釈できない値は原文を赤で出す
                  （エンジンが無視する＝自動で動かないトリガーであることを示す。3.8 の schedule 警告と同旨） */}
              {describeSchedule(node.schedule) ? (
                <span className="text-muted-foreground">{describeSchedule(node.schedule)}</span>
              ) : (
                <span className="text-destructive">{node.schedule}（解釈不能）</span>
              )}
            </Hint>
          ) : (
            <Hint
              id="schedule"
              text="設定するまで手動▶でしか開始しない。パネルの起動方式欄（間隔ごと / 毎日 / 毎週 / cron式）で設定する"
            >
              <span className="text-destructive">起動条件が未設定</span>
            </Hint>
          )}
        </div>
      )}
      {node.kind === "trigger" && node.executor === "ai" && (
        <Hint
          id="schedule"
          text="AIに開始要否を判定させる間隔（every のみ解釈、無指定は1時間）。開始の条件自体は概要や手順書に書く"
        >
          <div className="mt-1.5 text-xs text-muted-foreground">
            {/* AIトリガーは every（間隔）だけ解釈する（3.8）。それ以外が書いてあっても
                エンジンは既定1時間で動くので、見た目もそれに合わせる */}
            チェック間隔:{" "}
            {node.schedule && parseSchedule(node.schedule)?.type === "every"
              ? describeSchedule(node.schedule)
              : "1時間ごと（既定）"}
          </div>
        </Hint>
      )}
      <BottomPorts node={node} />
    </div>
  );

  if (!menu) return card;

  return (
    <NodeMenu
      node={node}
      menu={menu}
      progressItems={progressItems}
      canRun={canRun}
      canEditTemplate={canEditTemplate}
      descendants={descendants}
      onCreateRun={() => void createRun()}
      onToggleFixed={() => void toggleFixed()}
    >
      {card}
    </NodeMenu>
  );
}
