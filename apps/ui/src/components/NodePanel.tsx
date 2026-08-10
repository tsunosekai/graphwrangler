import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  History,
  Lock,
  MessageSquare,
  MessageSquarePlus,
  ScrollText,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { effortLabel, modelLabel, useAiDefaults } from "../lib/aiDefaults";
import { api, postReads, type NodePatchInput } from "../lib/api";
import { confirmDialog, confirmWithAltDialog } from "../lib/dialogs";
import { HINT_TEXT, TRIAL_CONFIRM_MESSAGE } from "../lib/hints";
import { EXECUTOR_JA, KIND_JA } from "../lib/labels";
import { buildRemoveMessage, computeRemoveImpact, removeImpactWarnings } from "../lib/removal";
import { useDraftField } from "../hooks/useDraftField";
import { useIsMobile } from "../hooks/useIsMobile";
import { isRoutinePage } from "../lib/routine";
import { threadKey } from "../lib/unread";
import { usePolling } from "../hooks/usePolling";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { displayNameOf, sameEmail, useTeam } from "../lib/team";
import { cn } from "../lib/utils";
import type { Node, Run } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";
import { DecisionCard } from "./DecisionCard";
import { Hint } from "./Hint";
import { Icon } from "./Icon";
import { RunTimeNote } from "./RunTimeNote";
import { Thread } from "./Thread";
import { BranchesEditor, DecisionChoice } from "./nodepanel/DecisionSection";
import { HistoryTab } from "./nodepanel/HistoryTab";
import { ImplSection } from "./nodepanel/ImplSection";
import { MembersSection } from "./nodepanel/MembersSection";
import { OutputsSection } from "./nodepanel/OutputsSection";
import { StatusSection } from "./nodepanel/StatusSection";
import { findLastBreak, inTab, splitSessions, type PanelTab } from "./nodepanel/messageFilters";
import { useImplStatus } from "./nodepanel/useImplStatus";

interface Props {
  node: Node;
  /** 実行フェーズゲート（docs/design.md 3.9）の判定に使う全ノード。分岐の親の status を見る */
  allNodes: Node[];
  /** アクティブなラン（docs/design.md 3.8）。現在ページの status==="running" 最新1本。
   *  無ければ null——このノードがルーティーンのテンプレートメンバーなら現行の注記のまま */
  activeRun: Run | null;
  /** ノードid → 既読時刻（サーバ持ち。2026-08-02 localStorage から移行＝端末間で一致） */
  reads: Record<string, string>;
  /** ランのページを見ているか（2026-08-08 本人指定「ランは個別ページ」）。非 null のとき:
   *  - node はそのランのフォーク（ラン作成時点の中身）＝やり方の編集はできない
   *  - 会話・実行履歴もそのランのものだけを出し、書き込みもそのランに属する */
  runView?: { id: string; title: string } | null;
  /** スレッドを表示した時点で呼ばれる（App が既読オーバーレイでカード/レールの未読バッジを
   *  即消すため。2026-08-05 本人指示「何秒かじゃなくて即で」）。lastTs はスレッド最終
   *  メッセージの ts（サーバ発行）で、端末の時計ズレに影響されない既読の基準になる */
  onViewed?: (nodeId: string, lastTs: string | null) => void;
  onMutated: () => void;
  onClose: () => void;
  /** ノード複製後に新規ノードを選択するため。ページ切替も面倒を見る App.selectNode を渡す */
  onSelect: (id: string) => void;
}

// 種別はノードの3種のみ（ゴールはページなので選択肢に出さない。現在値がゴール等の時だけ表示）
const KIND_OPTIONS: Node["kind"][] = ["task", "decision", "trigger"];

// 種別・担当の日本語（KIND_JA / EXECUTOR_JA）は lib/labels.ts が唯一の正
const EXECUTOR_OPTIONS: Node["executor"][] = ["human", "ai", "script"];

/** タブの未読ドット。色はノードカード/レールの未読バッジと同じ bg-ai（青）で、
 *  「あなたの番」の橙(--attention)とは別物であることを色で示す */
function UnreadDot() {
  return (
    <Hint id="unread" always="このタブに未読があります" text={HINT_TEXT.unread}>
      <span className="size-1.5 flex-shrink-0 rounded-full bg-ai" />
    </Hint>
  );
}

// key={node.id} で App から渡されるため、node が切り替わるたびにこのコンポーネントは
// まっさらな状態で再マウントされる（未読ドラフト・タブ・スレッドポーリングが混線しない）。
export function NodePanel({
  node,
  allNodes,
  activeRun,
  reads,
  runView = null,
  onViewed,
  onMutated,
  onClose,
  onSelect,
}: Props) {
  // 会話=今の会話 / 履歴=過去の会話（GraphWrangler AI の「履歴」と同じ意味） / 実行記録=status・artifact
  // （2026-08-02 本人要望「会話の履歴と実行の履歴を分けてほしい」で2タブ→3タブ化。
  // それまで「新しい会話」で区切った過去の会話は UI のどこからも見えなくなっていた）
  const isMobile = useIsMobile();
  // チーム化（2026-08-04）: ロスターとログイン情報。人系UI（担当者・関係者）は enabled
  // （ロスター2人以上）のときだけ出す（degrade 原則）
  const { users, enabled: teamEnabled } = useTeam();
  const [tab, setTab] = useState<PanelTab>("talk");
  // 履歴タブで開いている過去セッション（chatBreak メッセージの id。null = 一覧）。
  // GraphWrangler AI の履歴タブ（セッション一覧→クリックで中身）と同じ動線に揃える
  const [historySessionId, setHistorySessionId] = useState<string | null>(null);
  // ノード詳細は既定で開いておく（2026-07-31 本人指定）。会話に集中したいときだけ
  // タブ行右端の「会話を広げる」で閉じる。開閉はリロードを跨いで保持
  // （key={node.id} で再マウントされるため、ノード横断のグローバル設定として保存）
  const [metaOpen, setMetaOpenRaw] = useState(() => {
    try {
      return localStorage.getItem("gw.metaOpen") !== "0";
    } catch {
      return true;
    }
  });
  const setMetaOpen = (updater: (v: boolean) => boolean) =>
    setMetaOpenRaw((v) => {
      const next = updater(v);
      try {
        localStorage.setItem("gw.metaOpen", next ? "1" : "0");
      } catch {
        // 無視
      }
      return next;
    });
  const [width, startResize] = useResizableWidth("panelW", 380, 300, 640);
  // 会話・実行履歴はランごと（2026-08-08「会話や実行履歴もフォーク」）。
  // ランのページならそのランの分だけ、テンプレートなら設計図側の分だけが返る
  const { data: thread, refresh: refreshThread } = usePolling(
    () => api.getThread(node.id, runView?.id ?? null),
    10000,
    `${node.id}:${runView?.id ?? ""}`,
  );
  /** ランのページでは「やり方」（タイトル・概要・手順・種別など）を編集させない。
   *  そのランは既に起きたことの記録で、直すべきはテンプレート側だから */
  const contentLocked = node.fixed || !!runView;

  // パネルを開いた時点の「前回の既読時刻」を捕まえておく（下の effect が既読を更新する前に
  // useState 初期化子で読む。key={node.id} 再マウントなのでノードごとに一度だけ評価される）。
  // 未読バッジが付いていた理由＝この時刻より新しいメッセージ、を「ここから未読」区切りとして
  // スレッドに表示する（2026-08-02 本人要望「なぜ通知が付いているのか分かりづらい。
  // ノードを開いたときに分かるでいい」）
  // 既読キーは会話の単位（テンプレート / そのラン）で分かれる（2026-08-08。lib/unread.ts）
  const readKey = threadKey(node.id, runView?.id);
  const [unreadSince] = useState<string | null>(() => reads[readKey] ?? null);

  // スレッドを表示したら既読tsをサーバへ書く（thread取得のたびに更新=開いたまま新着が
  // 来ても「読んだ」扱いを追随させる）。サーバ側は巻き戻さない（max を採る）ので、
  // 別端末で先に進んだ既読をこちらが古い時刻で戻すことはない。
  // 送る値は**クライアントの現在時刻ではなく、スレッド最終メッセージの ts**（サーバが
  // 発行した時刻）にする: 未読判定は threadMeta（＝この ts）との大小比較なので、
  // 端末の時計がサーバより遅れていると「開いたのにバッジが消えない」が起き続ける
  // （2026-08-05 本人報告「青ドットが消えない」の再発防止）
  const lastThreadTs = thread?.messages?.length
    ? thread.messages[thread.messages.length - 1].ts
    : null;
  useEffect(() => {
    if (!lastThreadTs) return;
    postReads({ [readKey]: lastThreadTs });
  }, [lastThreadTs, readKey]);

  // Task AI が応答生成中（考え中）の間だけ2秒間隔でスレッドを取りにいく
  // （通常ポーリングは10秒。返事が着いてから最大10秒「考え中」が残るのを防ぐ）
  useEffect(() => {
    if (!thread?.aiBusy) return;
    const timer = window.setInterval(() => void refreshThread(), 2000);
    return () => window.clearInterval(timer);
  }, [thread?.aiBusy, refreshThread]);

  // 「見たら即消える」（2026-08-05 本人指示。それまでは1秒待ちだった）: 表示中のタブは、
  // スレッドが出た時点で未読扱いを解く（タブのドット・カード/レールのバッジ（onViewed 経由）
  // が対象）。見ていないタブのドットは、そのタブを開いた時点で消える。
  // 「ここから未読」の区切り線だけは開いている間ずっと残す——どこから読めばいいかの目印で、
  // 消えてしまうと開いた意味が無い（次に開いたときは既読が進んでいるので自然に消える）
  const [seenTabs, setSeenTabs] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!thread) return;
    setSeenTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
    // 既読の上書きも会話の単位で（ランのページで読んでもテンプレート側は未読のまま）
    onViewed?.(readKey, lastThreadTs);
  }, [thread !== null, tab, readKey, onViewed, lastThreadTs]);

  // 「既定」が実際に何か（⚙の実行AI設定）をセレクタのラベルに出す（2026-08-07 本人指摘）
  const aiDefaults = useAiDefaults();

  const title = useDraftField(node.title);
  // タイトルは折り返して全文見せる（2026-08-07 本人要望「タイトルを別段にして全文読みやすく」。
  // 旧: 1行 Input で長いタイトルは読めなかった）。textarea を内容の高さに追従させる
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [title.draft, node.id]);

  const detail = useDraftField(node.detail ?? "");

  // kind=trigger 用: 起動方式の記述（docs/design.md 3.8）
  const schedule = useDraftField(node.schedule ?? "");

  // 試走ゲート（docs/design.md 3.5.1）の鮮度。実装セクションの表示と昇格時警告の両方で使う
  const implStatus = useImplStatus(node);

  const patch = async (fields: NodePatchInput) => {
    await api.patchNode(node.id, fields);
    onMutated();
  };

  // ---- ラン投影（docs/design.md 3.8）: アクティブなラン（現在ページの status==="running"
  //      最新1本）がこのノードのワークアイテムを持っていれば、その進捗をパネルにも投影する。
  //      テンプレートの patch（patchNode）ではなく、ランのアイテムを更新する（api.patchRunItem） ----
  const activeRunItem = activeRun?.items[node.id] ?? null;

  // ページ（group）がトリガーを持つか＝ルーティーン配下か（docs/design.md 3.8）。
  // 進捗・出力の各所で使うため一度だけ導出して共有する
  const pageHasTrigger = useMemo(
    () => node.group != null && allNodes.some((n) => n.kind === "trigger" && n.group === node.group),
    [node.group, allNodes],
  );

  // 昇格時警告（ハードブロックしない。docs/design.md 3.5 近く）: 担当をscriptに変更する時、
  // または担当=scriptのノードで「プラン済みにする」を押す時、試走が ok でなければ確認する
  const confirmPromotionIfNeeded = async (): Promise<boolean> => {
    if (implStatus === "ok") return true;
    return confirmDialog(TRIAL_CONFIRM_MESSAGE, { confirmLabel: "続ける" });
  };

  const handleExecutorChange = async (v: Node["executor"]) => {
    if (v === "script" && !(await confirmPromotionIfNeeded())) return;
    await patch({ executor: v });
  };

  const saveTitle = async () => {
    title.setFocused(false);
    const t = title.draft.trim();
    if (t && t !== node.title) await patch({ title: t });
  };

  const saveDetail = async () => {
    detail.setFocused(false);
    if (detail.draft !== (node.detail ?? "")) await patch({ detail: detail.draft || null });
  };

  const saveSchedule = async () => {
    schedule.setFocused(false);
    if (schedule.draft !== (node.schedule ?? "")) await patch({ schedule: schedule.draft || null });
  };

  // ノード複製。作成後は新規ノードを選択する。
  // parents は複製元と同じ集合のままなので parentOptions（decision分岐の対応）もそのまま引き継げる。
  // kind=decision は branches が無いとサーバ検証で弾かれるためこちらも引き継ぐ（choiceは新規なので引き継がない）
  const handleDuplicate = async () => {
    try {
      const created = await api.addNode({
        title: node.title ? `${node.title}のコピー` : "のコピー",
        detail: node.detail,
        impl: node.impl,
        parents: node.parents,
        parentOptions: node.parentOptions,
        group: node.group,
        kind: node.kind,
        branches: node.branches,
        // 出力宣言も「やり方」の一部なので引き継ぐ（3.15）
        outputs: node.outputs,
        executor: node.executor,
        approval: node.approval,
        autonomy: node.autonomy,
        // 担当者・関係者も引き継ぐ（チーム化 2026-08-04）。createdBy は複製しない
        // ——サーバが「複製した人」を新たに刻む
        assignee: node.assignee,
        members: node.members,
        status: "pending",
        lifecycle: "draft",
      });
      onMutated();
      onSelect(created.id);
    } catch {
      // api() 側でトースト表示済み
    }
  };

  // 実行フェーズの原則（docs/design.md 3.9）: 分岐を選ぶのは lifecycle=committed かつ
  // 全 parents が done|skipped（frontier）のノードでのみ許可する。まだ順番が来ていない
  // ノードで実行系操作ができてしまわないための UI 側ガード（サーバ側は GraphStore.validateDecisionGate
  // が同じ規則で 409 を返す。ここでは事前にボタンを無効化して分かりやすくするだけ）。
  // 進捗ボタン（着手・完了）の frontier 判定と同じ導出なので一度だけ計算して共有する
  const isFrontier = useMemo(
    () =>
      node.parents.every((pid) => {
        const s = allNodes.find((n) => n.id === pid)?.status;
        return s === "done" || s === "skipped";
      }),
    [node.parents, allNodes],
  );
  const decisionGateOk =
    node.lifecycle === "committed" && isFrontier && node.status !== "dropped";

  const handleDelete = async () => {
    // ロック・メンバー持ち・子持ちでも削除は常にできる。危ないケースは削除前に
    // モーダルで教える（2026-08-01 本人指摘「消せないのは違う。ロックはモーダルで確認」）
    const impact = computeRemoveImpact([node.id], allNodes);
    // ページ（kind=goal / メンバー持ち）を消すときだけ「消さずにアーカイブする」を推しで
    // 並べる（2026-08-09 本人要望。左レールの削除と同じ選択肢）。ページ内の1ノードには
    // アーカイブという畳み先が無いので出さない
    const isPage = node.kind === "goal" || allNodes.some((n) => n.group === node.id);
    const canArchive = isPage && node.status !== "done" && node.status !== "dropped";
    const choice = await confirmWithAltDialog(
      buildRemoveMessage(
        `「${node.title || "（無題）"}」を削除しますか？（Ctrl+Z で戻せます）`,
        removeImpactWarnings(impact),
      ),
      {
        danger: true,
        confirmLabel: "削除",
        ...(canArchive ? { alt: { label: "アーカイブする" } } : {}),
      },
    );
    if (choice === "alt") {
      try {
        await api.patchNode(node.id, { status: "done" });
        onMutated();
      } catch {
        // エラーは api() 側でトースト表示済み
      }
      return;
    }
    if (choice !== "confirm") return;
    try {
      await api.removeNode(node.id, { force: true });
      onMutated();
      onClose();
    } catch {
      // エラーは api() 側でトースト表示済み
    }
  };

  const messages = thread?.messages ?? [];
  // 「新しい会話」区切り（payload.chatBreak）以降だけを会話タブに出す（2026-07-31 本人要望。
  // スレッドは経緯の正史なので消さない。Task AI の応答文脈も server 側で同じ区切りを尊重する）
  const lastBreak = findLastBreak(messages);
  const talkSource = lastBreak >= 0 ? messages.slice(lastBreak + 1) : messages;
  const filtered = (tab === "talk" ? talkSource : messages).filter((m) => inTab(m, tab));
  // 「ノード内ノードに展開」ボタンを出してよいか（実行の内訳＝実行記録の下に出す）。
  // ラン表示（runView）はラン作成時点のフォークを見せているだけで書き込み対象ではないので不可、
  // それ以外は kind=task・未Fix・このノードが今のグラフに実在する（allNodes は
  // App が runView 時は runNodes に差し替えるので、run 中に消えた/ラン専用の
  // ノードでは false になる。expand 自体は409で弾かれるがボタンは出さない側で先に絞る）
  const canExpandSubSteps = !runView && node.kind === "task" && !node.fixed && allNodes.some((n) => n.id === node.id);
  const pastSessions = splitSessions(messages);
  const currentTalk = talkSource.filter((m) => inTab(m, "talk"));
  // モバイルは「ノード詳細」か「会話」のどちらか一方だけを画面に出す（2026-08-02 本人指示
  // 「（詰まった会話節は）いらねぇっつってんだよ、その分上広げろよ」）。切替は一番下の
  // 「会話を広げる」トグル。デスクトップは従来どおり両方出す
  const showTalk = !isMobile || !metaOpen;
  // タブごとの未読ドット（2026-08-02 本人要望「ノード詳細のどこが未読なのか分からないので
  // ドットをつけてほしい」）。未読の実体はスレッドのメッセージなので、それを切り分けている
  // 3タブのどれに入るかを示す＝どのタブを見ればいいかが分かる。判定は Thread の
  // 「ここから未読」区切りと同じ unreadSince（パネルを開いた時点の前回既読時刻）基準なので、
  // 開いている間はタブを見に行っても消えない（区切り線と足並みを揃える）
  // 既読記録が無い（この端末では初見）ときは全部未読扱い。カード/レールのバッジと同じ規約に
  // 揃える（揃えないと「バッジは付いているのに開いてもドットが無い」になる。2026-08-02 本人報告）
  // 「見た（表示した）」タブのドットは即座に消す（2026-08-05 本人指示）。
  // 履歴タブの対象は**過去セッション（最後の「新しい会話」区切りより前）だけ**にする:
  // 履歴は会話の上位集合なので、同じ新着メッセージで会話と履歴の両方にドットが点き、
  // 会話を読んでも履歴側だけが残って消せなかった（2026-08-05 本人報告
  // 「履歴のところに出てる青ドットが全部見ても消えない」）
  const hasUnreadIn = (t: PanelTab) => {
    if (seenTabs.has(t)) return false;
    const source =
      t === "talk" ? talkSource : t === "history" ? messages.slice(0, lastBreak + 1) : messages;
    return source.some((m) => m.ts > (unreadSince ?? "") && inTab(m, t));
  };

  // 区切りも会話の単位（そのラン / テンプレート）に属する: ランのページで押したら
  // そのランの会話を区切る（テンプレート側のスレッドには触らない）
  const startNewTalk = async () => {
    try {
      await api.postChatBreak(node.id, runView?.id ?? null);
      refreshThread();
    } catch {
      // api() 側でトースト表示済み
    }
  };
  // 開いている判断リクエストは会話の流れではなく「ノード詳細とチャット欄の間」に固定表示する
  // （本人指定 2026-07-31）。タブに関わらず見える（履歴タブでも回答できる）
  const openRequests = messages.filter(
    (m) => m.kind === "decision_request" && m.requestStatus === "open",
  );

  return (
    <aside
      data-mobile-panel="right"
      // @container/panel: タブ行の段階縮小はビューポートでなく**パネルの実幅**で判定する
      // （パネルはドラッグでリサイズされるため md: では追従できず、狭くすると
      // タブと右肩ボタンの文字が重なっていた。2026-08-05 本人報告）
      // overflow-hidden はルートに付けない（リサイズハンドルの外側半分が切られる。2026-08-07）
      className="@container/panel relative flex flex-shrink-0 flex-col gap-3 border-l bg-background p-4"
      style={{ width }}
    >
      <div className="resize-handle resize-handle-left" onPointerDown={(e) => startResize(e, -1)} />
      <div className="flex items-center gap-2">
        {/* 何を開いているかの種別バッジ（2026-08-04 本人要望「プロジェクトかルーティーンか
            タスクかが分かるようにタイトルの左にバッジ」）。ページ（goal）はトリガーの有無で
            プロジェクト/ルーティーンに分かれる（PageList の節分けと同じ導出 = isRoutinePage） */}
        {(() => {
          const routine = node.kind === "goal" && isRoutinePage(node, allNodes);
          const label =
            node.kind === "goal"
              ? routine
                ? "ルーティーン"
                : "プロジェクト"
              : // 種別ラベルはノード上のチップと同じ語彙（実行/判断/トリガー）に統一
                // （2026-08-08 本人指摘「タスクとノードの表記ゆれ」——ここだけ「タスク」だった）
                KIND_JA[node.kind];
          return (
            <Hint
              id={node.kind === "goal" ? (routine ? "page-routine" : "page-project") : "kind"}
              always={`種別: ${label}`}
              text={
                node.kind === "goal"
                  ? routine
                    ? HINT_TEXT.pageRoutine
                    : HINT_TEXT.pageProject
                  : HINT_TEXT.kind
              }
            >
              <Badge variant="outline" className="flex-shrink-0 text-muted-foreground">
                {label}
              </Badge>
            </Hint>
          );
        })()}
        <span className="flex-1" />
        <Hint
          id="fixed"
          always={node.fixed ? "ロック済み" : "未ロック（改善中）"}
          text={HINT_TEXT.fixed}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            // Fix済み=濃く（緑の錠前）、未Fix=薄く（開いた錠前）
            className={node.fixed ? "text-ok" : "text-text-lo opacity-60"}
            onClick={() => patch({ fixed: !node.fixed })}
          >
            {node.fixed ? <Lock /> : <Unlock />}
          </Button>
        </Hint>
        <Hint
          id="node-duplicate"
          always="このノードを複製"
          text="依存・実装・担当なども引き継いだコピーを同じページに作る（進捗は待ちから）"
        >
          <Button type="button" variant="ghost" size="icon" onClick={handleDuplicate}>
            <Copy />
          </Button>
        </Hint>
        <Hint
          id="node-delete"
          always={node.fixed ? "このノードを削除（ロック中なので確認します）" : "このノードを削除"}
          text="Ctrl+Z で戻せる。子や依存の巻き添えがあるときは削除前に確認が出る"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleDelete}
          >
            <Trash2 />
          </Button>
        </Hint>
        {/* モバイルは下部タブバーでビューを移動するので ✕ は不要（2026-08-02 本人指示）。
            デスクトップはパネルを閉じる唯一の導線なので残す */}
        {!isMobile && (
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="閉じる">
            <X />
          </Button>
        )}
      </div>

      {/* タイトルは種別バッジ・ボタン行とは別段の全幅で、折り返して全文見せる
          （2026-08-07 本人要望「タイトルを別段にして全文読みやすく」。旧: 1行 Input で
          長いタイトルの後半が読めなかった）。Enter で確定（タイトルに改行は入れない） */}
      <textarea
        ref={titleRef}
        rows={1}
        className="w-full flex-shrink-0 resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-2 py-1 text-lg font-semibold leading-snug outline-none transition-colors hover:border-input focus-visible:border-input disabled:cursor-not-allowed disabled:opacity-60"
        value={title.draft}
        disabled={contentLocked}
        onFocus={() => title.setFocused(true)}
        onChange={(e) => title.setDraft(e.target.value.replace(/\n/g, ""))}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />

      <DecisionChoice
        node={node}
        runView={runView}
        activeRunItem={activeRunItem}
        decisionGateOk={decisionGateOk}
        onMutated={() => {
          onMutated();
          refreshThread();
        }}
      />

      {/* 担当×実装の不整合⚠（docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）:
          担当=script なのに impl が script でない=実行すると失敗する組み合わせ。
          常に見えるようにする（メタ折りたたみの外）。NodeCard 側にも同じ理由で⚠バッジを出す。
          kind=trigger は対象外——トリガーの executor=script は「schedule でランを作る」の意味で
          あって command 実行ではない（docs/design.md 3.8）ため、impl 不要 */}
      {node.executor === "script" && node.kind !== "trigger" && node.impl?.type !== "script" && (
        <div
          className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          title="担当がスクリプトなのに実装がスクリプトでない＝実行すると失敗する。実装欄でコマンドを設定するか担当を変える"
        >
          <Icon name="alert" size={13} />
          実装が未接続
        </div>
      )}

      {/* 操作の主役は「詳細をたたむ」ではなく「会話を広げる」（2026-07-31 本人指定）。
          既定は会話が広い状態（メタ非表示）で、切替はタブ行の右端のボタンが担う。
          セクション全体が縦に長くなってもパネル（overflow-hidden）から溢れないよう
          スクロール容器で包む（2026-08-02 スクロール不能バグ修正の一環） */}
      {metaOpen && (
        <div
          className={cn(
            "flex min-h-0 flex-col gap-3 overflow-y-auto",
            // モバイルで詳細を開いている間は会話節を出さないので、空いたぶんを全部ここに回す
            // （2026-08-02 本人指示「その分上広げろよ」）。デスクトップは会話と同居するので
            // 従来どおり上限60%の縮む節のまま
            showTalk ? "flex-shrink-0 basis-auto" : "flex-1",
          )}
          style={showTalk ? { maxHeight: "60%" } : undefined}
        >
          {/* Fix実効化の注記（docs/design.md 3.5）: ロック中は「やり方」フィールドの編集UIを
              disabled にする。進捗（status）・params の値・試走・Fixトグル自体は生かしたまま */}
          {runView ? (
            <p className="text-xs text-muted-foreground">
              このランの記録（{runView.title}）。やり方を直すときはテンプレート（設計図）側で
            </p>
          ) : (
            node.fixed && (
              <p className="text-xs text-muted-foreground">🔒 ロック中（編集するには解除）</p>
            )
          )}

          {/* max-h + overflow: Textarea は field-sizing-content で中身に合わせて伸び続けるため、
              長文だとパネル（overflow-hidden）からはみ出て下半分に到達できなくなる
              （2026-08-02 本人報告「本文が長い場合スクロールが効かない」）。上限を付けて
              内部スクロールに切り替える */}
          <Textarea
            className="max-h-48 overflow-y-auto"
            placeholder="概要"
            value={detail.draft}
            disabled={contentLocked}
            onFocus={() => detail.setFocused(true)}
            onChange={(e) => detail.setDraft(e.target.value)}
            onBlur={saveDetail}
            rows={3}
          />

          {/* ラン投影中に「そのランの時点では何と書いてあったか」を出す（2026-08-08）。
              今と同じなら何も出ない。上の欄は常に**今**のテンプレートで、編集もそちらに効く */}
          <RunTimeNote run={activeRun} node={node} />

          {/* トリガーの起動方式（docs/design.md 3.8）。human は手動でランを作る操作(▶)のみなので欄自体を出さない。
              script=cron的なランを作る条件、ai=ラン作成要否を判定させる間隔 */}
          {node.kind === "trigger" &&
            (node.executor === "human" ? (
              <p className="text-xs text-muted-foreground">手動開始のみ（ノードの ▶ から開始）</p>
            ) : (
              <Input
                placeholder={
                  node.executor === "ai"
                    ? "チェック間隔: every 1h（条件は detail や手順書に書く）"
                    : "every 15m / daily 09:00 / weekly mon 09:00"
                }
                value={schedule.draft}
                disabled={contentLocked}
                onFocus={() => schedule.setFocused(true)}
                onChange={(e) => schedule.setDraft(e.target.value)}
                onBlur={saveSchedule}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
            ))}

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              <Hint id="kind" text={HINT_TEXT.kind}>
                <span className="self-start">種別</span>
              </Hint>
              <Select
                value={node.kind}
                disabled={contentLocked}
                onValueChange={(v) => {
                  const kind = v as Node["kind"];
                  // decision に切り替えた時、branches が未設定なら既定2枝を立てる（docs/design.md 3.9）
                  if (kind === "decision" && !node.branches) {
                    patch({
                      kind,
                      branches: [
                        { id: "a", label: "A" },
                        { id: "b", label: "B" },
                      ],
                    });
                  } else {
                    patch({ kind });
                  }
                }}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(KIND_OPTIONS.includes(node.kind) ? KIND_OPTIONS : [node.kind, ...KIND_OPTIONS]).map(
                    (k) => (
                      <SelectItem key={k} value={k} disabled={!KIND_OPTIONS.includes(k)}>
                        {KIND_JA[k]}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              {/* 最重要ヒント（2026-08-05 本人指定）: 担当=「誰がその作業を始めるのか」 */}
              <Hint id="executor" text={HINT_TEXT.executor}>
                <span className="self-start">担当</span>
              </Hint>
              <Select
                value={node.executor}
                disabled={contentLocked}
                onValueChange={(v) => handleExecutorChange(v as Node["executor"])}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EXECUTOR_OPTIONS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {EXECUTOR_JA[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {/* 担当者（チーム化 2026-08-04）: 担当=人間のノードで「人間の誰がやるか」（単数）。
                やり方（Fix対象）ではなく実行の割当なので、ロック中も変更できる。
                ロスターが2人未満の運用では出さない（degrade 原則） */}
            {teamEnabled && node.executor === "human" && (
              <label className="col-span-2 flex flex-col gap-1 text-sm text-muted-foreground">
                <Hint id="assignee" text={HINT_TEXT.assignee}>
                  <span className="self-start">担当者</span>
                </Hint>
                <Select
                  // 大文字小文字の表記ゆれはロスター側の表記に寄せて選択状態にする
                  // （メール比較は sameEmail。2026-08-04 追修）。無効化ユーザーは候補に
                  // 出ないため、現在値が無効化済みなら下のフォールバック項目の値に寄せる
                  value={
                    users.find((u) => !u.disabled && sameEmail(u.email, node.assignee))?.email ??
                    node.assignee ??
                    "none"
                  }
                  onValueChange={(v) => patch({ assignee: v === "none" ? null : v })}
                >
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">未割当</SelectItem>
                    {/* 無効化ユーザーは新規割当の候補から除外（2026-08-04 アカウント管理） */}
                    {users
                      .filter((u) => !u.disabled)
                      .map((u) => (
                        <SelectItem key={u.email} value={u.email}>
                          {displayNameOf(u.email, users)}
                        </SelectItem>
                      ))}
                    {/* ロスターから消えた・無効化されたメールが残っている場合も、現在値として
                        表示名で見えて解除できるようにする */}
                    {node.assignee &&
                      !users.some((u) => !u.disabled && sameEmail(u.email, node.assignee)) && (
                        <SelectItem value={node.assignee}>
                          {displayNameOf(node.assignee, users)}
                        </SelectItem>
                      )}
                  </SelectContent>
                </Select>
              </label>
            )}
            {/* 承認ゲートは「機械（AI/スクリプト）の仕事」の直前に挟まるもの。担当=人間の
                ノードでは本人の操作が承認そのものなのでトグルを出さない（既に irreversible の
                ノードだけは解除できるよう表示する）。トリガーでは意味が「ラン前承認」になる
                （script の定刻ラン作成・AI の自動のラン作成の直前にゲート。手動▶はそのままラン作成） */}
            {(node.executor !== "human" || node.approval) && (
              <label className="col-span-2 flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                {/* 「?」アイコンは廃止し、ラベル自体のマウスオーバーに統一（2026-08-05 本人指定） */}
                <Hint id="approval" text={HINT_TEXT.approval}>
                  <span>{node.kind === "trigger" ? "開始前承認" : "実行前承認"}</span>
                </Hint>
                <Switch
                  checked={node.approval}
                  disabled={contentLocked}
                  onCheckedChange={(v) => patch({ approval: v })}
                />
              </label>
            )}
            {/* 自律度（autonomy）は AI が実行するタスクにだけ意味を持つ。
                高=人間に聞かず進む（失敗もまず自動リトライ）/ 標準=必要なときだけ質問 /
                低=迷ったら人間に質問するほうへ倒す。実行前承認（approval）は自律度では外れない */}
            {node.kind === "task" && node.executor === "ai" && (
              <label className="col-span-2 flex flex-col gap-1 text-sm text-muted-foreground">
                <Hint id="autonomy" text={HINT_TEXT.autonomy}>
                  <span className="self-start">自律度</span>
                </Hint>
                <Select
                  value={node.autonomy}
                  disabled={contentLocked}
                  onValueChange={(v) => patch({ autonomy: v as Node["autonomy"] })}
                >
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="high">高（聞かずに進む）</SelectItem>
                    <SelectItem value="normal">標準（必要なときだけ質問）</SelectItem>
                    <SelectItem value="low">低（積極的に相談）</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            )}
            {/* AI のモデル・エフォート（2026-08-07 本人要望「切り替えられるように」）。
                このノードの実行AI・Task AI に適用。既定 = 設定（⚙）の実行AIの値を
                実値で見せる（2026-08-07 本人指摘「既定が何なのか書いて」）。
                params[].value と同じ実行時チューニングなのでロック中も変更できる */}
            {node.executor === "ai" && (
              <>
                <label className="flex flex-col gap-1 text-sm text-muted-foreground">
                  <span className="self-start">AIモデル</span>
                  <Select
                    value={node.aiModel ?? "default"}
                    onValueChange={(v) => patch({ aiModel: v === "default" ? null : v })}
                  >
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">
                        {aiDefaults ? `${modelLabel(aiDefaults.engineModel)}（既定）` : "既定（設定に従う）"}
                      </SelectItem>
                      <SelectItem value="opus">Opus 5</SelectItem>
                      <SelectItem value="sonnet">Sonnet 5</SelectItem>
                      <SelectItem value="haiku">Haiku 4.5</SelectItem>
                      {/* 設定・MCP 等で直接入った値もそのまま見えて解除できるようにする */}
                      {node.aiModel && !["opus", "sonnet", "haiku"].includes(node.aiModel) && (
                        <SelectItem value={node.aiModel}>{node.aiModel}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-muted-foreground">
                  <span className="self-start">思考の深さ</span>
                  <Select
                    value={node.aiEffort ?? "default"}
                    onValueChange={(v) =>
                      patch({ aiEffort: v === "default" ? null : (v as Node["aiEffort"]) })
                    }
                  >
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">
                        {aiDefaults ? `${effortLabel(aiDefaults.engineEffort)}（既定）` : "既定（設定に従う）"}
                      </SelectItem>
                      <SelectItem value="low">低</SelectItem>
                      <SelectItem value="medium">中</SelectItem>
                      <SelectItem value="high">高</SelectItem>
                      <SelectItem value="xhigh">超高</SelectItem>
                      <SelectItem value="max">最大</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </>
            )}
            <StatusSection
              node={node}
              activeRun={activeRun}
              activeRunItem={activeRunItem}
              runView={runView}
              pageHasTrigger={pageHasTrigger}
              isFrontier={isFrontier}
              patch={patch}
              onMutated={onMutated}
              confirmPromotionIfNeeded={confirmPromotionIfNeeded}
            />
          </div>

          <MembersSection node={node} allNodes={allNodes} patch={patch} />

          <ImplSection
            node={node}
            activeRun={activeRun}
            activeRunItem={activeRunItem}
            runView={runView}
            contentLocked={contentLocked}
            implStatus={implStatus}
            patch={patch}
            onMutated={onMutated}
            refreshThread={refreshThread}
          />

          <OutputsSection
            node={node}
            runView={runView}
            contentLocked={contentLocked}
            pageHasTrigger={pageHasTrigger}
            patch={patch}
          />

          <BranchesEditor node={node} contentLocked={contentLocked} patch={patch} />

          {/* 作成者の刻印は関係者セクション内の「作成者: ○○」に統一した（2026-08-04 追修。
              旧: 非 goal はここに「作成: ○○」を出していたが、関係者を全ノード種へ開放したので重複） */}
        </div>
      )}

      {openRequests.map((m) => (
        <DecisionCard
          key={m.id}
          message={m}
          nodeId={node.id}
          onMutated={() => {
            onMutated();
            refreshThread();
          }}
        />
      ))}

      {/* タブ行。「新しい会話」はタブと同じ行に置く（2026-08-02 本人要望）。折り返し禁止は
          index.css 側で data-tabrow を wrap 規則から除外。「会話を広げる」はモバイルでは
          一番下の行へ移した（同日の本人指示）ので、ここに並ぶのはデスクトップのときだけ */}
      {showTalk && (
      <div data-tabrow className="flex items-center justify-between gap-1">
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as PanelTab);
            // タブを離れたら履歴のセッション詳細は閉じる（次に開いたときは一覧から）
            setHistorySessionId(null);
          }}
          className="min-w-0 gap-3"
        >
          {/* パネルが狭い（24rem未満）ときはタブをアイコンだけにして1行に収める
              （文字の重なり対策。アイコンは3タブとも既にあるので誤読しない） */}
          <TabsList>
            <TabsTrigger value="talk">
              <MessageSquare className="size-3.5" />
              <span className="@max-[24rem]/panel:hidden">会話</span>
              {hasUnreadIn("talk") && <UnreadDot />}
            </TabsTrigger>
            <Hint id="tab-history" text="「新しい会話」で区切った過去の会話。一覧から選んで読み返せる">
              <TabsTrigger value="history">
                <History className="size-3.5" />
                <span className="@max-[24rem]/panel:hidden">履歴</span>
                {hasUnreadIn("history") && <UnreadDot />}
              </TabsTrigger>
            </Hint>
            <Hint id="tab-log" text="エンジンの実行・テスト実行・状態変化・成果物の記録（会話とは別ストリーム）">
              <TabsTrigger value="log">
                <ScrollText className="size-3.5" />
                <span className="@max-[24rem]/panel:hidden">実行記録</span>
                {hasUnreadIn("log") && <UnreadDot />}
              </TabsTrigger>
            </Hint>
          </TabsList>
        </Tabs>
        <span className="flex shrink-0 items-center">
        {/* 狭いときはラベルを落としてアイコンだけにする（2026-08-02 本人指示
            「新しい会話ボタンは入りきってないからアイコンに」）。判定はビューポート（md:）
            でなくパネルの実幅（@container。2026-08-05 重なり修正）。右肩のトグルは
            文字のままにしたいので、縮めるのはこちらだけ */}
        <Hint
          id="chat-new"
          always="新しい会話"
          text="ここまでの会話を区切って新しく始める（過去分は履歴タブに残る）"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="px-2 text-muted-foreground @min-[27rem]/panel:px-3"
            aria-label="新しい会話"
            onClick={() => void startNewTalk()}
          >
            <MessageSquarePlus className="size-3.5 @min-[27rem]/panel:hidden" />
            <span className="hidden @min-[27rem]/panel:inline">新しい会話</span>
          </Button>
        </Hint>
        {/* トグルは元どおりタブ行の右肩（＝会話の上）。モバイルでノード詳細だけを出して
            いる間はこのタブ行ごと消えるので、そのときだけ一番下の行に同じボタンを出す
            （下の isMobile && metaOpen のブロック） */}
        {(
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setMetaOpen((v) => !v)}
          >
            {metaOpen ? (
              <>
                <ChevronUp className="size-3.5" /> 会話を広げる
              </>
            ) : (
              <>
                <ChevronDown className="size-3.5" /> ノード詳細
              </>
            )}
          </Button>
        )}
        </span>
      </div>
      )}

      {showTalk && tab === "history" ? (
        <HistoryTab
          nodeId={node.id}
          currentTalk={currentTalk}
          pastSessions={pastSessions}
          openedSessionId={historySessionId}
          onOpenSession={setHistorySessionId}
          onShowTalk={() => setTab("talk")}
          onMutated={() => {
            onMutated();
            refreshThread();
          }}
        />
      ) : showTalk ? (
      <Thread
        nodeId={node.id}
        messages={filtered}
        // 「ここから未読」区切りは開いている間ずっと残す（ドットは即消えるが、
        //  どこから読めばいいかの目印は読み終わるまで要る。2026-08-05）
        unreadSince={unreadSince}
        aiBusy={thread?.aiBusy ?? false}
        aiQueued={thread?.aiQueued ?? false}
        showReplyBox={tab === "talk"}
        // 書き込み先もこのランの会話（テンプレート側の相談とは混ざらない。2026-08-08）
        runId={runView?.id ?? null}
        // 入力欄のモデル/エフォート切替（共通コンポーネント化 2026-08-07）。
        // 変更はこのノードの aiModel/aiEffort として保存され、Task AI・実行AI 両方に効く
        aiModel={node.aiModel}
        aiEffort={node.aiEffort}
        onAiModelChange={runView ? undefined : (v) => patch({ aiModel: v })}
        onAiEffortChange={runView ? undefined : (v) => patch({ aiEffort: v as Node["aiEffort"] })}
        canExpand={canExpandSubSteps}
        onMutated={() => {
          onMutated();
          refreshThread();
        }}
      />
      ) : null}

      {/* モバイルでノード詳細だけを出しているときの戻り口。タブ行（右肩のトグル）が
          消えている状態なので、ここに同じボタンを出して会話へ切り替える。
          右寄せ＝デスクトップの右肩と同じ側に揃える（2026-08-02 本人指示
          「デスクトップと変えなくていいところは変えたくない」） */}
      {isMobile && metaOpen && (
        <div className="flex flex-shrink-0 justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setMetaOpen((v) => !v)}
        >
          {metaOpen ? (
            <>
              <ChevronUp className="size-3.5" /> 会話を広げる
            </>
          ) : (
            <>
              <ChevronDown className="size-3.5" /> ノード詳細
            </>
          )}
        </Button>
        </div>
      )}
    </aside>
  );
}
