// スレッド（GET /api/nodes/:id/thread）から実行判定・プロンプトのための文脈を集める。
// どれも「取得に失敗してもその周は文脈なしで進む」方針（文脈は補助であり必須ではない）。
import { getThread } from "./api.js";
import { buildThreadContextLines } from "./ask.js";
import { log } from "./log.js";
import type { Message, Node } from "./types.js";

export async function lastMessagesFor(nodeIds: string[]): Promise<Record<string, Message | undefined>> {
  const result: Record<string, Message | undefined> = {};
  for (const id of nodeIds) {
    try {
      const { messages } = await getThread(id);
      result[id] = messages[messages.length - 1];
    } catch (err) {
      log(`スレッド取得に失敗（この周は候補から除外扱い）: node=${id} ${String(err)}`);
    }
  }
  return result;
}

/** 自ノードのスレッドから再実行プロンプト用の経緯（人間へのQ&A・直前の失敗）を拾う。
 *  runScope にランidを渡すと**そのランの会話だけ**を見る——ランは独立した世界線なので、
 *  別ランのQ&A（「質問不要」等の回答）が新しいランの実行文脈へ漏れると、手順書の
 *  「必ず質問すること」を AI が「もう確定済み」と飛ばす（2026-08-12 本人報告の原因）。
 *  null はテンプレート側（プロジェクト層の実行）。
 *  取得失敗時は経緯なしで実行を続ける（経緯は補助文脈であり必須ではない） */
export async function threadContextFor(nodeId: string, runScope: string | null = null): Promise<string[]> {
  try {
    const { messages } = await getThread(nodeId, runScope);
    return buildThreadContextLines(messages);
  } catch (err) {
    log(`スレッド経緯の取得に失敗（経緯なしで実行継続）: node=${nodeId} ${String(err)}`);
    return [];
  }
}

/** 親ノードのスレッド末尾の say メッセージ（文脈）を集める */
export async function parentSayContext(node: Node, nodes: Node[]): Promise<string[]> {
  const out: string[] = [];
  for (const pid of node.parents) {
    try {
      const { messages } = await getThread(pid);
      const say = [...messages].reverse().find((m) => m.kind === "say");
      if (say) {
        const title = nodes.find((n) => n.id === pid)?.title ?? pid;
        out.push(`${title}: ${say.body}`);
      }
    } catch (err) {
      log(`親ノードの文脈取得に失敗（実行は継続）: node=${pid} ${String(err)}`);
    }
  }
  return out;
}

/** parentSayContext のラン層版: 同じランに属する say（Message.runId === runId）だけを拾う。
 *  テンプレートのスレッドには複数の並列ランの記録が混ざるため、フィルタ無しで末尾を
 *  拾うと別ランの成果を文脈として渡してしまう（従来はラン層で [] 固定＝親の成果が
 *  全く渡っていなかった穴の修復。2026-08-09） */
export async function parentSayContextForRun(node: Node, nodes: Node[], runId: string): Promise<string[]> {
  const out: string[] = [];
  for (const pid of node.parents) {
    try {
      // そのランのスコープで取得する（2026-08-12 修正: 従来は既定=テンプレートスコープで
      // 取得していたため、runId 付きで保存されるランの say がそもそも応答に含まれず、
      // 下の filter が常に空振り＝親の成果が渡らない穴が 2026-08-09 の修正後も残っていた）
      const { messages } = await getThread(pid, runId);
      const say = [...messages].reverse().find((m) => m.kind === "say" && m.runId === runId);
      if (say) {
        const title = nodes.find((n) => n.id === pid)?.title ?? pid;
        out.push(`${title}: ${say.body}`);
      }
    } catch (err) {
      log(`親ノードの文脈取得に失敗（実行は継続）: run=${runId} node=${pid} ${String(err)}`);
    }
  }
  return out;
}
