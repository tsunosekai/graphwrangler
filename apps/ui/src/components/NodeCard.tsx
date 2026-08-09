import { useEffect, useRef, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { Loader2, Lock, Play, Unlock } from "lucide-react";
import { api } from "../lib/api";
import { fireTrigger } from "../lib/fire";
import { colorOf, displayNameOf, initialOf, turnIsMine, useTeam } from "../lib/team";
import { HINT_TEXT } from "../lib/hints";
import { cn } from "../lib/utils";
import type { Node, RunItemStatus } from "../types";
import { Hint } from "./Hint";
import { Icon } from "./Icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./ui/context-menu";

// 担当アイコン（2026-07-31 本人選定「B. 明快系」: 人型 / ロボット顔 / ターミナル >_）
const EXEC_ICON: Record<Node["executor"], "user" | "bot" | "terminal"> = {
  human: "user",
  ai: "bot",
  script: "terminal",
};
// 種別の文字チップ（本人選定「A+D」）。goal / folder はカードとして描かれないが型のため網羅
const KIND_CHIP: Record<Node["kind"], string> = {
  task: "実行",
  decision: "判断",
  trigger: "トリガー",
  goal: "プロジェクト",
  folder: "フォルダ",
};
const STATUS_LABEL: Record<Node["status"], string> = {
  unplanned: "未計画",
  pending: "待機",
  running: "実行中",
  done: "完了",
  dropped: "中止",
  skipped: "スキップ",
};

const EXEC_TEXT: Record<Node["executor"], string> = {
  human: "text-human",
  ai: "text-ai",
  script: "text-script",
};
const EXEC_JA: Record<Node["executor"], string> = { human: "人間", ai: "AI", script: "スクリプト" };

/** 右クリックメニュー（第0層＝既存操作への近道。docs/design.md 4章の視距離3層に階を
 *  増やさない）から呼ぶ操作。実体は GraphView が持つ既存ハンドラ（F2 / Tab / Ctrl+D /
 *  Delete …）で、カード側は「いまどの項目を出すか」だけを決める。
 *  ここに新しい概念は置かない——同じことをする項目は必ず既存の関数を呼ぶ */
export interface NodeMenuActions {
  /** メニューを開く直前に呼ぶ。右クリックしたノードが未選択なら単独選択へ切り替える
   *  （以降の項目が「選択中に対する既存操作」をそのまま呼べるようにするため） */
  onOpen: (id: string) => void;
  /** F2 と同じ（タイトル編集モードへ入る） */
  rename: (id: string) => void;
  /** Tab と同じ（そのノードの後続を作って即リネーム） */
  addChild: (id: string) => void;
  /** Ctrl+D と同じ（選択中を複製） */
  duplicate: () => void;
  /** Delete と同じ（選択中を削除。確認モーダルの出し方も既存のまま） */
  remove: () => void;
  /** そのノードの会話（テンプレート + 全ランぶん）に未読があるか */
  hasUnread: (id: string) => boolean;
  /** 上記をまとめて既読にする */
  markRead: (id: string) => void;
  copyLink: (id: string) => void;
  copyId: (id: string) => void;
  /** 担当の変更（NodePanel の担当 Select と同じ patch + 同じ試走ゲート確認） */
  setExecutor: (id: string, executor: Node["executor"]) => void;
  /** 「ページへ移動 ▸」の候補（同じ節の他ページ）。空ならサブメニューごと出さない */
  movePages: { id: string; title: string }[];
  /** BulkPanel の「別ページへ移動」と同じ（group を patch） */
  moveToPage: (id: string, pageId: string) => void;
  /** 「ここから下を全部 ▸」の対象数（0 なら親項目ごと出さない） */
  descendantCount: (id: string) => number;
  /** 子孫のうち下書きを計画済みにする */
  commitDescendants: (id: string) => void;
  /** 子孫 + 自分を葉から順に削除する（確認モーダルは件数付き） */
  removeSubtree: (id: string) => void;
  /** スクリプトの試走（api.trialNode） */
  trial: (id: string) => void;
}

export interface NodeCardData {
  node: Node;
  selected: boolean;
  editing: boolean;
  /** ルーティーンページ（テンプレートの編集）で描かれているカードか。テンプレートは status を
   *  持たない思想（docs/design.md 3.8）なので、status 由来の見た目は出さない
   *  ——ただし runItem がある間はその進捗を投影する（下記） */
  isTemplate?: boolean;
  /** 実行フェーズ（全親が done|skipped）か。段階式アクションボタンの表示条件 */
  isFrontier?: boolean;
  /** アクティブなランのこのノードに対応するワークアイテム（あれば）。docs/design.md 3.8:
   *  「アクティブなランがある間だけ、その進捗をカードに投影する」。runId はボタンの
   *  更新先（api.patchRunItem）の特定に使う——テンプレートの patchNode は使わない */
  runItem?: { runId: string; status: RunItemStatus; note: string | null } | null;
  /** ランのページ（そのランの記録）として描かれているか（2026-08-08 本人指定のフォーク）。
   *  true のときテンプレートを書き換える操作（計画済みにする等）は出さない——直すべきは
   *  テンプレート側で、ランは起きたことの記録だから */
  inRunPage?: boolean;
  /** kind=trigger のカードだけが受ける「いま実行中のランの本数」。発火時の確認文で
   *  「並行で増える」ことを伝えるのに使う（2026-08-08。ラン表示中は▶を無効にしたので、
   *  投影中のワークアイテムからは並走を知れなくなった） */
  runningRunCount?: number;
  /** runItem 版のフロンティア判定（親の「ランのアイテム」が全部 done|skipped か）。
   *  isFrontier のラン投影版。段階式アクションボタン（着手/完了）の表示条件 */
  isRunFrontier?: boolean;
  /** 発火フォームのプリフィル: 同じページの直近ランの context（docs/design.md 3.15
   *  「変えたい所だけ直す」）。kind=trigger のカードだけが使う */
  lastRunContext?: Record<string, string> | null;
  /** 配線チェック（GET /pages/:id/wiring）のこのノード宛警告 message 一覧。
   *  テンプレート表示のときだけ渡される（ランのページでは描かない。docs/design.md 3.15） */
  wiringWarnings?: string[];
  /** 既読ts（サーバ持ちの reads[<id>]）より新しいメッセージがあるか */
  unread?: boolean;
  /** 右クリックメニューの呼び先。未指定＝メニューを出さない（粗いポインタ環境。
   *  出す/出さないの判断は GraphView が一箇所で行う） */
  menu?: NodeMenuActions;
  onSelect: (id: string) => void;
  /** 手動発火でランが生まれたときに呼ばれる（2026-08-08 本人指定「発火したらそのランの
   *  ページへ移る」）。移動そのものは App が行う */
  onRunStarted?: (runId: string) => void;
  onDoubleClick: (id: string) => void;
  onCommitTitle: (id: string, title: string) => void;
  onCancelEdit: () => void;
  [key: string]: unknown;
}

// selected は React Flow が rfNode.selected から自動で渡す（複数選択・矩形選択の見た目用）。
// data.selected は App が追跡する「主選択」1件のための既存フラグ。どちらか点灯でリングを出す
export function NodeCard({ data, selected }: { data: NodeCardData; selected?: boolean }) {
  const { node, isTemplate, runItem } = data;
  // 「あなたの番」の per-user 判定（チーム化 2026-08-04）: assignee が他人なら橙にしない
  const { me, users, enabled: teamEnabled } = useTeam();
  const turnMine = turnIsMine(node.assignee, me.email);
  const [draft, setDraft] = useState(node.title);
  const [firing, setFiring] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const ringOn = data.selected || selected;
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
  const visualStatus = projecting ? runItem.status : node.pendingRequest ? "waiting" : node.status;
  // 見た目に status を反映してよいか（非テンプレート、または投影中のテンプレート）
  const showStatus = !isTemplate || projecting;

  // ラン内の段階式アクション（docs/design.md 3.8）: 担当が human の task アイテムだけ
  // （分岐(decision)は「分岐を選ぶ」が唯一の決着経路。choice を経ずに done にしない）。
  // pending+ラン内フロンティア→「着手」「完了」、running→「完了」「戻す」（戻す=pending）。
  // ボタンはランのアイテムを更新する（テンプレートの patchNode は使わない）
  const runButtons: { label: string; status: RunItemStatus }[] =
    projecting && node.executor === "human" && node.kind === "task"
      // waiting = エンジンが「あなたの番」へ上げた状態（2026-08-08）。pending と同じ操作を出す
      ? (runItem.status === "pending" || runItem.status === "waiting") && data.isRunFrontier
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

  // トリガー手動発火（human executor はこれが唯一の発火経路。script/aiは手動上書きとして使える。
  // docs/design.md 3.8「human = 手動発火（トリガー上の▶）」）。
  // フォーム・確認文・トーストは lib/fire.ts が一箇所で持つ（左レールの「発火」・台帳の
  // 開始ボタンと同じもの）。ここは▶の多重押し防止と、生まれたランへの移動だけを持つ
  const fire = async () => {
    if (firing) return;
    setFiring(true);
    try {
      const run = await fireTrigger(node, {
        runningRunCount: data.runningRunCount,
        lastRunContext: data.lastRunContext,
      });
      if (run) data.onRunStarted?.(run.id); // 生まれたランのページへ移る
    } finally {
      setFiring(false);
    }
  };

  useEffect(() => {
    if (data.editing) setDraft(node.title);
  }, [data.editing, node.title]);

  // 編集開始時のフォーカス。autoFocus は使わない: マウント直後は React Flow の再計測で
  // ノードが一瞬 visibility:hidden になることがあり、その間の focus() は静かに不発になる
  // （2026-08-07 本人報告「タイトル編集中にフォーカスが外れる」。実測: autoFocus も
  // rAF 1回でも不発だった）。フォーカスが実際に付くまで数フレーム リトライする
  // （編集セッションにつき1回だけ走る。付いたら全選択して終了）
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!data.editing) return;
    let raf = 0;
    let tries = 0;
    const attempt = () => {
      const el = titleInputRef.current;
      if (!el) return; // 編集が終わって input が消えた
      el.focus();
      if (document.activeElement === el) {
        el.select();
        return;
      }
      if (++tries < 30) raf = requestAnimationFrame(attempt); // 最大 ~0.5秒
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [data.editing]);

  // 人間に名前で見せる状態は「未計画」だけ（2026-07-31 本人方針: 人間の語彙は未計画かdoneかだけ。
  // 実行中=スピナー/回答待ち=橙ドット/完了=チェック/スキップ=斜線円と、他は絵で伝わっている）
  const showFoot = !isTemplate && node.status === "unplanned";
  // 「プラン済みにする」は進捗ではなく計画（lifecycle）の操作なので、テンプレートでも
  // 順番未到達（frontier前）でも出す（committed でないノードはエンジンが実行しないため、
  // 確定の導線が無いと詰む。2026-08-01 本人指摘）。「完了」は実行フェーズの操作なので
  // 従来どおり非テンプレート・frontier・task のみ
  const canCommit = node.status === "unplanned" || node.lifecycle === "draft";
  const phaseAction = data.inRunPage
    ? null // ランのページではテンプレートの計画操作を出さない（2026-08-08）
    : node.kind === "trigger" && node.lifecycle === "draft"
      ? { label: "計画済みにする", patch: { lifecycle: "committed" } as const }
      : node.kind !== "trigger" && canCommit
        ? { label: "計画済みにする", patch: { status: "pending", lifecycle: "committed" } as const }
        : !isTemplate && data.isFrontier && node.kind === "task" && node.status === "pending"
          ? { label: "完了", patch: { status: "done" } as const }
          : null;
  // カードのボタンと右クリックメニューで同じ処理を呼ぶための切り出し（挙動の二重管理を避ける）
  const applyPhaseAction = async () => {
    if (phaseAction) await api.patchNode(node.id, phaseAction.patch);
  };
  const toggleFixed = async () => {
    await api.patchNode(node.id, { fixed: !node.fixed });
  };

  // ---- 右クリックメニュー（第0層）。該当しない項目は disabled にせず出さない
  //      （メニューを短く保つ）。「既読にする」だけは押しても無害なので disabled で残す ----
  const menu = data.menu;
  // ランのページ（記録）ではテンプレートを書き換える項目を出さない（2026-08-08 のフォーク）
  const canEditTemplate = !data.inRunPage;
  // 進捗: カードのボタンと同じ語彙・同じハンドラ。分岐(decision)に実行系（着手/完了/戻す）が
  // 出ないのは phaseAction / runButtons の条件（kind==="task"）がそのまま担保する
  // （docs/design.md 3.9「決着経路は分岐を選ぶのみ」。計画系は NodePanel と同じく残す）
  const progressItems: { label: string; run: () => void }[] = [];
  if (phaseAction) progressItems.push({ label: phaseAction.label, run: () => void applyPhaseAction() });
  for (const b of runButtons) progressItems.push({ label: b.label, run: () => void patchRunItemStatus(b.status) });
  // 「計画済みにする」の逆操作（NodePanel の status-unplan と同じ patch）。カードにボタンは
  // 無いが、計画の語彙として対が無いと行き止まりになるのでメニューには出す。
  // ラン投影中/ランのページでは出さない——実行中のランの進捗操作と混ざるため
  const unplanPatch: Parameters<typeof api.patchNode>[1] | null = data.inRunPage
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
  if (unplanPatch) {
    progressItems.push({ label: "未計画に戻す", run: () => void api.patchNode(node.id, unplanPatch) });
  }
  // トリガーの「発火」（カードの▶と同じハンドラ）。ラン表示中は▶と同じく出さない
  const canFire = node.kind === "trigger" && !projecting && !data.inRunPage;
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
        showStatus &&
          (visualStatus === "done" || visualStatus === "dropped" || visualStatus === "skipped") &&
          "opacity-90",
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
      {/* PDG風の完了/中止マーク（カード左外側の丸バッジ）。テンプレートには出さない
          ——ただしアクティブなランの投影中は item.status で描く（docs/design.md 3.8） */}
      {showStatus && visualStatus === "done" && (
        <Hint id="badge-done" always="完了">
          <span className="pdg-badge text-ok">
            <Icon name="check" size={14} />
          </span>
        </Hint>
      )}
      {showStatus && visualStatus === "dropped" && (
        <Hint id="badge-dropped" always="中止" text="進捗の「戻す」で待ちに復帰できる">
          <span className="pdg-badge text-text-lo">
            <Icon name="x" size={13} />
          </span>
        </Hint>
      )}
      {/* 処理中スピナーもチェックと同じ左外の丸バッジ（同位置・同サイズ。2026-07-31 本人指定）。
          done/running は排他なので左スロットは衝突しない */}
      {showStatus && visualStatus === "running" && (
        <Hint id="badge-running" always="処理中">
          <span className="pdg-badge" style={{ color: "var(--active-color)" }}>
            <Loader2 className="size-3.5 animate-spin" />
          </span>
        </Hint>
      )}
      {/* 右側のバッジ列: 発火(▶) + Fix（ロック）トグル */}
      <span className="absolute -right-[30px] inset-y-0 flex flex-col items-center justify-center gap-1">
        {node.kind === "trigger" && (
          // ラン表示中は押せない（2026-08-08 本人指定「既に押した発火はもう押せないように」）。
          // そのランは発火済みで、ここから作れるのは常に**別の**ランだから紛らわしい。
          // 新しく始めるのはテンプレート表示（＝ページを開いた既定）と実行一覧の発火ボタンから
          // ——並行ランは従来どおり何本でも回せる
          <Hint
            id="fire"
            always={projecting ? "このランは発火済み" : "手動で開始"}
            text={
              projecting
                ? "表示中のランはもう発火しています。新しく始めるにはページを開き直す（テンプレート表示）か、実行一覧の発火から"
                : HINT_TEXT.fire
            }
          >
            <button
              type="button"
              className="nodrag inline-flex size-[22px] items-center justify-center rounded-full border border-border bg-background text-text-lo transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={firing || projecting}
              // disabled にはポインタイベントが来ない＝Hint のツールチップが出ないので、
              // 押せない理由だけは native title で見せる
              title={projecting ? "このランは発火済み" : undefined}
              onClick={(e) => {
                e.stopPropagation();
                void fire();
              }}
            >
              <Play className="size-3" />
            </button>
          </Hint>
        )}
        <Hint
          id="fixed"
          always={node.fixed ? "ロック済み（クリックで解除）" : "未ロック・改善中（クリックでロック）"}
          text={HINT_TEXT.fixed}
        >
          <button
            type="button"
            className={cn(
              "nodrag inline-flex size-[22px] items-center justify-center rounded-full border bg-background transition-opacity",
              node.fixed
                ? "border-ok text-ok" // Fix済み=濃く
                : "border-border text-text-lo opacity-40 hover:opacity-90", // 未Fix=薄く
            )}
            onClick={async (e) => {
              e.stopPropagation();
              await toggleFixed();
            }}
          >
            {node.fixed ? <Lock className="size-3" /> : <Unlock className="size-3" />}
          </button>
        </Hint>
      </span>
      {/* 「あなたの番」の右肩ドット。非テンプレートは pendingRequest、投影中はランアイテムの
          waiting をそのまま使う（ランアイテムに pendingRequest 概念はない。docs/design.md 3.8）。
          他人の番（assignee が他人。チーム化 2026-08-04）は attention 色にせず human 席色で
          「誰かの回答待ち」だけ伝える */}
      {((!isTemplate && node.pendingRequest) || (projecting && visualStatus === "waiting")) && (
        <Hint
          id="turn"
          always={
            turnMine || !node.assignee
              ? "あなたの番"
              : `${displayNameOf(node.assignee, users)}の番（回答待ち）`
          }
          text="質問・承認・分岐の回答待ち。ノードを開いて判断カードから回答すると先へ進む"
        >
          <span
            className="absolute -right-1 -top-1 size-2 flex-shrink-0 rounded-full"
            style={{ background: turnMine ? "var(--attention)" : "var(--human)" }}
          />
        </Hint>
      )}
      <div
        className={cn(
          "flex items-center gap-1.5",
          showStatus &&
            (visualStatus === "done" || visualStatus === "dropped" || visualStatus === "skipped") &&
            "opacity-55",
        )}
      >
        {/* 担当アイコンのヒント（2026-08-05 本人指定の最重要ヒント）: 担当=誰が始めるのか。
            id はパネルの「担当」と共有——どちらかで OK すれば両方消える */}
        <Hint id="executor" always={`担当: ${EXEC_JA[node.executor]}`} text={HINT_TEXT.executor}>
          <span className={cn("inline-flex flex-shrink-0", EXEC_TEXT[node.executor])}>
            <Icon name={EXEC_ICON[node.executor]} />
          </span>
        </Hint>
        {/* 担当者のイニシャルバッジ（チーム化 2026-08-04）: 担当=人間で assignee があるとき、
            「人間の誰がやるか」を1文字で示す。ロスターが2人未満の運用では出さない（degrade 原則） */}
        {teamEnabled && node.executor === "human" && node.assignee && (
          <Hint
            id="assignee"
            always={`担当者: ${displayNameOf(node.assignee, users)}`}
            text={HINT_TEXT.assignee}
          >
            <span
              className="inline-flex size-4 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none text-white"
              style={{ background: colorOf(node.assignee) }}
            >
              {initialOf(node.assignee, users)}
            </span>
          </Hint>
        )}
        {/* 2個目スロットは種別の文字チップ（本人選定「A+D」2026-07-31: アイコンをやめて
            実行/判断/トリガー の文字で誤読ゼロに）。実装(impl)バッジは別軸なのでタイトル右端 */}
        <Hint id="kind" always={`種別: ${KIND_CHIP[node.kind]}`} text={HINT_TEXT.kind}>
          <span className="flex-shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground">
            {KIND_CHIP[node.kind]}
          </span>
        </Hint>
        {data.editing ? (
          <input
            ref={titleInputRef}
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
          // タイトルは2行まで見せてから省略（2026-08-07 本人要望「二行まで表示」。旧: 1行 truncate）
          <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm">{node.title || "（無題）"}</span>
        )}
        {/* 実装形態（impl）は種別と別軸なので右端に薄く出す（本人選定「B」の一部） */}
        {node.impl && (
          <Hint
            id="impl"
            always={node.impl.type === "doc" ? "実装: 手順書（文書）" : "実装: スクリプト（決定的）"}
            text={HINT_TEXT.impl}
          >
            <span className="inline-flex flex-shrink-0 text-text-lo">
              <Icon name={node.impl.type === "doc" ? "doc" : "code"} size={12} />
            </span>
          </Hint>
        )}
        {/* 担当×実装の不整合⚠（docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）:
            担当=script なのに impl が script でない=実行すると失敗する。既存の不可逆⚠と
            同じ Icon name="alert" を使い、title で理由を区別する（NodePanel にも同じ警告を出す）。
            kind=trigger は対象外——トリガーの executor=script は「schedule で発火する」の意味で
            あって command 実行ではない（docs/design.md 3.8）ため、impl 不要 */}
        {node.executor === "script" && node.kind !== "trigger" && node.impl?.type !== "script" && (
          <Hint
            id="impl-missing"
            always="実装が未接続"
            text="担当がスクリプトなのに実装がスクリプトでない=実行すると失敗する。実装欄でコマンドを設定するか担当を変える"
          >
            <span className="flex-shrink-0 text-destructive">
              <Icon name="alert" size={12} />
            </span>
          </Hint>
        )}
        {node.approval && (
          <Hint
            id="approval"
            always={node.kind === "trigger" ? "開始前承認" : "実行前承認"}
            text={HINT_TEXT.approval}
          >
            <span className="flex-shrink-0 text-destructive">
              <Icon name="alert" size={12} />
            </span>
          </Hint>
        )}
        {/* 配線チェックの警告⚠（docs/design.md 3.15）: このノードの {x} 参照に供給元が無い等。
            発火は止めない（警告のみ）ので、エラー赤ではなく注意の橙（--attention）で描く */}
        {(data.wiringWarnings?.length ?? 0) > 0 && (
          <Hint
            id="wiring-warning"
            always="引数の配線に注意"
            text={<span className="whitespace-pre-line">{data.wiringWarnings!.join("\n")}</span>}
          >
            <span className="flex-shrink-0" style={{ color: "var(--attention)" }}>
              <Icon name="alert" size={12} />
            </span>
          </Hint>
        )}
        {/* 未読はカード内の右側（レールの未読バッジと同じ「右端」ポジション。旧: 左肩の外付けドット） */}
        {data.unread && (
          <Hint id="unread" always="未読メッセージあり" text={HINT_TEXT.unread}>
            <span className="size-2 flex-shrink-0 rounded-full bg-ai" />
          </Hint>
        )}
      </div>
      {(showFoot || phaseAction || runButtons.length > 0) && (
        <div className="mt-1.5 flex items-center gap-2">
          {showFoot && <span className="text-xs text-muted-foreground">{STATUS_LABEL[node.status]}</span>}
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
      {/* トリガーの起動方式（docs/design.md 3.8）。script=cron的な発火条件、ai=発火要否を判定させる間隔。
          human はここには何も出さない（▶ボタンが唯一の発火経路のため） */}
      {node.kind === "trigger" && node.executor === "script" && (
        <div className="mt-1.5 text-xs">
          {node.schedule ? (
            <Hint
              id="schedule"
              text="スクリプト・トリガーの自動開始条件（書式: every 15m / daily 09:00 / weekly mon 09:00 / cron 5フィールド）"
            >
              <span className="text-muted-foreground">{node.schedule}</span>
            </Hint>
          ) : (
            <Hint
              id="schedule"
              text="設定するまで手動▶でしか開始しない。パネルの起動方式欄に every 15m / daily 09:00 / weekly mon 09:00 か cron 5フィールドで書く"
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
            チェック間隔: {node.schedule || "every 1h"}
          </div>
        </Hint>
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

  if (!menu) return card;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        // ノード上の右クリックはペインのメニューまで上げない（両方が同時に開かないように）。
        // preventDefault はしない——Radix 側の内部ハンドラ（メニューを開く）が走らなくなる
        onContextMenu={(e) => {
          e.stopPropagation();
          menu.onOpen(node.id);
        }}
      >
        {card}
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-52"
        // 閉じたあとカードへフォーカスを戻さない。「名前を変更」で開いたタイトル入力から
        // フォーカスを奪い返す事故を構造的に防ぐ（2026-08-07「タイトル編集中にフォーカスが
        // 外れる」と同じ経路）。キーボード操作は GraphView の window keydown が一元管理する
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {progressItems.map((item) => (
          <ContextMenuItem key={item.label} onSelect={item.run}>
            {item.label}
          </ContextMenuItem>
        ))}
        {canFire && <ContextMenuItem onSelect={() => void fire()}>発火</ContextMenuItem>}
        {(progressItems.length > 0 || canFire) && <ContextMenuSeparator />}
        <ContextMenuItem
          // 未読が無いときは押しても意味が無いだけなので disabled（非表示にはしない）
          disabled={!menu.hasUnread(node.id)}
          onSelect={() => menu.markRead(node.id)}
        >
          既読にする
        </ContextMenuItem>
        {canEditTemplate && (
          <>
            <ContextMenuSeparator />
            {/* Fix済みは名前も変えられない（F2 と同じガード） */}
            {!node.fixed && (
              <ContextMenuItem onSelect={() => menu.rename(node.id)}>
                名前を変更
                <ContextMenuShortcut>F2</ContextMenuShortcut>
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={() => menu.addChild(node.id)}>
              子ノードを作る
              <ContextMenuShortcut>Tab</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => menu.duplicate()}>
              複製
              <ContextMenuShortcut>Ctrl+D</ContextMenuShortcut>
            </ContextMenuItem>
            {/* 「やり方」フィールド（担当・ページ）は Fix済みだとサーバが409で拒否する */}
            {!node.fixed && <ContextMenuSeparator />}
            {!node.fixed && (
              <ContextMenuSub>
                <ContextMenuSubTrigger>担当を変える</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuRadioGroup
                    value={node.executor}
                    onValueChange={(v) => menu.setExecutor(node.id, v as Node["executor"])}
                  >
                    {(["human", "ai", "script"] as const).map((ex) => (
                      <ContextMenuRadioItem key={ex} value={ex}>
                        {EXEC_JA[ex]}
                      </ContextMenuRadioItem>
                    ))}
                  </ContextMenuRadioGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>
            )}
            {!node.fixed && menu.movePages.length > 0 && (
              <ContextMenuSub>
                <ContextMenuSubTrigger>ページへ移動</ContextMenuSubTrigger>
                <ContextMenuSubContent className="max-h-72 overflow-y-auto">
                  {menu.movePages.map((p) => (
                    <ContextMenuItem key={p.id} onSelect={() => menu.moveToPage(node.id, p.id)}>
                      {p.title}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void toggleFixed()}>
              {node.fixed ? "Fix を解除" : "Fix する"}
            </ContextMenuItem>
          </>
        )}
        {/* 試走はランのページでも出す（テンプレートを書き換えないため） */}
        {node.impl?.type === "script" && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => menu.trial(node.id)}>試走</ContextMenuItem>
          </>
        )}
        {canEditTemplate && descendants > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>ここから下を全部</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => menu.commitDescendants(node.id)}>
                計画済みにする
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" onSelect={() => menu.removeSubtree(node.id)}>
                削除（{descendants + 1}件）
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => menu.copyLink(node.id)}>リンクをコピー</ContextMenuItem>
        <ContextMenuItem onSelect={() => menu.copyId(node.id)}>ID をコピー</ContextMenuItem>
        {canEditTemplate && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => menu.remove()}>
              削除
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
