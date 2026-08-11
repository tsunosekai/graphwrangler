// 左レールの人フィルタ（チーム化 2026-08-04。PageList から切り出し）。
// 「どの値が選ばれているか」「その値でページをどう絞るか」「セレクタの見た目」を1つにまとめた。
// 絞り込みの判定は実効関係者（手動 members ∪ 作成者 ∪ 配下ノードの担当・関係者・作成者。
// lib/team.ts の effectiveMembers）で行う。
import { useCallback, useState } from "react";
import { displayNameOf, effectiveMembers, sameEmail, useTeam } from "../../lib/team";
import type { Node } from "../../types";
import { Hint } from "../Hint";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const STORAGE_KEY = "gw.pageFilter";

export interface PersonFilterState {
  /** 正規化済みの選択値。"all" / "me" / "none" / メールアドレス */
  value: string;
  setValue: (v: string) => void;
  /** ページの絞り込み述語（フィルタ無し・ロスター2人未満なら常に true） */
  byPerson: (f: Node) => boolean;
}

export function usePersonFilter(membersOf: (groupId: string) => Node[]): PersonFilterState {
  // チーム化（2026-08-04）: 人フィルタとイニシャルバッジ。ロスターが2人未満なら出さない
  const { me, users, enabled: teamEnabled } = useTeam();
  // 人フィルタ: "all"（全員）/ "me"（自分。ログイン中のみ）/ "none"（帰属なし）/
  // メールアドレス。リロード跨ぎで保持
  const [personFilter, setPersonFilterRaw] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? "all",
  );
  const setValue = (v: string) => {
    setPersonFilterRaw(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      // 無視（永続化は補助機能）
    }
  };
  // 保存値の正規化: 未ログインで "me" が残っていた・ロスターから消えたメールだった、は
  // 「全員」に倒す（Select の表示と絞り込みの両方がこれを使う）。"none"（帰属なし）は有効値
  const value =
    personFilter === "me"
      ? me.email
        ? "me"
        : "all"
      : personFilter === "all" ||
          personFilter === "none" ||
          users.some((u) => !u.disabled && sameEmail(u.email, personFilter))
        ? personFilter
        : "all";
  // ページの絞り込み述語（チーム化 2026-08-04）。判定は実効関係者:
  // - 全員（またはロスター2人未満）: 絞り込みなし
  // - 人: その人が実効関係者に居るページだけ（厳格。実効関係者が空のページは出さない——
  //   当初は全滅防止で「空は常に表示」の救済を入れていたが、「担当が付いていないのに
  //   フィルタをすり抜けて出てくる」と逆の不満になった。2026-08-04 実機指摘で撤回）
  // - 帰属なし: 実効関係者が空のページだけ。救済の代替で、チーム化前の既存データに
  //   帰属を付けて回る作業や拾い漏れの発見に使う
  const byPerson = useCallback(
    (f: Node): boolean => {
      if (!teamEnabled || value === "all") return true;
      const eff = effectiveMembers(f, membersOf(f.id));
      if (value === "none") return eff.length === 0;
      const email = value === "me" ? me.email : value;
      return !!email && eff.some((m) => sameEmail(m, email));
    },
    [teamEnabled, value, me.email, membersOf],
  );

  return { value, setValue, byPerson };
}

/** 人フィルタのセレクタ。見出しの隣へ小さく寄せる（2026-08-05。幅いっぱいのセレクタは
 *  主張が強すぎた）。出す/出さない（degrade 原則）の判断は呼び出し側 */
export function PersonFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { me, users } = useTeam();
  return (
    <Select value={value} onValueChange={onChange}>
      <Hint
        id="person-filter"
        text="実効関係者（担当者・関係者・作成者の集計）でページを絞り込む。関係者なし=誰も付いていないページだけ"
      >
        <SelectTrigger
          size="sm"
          className="h-5 w-auto max-w-24 gap-0.5 border-transparent bg-transparent px-1 py-0 text-[11px] font-normal shadow-none hover:bg-accent/60 [&_svg]:size-3"
        >
          <SelectValue />
        </SelectTrigger>
      </Hint>
      <SelectContent>
        <SelectItem value="all">全員</SelectItem>
        {me.email && <SelectItem value="me">自分</SelectItem>}
        {/* 無効化ユーザーは選択肢から除外（2026-08-04 アカウント管理）。保存値に
            無効化済みメールが残っていた場合は usePersonFilter の正規化が「全員」に倒す */}
        {users
          .filter((u) => !u.disabled && !sameEmail(u.email, me.email))
          .map((u) => (
            <SelectItem key={u.email} value={u.email}>
              {displayNameOf(u.email, users)}
            </SelectItem>
          ))}
        {/* 帰属なし = 実効関係者が空のページだけ。人フィルタは厳格絞り込みなので、
            帰属未記入の既存データはここで見つけて付けて回る（2026-08-04 追修） */}
        <SelectItem value="none">関係者なし</SelectItem>
      </SelectContent>
    </Select>
  );
}
