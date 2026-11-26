// 計画済みノードの「読む」表示（docs/design.md 3.19 / 3.20）。会話の列の上に留めるカード。
//
// 2026-11-24 本人要望「右のパネルの情報量が多く認知負荷が高い。計画済みにしたらスッキリした
// 画面に。重要なのは手順とチャット欄ぐらいで、あとは小さく。基本的に何か入力されてるところだけ
// 出せばいい」→ 同日「会話パネルここじゃないような気がしてきた」を受けて、会話を列の主役にし、
// ノードの中身はその上のたためるカードにした（前準備の固定表示と同じ扱い）。
//
//   - 1行目: 入力されている設定だけのチップ（常に見える。たたんだときの姿）
//   - 進捗の操作（着手・完了など。常に見える——たたんでも押せる）
//   - たためる中身: 概要（書いてあるときだけ）、手順（Markdown）、出力
// 直したいときは「編集」でフォームに切り替える。
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describeSchedule } from "@graphwrangler/core/schedule";
import { describeWait } from "@graphwrangler/core/wait";
import { EXECUTOR_JA } from "../../lib/labels";
import { Linkify } from "../../lib/linkify";
import { richMdComponents } from "../../lib/richMd";
import { displayNameOf, useTeam } from "../../lib/team";
import { cn } from "../../lib/utils";
import type { Node } from "../../types";
import { Icon } from "../Icon";

interface Chip {
  text: string;
  title?: string;
  tone?: "warn";
  icon?: "user" | "bot" | "terminal";
}

const EXEC_ICON: Record<Node["executor"], "user" | "bot" | "terminal"> = {
  human: "user",
  ai: "bot",
  script: "terminal",
};

const AUTONOMY_JA: Record<string, string> = { high: "自律度: 高", low: "自律度: 低" };

/** 入力されている設定だけをチップにする（既定値のままのものは出さない） */
function chipsOf(node: Node, assigneeName: string | null): Chip[] {
  const chips: Chip[] = [];
  if (node.kind === "task" || node.kind === "decision" || node.kind === "trigger") {
    chips.push({
      text: assigneeName ? `${EXECUTOR_JA[node.executor]}（${assigneeName}）` : EXECUTOR_JA[node.executor],
      title: "担当",
      icon: EXEC_ICON[node.executor],
    });
  }
  if (node.kind === "trigger") {
    if (node.executor === "human") chips.push({ text: "手動開始", title: "ノードの ▶ から開始" });
    else if (node.schedule) {
      const d = describeSchedule(node.schedule);
      chips.push(
        d
          ? { text: d, title: node.executor === "ai" ? "AI が開始するかを判定する間隔" : "起動方式" }
          : { text: `${node.schedule}（解釈不能）`, tone: "warn", title: "このままでは自動で開始しません" },
      );
    } else if (node.executor === "script") {
      chips.push({ text: "起動条件が未設定", tone: "warn", title: "手動 ▶ でしか開始しません" });
    }
    if (node.executor === "script" && node.schedule && node.catchUp === false) {
      chips.push({ text: "止まっていた回は実行しない", title: "起動していなかった間の回を、次に起動したとき実行しない" });
    }
  }
  if (node.kind === "wait") {
    const d = describeWait(node.wait ?? null);
    chips.push(
      d ? { text: d, title: "待ち方" } : { text: node.wait ? `${node.wait}（解釈不能）` : "待ち方が未設定", tone: "warn" },
    );
  }
  if (node.approval) {
    chips.push({
      text: node.kind === "trigger" ? "開始前承認" : "実行前承認",
      title: "実行の直前に、人間の承認を待ちます",
    });
  }
  if (node.kind === "task" && node.executor === "ai" && AUTONOMY_JA[node.autonomy]) {
    chips.push({ text: AUTONOMY_JA[node.autonomy] });
  }
  if (node.kind === "task" && node.executor === "human" && node.prep === false) {
    chips.push({ text: "AI の前準備なし" });
  }
  if (node.aiModel || node.aiEffort) {
    chips.push({
      text: [node.aiModel, node.aiEffort].filter(Boolean).join(" / "),
      title: "このノードの AI のモデル / エフォート",
    });
  }
  if (node.kind === "goal" && node.muted === true) {
    chips.push({ text: "通知を切っています", title: "左の一覧の右クリックメニューから戻せます" });
  }
  if (node.kind === "decision" && node.branches?.length) {
    chips.push({ text: node.branches.map((b) => b.label).join(" / "), title: "選択肢" });
  }
  return chips;
}

export function NodeSummary({
  node,
  runNote,
  statusSection,
  implSection,
  outputsSection,
  expanded,
  onToggle,
  onEdit,
  onRequestPrep,
}: {
  node: Node;
  /** ラン表示のときの一言（どのランの記録か）。テンプレート表示では null */
  runNote: string | null;
  /** 進捗の操作（着手・完了・計画済みにする等）。編集フォームと同じものをそのまま使う。
   *  読むときに要らない場面（ルーティーンのテンプレート）では null */
  statusSection: ReactNode;
  /** 実装欄の「読む」版（スクリプトの引数・試走・折りたたんだコマンド／ファイルを指す手順書のパス）。
   *  手順書の文章が無いノードで出す。編集の欄は持たない（直すのは「編集」から） */
  implSection: ReactNode;
  outputsSection: ReactNode;
  /** 中身（概要・手順）を開いているか。たたむと会話が列の高さを全部使える */
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  /** プロジェクト層の人間ノードで、AI に前準備を頼む（頼めない場面では null） */
  onRequestPrep: (() => void) | null;
}) {
  const { users } = useTeam();
  const assigneeName = node.assignee ? displayNameOf(node.assignee, users) : null;
  const chips = chipsOf(node, assigneeName);
  const detail = node.detail?.trim() ?? "";
  const docText = node.impl?.type === "doc" ? (node.impl.text ?? "").trim() : "";
  // 手順書が文章で入っているノードは Markdown で読む。それ以外（スクリプト・ファイル参照の
  // 手順書）は、引数の入力や試走があるので実装欄をそのまま出す。何も無ければ欄ごと出さない
  const showImplSection =
    !docText &&
    node.kind !== "wait" &&
    (node.impl?.type === "script" || (node.impl?.type === "doc" && !!node.impl.path));
  const hasOutputs = !!node.outputs && node.outputs.length > 0;
  const hasBody = !!detail || !!docText || showImplSection || hasOutputs || !!runNote;

  return (
    <div className="gw-node-card flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {hasBody && (
          <button
            type="button"
            className="-ml-1 rounded px-1 text-text-lo hover:bg-muted hover:text-foreground"
            title={expanded ? "手順をたたむ（会話を広げる）" : "手順を開く"}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? "▾" : "▸"}
          </button>
        )}
        {chips.map((c, i) => (
          <span
            key={i}
            title={c.title}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5",
              c.tone === "warn" && "border-destructive/50 text-destructive",
            )}
          >
            {c.icon && <Icon name={c.icon} size={12} />}
            {c.text}
          </span>
        ))}
        {node.fixed && <span title="ロック中（やり方を変えるには解除）">🔒</span>}
        {/* たたんでいる間は、手順があることだけ分かるようにする */}
        {!expanded && docText && (
          <button type="button" className="text-text-lo hover:text-foreground" onClick={onToggle}>
            手順あり
          </button>
        )}
        <span className="flex-1" />
        {onRequestPrep &&
          (node.prepRequest ? (
            <span className="text-text-lo" title="AI が準備しています。終わると会話の上に出ます（数分かかることがあります）">
              AI が準備中…
            </span>
          ) : (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-text-lo hover:bg-muted hover:text-foreground"
              title="AI に、この作業の材料・下書き・開くものを揃えさせる（数分かかることがあります）"
              onClick={onRequestPrep}
            >
              AI に準備させる
            </button>
          ))}
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-text-lo hover:bg-muted hover:text-foreground"
          title="種別・担当・起動方式・手順などを編集する"
          onClick={onEdit}
        >
          編集
        </button>
      </div>

      {statusSection && <div className="mt-2 flex-shrink-0">{statusSection}</div>}

      {expanded && hasBody && (
        <div className="mt-2 flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          {runNote && <p className="text-xs text-text-lo">{runNote}</p>}
          {detail && (
            <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
              <Linkify text={detail} />
            </p>
          )}
          {docText && (
            <div className="chat-md break-words text-sm">
              <Markdown remarkPlugins={[remarkGfm]} components={richMdComponents(`impl:${node.id}`)}>
                {docText}
              </Markdown>
            </div>
          )}
          {showImplSection && implSection}
          {hasOutputs && outputsSection}
        </div>
      )}
    </div>
  );
}
