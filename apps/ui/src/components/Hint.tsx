// ヒント吹き出し（2026-08-05 本人要望）。対象にマウスオーバーすると上に吹き出しが出て、
// 右端の「OK」を押すとその説明は二度と出ない（lib/hints.ts に永続化）。
//
// UI全体のホバー表示はこのコンポーネントに統一する（一貫性。2026-08-05 本人指摘）:
// - アイコンだけの操作 = always に操作名、text に一歩踏み込んだ説明（あれば）
// - ラベル付きボタン    = text に説明だけ（OK後は何も出ない。意味はラベルが担う）
// - 状態チップ・属性     = always に現在値/状態名、text に概念の説明
// - text を省略した場所は「OKなし・ラベルだけ」の吹き出しになる（見た目は同じ）
// native の title= を使ってよいのは (a) truncate された全文・メール・note 等の生データ開示、
// (b) disabled 要素の理由（disabled にはポインタイベントが来ず吹き出しが開けない）のみ。
// スマホ（タッチ）では出ないが許容（本人指定）。
import { forwardRef } from "react";
import { Slot } from "radix-ui";
import { dismissHint, hintsEnabled, isHintDismissed, useHintsVersion } from "../lib/hints";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * TooltipTrigger と子の間に挟む中継（2026-08-08）。
 *
 * TooltipTrigger(asChild) は自分の `data-state`（closed / delayed-open）を子へ渡すが、
 * 子が Radix 部品（TabsTrigger 等）だと内部の `data-state="active"` を上書きしてしまい、
 * 選択中スタイルが消える。ここで data-state だけ落として残りは素通しすることで、
 * 子の状態を守りつつ ref（＝吹き出しの位置基準）とホバー用ハンドラは正しく届く。
 *
 * 直前の実装（display:contents の span で包む）は data-state 衝突は避けられるものの、
 * ラッパーの矩形が 0 になるため吹き出しが**画面左上**に出る不具合になっていた。
 */
type HintTargetProps = { children?: React.ReactNode } & Record<string, unknown>;

const HintTarget = forwardRef<HTMLElement, HintTargetProps>(function HintTarget(props, ref) {
  const { "data-state": _tooltipState, ...rest } = props;
  return <Slot.Root ref={ref as React.Ref<never>} {...(rest as object)} />;
});

interface Props {
  /** ヒントの恒久id。同じ概念には同じidを使う（片方でOKすれば全部消える） */
  id: string;
  /** 説明本文（OKで消える側）。省略時は always だけのラベル吹き出しになる */
  text?: React.ReactNode;
  /** OK後・無効時も吹き出しとして残す内容（操作名・状態・データ系）。
   *  ヒント表示中は本文の上に太字で出る */
  always?: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** トリガー要素。asChild で使うので ref を受けられる単一要素（span/button等） */
  children: React.ReactElement;
}

export function Hint({ id, text, always, side = "top", children }: Props) {
  useHintsVersion();
  const active = text != null && hintsEnabled() && !isHintDismissed(id);
  if (!active && always == null) return children;
  return (
    <Tooltip>
      {/* HintTarget 経由で合成する（data-state だけ落として素通し）。理由は上の定義を参照 */}
      <TooltipTrigger asChild>
        <HintTarget>{children}</HintTarget>
      </TooltipTrigger>
      {/* text-wrap: ベースの text-balance を打ち消す。balance だと行が均等長に折り返されて
          文の右側に余白が生まれ、OKボタンとの間が不自然に空いて見える（2026-08-05 本人報告） */}
      <TooltipContent side={side} className="max-w-72 text-left text-wrap">
        {active ? (
          <span className="flex items-center gap-2.5">
            <span className="min-w-0 flex-1 whitespace-pre-line">
              {always != null && <span className="mb-0.5 block font-semibold">{always}</span>}
              {text}
            </span>
            <button
              type="button"
              className="flex-shrink-0 self-center rounded border border-background/40 px-1.5 py-0.5 text-[10px] font-semibold leading-none transition-colors hover:bg-background/20"
              title="このヒントを二度と表示しない"
              onClick={(e) => {
                e.stopPropagation();
                dismissHint(id);
              }}
            >
              OK
            </button>
          </span>
        ) : (
          <span className="whitespace-pre-line">{always}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
