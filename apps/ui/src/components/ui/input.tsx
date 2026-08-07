import * as React from "react"

import { cn } from "@/lib/utils"

// forwardRef で包む（shadcn の React 19 版は ref を props として素通しするが、この UI は
// React 18 なので包まないと ref が DOM へ届かない。ヘッダーのゴール捕獲欄が
// 「＋」からフォーカスを受け取るのに必要）
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(function Input(
  { className, type, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        // フォーカスリングは**内側**に描く（2026-08-07 本人報告「枠線が太くなるが幅が
        // 用意されてない」）。外側リング（旧 ring-[3px]）はスクロールコンテナや詰まった
        // レイアウトの中で描画スペースがなく切り取られ、辺ごとに太さが違って見えていた
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
})

export { Input }
