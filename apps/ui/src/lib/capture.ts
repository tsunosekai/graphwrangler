// ヘッダーのゴール捕獲欄へフォーカスを渡すための薄いイベントバス（lib/palette.ts と同じ流儀）。
// 左レールの「＋」など、別の場所にある「新しいプロジェクトを作る」導線を、
// 唯一の入口であるヘッダーの入力欄へ集約するために使う（docs/design.md 4章 ②）。
type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeFocusGoalCapture(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function focusGoalCapture(): void {
  for (const fn of listeners) fn();
}
