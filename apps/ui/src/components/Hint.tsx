// ヒント吹き出し（2026-08-05 本人要望）。対象にマウスオーバーすると上に吹き出しが出て、
// 右端の「OK」を押すとそのヒントは二度と出ない（lib/hints.ts に永続化）。
// - 付け方は一律マウスオーバー（「?」アイコンは使わない。スマホで出ないのは許容）
// - OK 済み・設定で無効のときは `always`（データ系の内容）があれば普通のツールチップとして
//   残し、無ければ children をそのまま描く（レイアウトを変えない）
import { dismissHint, hintsEnabled, isHintDismissed, useHintsVersion } from "../lib/hints";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface Props {
  /** ヒントの恒久id。同じ概念には同じidを使う（片方でOKすれば全部消える） */
  id: string;
  /** 説明本文（OKで消える側） */
  text: React.ReactNode;
  /** OK後・無効時も普通のツールチップとして残す内容（「担当者: ○○」等のデータ系）。
   *  ヒント表示中は本文の上に太字で出る */
  always?: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** トリガー要素。asChild で使うので ref を受けられる単一要素（span/button等） */
  children: React.ReactElement;
}

export function Hint({ id, text, always, side = "top", children }: Props) {
  useHintsVersion();
  const active = hintsEnabled() && !isHintDismissed(id);
  if (!active && always == null) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-72 text-left">
        {active ? (
          <span className="flex items-center gap-2.5">
            <span className="min-w-0 flex-1">
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
          always
        )}
      </TooltipContent>
    </Tooltip>
  );
}
