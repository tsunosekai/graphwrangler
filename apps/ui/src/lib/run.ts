// トリガーから手動でランを作る操作（docs/design.md 3.8「human = 手動でランを作る（トリガー上の▶）」）を、
// 呼び出し口をまたいで1箇所に置いたもの。カードの▶（NodeCard）・左レールのページ行の
// 右クリックメニュー（PageList）・台帳のランボタン（LedgerView）で**同じフォーム・同じ
// 確認文**にするため——挙動が二重管理になると「▶ではプリフィルされるのにメニューでは
// されない」といったズレが出る。
//
// フォームの規約（docs/design.md 3.15）:
// - 入力欄はトリガーの outputs 宣言から作る。**必須にしない**（全部空でもランは作れる）
// - 直近ランの context をプリフィルし、変えたい所だけ直す
// - キャンセル（null）でラン作成自体を中止する（▶連打の幽霊ラン防止も兼ねる）
import type { Node, Run } from "../types";
import { api } from "./api";
import { formDialog } from "./dialogs";
import { pushToast } from "./toast";

export interface FireOptions {
  /** 同じページで実行中のラン本数。1本以上なら「並行で増える」ことを確認文に足す */
  runningRunCount?: number;
  /** 直近ランの context（入力欄のプリフィル）。無ければ空のフォーム */
  lastRunContext?: Record<string, string> | null;
}

/** ラン作成フォームを出して api.runTrigger まで通す。キャンセル・失敗はどちらも null を返す
 *  （失敗のトーストは api() 側で出ている）。成功したら生まれたランを返すので、
 *  呼び出し側は「そのランのページへ移る」等の後始末だけを持てばよい */
export async function runTrigger(trigger: Node, opts: FireOptions = {}): Promise<Run | null> {
  const running = opts.runningRunCount ?? 0;
  const res = await formDialog(
    running > 0
      ? `実行中のラン ${running} 本に加えて、並行で新しいランを開始します。\nランの名前は？（作品名など）`
      : "ランの名前は？（作品名など）",
    {
      fields: trigger.outputs ?? [],
      prefill: opts.lastRunContext ?? undefined,
      titleInput: { placeholder: "空欄なら日時" },
      confirmLabel: "開始",
    },
  );
  if (res === null) return null;
  try {
    const run = await api.runTrigger(trigger.id, {
      title: res.title.trim() || undefined,
      // 空欄の欄は formDialog 側で落ちている。1個も無ければキー自体送らない
      ...(Object.keys(res.values).length > 0 ? { context: res.values } : {}),
    });
    pushToast(`開始しました: ${run.title}`, "info");
    return run;
  } catch {
    return null; // api() 側でトースト表示済み
  }
}
