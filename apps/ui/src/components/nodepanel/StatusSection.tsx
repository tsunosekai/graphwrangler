// 進捗・計画（lifecycle）操作の節。NodePanel のメタグリッド（grid-cols-2）内に
// col-span-2 の行として並ぶ（トリガーの確定/取り消し・テンプレートのプラン化・
// ラン投影の進捗・プロジェクトの進捗ボタン。docs/design.md 3.8 / 3.9）
import { useState } from "react";
import { api, type NodePatchInput } from "../../lib/api";
import { optimisticPatchRunItem } from "../../lib/optimistic";
import { formDialog } from "../../lib/dialogs";
import { HINT_TEXT } from "../../lib/hints";
import { STATUS_JA } from "../../lib/labels";
import { displayNameOf, turnIsMine, useTeam } from "../../lib/team";
import type { Node, Run, RunItem, RunItemStatus } from "../../types";
import { Button } from "../ui/button";
import { Hint } from "../Hint";
import { StatusCircle } from "../StatusCircle";

// 進捗ラベルのヒント（プロジェクトの進捗とラン投影の進捗、2箇所で同じ id="status" を使う）
const STATUS_HINT =
  "未計画=やり方が決まっていない（エンジンは実行しない）。計画済みにすると待ちになり、前のノードが終わると着手できる。スキップ=分岐で選ばれなかった枝";
// 進捗はドロップダウンでなくボタン遷移（2026-07-31 本人指定）。
// 人間の語彙: 未計画 →[プラン済みにする]→ 待ち →[着手]→ 進行中 →[完了]。
// 待ち/進行中は人間ノードでは「やってるかどうかの目印」、AI/スクリプトでは機械が動かす。
// 中止(dropped)は選択肢から廃止（消すならノード削除。Ctrl+Zで戻せる）。
// waiting は保存値でなく導出値（pendingRequest あり / ランアイテムの waiting）。
// 進捗の日本語（STATUS_JA）は lib/labels.ts が唯一の正

interface Props {
  node: Node;
  activeRun: Run | null;
  activeRunItem: RunItem | null;
  runView: { id: string; title: string } | null;
  /** ページ（group）がトリガーを持つか（ルーティーン配下＝進捗はラン側。NodePanel が一度だけ導出） */
  pageHasTrigger: boolean;
  /** 全 parents が done|skipped（実行フェーズの原則 docs/design.md 3.9。NodePanel が一度だけ導出） */
  isFrontier: boolean;
  patch: (fields: NodePatchInput) => Promise<void>;
  onMutated: () => void;
  /** 昇格時警告（試走ゲート）。担当=script のプラン済み化の前に確認する */
  confirmPromotionIfNeeded: () => Promise<boolean>;
}

export function StatusSection({
  node,
  activeRun,
  activeRunItem,
  runView,
  pageHasTrigger,
  isFrontier,
  patch,
  onMutated,
  confirmPromotionIfNeeded,
}: Props) {
  const { me, users } = useTeam();
  // 「あなたの番」（waiting）が自分の番か（assignee が他人なら橙にしない。lib/team.ts で一元化）
  const turnMine = turnIsMine(node.assignee, me.email);

  // ラン内フロンティア: 親の「ランのアイテム」が全部 done|skipped か（親がトリガー等でランに
  // アイテムを持たない場合は「既に作成済み」として満たしている扱い。GraphView と同じ規則）
  const runFrontier = !!(
    activeRun &&
    node.parents.every((pid) => {
      const st = activeRun.items[pid]?.status;
      return st === undefined || st === "done" || st === "skipped";
    })
  );
  const [runItemBusy, setRunItemBusy] = useState(false);
  // 楽観更新（lib/optimistic.ts）: 押した瞬間に画面が変わる（グラフのカード左バッジの
  // ご褒美演出は NodeCard が遷移を検知して出す——ここから押しても同じに見える）
  const patchRunItemStatus = async (status: RunItemStatus) => {
    if (!activeRun || runItemBusy) return;
    setRunItemBusy(true);
    try {
      await optimisticPatchRunItem(activeRun.id, node.id, status);
      onMutated();
    } catch {
      // api() 側でトースト表示済み
    } finally {
      setRunItemBusy(false);
    }
  };

  // human ノードの完了ミニフォーム（docs/design.md 3.15 実行時の書き）: outputs 宣言のある
  // 担当=human のアイテムを**パネルから**完了するとき、宣言キーの任意入力欄を出す。
  // **必須にしない**（スキップ可＝全部空のまま完了できる。完了経路は台帳セル・カード・MCP と
  // 複数あり、全部に差し込むとワンクリック完了を壊すため、出すのはこの経路だけ）。
  // 入力があれば先に POST /runs/:id/context（nodeId 付き＝更新記録はこのノードのスレッドへ）
  const completeRunItem = async () => {
    if (activeRun && node.executor === "human" && (node.outputs?.length ?? 0) > 0) {
      const res = await formDialog(
        "完了します。ランに値を書き足しますか？（任意。空のままでも完了できます）",
        { fields: node.outputs!, confirmLabel: "完了" },
      );
      if (res === null) return; // キャンセル = 完了しない
      if (Object.keys(res.values).length > 0) {
        try {
          await api.patchRunContext(activeRun.id, res.values, { nodeId: node.id });
        } catch {
          return; // トーストは api() 側。コンテキストが書けなかったら完了も進めない
        }
      }
    }
    await patchRunItemStatus("done");
  };

  return (
    <>
      {/* トリガーに進捗はない（docs/design.md 3.8。ラン作成はあってもステータス遷移という概念が無い）。
          質問が開いている（pendingRequest あり）間は status が何であれ「あなたの番」を優先して
          描き、進捗ボタンも出さない（NodeCard の visualStatus / PageList の effStatus と同じ保険。
          回答は上の判断カードから行う） */}
      {/* トリガーは進捗を持たないが lifecycle は持つ。下書きの間だけ確定導線を出す
          （2026-07-31 本人報告「トリガーをプラン済みにする方法がUIに無い」） */}
      {!runView && node.kind === "trigger" && node.lifecycle === "draft" && (
        <div className="col-span-2 flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">下書き（未確定）</span>
          <span className="flex-1" />
          <Hint id="commit-plan" text={HINT_TEXT.commitPlan}>
            <Button type="button" variant="outline" size="sm" className="active:scale-95"
              onClick={() => void patch({ lifecycle: "committed" })}>
              計画済みにする
            </Button>
          </Hint>
        </div>
      )}
      {/* トリガーのプラン取り消し（2026-08-06 本人要望「ルーティーンも未計画に戻せるように」）。
          task と違い status ではなく lifecycle を draft へ戻す——エンジンのラン作成の判定
          （engine の isRunnableTrigger）は committed のトリガーだけを拾うので、
          トリガーにとっての「未計画」は draft。手動▶（POST /fire）は draft でも通るため、
          自動のラン作成だけが止まる */}
      {node.kind === "trigger" && node.lifecycle === "committed" && (
        <div className="col-span-2 flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">計画済み</span>
          <span className="flex-1" />
          <Hint
            id="status-unplan"
            text="計画を取り消して未計画に戻す（自動開始が止まる。手動の▶はそのまま使える）"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => patch({ lifecycle: "draft" })}
            >
              未計画に戻す
            </Button>
          </Hint>
        </div>
      )}
      {/* ルーティーン（トリガーを持つページ）のメンバーはテンプレート＝それ自体は進捗を持たない
          （docs/design.md 3.8。データモデルは不変——状態はラン側のみ）。ただし**アクティブな
          ラン（status==="running"の最新1本）がある間だけ**、その進捗をプロジェクトと
          同じ見た目・同じ操作で投影する（2026-07-31 本人合意）。ランが無ければ従来の注記のまま
          （2026-07-31 本人質問「実行後も待ちのまま」対応） */}
      {/* ルーティーンのテンプレートでも「プラン済みにする」は出す——これは進捗ではなく
          計画（lifecycle）の操作で、committed でないテンプレートはエンジンが実行しない
          （2026-08-01 本人指摘「プラン済みにするボタンがないノードがある」） */}
      {!runView &&
        node.kind !== "trigger" &&
        pageHasTrigger &&
        (node.lifecycle === "draft" || node.status === "unplanned") && (
          <div className="col-span-2 flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              {node.lifecycle === "draft" ? "下書き（未確定）" : "未計画"}
            </span>
            <span className="flex-1" />
            <Hint id="commit-plan" text={HINT_TEXT.commitPlan}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="active:scale-95"
                onClick={async () => {
                  if (node.executor === "script" && !(await confirmPromotionIfNeeded())) return;
                  void patch({ status: "pending", lifecycle: "committed" });
                }}
              >
                計画済みにする
              </Button>
            </Hint>
          </div>
        )}
      {/* テンプレートのプラン取り消し（2026-08-07 本人要望「未プランに戻すボタンを追加」。
          トリガー版 2026-08-06 と同じ流儀で lifecycle を draft へ戻す）。ラン投影中は
          出さない——実行中のランの進捗操作と混ざるため */}
      {!runView &&
        node.kind !== "trigger" &&
        pageHasTrigger &&
        node.lifecycle === "committed" &&
        node.status !== "unplanned" &&
        !activeRunItem && (
          <div className="col-span-2 flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">計画済み</span>
            <span className="flex-1" />
            <Hint
              id="status-unplan"
              text="計画を取り消して未計画（下書き）に戻す（エンジンの実行対象から外す）"
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => patch({ status: "unplanned", lifecycle: "draft" })}
              >
                未計画に戻す
              </Button>
            </Hint>
          </div>
        )}
      {node.kind !== "trigger" &&
        pageHasTrigger &&
        (activeRunItem ? (
          <div className="col-span-2 flex flex-wrap items-center gap-2 text-sm">
            <Hint
              id="status"
              text={`${STATUS_HINT}。ここの進捗はテンプレートではなく実行中のランのもの`}
            >
              <span className="text-muted-foreground">進捗（実行中のラン）:</span>
            </Hint>
            <span className="inline-flex items-center gap-1.5">
              {/* waiting でも assignee が他人なら橙にせず「誰の番か」を名前で見せる
                  （チーム化 2026-08-04。プロジェクト側の進捗表示と同じ描き分け） */}
              <StatusCircle status={activeRunItem.status} mine={turnMine} />
              {activeRunItem.status === "waiting" && !turnMine && node.assignee
                ? `${displayNameOf(node.assignee, users)}の番（回答待ち）`
                : STATUS_JA[activeRunItem.status]}
            </span>
            {/* waiting の理由（失敗: … / 承認待ち / 分岐待ち）を見せる。台帳の丸だけでは
                何が起きたか分からない（2026-08-01 手戻りレビュー） */}
            {activeRunItem.status === "waiting" && activeRunItem.note && (
              <span
                className="max-w-full truncate text-xs text-muted-foreground"
                title={activeRunItem.note}
              >
                {activeRunItem.note}
              </span>
            )}
            <span className="flex-1" />
            {/* AI/スクリプトの実行失敗（note が「失敗:」）は放置すると行き止まりになる
                （エンジンは waiting を拾わない）ため、リトライ/見送りの導線をここに置く。
                承認待ち・分岐待ちは判断カードが往復を担うので出さない */}
            {activeRunItem.status === "waiting" && activeRunItem.note?.startsWith("失敗") && (
              <>
                <Hint id="run-retry" text="待ちに戻して、エンジンにもう一度実行させる">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={runItemBusy}
                    onClick={() => patchRunItemStatus("pending")}
                  >
                    もう一度
                  </Button>
                </Hint>
                <Hint id="run-skip" text="このランではこのステップを見送る（テンプレートは変えない）">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={runItemBusy}
                    onClick={() => patchRunItemStatus("skipped")}
                  >
                    このランでは飛ばす
                  </Button>
                </Hint>
              </>
            )}
            {/* 分岐(decision)のアイテムは「分岐を選ぶ」で決着する（choice を経ずに done に
                できてしまう二重経路を作らない）。着手/完了は担当=人間の task のみ */}
            {node.executor === "human" && node.kind === "task" && activeRunItem.status === "pending" && !runFrontier && (
              <span className="text-xs text-text-lo">前のノードが終わると着手できます</span>
            )}
            {node.executor === "human" && node.kind === "task" &&
              (activeRunItem.status === "pending" || activeRunItem.status === "waiting") && runFrontier && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="active:scale-95"
                disabled={runItemBusy}
                onClick={() => patchRunItemStatus("running")}
              >
                着手
              </Button>
            )}
            {node.executor === "human" && node.kind === "task" &&
              (((activeRunItem.status === "pending" || activeRunItem.status === "waiting") && runFrontier) ||
                activeRunItem.status === "running") && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="active:scale-95"
                  disabled={runItemBusy}
                  // outputs 宣言があれば完了ミニフォーム（任意入力）を経由する（3.15）
                  onClick={() => void completeRunItem()}
                >
                  完了
                </Button>
              )}
            {node.executor === "human" && node.kind === "task" && activeRunItem.status === "running" && (
              <Hint id="status-back" text="着手前（待ち）に戻す">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={runItemBusy}
                  onClick={() => patchRunItemStatus("pending")}
                >
                  戻す
                </Button>
              </Hint>
            )}
          </div>
        ) : (
          <p className="col-span-2 text-xs text-text-lo">テンプレート（進捗はランごと。実行一覧で見る）</p>
        ))}
      {node.kind !== "trigger" &&
        !pageHasTrigger &&
        (() => {
          const vs = node.pendingRequest ? ("waiting" as const) : node.status;
          // 実行フェーズの原則（docs/design.md 3.9）: 前へ進める操作（着手・完了）は
          // 順番が来ている（親が全部 done|skipped）ノードだけ。プラン済み化（計画系）と
          // 戻す（修復系）はいつでも可（2026-07-31 本人報告のバグ修正）。
          // 分岐(decision)は「分岐を選ぶ」が唯一の決着経路なので、実行系ボタン
          // （着手/完了/戻す）は出さない——プラン済み化だけ残す（committed が選択の前提条件）
          const exec = node.kind !== "decision";
          const frontier = isFrontier;
          return (
            <div className="col-span-2 flex items-center gap-2 text-sm">
              <Hint id="status" text={STATUS_HINT}>
                <span className="text-muted-foreground">進捗:</span>
              </Hint>
              <span className="inline-flex items-center gap-1.5">
                {/* waiting でも assignee が他人なら橙にせず「誰の番か」を名前で見せる
                    （チーム化 2026-08-04。判定は lib/team.ts の turnIsMine） */}
                <StatusCircle status={vs} mine={turnMine} />
                {vs === "waiting" && !turnMine && node.assignee
                  ? `${displayNameOf(node.assignee, users)}の番（回答待ち）`
                  : STATUS_JA[vs]}
              </span>
              <span className="flex-1" />
              {(vs === "unplanned" || node.lifecycle === "draft") && (
                <Hint id="commit-plan" text={HINT_TEXT.commitPlan}>
                  <Button type="button" variant="outline" size="sm" className="active:scale-95"
                    onClick={async () => {
                      if (node.executor === "script" && !(await confirmPromotionIfNeeded())) return;
                      void patch({ status: "pending", lifecycle: "committed" });
                    }}>
                    計画済みにする
                  </Button>
                </Hint>
              )}
              {/* プラン済みの取り消し（計画系なので decision でも frontier 前でも出す。
                  2026-08-01 本人要望「プラン済みを未プランに戻す方法が無い」）。
                  status だけ unplanned に戻す——lifecycle は committed のまま残しても
                  エンジンは unplanned を拾わないため安全で、「プラン済みにする」が
                  再表示されて行き止まりにならない */}
              {vs === "pending" && (
                <Hint id="status-unplan" text="計画を取り消して未計画に戻す（エンジンの実行対象から外す）">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => patch({ status: "unplanned" })}
                  >
                    未計画に戻す
                  </Button>
                </Hint>
              )}
              {exec && vs === "pending" && node.lifecycle === "committed" && !frontier && (
                <span className="text-xs text-text-lo">前のノードが終わると着手できます</span>
              )}
              {exec && vs === "pending" && frontier && (
                <Button type="button" variant="outline" size="sm" className="active:scale-95"
                  onClick={() => void patch({ status: "running" })}>
                  着手
                </Button>
              )}
              {exec && ((vs === "pending" && frontier) || vs === "running") && (
                <Button type="button" variant="outline" size="sm" className="active:scale-95"
                  onClick={() => void patch({ status: "done" })}>
                  完了
                </Button>
              )}
              {/* dropped（中止）は kind を問わず復帰できる（エンジンの abort 回答で
                  dropped になったノードが行き止まりにならないように） */}
              {((exec && (vs === "running" || vs === "done")) || vs === "dropped") && (
                <Hint
                  id="status-back"
                  text={
                    vs === "running"
                      ? "着手前（待ち）に戻す"
                      : vs === "done"
                        ? "未完了（待ち）に戻す"
                        : "中止を取り消して待ちに戻す"
                  }
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => patch({ status: "pending" })}
                  >
                    戻す
                  </Button>
                </Hint>
              )}
            </div>
          );
        })()}
    </>
  );
}
