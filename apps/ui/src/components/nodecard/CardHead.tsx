// カードの上段（NodeCard から切り出し）: 担当アイコン・担当者バッジ・種別チップ・タイトル、
// そして右側に並ぶ小さな印（実装形態・⚠2種・配線の注意・未読）。
// ここは「node を読んで出すだけ」で、状態の導出（dimmed 等）は state.ts が決めたものを受ける。
import { colorOf, displayNameOf, initialOf, useTeam } from "../../lib/team";
import { HINT_TEXT } from "../../lib/hints";
import { EXECUTOR_JA, KIND_JA } from "../../lib/labels";
import { cn } from "../../lib/utils";
import type { Node } from "../../types";
import { Hint } from "../Hint";
import { Icon } from "../Icon";
import { TitleInput } from "./TitleInput";
import type { NodeCardData } from "./types";

// 担当アイコン（2026-07-31 本人選定「B. 明快系」: 人型 / ロボット顔 / ターミナル >_）
const EXEC_ICON: Record<Node["executor"], "user" | "bot" | "terminal"> = {
  human: "user",
  ai: "bot",
  script: "terminal",
};
// 種別の文字チップ（本人選定「A+D」）・進捗・担当の日本語は lib/labels.ts が唯一の正

const EXEC_TEXT: Record<Node["executor"], string> = {
  human: "text-human",
  ai: "text-ai",
  script: "text-script",
};

export function CardHead({ data, dimmed }: { data: NodeCardData; dimmed: boolean }) {
  const { node } = data;
  const { users, enabled: teamEnabled } = useTeam();
  return (
    <div className={cn("flex items-center gap-1.5", dimmed && "opacity-55")}>
      {/* 担当アイコンのヒント（2026-08-05 本人指定の最重要ヒント）: 担当=誰が始めるのか。
          id はパネルの「担当」と共有——どちらかで OK すれば両方消える */}
      <Hint id="executor" always={`担当: ${EXECUTOR_JA[node.executor]}`} text={HINT_TEXT.executor}>
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
      <Hint id="kind" always={`種別: ${KIND_JA[node.kind]}`} text={HINT_TEXT.kind}>
        <span className="flex-shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground">
          {KIND_JA[node.kind]}
        </span>
      </Hint>
      {data.editing ? (
        <TitleInput node={node} onCommit={data.onCommitTitle} onCancel={data.onCancelEdit} />
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
          kind=trigger は対象外——トリガーの executor=script は「schedule でランを作る」の意味で
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
          ラン作成は止めない（警告のみ）ので、エラー赤ではなく注意の橙（--attention）で描く */}
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
  );
}
