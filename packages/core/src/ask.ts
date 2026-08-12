// QUESTION プロトコル（AIが「人間にしか決められないこと」に当たったとき、作業を進めずに
// 決まった形で出力して止まる規約）。2026-08-03 本人指示「判断を促す仕組みも必要」。
//
// 2026-08-11 に engine から core へ移した。使い手が2つになったため:
//   - engine … ノード実行AI の出力を判定し、判断リクエストへ変換する（従来から）
//   - server … スレッドの Task AI（会話相手）の返信を判定する。会話の1往復ごとに
//              Discord へ通知していた旧仕様を廃止した代わりに、**AIが本当に人間の判断を
//              要したときだけ**「あなたの番」として鳴らすため（2026-08-11 本人指示
//              「AIが人間に本当に問い合わせをしたい時だけグラフ通知チャンネルに通知を出して」）
//
// 「人間の判断が要る」の表明を1つの規約に寄せているのが肝。表明の形が増えると、
// 通知を鳴らす条件も増えて、結局「全部鳴らす」に戻る。
import type { DecisionRequest } from "./schema.js";

function truncate(text: string, limit: number): string {
  const t = text.trim();
  return t.length <= limit ? t : t.slice(0, limit) + "…";
}

export interface AiQuestion {
  question: string;
  /** AIが提示した選択肢（0〜3個に切り詰めて使う。無ければ「おまかせで続行」を補う） */
  options: string[];
  /** 質問の下に書かれた判断材料の補足（無ければ空文字） */
  context: string;
}

/**
 * AI出力が QUESTION プロトコルか判定する。1行目が `QUESTION: 質問文`（全角コロン可、
 * 大文字小文字不問）なら質問とみなし、続く `OPTION: 選択肢` 行と残りの補足を取り出す。
 * それ以外の出力は null（=通常の作業成果 / 通常の返信）。
 */
export function parseAiQuestion(output: string): AiQuestion | null {
  const lines = output.trim().split(/\r?\n/);
  const first = lines[0]?.match(/^QUESTION[:：]\s*(.+)$/i);
  if (!first) return null;
  const options: string[] = [];
  const rest: string[] = [];
  for (const line of lines.slice(1)) {
    const opt = line.match(/^OPTION[:：]\s*(.+)$/i);
    if (opt) options.push(opt[1].trim());
    else rest.push(line);
  }
  return { question: first[1].trim(), options, context: rest.join("\n").trim() };
}

/**
 * AIの質問を人間向けの判断リクエストへ変換する。AI提示の選択肢は id "ai:1".. で並べ
 * （無ければ「おまかせで続行」）、末尾に必ず「中止」(id "abort") を付ける——abort は
 * engine の pick.ts / ラン側の質問tickが drop として解釈する予約id。
 * それ以外の回答（ai:* や自由文）は「回答を踏まえて再実行」になる。
 *
 * runMarker（engine の `[ラン <id>]`）を渡すと question の末尾に埋め込む——どのランの
 * 質問かを engine が回答から復元するため。会話（Task AI）からの質問はランに紐付かないので
 * 渡さない。
 */
export function buildAiQuestionRequest(
  nodeTitle: string,
  q: AiQuestion,
  runMarker?: string | null,
): DecisionRequest {
  const aiOptions =
    q.options.length > 0
      ? q.options.slice(0, 3).map((label, i) => ({
          id: `ai:${i + 1}`,
          label: truncate(label, 80),
          then: "この方針でAIが作業を続ける",
        }))
      : [
          {
            id: "ai:proceed",
            label: "おまかせで続行",
            then: "AIが自分の判断で決めて作業を続ける",
          },
        ];
  const contextLines = [`AIが「${nodeTitle}」の作業中に人間の判断を求めています。`];
  if (q.context) contextLines.push(truncate(q.context, 300));
  return {
    context: contextLines.join("\n"),
    question: runMarker ? `${q.question} ${runMarker}` : q.question,
    options: [
      ...aiOptions,
      {
        id: "abort",
        label: "中止",
        then: runMarker ? "このランではこのアイテムを中止する" : "このタスクを中止(dropped)にする",
      },
    ],
    impact: "safe",
    undo: null,
  };
}

/** QUESTION プロトコルの説明（AIのプロンプトに入れる文面）。engine は autonomy に応じて、
 *  server は Task AI のプロンプトに、それぞれ足す */
export const QUESTION_PROTOCOL_LINES = [
  "人間の判断が必要になったときは、作業を進めずに次の形式**だけ**を出力して終了してください:",
  "QUESTION: <人間への質問（1行）>",
  "OPTION: <選択肢>（任意。1行1個で最大3個。選んでほしい方針があるときに）",
  "（以降の行は判断材料の補足として自由に書いてよい）",
];

/**
 * ツール権限の説明（2026-08-12 本人報告「ダイアログが何のことかわからない」）。
 *
 * GraphWrangler の AI は全員ヘッドレス（claude -p）で動く。未許可のツールを呼ぶと CLI が
 * permission エラーを返すが、**対話的な許可ダイアログは出ない**——人間には押すボタンが無い。
 * それを知らない AI は「許可ダイアログを承認してください」と待ちに入り、人間は永久に承認
 * できず会話が詰まる（実際に Google カレンダー登録で発生）。
 * 正しい導線は「未許可だと伝えて、設定の追加許可ツールへ足してもらう」なので、それを教える。
 *
 * @param settingPath 追加許可ツールの在り処（役ごとに違う。例: ⚙（設定）→「実行AI（エンジン）」）
 */
export function toolPermissionLines(settingPath: string): string[] {
  return [
    "あなたはヘッドレスで動いています。**許可ダイアログは出ません**——人間の画面に承認ボタンは"
      + "存在しないので、承認を待っても永久に進みません。",
    "使えるツールは起動時の許可リストで固定です。未許可のツール（MCP のツール等）を呼ぶと"
      + "permission エラーで返ります。",
    "権限エラーが出たら、承認を待たずにその場で**どのツールが未許可か**を伝え、"
      + `${settingPath}の「追加許可ツール」へ \`mcp__<サーバ名>__*\` の形で足す必要がある、と案内してください。`,
    "「許可ダイアログを承認してください」「承認したら教えてください」とは言わないこと。",
  ];
}
