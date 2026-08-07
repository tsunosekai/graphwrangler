import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Copy,
  ExternalLink,
  History,
  Loader2,
  Lock,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  ScrollText,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { effortLabel, modelLabel, useAiDefaults } from "../lib/aiDefaults";
import { api, postReads, type NodePatchInput } from "../lib/api";
import { confirmDialog, promptDialog } from "../lib/dialogs";
import { HINT_TEXT } from "../lib/hints";
import { buildRemoveMessage, computeRemoveImpact, removeImpactWarnings } from "../lib/removal";
import { useIsMobile } from "../hooks/useIsMobile";
import { isRoutinePage } from "../lib/routine";
import { usePolling } from "../hooks/usePolling";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { sha256Hex } from "../lib/hash";
import { missingParamNames } from "../lib/params";
import { colorOf, displayNameOf, effectiveMembers, sameEmail, turnIsMine, useTeam } from "../lib/team";
import { pushToast } from "../lib/toast";
import { cn } from "../lib/utils";
import type { MaterializedMessage, Node, NodeBranch, Run, RunItemStatus, ScriptParam, Status } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";
import { DecisionCard } from "./DecisionCard";
import { Hint } from "./Hint";
import { Icon } from "./Icon";
import { StatusCircle } from "./StatusCircle";
import { Thread } from "./Thread";

interface Props {
  node: Node;
  /** 実行フェーズゲート（docs/design.md 3.9）の判定に使う全ノード。分岐の親の status を見る */
  allNodes: Node[];
  /** アクティブなラン（docs/design.md 3.8）。現在ページの status==="running" 最新1本。
   *  無ければ null——このノードがルーティーンのテンプレートメンバーなら現行の注記のまま */
  activeRun: Run | null;
  /** ノードid → 既読時刻（サーバ持ち。2026-08-02 localStorage から移行＝端末間で一致） */
  reads: Record<string, string>;
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

/** 履歴カードに出す「最初の人間の発言の先頭40字」（GraphWrangler AI＝ChatDrawer の
 *  firstUserPreview と同じ規約。履歴タブの見た目を両者でそろえる） */
function firstHumanPreview(messages: MaterializedMessage[]): string {
  const first = messages.find((m) => m.kind === "say" && m.author.kind === "human");
  return (first?.body ?? "").slice(0, 40) || "(発言なし)";
}
const KIND_JA: Record<Node["kind"], string> = {
  task: "実行",
  decision: "判断",
  trigger: "トリガー",
  goal: "ゴール（ページ）",
  // 左レールの整理棚（2026-08-05）。パネルからは開かないが型のため網羅
  folder: "フォルダ",
};
const EXECUTOR_OPTIONS: Node["executor"][] = ["human", "ai", "script"];
const EXECUTOR_JA: Record<Node["executor"], string> = { human: "人間", ai: "AI", script: "スクリプト" };
// 実装セクションのラベルは担当連動（docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）:
// human=読む手順書 / ai=実行時プロンプトへインライン / script=command 実行
const IMPL_LABEL_BY_EXECUTOR: Record<Node["executor"], string> = {
  human: "手順書",
  ai: "プロンプト（手順書）",
  script: "スクリプト",
};
type ImplTypeOption = "none" | "doc" | "script";
/** 試走状態の4値（試走ゲート。docs/design.md 3.5.1）。hash は server の sha256Hex と
 *  同じ値を Web Crypto で計算して突き合わせる */
type ImplStatusUi = "ok" | "stale" | "unverified" | "not-script";
const TRIAL_CONFIRM_MESSAGE = "スクリプトのテスト実行が成功していません。このまま続けますか？";
// 進捗ラベルのヒント（プロジェクトの進捗とラン投影の進捗、2箇所で同じ id="status" を使う）
const STATUS_HINT =
  "未計画=やり方が決まっていない（エンジンは実行しない）。計画済みにすると待ちになり、前のノードが終わると着手できる。スキップ=分岐で選ばれなかった枝";
// 進捗はドロップダウンでなくボタン遷移（2026-07-31 本人指定）。
// 人間の語彙: 未計画 →[プラン済みにする]→ 待ち →[着手]→ 進行中 →[完了]。
// 待ち/進行中は人間ノードでは「やってるかどうかの目印」、AI/スクリプトでは機械が動かす。
// 中止(dropped)は選択肢から廃止（消すならノード削除。Ctrl+Zで戻せる）。
// waiting は保存値でなく導出値（pendingRequest あり / ランアイテムの waiting）
const STATUS_JA: Record<Status, string> = {
  unplanned: "未計画",
  pending: "待ち",
  running: "進行中",
  waiting: "あなたの番（回答待ち）",
  done: "完了",
  dropped: "中止",
  skipped: "スキップ",
};

/** decision の枝の新規id採番: b1, b2, ... の空いている最初の番号（既存idは変更しない。docs/design.md 3.9） */
function nextBranchId(existing: NodeBranch[]): string {
  let i = 1;
  while (existing.some((b) => b.id === `b${i}`)) i++;
  return `b${i}`;
}

/** 分岐エディタの1行。ラベルを入力→blurで確定（title/detailと同じ「編集中は自分のdraftを見る」流儀） */
function BranchRow({
  branch,
  disableRemove,
  disabled,
  onCommit,
  onRemove,
}: {
  branch: NodeBranch;
  disableRemove: boolean;
  /** Fix済み（やり方確定=ロック）のノードでは枝編集自体を止める（docs/design.md 3.5 実効化） */
  disabled?: boolean;
  onCommit: (label: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(branch.label);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(branch.label);
  }, [branch.label, focused]);

  return (
    <div className="flex items-center gap-1.5">
      <Input
        className="h-8 flex-1"
        value={draft}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false);
          const t = draft.trim();
          if (t && t !== branch.label) onCommit(t);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <Hint id="branch-remove" always="この枝を削除">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || disableRemove}
          // disabled 理由だけは native title（disabled にはポインタイベントが来ない）
          title={disabled ? "ロック中は編集できません" : disableRemove ? "分岐は最低2つ必要です" : undefined}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </Hint>
    </div>
  );
}

/** パラメータ宣言(1件)の値入力行（docs/design.md 3.5.1）。宣言（name/label/example）は
 *  GraphWrangler AI が書く前提で v1 では追加/削除UIを持たず、値の編集だけを行う。
 *  blur で確定する流儀は title/detail/BranchRow と同じ */
function ParamRow({ param, onCommit }: { param: ScriptParam; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(param.value ?? "");
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(param.value ?? "");
  }, [param.value, focused]);

  return (
    <div className="flex items-center gap-1.5">
      <span
        className="w-24 flex-shrink-0 truncate text-xs text-muted-foreground"
        title={param.name}
      >
        {param.label ?? param.name}
      </span>
      <Input
        className="h-8 flex-1"
        value={draft}
        placeholder={param.example ?? undefined}
        onFocus={() => setFocused(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false);
          if (draft !== (param.value ?? "")) onCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

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
// ワークスペースの GitHub リンク基底（手順書パス右のアイコンリンク。2026-08-07 本人要望）。
// remote は運用中に変わらないのでモジュールで1回だけ取得して共有する
let githubBaseCache: string | null | undefined; // undefined = 未取得
function useGithubBlobBase(): string | null {
  const [base, setBase] = useState<string | null>(githubBaseCache ?? null);
  useEffect(() => {
    if (githubBaseCache !== undefined) return;
    githubBaseCache = null; // 取得中の多重リクエストを防ぐ（失敗時もリンク無しに倒す）
    void api
      .getWorkspaceInfo()
      .then((info) => {
        githubBaseCache = info.githubBlobBase ?? null;
        setBase(githubBaseCache);
      })
      .catch(() => {
        // 旧サーバ（githubBlobBase 無し）や取得失敗はリンク無しでよい
      });
  }, []);
  return base;
}

export function NodePanel({ node, allNodes, activeRun, reads, onViewed, onMutated, onClose, onSelect }: Props) {
  // 会話=今の会話 / 履歴=過去の会話（GraphWrangler AI の「履歴」と同じ意味） / 実行記録=status・artifact
  // （2026-08-02 本人要望「会話の履歴と実行の履歴を分けてほしい」で2タブ→3タブ化。
  // それまで「新しい会話」で区切った過去の会話は UI のどこからも見えなくなっていた）
  const isMobile = useIsMobile();
  // チーム化（2026-08-04）: ロスターとログイン情報。人系UI（担当者・関係者）は enabled
  // （ロスター2人以上）のときだけ出す（degrade 原則）
  const { me, users, enabled: teamEnabled } = useTeam();
  // 「あなたの番」（waiting）が自分の番か（assignee が他人なら橙にしない。lib/team.ts で一元化）
  const turnMine = turnIsMine(node.assignee, me.email);
  const [tab, setTab] = useState<"talk" | "history" | "log">("talk");
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
  const { data: thread, refresh: refreshThread } = usePolling(() => api.getThread(node.id), 10000);

  // パネルを開いた時点の「前回の既読時刻」を捕まえておく（下の effect が既読を更新する前に
  // useState 初期化子で読む。key={node.id} 再マウントなのでノードごとに一度だけ評価される）。
  // 未読バッジが付いていた理由＝この時刻より新しいメッセージ、を「ここから未読」区切りとして
  // スレッドに表示する（2026-08-02 本人要望「なぜ通知が付いているのか分かりづらい。
  // ノードを開いたときに分かるでいい」）
  const [unreadSince] = useState<string | null>(() => reads[node.id] ?? null);

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
    postReads({ [node.id]: lastThreadTs });
  }, [lastThreadTs, node.id]);

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
    onViewed?.(node.id, lastThreadTs);
  }, [thread !== null, tab, node.id, onViewed, lastThreadTs]);

  const githubBase = useGithubBlobBase();
  // 「既定」が実際に何か（⚙の実行AI設定）をセレクタのラベルに出す（2026-08-07 本人指摘）
  const aiDefaults = useAiDefaults();

  const [titleDraft, setTitleDraft] = useState(node.title);
  const [titleFocused, setTitleFocused] = useState(false);
  useEffect(() => {
    if (!titleFocused) setTitleDraft(node.title);
  }, [node.title, titleFocused]);
  // タイトルは折り返して全文見せる（2026-08-07 本人要望「タイトルを別段にして全文読みやすく」。
  // 旧: 1行 Input で長いタイトルは読めなかった）。textarea を内容の高さに追従させる
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [titleDraft, node.id]);

  const [detailDraft, setDetailDraft] = useState(node.detail ?? "");
  const [detailFocused, setDetailFocused] = useState(false);
  useEffect(() => {
    if (!detailFocused) setDetailDraft(node.detail ?? "");
  }, [node.detail, detailFocused]);

  // kind=trigger 用: 起動方式の記述（docs/design.md 3.8）
  const [scheduleDraft, setScheduleDraft] = useState(node.schedule ?? "");
  const [scheduleFocused, setScheduleFocused] = useState(false);
  useEffect(() => {
    if (!scheduleFocused) setScheduleDraft(node.schedule ?? "");
  }, [node.schedule, scheduleFocused]);

  // 実装（impl）編集ドラフト（title/detail/schedule と同じ「編集中は自分のdraftを見る」流儀）
  const [implPathFocused, setImplPathFocused] = useState(false);
  const [implPathDraft, setImplPathDraft] = useState(
    node.impl?.type === "doc" ? (node.impl.path ?? "") : "",
  );
  useEffect(() => {
    if (!implPathFocused) setImplPathDraft(node.impl?.type === "doc" ? (node.impl.path ?? "") : "");
  }, [node.impl, implPathFocused]);

  const [implTextFocused, setImplTextFocused] = useState(false);
  const [implTextDraft, setImplTextDraft] = useState(
    node.impl?.type === "doc" ? (node.impl.text ?? "") : "",
  );
  useEffect(() => {
    if (!implTextFocused) setImplTextDraft(node.impl?.type === "doc" ? (node.impl.text ?? "") : "");
  }, [node.impl, implTextFocused]);

  const [implCommandFocused, setImplCommandFocused] = useState(false);
  const [implCommandDraft, setImplCommandDraft] = useState(
    node.impl?.type === "script" ? node.impl.command : "",
  );
  useEffect(() => {
    if (!implCommandFocused) setImplCommandDraft(node.impl?.type === "script" ? node.impl.command : "");
  }, [node.impl, implCommandFocused]);

  // 試走ゲート: command の sha256 を UI 側でも計算し（Web Crypto は非同期）、implTrial.hash と
  // 突き合わせて鮮度を見る（packages/server/src/trial.ts の sha256Hex と同じ値になる）
  const [scriptHash, setScriptHash] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (node.impl?.type === "script") {
      sha256Hex(node.impl.command).then((h) => {
        if (!cancelled) setScriptHash(h);
      });
    } else {
      setScriptHash(null);
    }
    return () => {
      cancelled = true;
    };
  }, [node.impl]);

  const implStatus: ImplStatusUi = useMemo(() => {
    if (!node.impl || node.impl.type !== "script") return "not-script";
    if (!node.implTrial) return "unverified";
    if (scriptHash === null) return "unverified"; // ハッシュ計算中は保留（「未検証」扱い）
    if (node.implTrial.hash !== scriptHash) return "stale";
    return node.implTrial.success ? "ok" : "unverified";
  }, [node.impl, node.implTrial, scriptHash]);

  // パラメータ宣言の未入力チェック（docs/design.md 3.5.1）。試走ボタンの disabled 判定に使う
  const missingParams = useMemo(
    () => (node.impl?.type === "script" ? missingParamNames(node.impl.command, node.impl.params) : []),
    [node.impl],
  );

  const [trialRunning, setTrialRunning] = useState(false);
  const runTrial = async () => {
    if (trialRunning) return;
    setTrialRunning(true);
    try {
      const result = await api.trialNode(node.id);
      onMutated();
      refreshThread();
      pushToast(
        result.success ? "テスト成功" : `テスト失敗（exit ${result.exitCode ?? "?"}）`,
        result.success ? "info" : "error",
      );
    } catch {
      // api() 側でトースト表示済み
    } finally {
      setTrialRunning(false);
    }
  };

  const patch = async (fields: NodePatchInput) => {
    await api.patchNode(node.id, fields);
    onMutated();
  };

  // ---- ラン投影（docs/design.md 3.8）: アクティブなラン（現在ページの status==="running"
  //      最新1本）がこのノードのワークアイテムを持っていれば、その進捗をパネルにも投影する。
  //      テンプレートの patch（patchNode）ではなく、ランのアイテムを更新する（api.patchRunItem） ----
  const activeRunItem = activeRun?.items[node.id] ?? null;
  // ラン内フロンティア: 親の「ランのアイテム」が全部 done|skipped か（親がトリガー等でランに
  // アイテムを持たない場合は「既に発火済み」として満たしている扱い。GraphView と同じ規則）
  const runFrontier = !!(
    activeRun &&
    node.parents.every((pid) => {
      const st = activeRun.items[pid]?.status;
      return st === undefined || st === "done" || st === "skipped";
    })
  );
  const [runItemBusy, setRunItemBusy] = useState(false);
  const patchRunItemStatus = async (status: RunItemStatus) => {
    if (!activeRun || runItemBusy) return;
    setRunItemBusy(true);
    try {
      await api.patchRunItem(activeRun.id, node.id, { status });
      onMutated();
    } catch {
      // api() 側でトースト表示済み
    } finally {
      setRunItemBusy(false);
    }
  };

  // 実装の種類セレクトの変更。中身（path/text/command）は種類を跨いで保持しない
  // （doc⇔scriptは別素材のため引き継ぐ意味が薄い。desk のFix定義通り「素材」の切替）
  const setImplType = async (v: ImplTypeOption) => {
    if (v === "none") {
      await patch({ impl: null });
      return;
    }
    if (v === "doc") {
      const cur = node.impl?.type === "doc" ? node.impl : null;
      await patch({ impl: { type: "doc", text: cur?.text ?? null, path: cur?.path ?? null } });
      return;
    }
    await patch({ impl: { type: "script", command: node.impl?.type === "script" ? node.impl.command : "" } });
  };

  const saveImplPath = async () => {
    setImplPathFocused(false);
    if (node.impl?.type !== "doc") return;
    const v = implPathDraft.trim() || null;
    if (v !== (node.impl.path ?? null)) await patch({ impl: { type: "doc", text: node.impl.text ?? null, path: v } });
  };

  const saveImplText = async () => {
    setImplTextFocused(false);
    if (node.impl?.type !== "doc") return;
    const v = implTextDraft || null;
    if (v !== (node.impl.text ?? null)) await patch({ impl: { type: "doc", text: v, path: node.impl.path ?? null } });
  };

  // 手順書の本文をワークスペース内ファイルへ書き出し、path 参照へ切り替える
  // （2026-08-02 本人要望「実装の手順をドキュメント化（ファイル化）する機能」）。
  // 未保存の下書きがあれば先に保存してから、サーバの to-file を呼ぶ
  const fileifyImplDoc = async () => {
    await saveImplText();
    if (!implTextDraft.trim()) return;
    const safeName = (node.title || node.id).replace(/[\\/:*?"<>|]/g, "_").trim() || node.id;
    const filePath = await promptDialog(
      "ファイル化先のパス（ワークスペースルートからの相対）",
      { defaultValue: `docs/${safeName}.md`, confirmLabel: "ファイル化" },
    );
    if (!filePath) return;
    try {
      await api.implToFile(node.id, filePath);
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("既にファイル"))) return; // トーストは api() 側
      const ok = await confirmDialog(`「${filePath}」は既にあります。上書きしますか？`, {
        danger: true,
        confirmLabel: "上書き",
      });
      if (!ok) return;
      try {
        await api.implToFile(node.id, filePath, { overwrite: true });
      } catch {
        return;
      }
    }
    pushToast(`手順書をファイル化しました: ${filePath}`, "info");
    onMutated();
  };

  const saveImplCommand = async () => {
    setImplCommandFocused(false);
    if (node.impl?.type !== "script") return;
    const v = implCommandDraft.trim();
    if (v && v !== node.impl.command) await patch({ impl: { type: "script", command: v } });
  };

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
    setTitleFocused(false);
    const t = titleDraft.trim();
    if (t && t !== node.title) await patch({ title: t });
  };

  const saveDetail = async () => {
    setDetailFocused(false);
    if (detailDraft !== (node.detail ?? "")) await patch({ detail: detailDraft || null });
  };

  const saveSchedule = async () => {
    setScheduleFocused(false);
    if (scheduleDraft !== (node.schedule ?? "")) await patch({ schedule: scheduleDraft || null });
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
  // が同じ規則で 409 を返す。ここでは事前にボタンを無効化して分かりやすくするだけ）
  const isFrontier = node.parents.every((pid) => {
    const s = allNodes.find((n) => n.id === pid)?.status;
    return s === "done" || s === "skipped";
  });
  const decisionGateOk =
    node.lifecycle === "committed" && isFrontier && node.status !== "dropped";

  // decision の choice 未確定のときだけ「分岐を選ぶ」を出す（docs/design.md 3.9）
  const decide = async (branchId: string, label: string) => {
    try {
      await api.decide(node.id, branchId);
      onMutated();
      pushToast(`${label} に分岐しました`, "info");
    } catch {
      // api() 側でトースト表示済み
    }
  };

  // 分岐の選び直し（手戻り。docs/design.md 3.9）: choice を取り消し、この決着に由来する
  // skip を復元する。下流で進んだ作業（done）は戻らないので確認を挟む
  const revertDecision = async () => {
    const ok = await confirmDialog(
      "分岐を選び直しますか？\nスキップされた枝は待ちに戻ります（進んだ作業は戻りません）",
      { confirmLabel: "選び直す" },
    );
    if (!ok) return;
    try {
      await api.revertDecision(node.id);
      onMutated();
      refreshThread();
      pushToast("分岐の選択を取り消しました", "info");
    } catch {
      // api() 側でトースト表示済み
    }
  };

  const handleDelete = async () => {
    // ロック・メンバー持ち・子持ちでも削除は常にできる。危ないケースは削除前に
    // モーダルで教える（2026-08-01 本人指摘「消せないのは違う。ロックはモーダルで確認」）
    const impact = computeRemoveImpact([node.id], allNodes);
    const ok = await confirmDialog(
      buildRemoveMessage(
        `「${node.title || "（無題）"}」を削除しますか？（Ctrl+Z で戻せます）`,
        removeImpactWarnings(impact),
      ),
      { danger: true, confirmLabel: "削除" },
    );
    if (!ok) return;
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
  const lastBreak = messages.reduce(
    (acc, m, i) => ((m.payload as { chatBreak?: boolean } | null)?.chatBreak ? i : acc),
    -1,
  );
  const talkSource = lastBreak >= 0 ? messages.slice(lastBreak + 1) : messages;
  const isChatBreak = (m: MaterializedMessage) =>
    Boolean((m.payload as { chatBreak?: boolean } | null)?.chatBreak);
  // タブごとの表示対象（2026-08-02 3タブ化）:
  //   会話(talk)      = 区切り以降の say + 判断のやりとり
  //   履歴(history)   = 過去分も含む全ての会話（say + 判断）。「―― 新しい会話 ――」の
  //                     区切り行も挟んで表示する（どこで区切ったか分かるように）
  //   実行記録(log)   = status + artifact（エンジン実行・試走・状態変化・移行記録）。
  //                     会話の区切り行は実行記録ではないので除く
  const inTab = (m: MaterializedMessage, t: "talk" | "history" | "log") => {
    if (t === "talk") {
      return m.kind === "say" || m.kind === "decision_request" || m.kind === "decision_answer";
    }
    if (t === "history") {
      return (
        m.kind === "say" ||
        m.kind === "decision_request" ||
        m.kind === "decision_answer" ||
        isChatBreak(m)
      );
    }
    return (m.kind === "status" || m.kind === "artifact") && !isChatBreak(m);
  };
  const filtered = (tab === "talk" ? talkSource : messages).filter((m) => inTab(m, tab));
  // 履歴タブ用: chatBreak で区切った過去セッション一覧（GraphWrangler AI のアーカイブ一覧と
  // 同じ意味）。スレッドは経緯の正史なので実体は動かさず、区切りから毎回導出する。
  // ts は区切った時刻＝GraphWrangler AI の「新しい会話を押した時刻」に対応する
  const pastSessions: { id: string; ts: string; messages: MaterializedMessage[] }[] = [];
  {
    let seg: MaterializedMessage[] = [];
    for (const m of messages) {
      if (isChatBreak(m)) {
        const convo = seg.filter((x) => inTab(x, "talk"));
        if (convo.length > 0) pastSessions.push({ id: m.id, ts: m.ts, messages: convo });
        seg = [];
      } else {
        seg.push(m);
      }
    }
  }
  const currentTalk = talkSource.filter((m) => inTab(m, "talk"));
  const openedSession = pastSessions.find((s) => s.id === historySessionId) ?? null;
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
  const hasUnreadIn = (t: "talk" | "history" | "log") => {
    if (seenTabs.has(t)) return false;
    const source =
      t === "talk" ? talkSource : t === "history" ? messages.slice(0, lastBreak + 1) : messages;
    return source.some((m) => m.ts > (unreadSince ?? "") && inTab(m, t));
  };

  const startNewTalk = async () => {
    await fetch(`/api/nodes/${node.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "status", body: "―― 新しい会話 ――", payload: { chatBreak: true } }),
    });
    refreshThread();
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
      className="@container/panel relative flex flex-shrink-0 flex-col gap-3 overflow-hidden border-l bg-background p-4"
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
              : node.kind === "task"
                ? "タスク"
                : KIND_JA[node.kind];
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
        value={titleDraft}
        disabled={node.fixed}
        onFocus={() => setTitleFocused(true)}
        onChange={(e) => setTitleDraft(e.target.value.replace(/\n/g, ""))}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />

      {/* decision ノード: choice 未確定なら分岐を選ぶボタン列、確定済みなら選択結果（docs/design.md 3.9）。
          human分岐はエンジンが開く判断リクエスト(Threadタブ)でも回答できるが、ここから直接 /decide も正 */}
      {node.kind === "decision" &&
        node.branches &&
        (node.status === "done" || node.status === "skipped" ? (
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
            <Icon name="branch" size={13} />
            選択済み: {node.branches.find((b) => b.id === node.choice)?.label ?? node.choice ?? "-"}
            <span className="flex-1" />
            {/* 選び直し（手戻り）。自分が上流の分岐でskipされた場合(choice無し)は対象外 */}
            {node.status === "done" && node.choice && (
              <Hint
                id="decision-revert"
                text="選択を取り消し、スキップされた枝を待ちに戻す（進んだ作業は戻らない）"
              >
                <Button type="button" variant="ghost" size="sm" onClick={() => void revertDecision()}>
                  選び直す
                </Button>
              </Hint>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-border-strong bg-card p-2.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon name="branch" size={13} /> 分岐を選ぶ
            </span>
            {node.branches.map((b) => (
              <Button
                key={b.id}
                type="button"
                variant="outline"
                size="sm"
                className="justify-start"
                title={b.then}
                disabled={!decisionGateOk}
                onClick={() => decide(b.id, b.label)}
              >
                {b.label}
              </Button>
            ))}
            {!decisionGateOk && (
              <span className="text-xs text-text-lo">
                {node.status === "dropped"
                  ? "中止されています。進捗の「戻す」で復帰できます"
                  : node.lifecycle !== "committed"
                    ? "下書きです。先に確定してください"
                    : "前のノードが終わると選べます"}
              </span>
            )}
          </div>
        ))}

      {/* 担当×実装の不整合⚠（docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）:
          担当=script なのに impl が script でない=実行すると失敗する組み合わせ。
          常に見えるようにする（メタ折りたたみの外）。NodeCard 側にも同じ理由で⚠バッジを出す。
          kind=trigger は対象外——トリガーの executor=script は「schedule で発火する」の意味で
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
          {node.fixed && (
            <p className="text-xs text-muted-foreground">
              🔒 ロック中（編集するには解除）
            </p>
          )}

          {/* max-h + overflow: Textarea は field-sizing-content で中身に合わせて伸び続けるため、
              長文だとパネル（overflow-hidden）からはみ出て下半分に到達できなくなる
              （2026-08-02 本人報告「本文が長い場合スクロールが効かない」）。上限を付けて
              内部スクロールに切り替える */}
          <Textarea
            className="max-h-48 overflow-y-auto"
            placeholder="概要"
            value={detailDraft}
            disabled={node.fixed}
            onFocus={() => setDetailFocused(true)}
            onChange={(e) => setDetailDraft(e.target.value)}
            onBlur={saveDetail}
            rows={3}
          />

          {/* トリガーの起動方式（docs/design.md 3.8）。human は手動発火(▶)のみなので欄自体を出さない。
              script=cron的な発火条件、ai=発火要否を判定させる間隔 */}
          {node.kind === "trigger" &&
            (node.executor === "human" ? (
              <p className="text-xs text-muted-foreground">手動開始のみ（カードの ▶ から開始）</p>
            ) : (
              <Input
                placeholder={
                  node.executor === "ai"
                    ? "チェック間隔: every 1h（条件は detail や手順書に書く）"
                    : "every 15m / daily 09:00 / weekly mon 09:00"
                }
                value={scheduleDraft}
                disabled={node.fixed}
                onFocus={() => setScheduleFocused(true)}
                onChange={(e) => setScheduleDraft(e.target.value)}
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
                disabled={node.fixed}
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
                disabled={node.fixed}
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
                ノードだけは解除できるよう表示する）。トリガーでは意味が「発火前承認」になる
                （script の定刻発火・AI の自動発火の直前にゲート。手動▶はそのまま発火） */}
            {(node.executor !== "human" || node.approval) && (
              <label className="col-span-2 flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                {/* 「?」アイコンは廃止し、ラベル自体のマウスオーバーに統一（2026-08-05 本人指定） */}
                <Hint id="approval" text={HINT_TEXT.approval}>
                  <span>{node.kind === "trigger" ? "開始前承認" : "実行前承認"}</span>
                </Hint>
                <Switch
                  checked={node.approval}
                  disabled={node.fixed}
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
                  disabled={node.fixed}
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
            {/* トリガーに進捗はない（docs/design.md 3.8。発火はあってもステータス遷移という概念が無い）。
                質問が開いている（pendingRequest あり）間は status が何であれ「あなたの番」を優先して
                描き、進捗ボタンも出さない（NodeCard の visualStatus / PageList の effStatus と同じ保険。
                回答は上の判断カードから行う） */}
            {/* トリガーは進捗を持たないが lifecycle は持つ。下書きの間だけ確定導線を出す
                （2026-07-31 本人報告「トリガーをプラン済みにする方法がUIに無い」） */}
            {node.kind === "trigger" && node.lifecycle === "draft" && (
              <div className="col-span-2 flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">下書き（未確定）</span>
                <span className="flex-1" />
                <Hint id="commit-plan" text={HINT_TEXT.commitPlan}>
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => patch({ lifecycle: "committed" })}>
                    計画済みにする
                  </Button>
                </Hint>
              </div>
            )}
            {/* トリガーのプラン取り消し（2026-08-06 本人要望「ルーティーンも未計画に戻せるように」）。
                task と違い status ではなく lifecycle を draft へ戻す——エンジンの発火判定
                （engine の isFireableTrigger）は committed のトリガーだけを拾うので、
                トリガーにとっての「未計画」は draft。手動▶（POST /fire）は draft でも通るため、
                自動発火だけが止まる */}
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
            {node.kind !== "trigger" &&
              node.group != null &&
              allNodes.some((n) => n.kind === "trigger" && n.group === node.group) &&
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
                      onClick={async () => {
                        if (node.executor === "script" && !(await confirmPromotionIfNeeded())) return;
                        patch({ status: "pending", lifecycle: "committed" });
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
            {node.kind !== "trigger" &&
              node.group != null &&
              allNodes.some((n) => n.kind === "trigger" && n.group === node.group) &&
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
              node.group != null &&
              allNodes.some((n) => n.kind === "trigger" && n.group === node.group) &&
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
                  {node.executor === "human" && node.kind === "task" && activeRunItem.status === "pending" && runFrontier && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={runItemBusy}
                      onClick={() => patchRunItemStatus("running")}
                    >
                      着手
                    </Button>
                  )}
                  {node.executor === "human" && node.kind === "task" &&
                    ((activeRunItem.status === "pending" && runFrontier) || activeRunItem.status === "running") && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={runItemBusy}
                        onClick={() => patchRunItemStatus("done")}
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
              !(node.group != null && allNodes.some((n) => n.kind === "trigger" && n.group === node.group)) &&
              (() => {
                const vs = node.pendingRequest ? ("waiting" as const) : node.status;
                // 実行フェーズの原則（docs/design.md 3.9）: 前へ進める操作（着手・完了）は
                // 順番が来ている（親が全部 done|skipped）ノードだけ。プラン済み化（計画系）と
                // 戻す（修復系）はいつでも可（2026-07-31 本人報告のバグ修正）。
                // 分岐(decision)は「分岐を選ぶ」が唯一の決着経路なので、実行系ボタン
                // （着手/完了/戻す）は出さない——プラン済み化だけ残す（committed が選択の前提条件）
                const exec = node.kind !== "decision";
                const frontier = node.parents.every((pid) => {
                  const s = allNodes.find((n) => n.id === pid)?.status;
                  return s === "done" || s === "skipped";
                });
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
                        <Button type="button" variant="outline" size="sm"
                          onClick={async () => {
                            if (node.executor === "script" && !(await confirmPromotionIfNeeded())) return;
                            patch({ status: "pending", lifecycle: "committed" });
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
                      <Button type="button" variant="outline" size="sm" onClick={() => patch({ status: "running" })}>
                        着手
                      </Button>
                    )}
                    {exec && ((vs === "pending" && frontier) || vs === "running") && (
                      <Button type="button" variant="outline" size="sm" onClick={() => patch({ status: "done" })}>
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
          </div>

          {/* 関係者（チーム化 2026-08-04）: 全ノード種で編集できる（goal ノードはグラフに
              描画されず開く導線が無い + 配下ノードにも関係者を付けたい、で全種へ開放）。
              表示するのは実際の関係者だけ——手動 members のチップ（×で解除）と、ページ
              （goal）では配下ノード由来の自動集計（effectiveMembers）のうち手動に無い分の
              「自動」チップ。追加は末尾の「＋」からメニューで選ぶ（旧: ロスター全員をトグル
              チップで並べていたが、人数が多いと地獄。2026-08-04 実機指摘で現メンバー+＋方式へ）。
              左レールの人フィルタ・イニシャルバッジは実効関係者（手動 ∪ 自動）を見る。
              作成者（createdBy）はサーバが刻む不変値なので表示のみ。囲い（bg-card）は付けない
              ——detail や分岐の枝と同じ地のメタ項目として並べる（同日の実機指摘） */}
          {teamEnabled && (
            <div className="flex flex-col gap-1.5">
              <Hint
                id="members"
                text="このノードに関わる人。ページでは配下ノードの担当者・関係者・作成者からも自動で集まる（点線チップ）。左レールの人フィルタはこの実効関係者で絞り込む"
              >
                <span className="self-start text-sm text-muted-foreground">関係者</span>
              </Hint>
              <div className="flex flex-wrap items-center gap-1.5">
                {(node.members ?? []).map((m) => (
                  <span
                    key={m}
                    className="inline-flex items-center gap-1 rounded-full border border-human/60 bg-human/10 px-2 py-0.5 text-xs text-foreground"
                    title={m}
                  >
                    {/* 左端ドット = ユーザーの決定的カラー（colorOf。レール・カードのバッジと同じ色） */}
                    <i
                      className="size-2 flex-shrink-0 rounded-full"
                      style={{ background: colorOf(m) }}
                    />
                    {displayNameOf(m, users)}
                    <Hint id="member-remove" always="関係者から外す">
                      <button
                        type="button"
                        className="inline-flex text-muted-foreground transition-colors hover:text-foreground"
                        onClick={() =>
                          patch({ members: (node.members ?? []).filter((x) => !sameEmail(x, m)) })
                        }
                      >
                        <X className="size-3" />
                      </button>
                    </Hint>
                  </span>
                ))}
                {/* ページのみ: 配下ノード由来の継承分（手動 members に無い人）。集計値なので
                    ここでは外せない（外したければ配下ノード側の帰属を変える）。控えめな点線 */}
                {node.kind === "goal" &&
                  effectiveMembers(node, allNodes)
                    .filter((m) => !(node.members ?? []).some((x) => sameEmail(x, m)))
                    .map((m) => (
                      <Hint
                        key={m}
                        id="members-auto"
                        always="自動集計の関係者"
                        text="配下ノードの担当者・関係者・作成者から自動で集まった分。ここでは外せない（外すには配下ノード側の担当者・関係者を変える）"
                      >
                        <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-text-lo">
                          {displayNameOf(m, users)}
                          <span className="text-[9px]">自動</span>
                        </span>
                      </Hint>
                    ))}
                {/* まだ手動 members に居ないロスターの人だけを候補に出す（無効化ユーザーは除外。
                    2026-08-04 アカウント管理）。候補ゼロなら＋自体を出さない */}
                {users.some(
                  (u) => !u.disabled && !(node.members ?? []).some((m) => sameEmail(m, u.email)),
                ) && (
                  <DropdownMenu>
                    <Hint id="member-add" always="関係者を追加">
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-6 rounded-full text-muted-foreground"
                        >
                          <Plus className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                    </Hint>
                    <DropdownMenuContent align="start">
                      {users
                        .filter(
                          (u) =>
                            !u.disabled &&
                            !(node.members ?? []).some((m) => sameEmail(m, u.email)),
                        )
                        .map((u) => (
                          <DropdownMenuItem
                            key={u.email}
                            title={u.email}
                            onSelect={() => patch({ members: [...(node.members ?? []), u.email] })}
                          >
                            {displayNameOf(u.email, users)}
                          </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              {node.createdBy && (
                <span className="text-xs text-muted-foreground">
                  作成者: {displayNameOf(node.createdBy, users)}
                </span>
              )}
            </div>
          )}

          {/* 実装（impl）: 担当連動ラベル + 種類セレクト + doc/script 編集 + 試走ボタン
              （試走ゲート。docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）。対応表:
              human→doc=読む手順書 / ai→doc=実行時プロンプトへインライン / script→script=command
              実行。それ以外の組み合わせ（例: 担当=humanでimpl=script）は実行に使われない */}
          <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5">
            <Hint id="impl" text={HINT_TEXT.impl}>
              <span className="flex items-center gap-1.5 self-start text-sm text-muted-foreground">
                <Icon name={node.impl?.type === "script" ? "code" : "doc"} size={13} />
                実装（{IMPL_LABEL_BY_EXECUTOR[node.executor]}）
              </span>
            </Hint>
            <Select
              value={node.impl === null ? "none" : node.impl.type}
              disabled={node.fixed}
              onValueChange={(v) => setImplType(v as ImplTypeOption)}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">なし</SelectItem>
                <SelectItem value="doc">手順書</SelectItem>
                {/* スクリプト実装は担当=script のノードでしか実行されない（3.5.1 の対応表）ため、
                    選択肢として出すのも担当=script のときだけ。担当を後から変えた等で既に
                    script 実装を持つノードは、現在値として表示・編集できるよう残す */}
                {((node.executor === "script" && node.kind !== "trigger") || node.impl?.type === "script") && (
                  <SelectItem value="script">スクリプト</SelectItem>
                )}
              </SelectContent>
            </Select>

            {node.impl?.type === "doc" && (
              <>
                <span className="flex items-center gap-1.5">
                  <Input
                    className="flex-1"
                    placeholder="フォルダからの相対パス（例: docs/how-to.md）。本文も書いてあれば本文を優先"
                    value={implPathDraft}
                    disabled={node.fixed}
                    onFocus={() => setImplPathFocused(true)}
                    onChange={(e) => setImplPathDraft(e.target.value)}
                    onBlur={saveImplPath}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                  {/* GitHub リンク（2026-08-07 本人要望「手順書のパスの右側にアイコンリンク」）。
                      ワークスペースの remote が GitHub のときだけ出る */}
                  {githubBase && node.impl.path && (
                    <a
                      href={`${githubBase}/${node.impl.path.split("/").map(encodeURIComponent).join("/")}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-shrink-0 text-text-lo transition-colors hover:text-foreground"
                      title="GitHub でこの手順書を開く"
                    >
                      <ExternalLink className="size-4" />
                    </a>
                  )}
                </span>
                {/* 手順書の本文は長くなりがち。field-sizing-content の伸び放題を止めて
                    内部スクロールにする（detail 欄と同じ理由。2026-08-02） */}
                <Textarea
                  className="max-h-72 overflow-y-auto"
                  placeholder="本文（パスと両方あれば省略可。どちらか片方があればよい）"
                  value={implTextDraft}
                  disabled={node.fixed}
                  onFocus={() => setImplTextFocused(true)}
                  onChange={(e) => setImplTextDraft(e.target.value)}
                  onBlur={saveImplText}
                  rows={4}
                />
                {implTextDraft.trim() && (
                  <Hint
                    id="impl-fileify"
                    text="本文をワークスペース内の .md ファイルへ書き出し、path 参照に切り替える（git で版管理される）"
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="self-start"
                      disabled={node.fixed}
                      // disabled 理由だけは native title（disabled にはポインタイベントが来ない）
                      title={node.fixed ? "ロック中はファイル化できません（先に解除）" : undefined}
                      onClick={() => void fileifyImplDoc()}
                    >
                      <Icon name="doc" size={13} /> 本文をファイル化
                    </Button>
                  </Hint>
                )}
              </>
            )}

            {node.impl?.type === "script" && (
              <>
                <Input
                  placeholder="実行コマンド（引数が要るなら {name} プレースホルダを使う）"
                  value={implCommandDraft}
                  disabled={node.fixed}
                  onFocus={() => setImplCommandFocused(true)}
                  onChange={(e) => setImplCommandDraft(e.target.value)}
                  onBlur={saveImplCommand}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />

                {/* パラメータ宣言（docs/design.md 3.5.1）: 宣言=AI、値=人間がここで入力。
                    Fix中でも値の入力だけは活かす（docs/design.md 3.5 実効化: 値は実行時入力でやり方ではない）。
                    宣言の追加/削除UIはv1では作らない（GraphWrangler AIが command と一緒に書く想定） */}
                {(node.impl.params?.length ?? 0) > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">パラメータ</span>
                    {node.impl.params!.map((p) => (
                      <ParamRow
                        key={p.name}
                        param={p}
                        onCommit={(value) => {
                          if (node.impl?.type !== "script") return;
                          const params = (node.impl.params ?? []).map((x) =>
                            x.name === p.name ? { ...x, value: value || null } : x,
                          );
                          patch({ impl: { type: "script", command: node.impl.command, params } });
                        }}
                      />
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {/* ラベルは「試走」だけにし、説明はツールチップへ（2026-07-31 本人指定）。
                      試走=常に--dry-runの予告編なので、実行前承認ノードでも試走できる
                      （旧「承認ノードは試走不可」ルールは撤廃） */}
                  <Hint
                    id="trial"
                    text="--dry-run を付けて実行し、何も変えずに「やる予定の操作」だけを表示する。実行前承認のノードでも安全に試せる"
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={trialRunning || missingParams.length > 0}
                      // disabled 理由だけは native title（disabled にはポインタイベントが来ない）
                      title={missingParams.length > 0 ? `未入力: ${missingParams.join(", ")}` : undefined}
                      onClick={runTrial}
                    >
                      {trialRunning && <Loader2 className="size-3.5 animate-spin" />}
                      試走
                    </Button>
                  </Hint>
                  {missingParams.length > 0 && (
                    <span className="text-xs text-destructive">未入力: {missingParams.join(", ")}</span>
                  )}
                  {implStatus === "ok" && node.implTrial && (
                    <span className="text-xs text-ok">
                      ✓ テスト成功（{new Date(node.implTrial.ts).toLocaleString("ja-JP")}）
                    </span>
                  )}
                  {implStatus === "stale" && (
                    <span className="text-xs text-destructive">
                      ⚠ コマンドが変更されています（再試走を推奨）
                    </span>
                  )}
                  {implStatus === "unverified" && node.implTrial && !node.implTrial.success && (
                    <span className="text-xs text-destructive">
                      ✗ テスト失敗（{new Date(node.implTrial.ts).toLocaleString("ja-JP")}）
                    </span>
                  )}
                  {implStatus === "unverified" && !node.implTrial && (
                    <span className="text-xs text-muted-foreground">未検証</span>
                  )}
                </div>
              </>
            )}

            {node.impl?.type === "script" && node.executor !== "script" && (
              <p className="text-xs text-muted-foreground">
                このスクリプトは実行されません（担当がスクリプトではないため）
              </p>
            )}
          </div>

          {/* decision の枝エディタ: ラベル編集+削除（最低2枝）+追加。id は既存のものを変更しない
              （エッジが parentOptions[decisionId]=branchId で紐づいているため。docs/design.md 3.9） */}
          {node.kind === "decision" && (
            <div className="flex flex-col gap-1.5">
              <Hint
                id="branches"
                text="このノードが完了するときに選ぶ選択肢。枝ごとに別の後続ノードをつなげられ、選ばれなかった枝の先はスキップになる"
              >
                <span className="flex items-center gap-1.5 self-start text-sm text-muted-foreground">
                  <Icon name="branch" size={13} /> 分岐の枝
                </span>
              </Hint>
              {(node.branches ?? []).map((b) => (
                <BranchRow
                  key={b.id}
                  branch={b}
                  disableRemove={(node.branches?.length ?? 0) <= 2}
                  disabled={node.fixed}
                  onCommit={(label) =>
                    patch({
                      branches: (node.branches ?? []).map((x) => (x.id === b.id ? { ...x, label } : x)),
                    })
                  }
                  onRemove={() => patch({ branches: (node.branches ?? []).filter((x) => x.id !== b.id) })}
                />
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={node.fixed}
                title={node.fixed ? "ロック中は編集できません" : undefined}
                onClick={() =>
                  patch({
                    branches: [
                      ...(node.branches ?? []),
                      { id: nextBranchId(node.branches ?? []), label: "新しい枝" },
                    ],
                  })
                }
              >
                + 枝を追加
              </Button>
            </div>
          )}

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
            setTab(v as "talk" | "history" | "log");
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
            <Hint id="tab-history" text="「新しい会話」で区切った過去の会話。カードで選んで読み返せる">
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

      {/* 履歴タブは GraphWrangler AI（ChatDrawer）と同じ「セッションカード一覧 → クリックで
          中身」の動線（2026-08-04 本人指示「Task AI の履歴の仕組み（＆UI）を揃えて」。
          それまではベタ流し + 区切り行だった）。スレッドが正史なので中身は読み取り専用で
          開く（GraphWrangler AI は読み込んで続きを話せるが、こちらの「続き」は会話タブ＝
          今のセッションの役割） */}
      {showTalk && tab === "history" ? (
        openedSession ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex flex-shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setHistorySessionId(null)}
              >
                <ChevronLeft className="size-3.5" /> 履歴一覧
              </Button>
              <span className="text-xs text-muted-foreground">
                {new Date(openedSession.ts).toLocaleString("ja-JP")} ・ {openedSession.messages.length}件
              </span>
            </div>
            <Thread
              nodeId={node.id}
              messages={openedSession.messages}
              aiBusy={false}
              showReplyBox={false}
              onMutated={() => {
                onMutated();
                refreshThread();
              }}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
            {/* 今の会話は一覧の先頭（GraphWrangler AI と同じ）。クリックで会話タブへ */}
            {currentTalk.length > 0 && (
              <button
                type="button"
                className="flex flex-shrink-0 flex-col gap-0.5 rounded-md border border-ai/40 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                onClick={() => setTab("talk")}
              >
                <span className="text-xs text-ai">今の会話 ・ {currentTalk.length}件（保存済み）</span>
                <span className="truncate">{firstHumanPreview(currentTalk)}</span>
              </button>
            )}
            {pastSessions.length === 0 && currentTalk.length === 0 && (
              <div className="p-2 text-sm text-muted-foreground">まだありません</div>
            )}
            {[...pastSessions].reverse().map((s) => (
              <button
                key={s.id}
                type="button"
                className="flex flex-shrink-0 flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                onClick={() => setHistorySessionId(s.id)}
              >
                <span className="text-xs text-muted-foreground">
                  {new Date(s.ts).toLocaleString("ja-JP")} ・ {s.messages.length}件
                </span>
                <span className="truncate">{firstHumanPreview(s.messages)}</span>
              </button>
            ))}
          </div>
        )
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
        // 入力欄のモデル/エフォート切替（共通コンポーネント化 2026-08-07）。
        // 変更はこのノードの aiModel/aiEffort として保存され、Task AI・実行AI 両方に効く
        aiModel={node.aiModel}
        aiEffort={node.aiEffort}
        onAiModelChange={(v) => patch({ aiModel: v })}
        onAiEffortChange={(v) => patch({ aiEffort: v as Node["aiEffort"] })}
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
