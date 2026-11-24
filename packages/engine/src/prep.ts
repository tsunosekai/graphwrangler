// 人間ノードの「前準備」（docs/design.md 3.18）。ランで担当=人間のステップに順番が回ってきたら、
// 「あなたの番」にする前に AI が準備をして、結果をその人間ノードのチャットへ発言する。
// 狙いは、人がノードを開いたときに「あとは手を動かすだけ」になっていること。
//
// 喋るのは**人間ノード側の AI**（前の AI ノードではない）: 作業する場所に出る・前に AI ノードが
// 無くても動く・前のノードに後続の都合を書かせない、の3点のため。
//
// プロンプトの組み立て（純粋関数）と、実行して発言する配線の両方をここに置く。
import { ACTIONS_LANG, toolPermissionLines } from "@graphwrangler/core";
import { getThread, postMessage } from "./api.js";
import { ENGINE_ACTOR, VIA } from "./actor.js";
import { aiExecutorName, runAiExecutor } from "./executor.js";
import { truncate, withSubSteps } from "./format.js";
import { log } from "./log.js";
import { threadContextFor } from "./threadContext.js";
import type { Actor, Node, Run } from "./types.js";

export interface PrepPromptInput {
  node: Node;
  goal: Node | null;
  /** 先行ノードがこのランで出した成果（「タイトル: 本文」） */
  upstream: string[];
  /** このノードのこのランでの経緯（準備し直しのとき、前回の準備や担当者とのやり取りが入る） */
  threadContext: string[];
  runContext: Record<string, string>;
}

/** 前準備のプロンプトを組み立てる（純粋関数） */
export function buildPrepPrompt(input: PrepPromptInput): string {
  const { node, goal, upstream, threadContext, runContext } = input;
  const lines: string[] = [
    "あなたは GraphWrangler（タスクグラフをAIと人間で分担するツール）の、人間の作業の「前準備」担当です。",
    "このあと担当者（人間）が下の作業をします。担当者がこの画面を開いたら**すぐ手を動かせる**よう、" +
      "あなたにできる準備を済ませ、結果を担当者に渡してください。",
    "",
    ...toolPermissionLines("⚙（設定）→「実行AI（エンジン）」"),
    "",
  ];
  if (goal) {
    lines.push(`ゴール: ${goal.title}`);
    if (goal.detail) lines.push(`ゴールの補足: ${goal.detail}`);
    lines.push("");
  }
  if (upstream.length > 0) {
    lines.push("先行ノードがこのランで出した成果:");
    for (const s of upstream) lines.push(`- ${s}`);
    lines.push("");
  }
  if (threadContext.length > 0) {
    lines.push("この作業のこれまでの経緯（準備し直しなら、前回の準備と担当者の発言）:");
    for (const s of threadContext) lines.push(`- ${s}`);
    lines.push("");
  }
  if (Object.keys(runContext).length > 0) {
    lines.push("ランのコンテキスト:");
    for (const [k, v] of Object.entries(runContext)) lines.push(`- ${k}: ${v}`);
    lines.push("");
  }
  lines.push(`担当者の作業: ${node.title}`);
  if (node.detail) lines.push(`補足: ${node.detail}`);
  if (node.impl && node.impl.type === "doc" && node.impl.text) {
    lines.push("", "担当者の手順書:", node.impl.text);
  }
  lines.push(
    "",
    "## 準備としてやること",
    "- 材料を集めて確かめる（ファイルの場所、数字の突き合わせ、いまの状態）",
    "- 下書きを作る（送る文面、入力する値の表）",
    "- 必要なら作業用のファイルを作る・並べる（元のファイルは書き換えない・消さない）",
    "",
    "## やってはいけないこと",
    "- 作業そのもの。送信・支払い・提出・公開・削除など、外に出る操作や取り返しのつかない操作は担当者の仕事",
    "- 窓やアプリを自分で開くこと。担当者が席にいるとは限らない。開くものは下の実行ブロックに書く",
    "- 質問して止まること。準備できなかったことは、理由を添えて「注意」に書く",
    "- 口座番号・住所などの個人情報を書き写すこと。ファイルの場所を示す",
    "",
    "## 返し方",
    "あなたの出力が、そのまま担当者のチャットに出ます。Markdown で短く、次の順に:",
    "1. 一行の要約",
    "2. 「やること」: 残っている手作業だけを、チェックリスト（`- [ ] `）で1件ずつ",
    "3. 材料: コピーして使う文面や値は、**1つずつコードブロック（```）**に入れる（コピーボタンが付く）。" +
      "ブロックの直前に、誰宛て・何用かを1行で書く",
    `4. 実行ブロック: \`\`\`${ACTIONS_LANG} のコードブロックに、1行1個の JSON を書く。実行ボタンになり、` +
      "担当者が「着手」を押すと上から順に実行される:",
    '   - 開く: {"label":"未払いフォルダを開く","open":"X:/経理/未払い"}（URL・フォルダ・ファイル。パスの区切りは / で書く）',
    '   - コマンド: {"label":"…","run":"コマンド"}（どうしても要るときだけ）',
    '   - 着手では実行せず、ボタンを押したときだけにしたいものは "auto": false を足す',
    "5. 「注意」: 食い違い、準備できなかったこととその理由（無ければ省く）",
    "",
    "準備が何も要らない作業なら、要約とやることだけを短く返してください。",
  );
  return lines.join("\n");
}

/** 待ちノードを飛び越えて、成果（say）を持ちうる先祖を集める。待ちは何も喋らないので、
 *  「AI ノード → 待ち → 人間ノード」の人間ノードには、待ちの手前の AI ノードの成果を渡す */
export function upstreamProducers(node: Node, byId: Map<string, Node>, seen = new Set<string>()): Node[] {
  const out: Node[] = [];
  for (const pid of node.parents) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = byId.get(pid);
    if (!p) continue;
    if (p.kind === "wait") out.push(...upstreamProducers(p, byId, seen));
    else if (p.kind !== "trigger") out.push(p);
  }
  return out;
}

async function upstreamSays(node: Node, nodes: Node[], runId: string): Promise<string[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (const p of upstreamProducers(node, byId)) {
    try {
      const { messages } = await getThread(p.id, runId);
      const say = [...messages].reverse().find((m) => m.kind === "say" && m.runId === runId);
      if (say) out.push(`${p.title}: ${say.body}`);
    } catch (err) {
      log(`前準備: 先行ノードの成果の取得に失敗（無しで続行）: run=${runId} node=${p.id} ${String(err)}`);
    }
  }
  return out;
}

/**
 * 人間ノードの前準備を実行し、結果をそのノードのチャット（このランの会話）へ発言する。
 * **失敗しても投げない**——準備はあくまで下ごしらえで、失敗で流れを止めない。呼び出し側は
 * このあと必ず「あなたの番」へ進める。失敗の理由はチャットに残す。
 */
export async function prepareHumanTurn(nodes: Node[], run: Run, node: Node): Promise<void> {
  log(`前準備開始: run=${run.id} node=${node.id} title=${node.title}`);
  const actor: Actor = { kind: "agent", name: aiExecutorName() };
  try {
    const prompt = buildPrepPrompt({
      node,
      goal: nodes.find((n) => n.id === run.pageId) ?? null,
      upstream: await upstreamSays(node, nodes, run.id),
      threadContext: await threadContextFor(node.id, run.id),
      runContext: run.context,
    });
    const result = await runAiExecutor(prompt, node);
    if (result.success && result.output.trim()) {
      await postMessage(
        node.id,
        {
          kind: "say",
          body: result.output.trim(),
          // prep: チャットが上に固定する目印。runId: ランの記録として拾うための併記（tickRun と同じ）
          payload: withSubSteps({ runId: run.id, prep: true }, result),
          runId: run.id,
        },
        actor,
        VIA,
      );
      log(`前準備完了: run=${run.id} node=${node.id}`);
      return;
    }
    const reason = result.error ?? "出力が空でした";
    await postMessage(
      node.id,
      {
        kind: "status",
        body: truncate(`AI の前準備ができませんでした（${reason}）。手順書を見て進めてください`, 500),
        payload: { runId: run.id },
        runId: run.id,
      },
      ENGINE_ACTOR,
      VIA,
    );
    log(`前準備失敗（あなたの番へは進める）: run=${run.id} node=${node.id} reason=${reason}`);
  } catch (err) {
    log(`前準備で例外（あなたの番へは進める）: run=${run.id} node=${node.id} ${String(err)}`);
  }
}
