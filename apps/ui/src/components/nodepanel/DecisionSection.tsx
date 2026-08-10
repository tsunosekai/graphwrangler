// decision ノードの分岐まわり（docs/design.md 3.9）: 分岐を選ぶ/選択結果（DecisionChoice）と
// 枝エディタ（BranchesEditor）。判断リクエストへの回答カード自体は DecisionCard（共通）が担う
import { Trash2 } from "lucide-react";
import { api, type NodePatchInput } from "../../lib/api";
import { confirmDialog } from "../../lib/dialogs";
import { useDraftField } from "../../hooks/useDraftField";
import { pushToast } from "../../lib/toast";
import type { Node, NodeBranch, RunItem } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Hint } from "../Hint";
import { Icon } from "../Icon";

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
  const label = useDraftField(branch.label);

  return (
    <div className="flex items-center gap-1.5">
      <Input
        className="h-8 flex-1"
        value={label.draft}
        disabled={disabled}
        onFocus={() => label.setFocused(true)}
        onChange={(e) => label.setDraft(e.target.value)}
        onBlur={() => {
          label.setFocused(false);
          const t = label.draft.trim();
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

/** decision ノード: choice 未確定なら分岐を選ぶボタン列、確定済みなら選択結果（docs/design.md 3.9）。
 *  human分岐はエンジンが開く判断リクエスト(Threadタブ)でも回答できるが、ここから直接 /decide も正 */
export function DecisionChoice({
  node,
  runView,
  activeRunItem,
  decisionGateOk,
  onMutated,
}: {
  node: Node;
  runView: { id: string; title: string } | null;
  activeRunItem: RunItem | null;
  /** 分岐を選んでよいか（lifecycle=committed かつ frontier。NodePanel が導出） */
  decisionGateOk: boolean;
  onMutated: () => void;
}) {
  // decision の choice 未確定のときだけ「分岐を選ぶ」を出す（docs/design.md 3.9）。
  // ランのページではラン層のワークアイテムを決着させる（3.9のラン内版。テンプレートの
  // choice には触らない——テンプレート層へ書くと設計図側が巻き添えで決着してしまう）
  const decide = async (branchId: string, label: string) => {
    try {
      if (runView) {
        await api.decideRunItem(runView.id, node.id, branchId);
      } else {
        await api.decide(node.id, branchId);
      }
      onMutated();
      pushToast(`${label} に分岐しました`, "info");
    } catch {
      // api() 側でトースト表示済み
    }
  };
  // ランのページでの決着済み表示はランのアイテムの choice を見る（フォーク側 node.choice は
  // ラン作成時点の値のままで更新されない）
  const decidedChoice = runView ? (activeRunItem?.choice ?? null) : node.choice;

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
      pushToast("分岐の選択を取り消しました", "info");
    } catch {
      // api() 側でトースト表示済み
    }
  };

  if (node.kind !== "decision" || !node.branches) return null;
  return node.status === "done" || node.status === "skipped" ? (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
      <Icon name="branch" size={13} />
      選択済み: {node.branches.find((b) => b.id === decidedChoice)?.label ?? decidedChoice ?? "-"}
      <span className="flex-1" />
      {/* 選び直し（手戻り）。自分が上流の分岐でskipされた場合(choice無し)は対象外。
          ラン層の分岐に選び直しは無い（docs/design.md 3.9。繰り返しは「次のラン」で表現する） */}
      {!runView && node.status === "done" && node.choice && (
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
  );
}

/** decision の枝エディタ: ラベル編集+削除（最低2枝）+追加。id は既存のものを変更しない
 *  （エッジが parentOptions[decisionId]=branchId で紐づいているため。docs/design.md 3.9） */
export function BranchesEditor({
  node,
  contentLocked,
  patch,
}: {
  node: Node;
  contentLocked: boolean;
  patch: (fields: NodePatchInput) => Promise<void>;
}) {
  if (node.kind !== "decision") return null;
  return (
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
          disabled={contentLocked}
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
        disabled={contentLocked}
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
  );
}
