// デスクトップ版（apps/desktop）への橋と、チャットの実行ボタン（gw-actions）の実行。
// ブラウザやスマホで開いているときは橋が無い——そのときにできるのは Web の URL を開くことだけで、
// フォルダ・ファイル・コマンドは「デスクトップ版で実行できます」と伝える。
import { extractActions, isWebUrl, type GwAction } from "@graphwrangler/core/prep";
import { pushToast } from "./toast";

interface DesktopBridge {
  show?: () => void;
  open?: (target: string) => Promise<{ ok: boolean; error?: string }>;
  run?: (command: string) => Promise<{ ok: boolean; error?: string }>;
}

function bridge(): DesktopBridge | null {
  return (window as unknown as { gwDesktop?: DesktopBridge }).gwDesktop ?? null;
}

/** フォルダ・ファイルを開く／コマンドを実行する、ができる環境か（＝デスクトップ版の窓の中か） */
export function canRunLocally(): boolean {
  const b = bridge();
  return !!b?.open && !!b?.run;
}

/** この環境でその項目を実行できるか */
export function canRunAction(action: GwAction): boolean {
  if (action.type === "open" && isWebUrl(action.target)) return true;
  return canRunLocally();
}

/** 実行項目を1つ実行する。できなかったらトーストで知らせて false */
export async function runAction(action: GwAction): Promise<boolean> {
  const b = bridge();
  try {
    if (action.type === "open") {
      if (b?.open) {
        const r = await b.open(action.target);
        if (!r.ok) throw new Error(r.error ?? "開けませんでした");
        return true;
      }
      if (isWebUrl(action.target)) {
        window.open(action.target, "_blank", "noopener,noreferrer");
        return true;
      }
      throw new Error("フォルダやファイルはデスクトップ版でだけ開けます");
    }
    if (!b?.run) throw new Error("コマンドはデスクトップ版でだけ実行できます");
    const r = await b.run(action.command);
    if (!r.ok) throw new Error(r.error ?? "実行できませんでした");
    return true;
  } catch (err) {
    pushToast(`「${action.label}」: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ---- 着手での一括実行 ----
// いま開いているノードの「最新の前準備」の本文を、会話を描いている Thread が登録する。
// 着手ボタン（StatusSection）は会話のデータを持っていないので、ここ経由で受け取る。

const currentPrep = new Map<string, string>();
/** runId が null = テンプレート側（プロジェクト層のノード） */
const prepKey = (nodeId: string, runId: string | null) => `${runId ?? "template"}:${nodeId}`;

export function setCurrentPrep(nodeId: string, runId: string | null, body: string | null): void {
  if (body === null) currentPrep.delete(prepKey(nodeId, runId));
  else currentPrep.set(prepKey(nodeId, runId), body);
}

/** 着手したとき: 前準備の実行項目のうち auto のものを上から順に実行する。
 *  この環境で実行できないもの（スマホでのフォルダ等）は黙って飛ばす——着手のたびに
 *  「開けません」が並ぶのを避ける（個別のボタンを押したときは理由を出す） */
export async function runPrepActionsOnStart(nodeId: string, runId: string | null): Promise<void> {
  const body = currentPrep.get(prepKey(nodeId, runId));
  if (!body) return;
  for (const action of extractActions(body)) {
    if (!action.auto || !canRunAction(action)) continue;
    await runAction(action);
  }
}
