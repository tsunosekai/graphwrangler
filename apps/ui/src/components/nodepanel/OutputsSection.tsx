// 出力宣言エディタ（docs/design.md 3.15）: このノードがランのコンテキストへ書き出す
// キーの宣言（name/label/example）。task と trigger で表示する。トリガーの outputs は
// 「ランを作るときに入る初期キー」＝手動▶のラン作成フォームの項目 / 検知スクリプトの emit 契約。
// ラン表示（runView）では出さない——宣言はやり方（テンプレート側）だから
import { Trash2 } from "lucide-react";
import type { NodePatchInput } from "../../lib/api";
import { useDraftField } from "../../hooks/useDraftField";
import type { Node, OutputParam } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Hint } from "../Hint";

/** 出力宣言（docs/design.md 3.15）の新規行の name 採番: out1, out2, ... の空いている最初の番号 */
function nextOutputName(existing: OutputParam[]): string {
  let i = 1;
  while (existing.some((o) => o.name === `out${i}`)) i++;
  return `out${i}`;
}

/** 出力宣言エディタの1行（docs/design.md 3.15）。name / label / example を blur で確定する
 *  （title/detail/BranchRow と同じ「編集中は自分のdraftを見る」流儀）。行の追加・削除は親が持つ */
function OutputRow({
  output,
  disabled,
  onCommit,
  onRemove,
}: {
  output: OutputParam;
  disabled?: boolean;
  onCommit: (next: OutputParam) => void;
  onRemove: () => void;
}) {
  const field = useDraftField<OutputParam>(output);

  const commit = () => {
    field.setFocused(false);
    const name = field.draft.name.trim();
    if (!name) {
      field.setDraft(output); // name 空は無効。元の値へ戻す
      return;
    }
    const next: OutputParam = {
      name,
      label: field.draft.label?.trim() || null,
      example: field.draft.example?.trim() || null,
    };
    if (next.name !== output.name || next.label !== (output.label ?? null) || next.example !== (output.example ?? null)) {
      onCommit(next);
    }
  };

  const blurOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };

  return (
    <div className="flex items-center gap-1.5">
      <Input
        className="h-8 w-24 flex-shrink-0 font-mono text-xs"
        placeholder="name"
        value={field.draft.name}
        disabled={disabled}
        onFocus={() => field.setFocused(true)}
        onChange={(e) => field.setDraft((d) => ({ ...d, name: e.target.value }))}
        onBlur={commit}
        onKeyDown={blurOnEnter}
      />
      <Input
        className="h-8 flex-1"
        placeholder="ラベル"
        value={field.draft.label ?? ""}
        disabled={disabled}
        onFocus={() => field.setFocused(true)}
        onChange={(e) => field.setDraft((d) => ({ ...d, label: e.target.value }))}
        onBlur={commit}
        onKeyDown={blurOnEnter}
      />
      <Input
        className="h-8 flex-1"
        placeholder="例"
        value={field.draft.example ?? ""}
        disabled={disabled}
        onFocus={() => field.setFocused(true)}
        onChange={(e) => field.setDraft((d) => ({ ...d, example: e.target.value }))}
        onBlur={commit}
        onKeyDown={blurOnEnter}
      />
      <Hint id="output-remove" always="この出力宣言を削除">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          title={disabled ? "ロック中は編集できません" : undefined}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </Hint>
    </div>
  );
}

export function OutputsSection({
  node,
  runView,
  contentLocked,
  pageHasTrigger,
  patch,
}: {
  node: Node;
  runView: { id: string; title: string } | null;
  contentLocked: boolean;
  /** ページ（group）がトリガーを持つか（NodePanel が一度だけ導出） */
  pageHasTrigger: boolean;
  patch: (fields: NodePatchInput) => Promise<void>;
}) {
  if (runView || (node.kind !== "task" && node.kind !== "trigger")) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5">
      <Hint
        id="outputs"
        text={
          node.kind === "trigger"
            ? "ランを作るときに入る初期キーの宣言。手動▶の入力フォームの項目になり、検知スクリプト・AIのラン作成が出す context の契約にもなる（入力は任意＝空でもランは作れる）"
            : "このノードがランのコンテキストへ書き出すキーの宣言。下流のコマンドは {name} で参照でき、配線チェック（参照矢印と警告）の根拠になる"
        }
      >
        <span className="self-start text-sm text-muted-foreground">
          出力（ランのコンテキスト）
        </span>
      </Hint>
      {(node.outputs ?? []).map((o, i) => (
        <OutputRow
          // name は編集で変わり得るので index を key にする（BranchRow と違い恒久idが無い）
          key={i}
          output={o}
          disabled={contentLocked}
          onCommit={(next) =>
            patch({
              outputs: (node.outputs ?? []).map((x, j) => (j === i ? next : x)),
            })
          }
          onRemove={() => {
            const rest = (node.outputs ?? []).filter((_, j) => j !== i);
            patch({ outputs: rest.length > 0 ? rest : null });
          }}
        />
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={contentLocked}
        title={node.fixed ? "ロック中は編集できません" : undefined}
        onClick={() =>
          patch({
            outputs: [
              ...(node.outputs ?? []),
              { name: nextOutputName(node.outputs ?? []), label: null, example: null },
            ],
          })
        }
      >
        + 出力を追加
      </Button>
      {/* トリガーを持たないページ（プロジェクト）ではランが無い＝context も無い。
          宣言自体は置けるが効かないことを注記する（docs/design.md 3.15 適用範囲） */}
      {node.kind !== "trigger" && !pageHasTrigger && (
        <p className="text-xs text-text-lo">
          このページはトリガーを持たない（プロジェクト）ため、出力宣言はランでのみ有効です
        </p>
      )}
    </div>
  );
}
