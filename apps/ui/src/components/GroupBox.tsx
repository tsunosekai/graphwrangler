// グループ（ゴール=ノード群のフォルダ）の描画。Houdiniのネットワークボックス風の囲い。
import type { Node } from "../types";
import { Icon } from "./Icon";

export interface GroupBoxData {
  node: Node;
  selected: boolean;
  onSelect: (id: string) => void;
  [key: string]: unknown;
}

export function GroupBox({ data }: { data: GroupBoxData }) {
  const { node } = data;
  return (
    <div
      className={`group-box ${data.selected ? "is-selected" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        data.onSelect(node.id);
      }}
    >
      <div className="group-box-title">
        {node.status === "done" ? (
          <span className="group-done">
            <Icon name="check" size={12} />
          </span>
        ) : null}
        {node.title}
      </div>
    </div>
  );
}
