// 関係者（チーム化 2026-08-04）: 全ノード種で編集できる（goal ノードはグラフに
// 描画されず開く導線が無い + 配下ノードにも関係者を付けたい、で全種へ開放）。
// 表示するのは実際の関係者だけ——手動 members のチップ（×で解除）と、ページ
// （goal）では配下ノード由来の自動集計（effectiveMembers）のうち手動に無い分の
// 「自動」チップ。追加は末尾の「＋」からメニューで選ぶ（旧: ロスター全員をトグル
// チップで並べていたが、人数が多いと地獄。2026-08-04 実機指摘で現メンバー+＋方式へ）。
// 左レールの人フィルタ・イニシャルバッジは実効関係者（手動 ∪ 自動）を見る。
// 作成者（createdBy）はサーバが刻む不変値なので表示のみ。囲い（bg-card）は付けない
// ——detail や分岐の枝と同じ地のメタ項目として並べる（同日の実機指摘）
import { Plus, X } from "lucide-react";
import type { NodePatchInput } from "../../lib/api";
import { colorOf, displayNameOf, effectiveMembers, sameEmail, useTeam } from "../../lib/team";
import type { Node } from "../../types";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Hint } from "../Hint";

export function MembersSection({
  node,
  allNodes,
  patch,
}: {
  node: Node;
  allNodes: Node[];
  patch: (fields: NodePatchInput) => Promise<void>;
}) {
  const { users, enabled } = useTeam();
  if (!enabled) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <Hint
        id="members"
        text="このノードに関わる人。ページでは配下ノードの担当者・関係者・作成者からも自動で集まる（点線チップ）。左レールの人フィルタはこの実効関係者で絞り込む"
      >
        <span className="self-start text-sm text-muted-foreground">関係者</span>
      </Hint>
      <div className="flex flex-wrap items-center gap-1.5">
        {(node.members ?? []).map((m) => (
          <span
            key={m}
            className="inline-flex items-center gap-1 rounded-full border border-human/60 bg-human/10 px-2 py-0.5 text-xs text-foreground"
            title={m}
          >
            {/* 左端ドット = ユーザーの決定的カラー（colorOf。レール・カードのバッジと同じ色） */}
            <i
              className="size-2 flex-shrink-0 rounded-full"
              style={{ background: colorOf(m) }}
            />
            {displayNameOf(m, users)}
            <Hint id="member-remove" always="関係者から外す">
              <button
                type="button"
                className="inline-flex text-muted-foreground transition-colors hover:text-foreground"
                onClick={() =>
                  patch({ members: (node.members ?? []).filter((x) => !sameEmail(x, m)) })
                }
              >
                <X className="size-3" />
              </button>
            </Hint>
          </span>
        ))}
        {/* ページのみ: 配下ノード由来の継承分（手動 members に無い人）。集計値なので
            ここでは外せない（外したければ配下ノード側の帰属を変える）。控えめな点線 */}
        {node.kind === "goal" &&
          effectiveMembers(node, allNodes)
            .filter((m) => !(node.members ?? []).some((x) => sameEmail(x, m)))
            .map((m) => (
              <Hint
                key={m}
                id="members-auto"
                always="自動集計の関係者"
                text="配下ノードの担当者・関係者・作成者から自動で集まった分。ここでは外せない（外すには配下ノード側の担当者・関係者を変える）"
              >
                <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-text-lo">
                  {displayNameOf(m, users)}
                  <span className="text-[9px]">自動</span>
                </span>
              </Hint>
            ))}
        {/* まだ手動 members に居ないロスターの人だけを候補に出す（無効化ユーザーは除外。
            2026-08-04 アカウント管理）。候補ゼロなら＋自体を出さない */}
        {users.some(
          (u) => !u.disabled && !(node.members ?? []).some((m) => sameEmail(m, u.email)),
        ) && (
          <DropdownMenu>
            <Hint id="member-add" always="関係者を追加">
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 rounded-full text-muted-foreground"
                >
                  <Plus className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="start">
              {users
                .filter(
                  (u) =>
                    !u.disabled &&
                    !(node.members ?? []).some((m) => sameEmail(m, u.email)),
                )
                .map((u) => (
                  <DropdownMenuItem
                    key={u.email}
                    title={u.email}
                    onSelect={() => patch({ members: [...(node.members ?? []), u.email] })}
                  >
                    {displayNameOf(u.email, users)}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {node.createdBy && (
        <span className="text-xs text-muted-foreground">
          作成者: {displayNameOf(node.createdBy, users)}
        </span>
      )}
    </div>
  );
}
