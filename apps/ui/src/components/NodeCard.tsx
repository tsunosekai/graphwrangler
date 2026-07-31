import { useEffect, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { Loader2, Lock, Play, Unlock, Zap } from "lucide-react";
import { api } from "../lib/api";
import { pushToast } from "../lib/toast";
import { cn } from "../lib/utils";
import type { Node } from "../types";
import { Icon } from "./Icon";

// 担当アイコン（2026-07-31 本人選定「B. 明快系」: 人型 / ロボット顔 / ターミナル >_）
const EXEC_ICON: Record<Node["executor"], "user" | "bot" | "terminal"> = {
  human: "user",
  ai: "bot",
  script: "terminal",
};
const STATUS_LABEL: Record<Node["status"], string> = {
  unplanned: "未計画",
  pending: "待機",
  running: "実行中",
  waiting: "回答待ち",
  done: "完了",
  dropped: "中止",
  skipped: "スキップ",
};

const EXEC_TEXT: Record<Node["executor"], string> = {
  human: "text-human",
  ai: "text-ai",
  script: "text-script",
};

export interface NodeCardData {
  node: Node;
  selected: boolean;
  editing: boolean;
  /** ルーティーンページ（テンプレートの編集）で描かれているカードか。テンプレートは status を
   *  持たない思想（docs/design.md 3.8）なので、status 由来の見た目は出さない */
  isTemplate?: boolean;
  /** 実行フェーズ（全親が done|skipped）か。段階式アクションボタンの表示条件 */
  isFrontier?: boolean;
  /** QOL-7: 既読ts(localStorage gw.read.<id>)より新しいメッセージがあるか */
  unread?: boolean;
  onSelect: (id: string) => void;
  onDoubleClick: (id: string) => void;
  onCommitTitle: (id: string, title: string) => void;
  onCancelEdit: () => void;
  [key: string]: unknown;
}

// selected は React Flow が rfNode.selected から自動で渡す（複数選択・矩形選択の見た目用）。
// data.selected は App が追跡する「主選択」1件のための既存フラグ。どちらか点灯でリングを出す
export function NodeCard({ data, selected }: { data: NodeCardData; selected?: boolean }) {
  const { node, isTemplate } = data;
  const [draft, setDraft] = useState(node.title);
  const [firing, setFiring] = useState(false);
  const ringOn = data.selected || selected;
  // 保険: 質問が開いている（pendingRequest あり）間は、status が何であれ「あなたの番」を
  // 優先して実行中アニメーション/スピナーを出さない（waiting は本来 pendingRequest から
  // 導出できる派生状態。docs/design.md ステータス注記）。status との食い違いは旧プロセスの
  // 取り残し等で起こり得るため、見た目はこちらを正とする（2026-07-31 本人指摘）
  const visualStatus = node.pendingRequest ? "waiting" : node.status;

  // トリガー手動発火（human executor はこれが唯一の発火経路。script/aiは手動上書きとして使える。
  // docs/design.md 3.8「human = 手動発火（トリガー上の▶）」）
  const fire = async () => {
    if (firing) return;
    setFiring(true);
    try {
      const run = await api.fireTrigger(node.id);
      pushToast(`発火しました: ${run.title}`, "info");
    } catch {
      // api() 側でトースト表示済み
    } finally {
      setFiring(false);
    }
  };

  useEffect(() => {
    if (data.editing) setDraft(node.title);
  }, [data.editing, node.title]);

  // 人間に名前で見せる状態は「未計画」だけ（2026-07-31 本人方針: 人間の語彙は未計画かdoneかだけ。
  // 実行中=スピナー/回答待ち=橙ドット/完了=チェック/スキップ=斜線円と、他は絵で伝わっている）
  const showFoot = !isTemplate && node.status === "unplanned";
  // 実行フェーズの段階式アクション: 未計画 →「プラン済みにする」→ 進行 →「完了」
  // （decision は「分岐を選ぶ」がパネルにあるので対象外。trigger も対象外）
  const actionable =
    !isTemplate && data.isFrontier && node.kind === "task";
  // 下書き（draft）の間は status に関わらず「プラン済みにする」（確定）が先。
  // 破線=draft のカードに「完了」が出るのは筋が通らない（2026-07-31 本人指摘の紛れ）。
  // 「プラン済みにする」は lifecycle:"committed" まで含めた patch（status だけ変えても
  // draft+pending のノードでは何も起きない、が実際に起きたバグの修正）
  // トリガーは進捗を持たない（3.8）が lifecycle は持つ。下書きトリガーの確定導線が
  // 無かったため、カードにも「プラン済みにする」を出す（2026-07-31 本人報告）
  const phaseAction =
    !isTemplate && node.kind === "trigger" && node.lifecycle === "draft"
      ? { label: "プラン済みにする", patch: { lifecycle: "committed" } as const }
      : actionable && (node.status === "unplanned" || node.lifecycle === "draft")
        ? { label: "プラン済みにする", patch: { status: "pending", lifecycle: "committed" } as const }
        : actionable && node.status === "pending"
          ? { label: "完了", patch: { status: "done" } as const }
          : null;

  return (
    <div
      className={cn(
        // marker クラス（exec-*/status-*/lifecycle-*）は index.css のパルスアニメーション・
        // 下書きの粗い破線背景に使う。見た目の大半は Tailwind ユーティリティで組む
        // 枠の濃さは破線（draft）時代の明るい方に統一（本人指定）。hover での色変化は
        // ベースが既に strong なので廃止
        "node-card relative w-[220px] rounded-md border border-border-strong bg-card p-3 shadow-xs transition-colors",
        `exec-${node.executor}`,
        `lifecycle-${node.lifecycle}`,
        !isTemplate && `status-${visualStatus}`,
        !isTemplate &&
          (node.status === "done" || node.status === "dropped" || node.status === "skipped") &&
          "opacity-90",
        ringOn && "is-selected border-border-strong shadow-[0_0_0_1px_var(--border-strong)]",
      )}
      onClick={() => data.onSelect(node.id)}
      onDoubleClick={() => data.onDoubleClick(node.id)}
    >
      {/* trigger は parents を持てない=グラフの起点（docs/design.md 3.4）。
          入力ハンドルを構造的に持たせないことで、他ノードの後続へドラッグ接続できないようにする */}
      {node.kind !== "trigger" && <Handle type="target" position={Position.Top} />}
      {/* PDG風の完了/中止マーク（カード左外側の丸バッジ）。テンプレートには出さない */}
      {!isTemplate && node.status === "done" && (
        <span className="pdg-badge text-ok" title="完了">
          <Icon name="check" size={14} />
        </span>
      )}
      {!isTemplate && node.status === "dropped" && (
        <span className="pdg-badge text-text-lo" title="中止">
          <Icon name="x" size={13} />
        </span>
      )}
      {/* 処理中スピナーもチェックと同じ左外の丸バッジ（同位置・同サイズ。2026-07-31 本人指定）。
          done/running は排他なので左スロットは衝突しない */}
      {!isTemplate && visualStatus === "running" && (
        <span className="pdg-badge" style={{ color: "var(--active-color)" }} title="処理中">
          <Loader2 className="size-3.5 animate-spin" />
        </span>
      )}
      {/* 右側のバッジ列: 発火(▶) + Fix（ロック）トグル */}
      <span className="absolute -right-[30px] inset-y-0 flex flex-col items-center justify-center gap-1">
        {node.kind === "trigger" && (
          <button
            type="button"
            className="nodrag inline-flex size-[22px] items-center justify-center rounded-full border border-border bg-background text-text-lo transition-opacity hover:opacity-90 disabled:opacity-40"
            title="手動発火"
            disabled={firing}
            onClick={(e) => {
              e.stopPropagation();
              void fire();
            }}
          >
            <Play className="size-3" />
          </button>
        )}
        <button
          type="button"
          className={cn(
            "nodrag inline-flex size-[22px] items-center justify-center rounded-full border bg-background transition-opacity",
            node.fixed
              ? "border-ok text-ok" // Fix済み=濃く
              : "border-border text-text-lo opacity-40 hover:opacity-90", // 未Fix=薄く
          )}
          title={node.fixed ? "Fix済み（クリックで解除）" : "未Fix・改善中（クリックで Fix）"}
          onClick={async (e) => {
            e.stopPropagation();
            await api.patchNode(node.id, { fixed: !node.fixed });
          }}
        >
          {node.fixed ? <Lock className="size-3" /> : <Unlock className="size-3" />}
        </button>
      </span>
      {node.pendingRequest && (
        <span
          className="absolute -right-1 -top-1 size-2 flex-shrink-0 rounded-full bg-[var(--attention)]"
          title="あなたの番"
        />
      )}
      <div
        className={cn(
          "flex items-center gap-1.5",
          !isTemplate &&
            (node.status === "done" || node.status === "dropped" || node.status === "skipped") &&
            "opacity-55",
        )}
      >
        <span className={cn("inline-flex flex-shrink-0", EXEC_TEXT[node.executor])}>
          <Icon name={EXEC_ICON[node.executor]} />
        </span>
        {/* 2個目スロットは種別専任で常時表示（本人選定「B」2026-07-31: 実行=▷ 判断=⑂ トリガー=⚡）。
            実装(impl)バッジは別軸なのでタイトル右端へ分離 */}
        {node.kind === "task" && (
          <span className="inline-flex flex-shrink-0 text-muted-foreground" title="実行ノード">
            <Play className="size-3" />
          </span>
        )}
        {node.kind === "decision" && (
          <span className="inline-flex flex-shrink-0 text-muted-foreground" title="判断ノード（分岐）">
            <Icon name="branch" size={12} />
          </span>
        )}
        {node.kind === "trigger" && (
          <span className="inline-flex flex-shrink-0 text-muted-foreground" title="起点ノード（トリガー）">
            <Zap className="size-3" />
          </span>
        )}
        {data.editing ? (
          <input
            autoFocus
            className="nodrag min-w-0 flex-1 rounded-sm border border-border bg-transparent px-1 py-px text-sm text-foreground outline-none focus:border-border-strong"
            value={draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                data.onCommitTitle(node.id, draft);
              } else if (e.key === "Escape") {
                e.preventDefault();
                data.onCancelEdit();
              }
            }}
            onBlur={() => data.onCommitTitle(node.id, draft)}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm">{node.title || "（無題）"}</span>
        )}
        {/* 実装形態（impl）は種別と別軸なので右端に薄く出す（本人選定「B」の一部） */}
        {node.impl && (
          <span
            className="inline-flex flex-shrink-0 text-text-lo"
            title={node.impl.type === "doc" ? "実装: 手順書（文書）" : "実装: スクリプト（決定的）"}
          >
            <Icon name={node.impl.type === "doc" ? "doc" : "code"} size={12} />
          </span>
        )}
        {/* 担当×実装の不整合⚠（docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）:
            担当=script なのに impl が script でない=実行すると失敗する。既存の不可逆⚠と
            同じ Icon name="alert" を使い、title で理由を区別する（NodePanel にも同じ警告を出す） */}
        {node.executor === "script" && node.impl?.type !== "script" && (
          <span className="flex-shrink-0 text-destructive" title="実装が未接続（実行すると失敗します）">
            <Icon name="alert" size={12} />
          </span>
        )}
        {node.impact === "irreversible" && (
          <span className="flex-shrink-0 text-destructive" title="不可逆">
            <Icon name="alert" size={12} />
          </span>
        )}
        {/* 未読はカード内の右側（レールの未読バッジと同じ「右端」ポジション。旧: 左肩の外付けドット） */}
        {data.unread && (
          <span className="size-2 flex-shrink-0 rounded-full bg-ai" title="未読メッセージあり" />
        )}
      </div>
      {(showFoot || phaseAction) && (
        <div className="mt-1.5 flex items-center gap-2">
          {showFoot && <span className="text-xs text-muted-foreground">{STATUS_LABEL[node.status]}</span>}
          {phaseAction && (
            <button
              type="button"
              className="nodrag rounded-sm border border-border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
              onClick={async (e) => {
                e.stopPropagation();
                await api.patchNode(node.id, phaseAction.patch);
              }}
            >
              {phaseAction.label}
            </button>
          )}
        </div>
      )}
      {/* トリガーの起動方式（docs/design.md 3.8）。script=cron的な発火条件、ai=発火要否を判定させる間隔。
          human はここには何も出さない（▶ボタンが唯一の発火経路のため） */}
      {node.kind === "trigger" && node.executor === "script" && (
        <div className="mt-1.5 text-xs">
          {node.schedule ? (
            <span className="text-muted-foreground">{node.schedule}</span>
          ) : (
            <span className="text-destructive">schedule 未設定</span>
          )}
        </div>
      )}
      {node.kind === "trigger" && node.executor === "ai" && (
        <div className="mt-1.5 text-xs text-muted-foreground">チェック間隔: {node.schedule || "every 1h"}</div>
      )}
      {/* 分岐確定後: 選んだ枝を表示（docs/design.md 3.9） */}
      {node.kind === "decision" && node.choice && (
        <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
          <Icon name="branch" size={12} />
          <span className="truncate">
            → {node.branches?.find((b) => b.id === node.choice)?.label ?? node.choice}
          </span>
        </div>
      )}
      {node.kind === "decision" && node.branches && node.branches.length > 0 ? (
        <>
          {node.branches.map((b, i) => {
            const leftPct = ((i + 0.5) / node.branches!.length) * 100;
            return (
              <Handle
                key={b.id}
                type="source"
                id={b.id}
                position={Position.Bottom}
                style={{ left: `${leftPct}%` }}
              />
            );
          })}
          <div className="pointer-events-none absolute inset-x-1 -bottom-4 flex text-[9px] leading-none text-muted-foreground">
            {node.branches.map((b, i) => {
              const leftPct = ((i + 0.5) / node.branches!.length) * 100;
              return (
                <span
                  key={b.id}
                  className="absolute max-w-[70px] -translate-x-1/2 truncate"
                  style={{ left: `${leftPct}%` }}
                  title={b.label}
                >
                  {b.label}
                </span>
              );
            })}
          </div>
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} />
      )}
    </div>
  );
}
