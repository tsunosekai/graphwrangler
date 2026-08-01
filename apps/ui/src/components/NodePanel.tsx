import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Copy,
  History,
  Loader2,
  Lock,
  MessageSquare,
  ScrollText,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { api, type NodePatchInput } from "../lib/api";
import { confirmDialog, promptDialog } from "../lib/dialogs";
import { buildRemoveMessage, computeRemoveImpact, removeImpactWarnings } from "../lib/removal";
import { usePolling } from "../hooks/usePolling";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { sha256Hex } from "../lib/hash";
import { missingParamNames } from "../lib/params";
import { pushToast } from "../lib/toast";
import type { MaterializedMessage, Node, NodeBranch, Run, RunItemStatus, ScriptParam, Status } from "../types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { DecisionCard } from "./DecisionCard";
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
  onMutated: () => void;
  onClose: () => void;
  /** ノード複製後に新規ノードを選択するため。ページ切替も面倒を見る App.selectNode を渡す */
  onSelect: (id: string) => void;
}

// 種別はノードの3種のみ（ゴールはページなので選択肢に出さない。現在値がゴール等の時だけ表示）
const KIND_OPTIONS: Node["kind"][] = ["task", "decision", "trigger"];
const KIND_JA: Record<Node["kind"], string> = {
  task: "実行",
  decision: "判断",
  trigger: "トリガー",
  goal: "ゴール（ページ）",
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
const TRIAL_CONFIRM_MESSAGE = "スクリプトの試走が成功していません。このまま続けますか？";
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
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled || disableRemove}
        title={disabled ? "ロック中は編集できません" : disableRemove ? "分岐は最低2つ必要です" : "この枝を削除"}
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

/** パラメータ宣言(1件)の値入力行（docs/design.md 3.5.1）。宣言（name/label/example）は
 *  Workflow AI が書く前提で v1 では追加/削除UIを持たず、値の編集だけを行う。
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

// key={node.id} で App から渡されるため、node が切り替わるたびにこのコンポーネントは
// まっさらな状態で再マウントされる（未読ドラフト・タブ・スレッドポーリングが混線しない）。
export function NodePanel({ node, allNodes, activeRun, onMutated, onClose, onSelect }: Props) {
  // 会話=今の会話 / 履歴=過去の会話（Workflow AI の「履歴」と同じ意味） / 実行記録=status・artifact
  // （2026-08-02 本人要望「会話の履歴と実行の履歴を分けてほしい」で2タブ→3タブ化。
  // それまで「新しい会話」で区切った過去の会話は UI のどこからも見えなくなっていた）
  const [tab, setTab] = useState<"talk" | "history" | "log">("talk");
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

  // スレッドを表示したら既読ts(localStorage)を更新する（thread取得のたびに更新=
  // 開いたまま新着が来ても「読んだ」扱いを追随させる）
  useEffect(() => {
    if (!thread) return;
    try {
      localStorage.setItem(`gw.read.${node.id}`, new Date().toISOString());
    } catch {
      // 容量超過等は無視（未読バッジは補助機能）
    }
  }, [thread, node.id]);

  const [titleDraft, setTitleDraft] = useState(node.title);
  const [titleFocused, setTitleFocused] = useState(false);
  useEffect(() => {
    if (!titleFocused) setTitleDraft(node.title);
  }, [node.title, titleFocused]);

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
        result.success ? "試走成功" : `試走失敗（exit ${result.exitCode ?? "?"}）`,
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
        impact: node.impact,
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
  const filtered = (tab === "talk" ? talkSource : messages).filter((m) => {
    if (tab === "talk") {
      return m.kind === "say" || m.kind === "decision_request" || m.kind === "decision_answer";
    }
    if (tab === "history") {
      return (
        m.kind === "say" ||
        m.kind === "decision_request" ||
        m.kind === "decision_answer" ||
        isChatBreak(m)
      );
    }
    return (m.kind === "status" || m.kind === "artifact") && !isChatBreak(m);
  });

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
      className="relative flex flex-shrink-0 flex-col gap-3 overflow-hidden border-l bg-background p-4"
      style={{ width }}
    >
      <div className="resize-handle resize-handle-left" onPointerDown={(e) => startResize(e, -1)} />
      <div className="flex items-center gap-2">
        <Input
          className="flex-1 border-transparent bg-transparent text-lg font-semibold hover:border-input focus-visible:border-input"
          value={titleDraft}
          disabled={node.fixed}
          onFocus={() => setTitleFocused(true)}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
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
          </TooltipTrigger>
          <TooltipContent>
            {node.fixed
              ? "Fix済み: やり方が確定。AIは実装を書き換えない"
              : "未Fix（改善中）: AIが実装を書き換えてよい。クリックで Fix する"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" onClick={handleDuplicate}>
              <Copy />
            </Button>
          </TooltipTrigger>
          <TooltipContent>このノードを複製</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleDelete}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{node.fixed ? "このノードを削除（ロック中なので確認します）" : "このノードを削除"}</TooltipContent>
        </Tooltip>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="閉じる">
          <X />
        </Button>
      </div>

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
              <Button type="button" variant="ghost" size="sm" onClick={() => void revertDecision()}>
                選び直す
              </Button>
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
              <span className="text-xs text-muted-foreground">
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
        <div className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <Icon name="alert" size={13} />
          実装が未接続（実行すると失敗します）
        </div>
      )}

      {/* 操作の主役は「詳細をたたむ」ではなく「会話を広げる」（2026-07-31 本人指定）。
          既定は会話が広い状態（メタ非表示）で、切替はタブ行の右端のボタンが担う。
          セクション全体が縦に長くなってもパネル（overflow-hidden）から溢れないよう
          スクロール容器で包む（2026-08-02 スクロール不能バグ修正の一環） */}
      {metaOpen && (
        <div className="flex min-h-0 flex-shrink-0 basis-auto flex-col gap-3 overflow-y-auto" style={{ maxHeight: "60%" }}>
          {/* Fix実効化の注記（docs/design.md 3.5）: ロック中は「やり方」フィールドの編集UIを
              disabled にする。進捗（status）・params の値・試走・Fixトグル自体は生かしたまま */}
          {node.fixed && (
            <p className="text-xs text-muted-foreground">
              🔒 Fix済み（やり方はロック中。編集するには解除）
            </p>
          )}

          {/* max-h + overflow: Textarea は field-sizing-content で中身に合わせて伸び続けるため、
              長文だとパネル（overflow-hidden）からはみ出て下半分に到達できなくなる
              （2026-08-02 本人報告「本文が長い場合スクロールが効かない」）。上限を付けて
              内部スクロールに切り替える */}
          <Textarea
            className="max-h-48 overflow-y-auto"
            placeholder="detail / 補足"
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
              <p className="text-xs text-muted-foreground">手動発火のみ（カードの ▶ から発火）</p>
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
              種別
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
              担当
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
            {/* 承認ゲートは「機械（AI/スクリプト）の仕事」の直前に挟まるもの。担当=人間の
                ノードでは本人の操作が承認そのものなのでトグルを出さない（既に irreversible の
                ノードだけは解除できるよう表示する）。トリガーでは意味が「発火前承認」になる
                （script の定刻発火・AI の自動発火の直前にゲート。手動▶はそのまま発火） */}
            {(node.executor !== "human" || node.impact === "irreversible") && (
              <label className="col-span-2 flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <span className="flex items-center gap-1.5">
                  <span>{node.kind === "trigger" ? "発火前承認" : "実行前承認"}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex cursor-help text-muted-foreground">
                        <CircleHelp className="size-3.5" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">
                      {node.kind === "trigger"
                        ? "自動発火（scriptの定刻 / AIの判定）の直前に人間の承認ゲートを通る。手動の▶はそのまま発火する"
                        : "実行前に人間の承認ゲートを通る（外部公開・送信・削除など取り返しのつかない操作）"}
                    </TooltipContent>
                  </Tooltip>
                </span>
                <Switch
                  checked={node.impact === "irreversible"}
                  disabled={node.fixed}
                  onCheckedChange={(v) => patch({ impact: v ? "irreversible" : "safe" })}
                />
              </label>
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
                <Button type="button" variant="outline" size="sm"
                  onClick={() => patch({ lifecycle: "committed" })}>
                  プラン済みにする
                </Button>
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
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      if (node.executor === "script" && !(await confirmPromotionIfNeeded())) return;
                      patch({ status: "pending", lifecycle: "committed" });
                    }}
                  >
                    プラン済みにする
                  </Button>
                </div>
              )}
            {node.kind !== "trigger" &&
              node.group != null &&
              allNodes.some((n) => n.kind === "trigger" && n.group === node.group) &&
              (activeRunItem ? (
                <div className="col-span-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">進捗（実行中のラン）:</span>
                  <span className="inline-flex items-center gap-1.5">
                    <StatusCircle status={activeRunItem.status} />
                    {STATUS_JA[activeRunItem.status]}
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
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={runItemBusy}
                        title="待ちに戻す（エンジンがもう一度実行する）"
                        onClick={() => patchRunItemStatus("pending")}
                      >
                        もう一度
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={runItemBusy}
                        title="このランではこのステップを見送る"
                        onClick={() => patchRunItemStatus("skipped")}
                      >
                        このランでは飛ばす
                      </Button>
                    </>
                  )}
                  {/* 分岐(decision)のアイテムは「分岐を選ぶ」で決着する（choice を経ずに done に
                      できてしまう二重経路を作らない）。着手/完了は担当=人間の task のみ */}
                  {node.executor === "human" && node.kind === "task" && activeRunItem.status === "pending" && !runFrontier && (
                    <span className="text-xs text-muted-foreground">前のノードが終わると着手できます</span>
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={runItemBusy}
                      title="着手前（待ち）に戻す"
                      onClick={() => patchRunItemStatus("pending")}
                    >
                      戻す
                    </Button>
                  )}
                </div>
              ) : (
                <p className="col-span-2 text-xs text-muted-foreground">
                  ルーティーンのテンプレートです。進捗は実行（ラン）ごとに付きます——台帳ビューで確認できます
                </p>
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
                    <span className="text-muted-foreground">進捗:</span>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusCircle status={vs} />
                      {STATUS_JA[vs]}
                    </span>
                    <span className="flex-1" />
                    {(vs === "unplanned" || node.lifecycle === "draft") && (
                      <Button type="button" variant="outline" size="sm"
                        onClick={async () => {
                          if (node.executor === "script" && !(await confirmPromotionIfNeeded())) return;
                          patch({ status: "pending", lifecycle: "committed" });
                        }}>
                        プラン済みにする
                      </Button>
                    )}
                    {/* プラン済みの取り消し（計画系なので decision でも frontier 前でも出す。
                        2026-08-01 本人要望「プラン済みを未プランに戻す方法が無い」）。
                        status だけ unplanned に戻す——lifecycle は committed のまま残しても
                        エンジンは unplanned を拾わないため安全で、「プラン済みにする」が
                        再表示されて行き止まりにならない */}
                    {vs === "pending" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        title="プランを取り消して未計画に戻す（エンジンの実行対象から外す）"
                        onClick={() => patch({ status: "unplanned" })}
                      >
                        未計画に戻す
                      </Button>
                    )}
                    {exec && vs === "pending" && node.lifecycle === "committed" && !frontier && (
                      <span className="text-xs text-muted-foreground">前のノードが終わると着手できます</span>
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
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        title={
                          vs === "running"
                            ? "着手前（待ち）に戻す"
                            : vs === "done"
                              ? "未完了（待ち）に戻す"
                              : "中止を取り消して待ちに戻す"
                        }
                        onClick={() => patch({ status: "pending" })}
                      >
                        戻す
                      </Button>
                    )}
                  </div>
                );
              })()}
          </div>

          {/* 実装（impl）: 担当連動ラベル + 種類セレクト + doc/script 編集 + 試走ボタン
              （試走ゲート。docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）。対応表:
              human→doc=読む手順書 / ai→doc=実行時プロンプトへインライン / script→script=command
              実行。それ以外の組み合わせ（例: 担当=humanでimpl=script）は実行に使われない */}
          <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5">
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Icon name={node.impl?.type === "script" ? "code" : "doc"} size={13} />
              実装（{IMPL_LABEL_BY_EXECUTOR[node.executor]}）
            </span>
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
                <Input
                  placeholder="ワークスペース相対パス（例: docs/how-to.md）。text と両方あれば text 優先"
                  value={implPathDraft}
                  disabled={node.fixed}
                  onFocus={() => setImplPathFocused(true)}
                  onChange={(e) => setImplPathDraft(e.target.value)}
                  onBlur={saveImplPath}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
                {/* 手順書の本文は長くなりがち。field-sizing-content の伸び放題を止めて
                    内部スクロールにする（detail 欄と同じ理由。2026-08-02） */}
                <Textarea
                  className="max-h-72 overflow-y-auto"
                  placeholder="本文（path と両方あれば省略可。どちらか片方があればよい）"
                  value={implTextDraft}
                  disabled={node.fixed}
                  onFocus={() => setImplTextFocused(true)}
                  onChange={(e) => setImplTextDraft(e.target.value)}
                  onBlur={saveImplText}
                  rows={4}
                />
                {implTextDraft.trim() && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start"
                    disabled={node.fixed}
                    title={
                      node.fixed
                        ? "ロック中はファイル化できません（先に解除）"
                        : "本文をワークスペース内の .md ファイルへ書き出し、path 参照に切り替える（git で版管理される）"
                    }
                    onClick={() => void fileifyImplDoc()}
                  >
                    <Icon name="doc" size={13} /> 本文をファイル化
                  </Button>
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
                    宣言の追加/削除UIはv1では作らない（Workflow AIが command と一緒に書く想定） */}
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
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={trialRunning || missingParams.length > 0}
                    title={
                      missingParams.length > 0
                        ? `未入力: ${missingParams.join(", ")}`
                        : "--dry-run 付きで実行します（何も変えず、やる予定の操作を表示するだけ）"
                    }
                    onClick={runTrial}
                  >
                    {trialRunning && <Loader2 className="size-3.5 animate-spin" />}
                    試走
                  </Button>
                  {missingParams.length > 0 && (
                    <span className="text-xs text-destructive">未入力: {missingParams.join(", ")}</span>
                  )}
                  {implStatus === "ok" && node.implTrial && (
                    <span className="text-xs text-ok">
                      ✓ 試走成功（{new Date(node.implTrial.ts).toLocaleString("ja-JP")}）
                    </span>
                  )}
                  {implStatus === "stale" && (
                    <span className="text-xs text-destructive">
                      ⚠ コマンドが変更されています（再試走を推奨）
                    </span>
                  )}
                  {implStatus === "unverified" && node.implTrial && !node.implTrial.success && (
                    <span className="text-xs text-destructive">
                      ✗ 試走失敗（{new Date(node.implTrial.ts).toLocaleString("ja-JP")}）
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
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Icon name="branch" size={13} /> 分岐の枝
              </span>
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

      <div className="flex items-center justify-between">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "talk" | "history" | "log")} className="gap-3">
          <TabsList>
            <TabsTrigger value="talk">
              <MessageSquare className="size-3.5" /> 会話
            </TabsTrigger>
            <TabsTrigger value="history">
              <History className="size-3.5" /> 履歴
            </TabsTrigger>
            <TabsTrigger value="log">
              <ScrollText className="size-3.5" /> 実行記録
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="flex items-center">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          title="ここまでの会話を区切って新しく始める（過去分は履歴タブに残る）"
          onClick={() => void startNewTalk()}
        >
          新しい会話
        </Button>
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
        </span>
      </div>

      <Thread
        nodeId={node.id}
        messages={filtered}
        showReplyBox={tab === "talk"}
        onMutated={() => {
          onMutated();
          refreshThread();
        }}
      />
    </aside>
  );
}
