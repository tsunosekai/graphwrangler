// 通知の宛先（関係者）の解決。2026-08-11 本人要望「『関係者』を見て適切にメンションしてほしい」。
//
// 従来は assignee 1本しか見ておらず、担当未設定のノードは「あなたの番は @here / Task AI 返信は
// 無言」に落ちていた——**鳴るのに宛先が無い通知**は、チャンネルの信用を落とす一番典型的な
// 作られ方だった（2026-08-11 本人報告「メンションが無いなぁ」「出しすぎると人間はそのチャンネルを
// 信用しなくなる（オオカミ少年）」）。
//
// 段を上から試し、**最初に1人でも取れた段で打ち切る**（取れなければ次の段へ広げる）。
// 全段を合算しないのは、広げるほど「実質全員通知」に戻り、メンションの重みが消えるため。
//   1. assignee                            … 担当が居るならその人だけの番
//   2. ノードの createdBy                  … 担当未設定なら、そのノードを立てた人が当事者
//   3. ページ(group)の members + createdBy … ノード単位で決まらなければページの関係者へ
//   4. 直近スレッドの人間の発言者          … それも空なら、実際に会話していた人へ
// どの段も空なら [] を返す。呼び出し側はそれを @here にする＝本当の意味の「全員の番」だけが
// 全体を鳴らす。
import type { GraphStore, Message, ThreadStore } from "@graphwrangler/core";
import type { NotifyUser } from "./discord.js";

/** 段4で遡るスレッドの件数。直近の会話の当事者が拾えれば十分で、
 *  遡りすぎると「昔ちょっと書いた人」まで鳴らしてしまう */
const THREAD_LOOKBACK = 20;

/** メールの大文字小文字を無視して重複を潰す（users.json との突き合わせと同じ規約）。
 *  最初に現れた表記を残す——表示に使うのは users.json 側なので実害は無いが、
 *  順序が入力ごとにブレると通知本文が安定しない */
function dedupe(emails: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of emails) {
    if (!e) continue;
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export interface ResolveRecipientsInput {
  /** 担当者（メール）。null = 未割当 */
  assignee: string | null;
  /** ノードの作成者（メール）。ログイン無し運用・エンジン/MCP 経由では null */
  createdBy: string | null;
  /** 所属ページ（group）。関係者(members)を持つのはページだけ。無所属なら null */
  page: { members: string[]; createdBy: string | null } | null;
  /** 直近スレッドで発言した人間のメール（呼び出し側で人間の発言だけに絞って渡す） */
  threadAuthors: string[];
}

/**
 * 宛先メールを決める（純粋関数。テスト対象）。上の段から順に試し、
 * **最初に1人でも取れた段の結果をそのまま返す**。全段空なら []。
 */
export function resolveRecipientEmails(input: ResolveRecipientsInput): string[] {
  const stages: (string | null | undefined)[][] = [
    [input.assignee],
    [input.createdBy],
    input.page ? [...input.page.members, input.page.createdBy] : [],
    input.threadAuthors,
  ];
  for (const stage of stages) {
    const emails = dedupe(stage);
    if (emails.length > 0) return emails;
  }
  return [];
}

/** メールを users.json の登録内容へ引き当てる。**未登録のメールも落とさず返す**——
 *  落とすと「宛先は居るのに誰も出てこない通知」になり、宛先不明と区別が付かなくなる。
 *  discordId が無ければ通知本文には名前だけが出る（メンションは鳴らない）。
 *
 *  例外: **ロスター（users.json）が空＝ログイン無しの一人運用**では [] を返す＝呼び出し側で
 *  @here に落ちる（2026-08-12 zinsei で実測——誰の discordId も引けないため、全通知が
 *  「メールさん」の鳴らない文字列になっていた。一人運用の「あなたの番」は常にその一人の番
 *  なので、解決を試みる意味が無く、@here で鳴らすのが従来どおりの正しい挙動） */
export function toRecipients(emails: string[], users: NotifyUser[]): NotifyUser[] {
  if (users.length === 0) return [];
  return emails.map(
    (email) => users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? { email },
  );
}

/** 直近スレッドの人間の発言者（新しい順に THREAD_LOOKBACK 件を見る）。
 *  actor.name は人間なら常にメール（auth.ts の規約）。agent/system は当事者ではないので除く */
export function humanAuthorsOf(messages: Message[]): string[] {
  return dedupe(
    messages
      .slice(-THREAD_LOOKBACK)
      .filter((m) => m.author.kind === "human")
      .map((m) => m.author.name),
  );
}

/**
 * グラフ・スレッドから宛先を解決する（resolveRecipientEmails の実データ版）。
 * runId を渡すとそのランの会話だけを段4の材料にする（会話はランごとに分かれている。
 * docs/design.md 3.16）。
 */
export function resolveRecipients(
  graph: GraphStore,
  threads: ThreadStore,
  users: NotifyUser[],
  /** createdBy は任意——ランのワークアイテムが指すのは NodeSnapshot で、そこには
   *  createdBy が無い（ラン作成時点の複製なので作成者は元ノード側の情報）。
   *  その場合は段2を飛ばしてページの関係者・スレッド発言者へ落ちる */
  node: { id: string; group: string | null; assignee: string | null; createdBy?: string | null },
  runId: string | null = null,
): NotifyUser[] {
  const page =
    node.group && graph.has(node.group)
      ? (() => {
          const g = graph.get(node.group as string);
          return { members: g.members, createdBy: g.createdBy };
        })()
      : null;
  // スレッドが読めなくても通知は出したい（宛先が1段狭まるだけ）
  let threadAuthors: string[] = [];
  try {
    threadAuthors = humanAuthorsOf(threads.listScoped(node.id, runId));
  } catch {
    threadAuthors = [];
  }
  return toRecipients(
    resolveRecipientEmails({
      assignee: node.assignee,
      createdBy: node.createdBy ?? null,
      page,
      threadAuthors,
    }),
    users,
  );
}
