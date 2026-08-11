// カード下辺の出力（NodeCard から切り出し）。分岐(decision)は選択肢ごとの出力ポートを
// ラベル付きで並べ、それ以外は単一の source ハンドル1つ（docs/design.md 3.9）。
// 決着済みの分岐は「→ 選んだ枝」も出す。
import { Handle, Position } from "@xyflow/react";
import type { Node } from "../../types";
import { Icon } from "../Icon";

export function BottomPorts({ node }: { node: Node }) {
  return (
    <>
      {/* 分岐確定後: 選んだ枝を表示（docs/design.md 3.9） */}
      {node.kind === "decision" && node.choice && (
        <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
          <Icon name="branch" size={12} />
          <span className="truncate">
            → {node.branches?.find((b) => b.id === node.choice)?.label ?? node.choice}
          </span>
        </div>
      )}
      {node.kind === "decision" && node.branches && node.branches.length > 0 ? (
        <>
          {node.branches.map((b, i) => {
            const leftPct = ((i + 0.5) / node.branches!.length) * 100;
            return (
              <Handle
                key={b.id}
                type="source"
                id={b.id}
                position={Position.Bottom}
                style={{ left: `${leftPct}%` }}
              />
            );
          })}
          <div className="pointer-events-none absolute inset-x-1 -bottom-4 flex text-[9px] leading-none text-muted-foreground">
            {node.branches.map((b, i) => {
              const leftPct = ((i + 0.5) / node.branches!.length) * 100;
              return (
                <span
                  key={b.id}
                  className="absolute max-w-[70px] -translate-x-1/2 truncate"
                  style={{ left: `${leftPct}%` }}
                  title={b.label}
                >
                  {b.label}
                </span>
              );
            })}
          </div>
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} />
      )}
    </>
  );
}
