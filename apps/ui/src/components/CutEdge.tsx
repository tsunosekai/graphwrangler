// 依存エッジの選択+切断（QOL-2）。選択中は太らせて中点に✂ボタンを出す。
// 実データの切断（parents から source を除く patch）は呼び出し元（GraphView）の onCut に一任する
// ——このコンポーネントは見た目とクリック位置だけを持つ。
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";

export interface CutEdgeData {
  selected: boolean;
  onCut: (id: string) => void;
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

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? "var(--border-strong)" : "var(--edge)",
          strokeWidth: selected ? 2 : 1,
        }}
      />
      {selected && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan flex size-5 items-center justify-center rounded-full border border-border-strong bg-card text-xs leading-none text-foreground hover:bg-accent"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            title="依存を切る"
            onClick={(e) => {
              e.stopPropagation();
              d?.onCut(id);
            }}
          >
            ✂
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
