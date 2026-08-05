// 依存エッジの選択+切断。選択中は太らせて中点に✂ボタンを出す。
// 実データの切断（parents から source を除く patch）は呼び出し元（GraphView）の onCut に一任する
// ——このコンポーネントは見た目とクリック位置だけを持つ。
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { Hint } from "./Hint";

export interface CutEdgeData {
  selected: boolean;
  onCut: (id: string) => void;
  /** decision分岐(kind=decision)から生えるエッジの枝ラベル（docs/design.md 3.9） */
  label?: string;
  /** choice確定後、選ばれなかった枝のエッジを減光する */
  deemphasize?: boolean;
  [key: string]: unknown;
}

export function CutEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const d = data as CutEdgeData | undefined;
  const selected = !!d?.selected;
  const deemphasize = !!d?.deemphasize;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? "var(--border-strong)" : "var(--edge)",
          strokeWidth: selected ? 2 : 1,
          opacity: deemphasize ? 0.35 : 1,
        }}
      />
      {d?.label && !selected && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none whitespace-nowrap rounded-sm bg-background/80 px-1 text-[9px] leading-tight text-muted-foreground"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              opacity: deemphasize ? 0.55 : 1,
            }}
          >
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
      {selected && (
        <EdgeLabelRenderer>
          <Hint id="edge-cut" always="依存を切る" text="このエッジ（前後の依存）を外す。Ctrl+Z で戻せる">
            <button
              type="button"
              className="nodrag nopan flex size-5 items-center justify-center rounded-full border border-border-strong bg-card text-xs leading-none text-foreground hover:bg-accent"
              style={{
                position: "absolute",
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                pointerEvents: "all",
              }}
              onClick={(e) => {
                e.stopPropagation();
                d?.onCut(id);
              }}
            >
              ✂
            </button>
          </Hint>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
