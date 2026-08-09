// 参照矢印（docs/design.md 3.15）: 出力宣言（producer）とコマンド中の `{x}` 参照（consumer）
// から**自動導出**される破線エッジ。依存エッジ（CutEdge）とは別物で、手で張る線ではないため
// 選択・切断はできない（GraphView 側で selectable:false + onEdgeClick 対象外にしている）。
// 色は AI 青（--ai）+ 破線で、依存エッジ（--edge の実線）と一目で区別できるようにする。
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";

export interface RefEdgeData {
  /** 運ばれるキー名（run.context のキー）。中点にラベルとして出す */
  label: string;
  [key: string]: unknown;
}

export function RefEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
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
  const d = data as RefEdgeData | undefined;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: "var(--ai)",
          strokeWidth: 1,
          strokeDasharray: "5 4",
          opacity: 0.55,
          // 参照矢印はクリック対象にしない（依存エッジの選択・切断を邪魔しない）
          pointerEvents: "none",
        }}
      />
      {d?.label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none whitespace-nowrap rounded-sm bg-background/80 px-1 text-[9px] leading-tight"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              color: "var(--ai)",
              opacity: 0.9,
            }}
          >
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
