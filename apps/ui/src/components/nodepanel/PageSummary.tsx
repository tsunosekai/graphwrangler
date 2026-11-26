// ページ本体（プロジェクト／ルーティーン）の「読む」表示（docs/design.md 3.23）。
//
// 2026-11-26 本人指摘「ルーティン本体に完了とかは要らないのと、手順書も要らない。プロジェクトも
// 手順書は要らない。ノードに書くことだから」。ページ本体は入れ物なので、実行ノード用の欄
// （進捗の着手・完了、手順書、担当、承認、出力…）は出さない。出すのは:
//   - ルーティーン: いつ動くか（中のトリガー。押すとそのノードへ）
//   - プロジェクト: 中のノードの進み具合と「アーカイブする」
//   - 共通: 概要（書いてあるときだけ）、通知を切っている印
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Linkify } from "../../lib/linkify";
import { pageProgress, pageTriggerLines } from "../../lib/pageSummary";
import { richMdComponents } from "../../lib/richMd";
import { cn } from "../../lib/utils";
import type { Node } from "../../types";
import { Button } from "../ui/button";

export function PageSummary({
  node,
  allNodes,
  expanded,
  onToggle,
  onEdit,
  onSelect,
  onSetArchived,
}: {
  node: Node;
  allNodes: Node[];
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  /** 中のノード（トリガー）へ飛ぶ */
  onSelect: (id: string) => void;
  onSetArchived: (archived: boolean) => void;
}) {
  const triggers = pageTriggerLines(node, allNodes);
  const routine = triggers.length > 0;
  const progress = pageProgress(node, allNodes);
  const archived = node.status === "done" || node.status === "dropped";
  const detail = node.detail?.trim() ?? "";
  // 以前ページ本体に書かれた手順書は消さずに読めるようにしておく（新しくは書けない）
  const legacyDoc = node.impl?.type === "doc" ? (node.impl.text ?? "").trim() : "";
  const hasBody = !!detail || !!legacyDoc;

  return (
    <div className="gw-node-card flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {hasBody && (
          <button
            type="button"
            className="-ml-1 rounded px-1 text-text-lo hover:bg-muted hover:text-foreground"
            title={expanded ? "概要をたたむ（会話を広げる）" : "概要を開く"}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? "▾" : "▸"}
          </button>
        )}
        {routine ? (
          triggers.map((t) => (
            <button
              key={t.id}
              type="button"
              title="いつ動くか。押すとトリガーのノードを開きます"
              className={cn(
                "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 hover:bg-muted hover:text-foreground",
                t.warn && "border-destructive/50 text-destructive",
              )}
              onClick={() => onSelect(t.id)}
            >
              {t.text}
            </button>
          ))
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5">
            {progress.total === 0 ? "ノードはまだありません" : `${progress.settled} / ${progress.total} 済み`}
          </span>
        )}
        {archived && <span className="rounded-full border border-border px-2 py-0.5">アーカイブ済み</span>}
        {node.muted === true && (
          <span
            className="rounded-full border border-border px-2 py-0.5"
            title="左の一覧の右クリックメニューから戻せます"
          >
            通知を切っています
          </span>
        )}
        <span className="flex-1" />
        {/* プロジェクトを片づける出口。ルーティーンは「完了」する性質のものではないので出さない
            （しまいたいときは左の一覧の右クリックから） */}
        {(!routine || archived) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs text-text-lo"
            title={archived ? "アーカイブから戻す" : "このプロジェクトをアーカイブへしまう（あとで戻せます）"}
            onClick={() => onSetArchived(!archived)}
          >
            {archived ? "アーカイブから戻す" : "アーカイブする"}
          </Button>
        )}
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-text-lo hover:bg-muted hover:text-foreground"
          title="概要・関係者を編集する"
          onClick={onEdit}
        >
          編集
        </button>
      </div>

      {expanded && hasBody && (
        <div className="mt-2 flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          {detail && (
            <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
              <Linkify text={detail} />
            </p>
          )}
          {legacyDoc && (
            <div className="chat-md break-words text-sm">
              <p className="text-xs text-text-lo">以前ここに書かれた手順（手順は中のノードに書きます）</p>
              <Markdown remarkPlugins={[remarkGfm]} components={richMdComponents(`impl:${node.id}`)}>
                {legacyDoc}
              </Markdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
