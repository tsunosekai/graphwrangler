// カードの外周に付く印（NodeCard から切り出し）。カード枠の外に絶対配置される小さなもの:
// 左の完了/中止/処理中バッジ、右のラン作成(▶)と Fix（ロック）、右肩の「あなたの番」ドット。
// 出す/出さないの判断は state.ts（showStatus / showTurn / canRun）が済ませてあり、
// ここは受け取った状態を描くだけ。
import { Loader2, Lock, Play, Unlock } from "lucide-react";
import { HINT_TEXT } from "../../lib/hints";
import { displayNameOf, turnIsMine, useTeam } from "../../lib/team";
import { cn } from "../../lib/utils";
import type { Node, Status } from "../../types";
import { Hint } from "../Hint";
import { Icon } from "../Icon";

/** PDG風の完了/中止マーク（カード左外側の丸バッジ）と処理中スピナー。
 *  done/running は排他なので左スロットは衝突しない（2026-07-31 本人指定で同位置・同サイズ）。
 *  pop = 進捗がいま遷移した（NodeCard が検知）: 完了チェックはハンコみたいに押されて
 *  波紋の輪が1本広がり（badge-stamp）、処理中ぐるぐるはバネっぽくポップする（badge-pop）。
 *  2026-08-17 本人要望のご褒美演出。CSS は index.css */
export function StatusBadge({ visualStatus, pop = false }: { visualStatus: Status; pop?: boolean }) {
  if (visualStatus === "done") {
    return (
      <Hint id="badge-done" always="完了">
        <span className={cn("pdg-badge text-ok", pop && "badge-stamp")}>
          <Icon name="check" size={14} />
        </span>
      </Hint>
    );
  }
  if (visualStatus === "dropped") {
    return (
      <Hint id="badge-dropped" always="中止" text="進捗の「戻す」で待ちに復帰できる">
        <span className="pdg-badge text-text-lo">
          <Icon name="x" size={13} />
        </span>
      </Hint>
    );
  }
  if (visualStatus === "running") {
    return (
      <Hint id="badge-running" always="処理中">
        <span className={cn("pdg-badge", pop && "badge-pop")} style={{ color: "var(--active-color)" }}>
          <Loader2 className="size-3.5 animate-spin" />
        </span>
      </Hint>
    );
  }
  return null;
}

/** 右側のバッジ列: ラン作成(▶) + Fix（ロック）トグル */
export function SideBadges({
  node,
  projecting,
  firing,
  onCreateRun,
  onToggleFixed,
}: {
  node: Node;
  projecting: boolean;
  firing: boolean;
  onCreateRun: () => void;
  onToggleFixed: () => Promise<void>;
}) {
  return (
    <span className="absolute -right-[30px] inset-y-0 flex flex-col items-center justify-center gap-1">
      {node.kind === "trigger" && (
        // ラン表示中は押せない（2026-08-08 本人指定「既に押したラン作成はもう押せないように」）。
        // そのランは作成済みで、ここから作れるのは常に**別の**ランだから紛らわしい。
        // 新しく始めるのはテンプレート表示（＝ページを開いた既定）と実行一覧のランボタンから
        // ——並行ランは従来どおり何本でも回せる
        <Hint
          id="fire"
          always={projecting ? "このランは作成済み" : "手動でランを作る"}
          text={
            projecting
              ? "表示中のランはもう作られています。新しく始めるにはページを開き直す（テンプレート表示）か、実行一覧のランから"
              : HINT_TEXT.fire
          }
        >
          <button
            type="button"
            className="nodrag inline-flex size-[22px] items-center justify-center rounded-full border border-border bg-background text-text-lo transition-opacity hover:opacity-90 disabled:opacity-40"
            disabled={firing || projecting}
            // disabled にはポインタイベントが来ない＝Hint のツールチップが出ないので、
            // 押せない理由だけは native title で見せる
            title={projecting ? "このランは作成済み" : undefined}
            onClick={(e) => {
              e.stopPropagation();
              void onCreateRun();
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
            await onToggleFixed();
          }}
        >
          {node.fixed ? <Lock className="size-3" /> : <Unlock className="size-3" />}
        </button>
      </Hint>
    </span>
  );
}

/** 「あなたの番」の右肩ドット。他人の番（assignee が他人。チーム化 2026-08-04）は
 *  attention 色にせず human 席色で「誰かの回答待ち」だけ伝える */
export function TurnDot({ node }: { node: Node }) {
  const { me, users } = useTeam();
  const turnMine = turnIsMine(node.assignee, me.email);
  return (
    <Hint
      id="turn"
      always={
        turnMine || !node.assignee ? "あなたの番" : `${displayNameOf(node.assignee, users)}の番（回答待ち）`
      }
      text="質問・承認・分岐の回答待ち。ノードを開いて判断カードから回答すると先へ進む"
    >
      <span
        className="absolute -right-1 -top-1 size-2 flex-shrink-0 rounded-full"
        style={{ background: turnMine ? "var(--attention)" : "var(--human)" }}
      />
    </Hint>
  );
}
