// Discord Webhook 通知（2026-08-07 本人要望「あなたの番をディスコードでメンション通知」）。
// Bot ではなく Webhook を選んだ: チャンネル設定（連携サービス→ウェブフック）で発行した URL へ
// POST するだけで、トークン管理も常駐プロセスも要らない（gitpushlog と同じ方式）。
//
// 本文フォーマットは3行構成（2026-08-08 本人指示——本文引用が長すぎたため簡略化 + リンク化）:
//   1行目: メンション + 「あなたの番です」
//   2行目: 「<ページ名> - <ノード名>」（ランがあれば末尾に（ラン: <ラン名>））
//   3行目: ノードへのリンク（**必須**。2026-08-11 本人要望「何の話か分からないから
//          ノードURLは絶対にのせるようにしたい」——publicUrl 未設定なら通知そのものを出さない。
//          鳴るのに辿れない通知はチャンネルの信用を落とすだけなので、黙るほうを選ぶ）
//
// **このチャンネルに出るのは「グラフのボールが人間に渡った瞬間」だけ**（2026-08-11 本人指示
// 「あなたの番がグラフ通知になるようにしたい。ノードの進捗で機械的に決まるのがこの
// チャンネルの通知だから」）。発生源はサーバに2つ:
//   ① POST /nodes/:id/request … 判断リクエストが開く（pendingRequest セット）。
//      AI実行中の質問（engine の QUESTION プロトコル）・承認ゲート・失敗リカバリ・分岐も
//      すべてここを通る
//   ② POST /runs/:id/items/:nodeId … ランのワークアイテムが waiting へ遷移
// 手順書に書かれた業務連絡（「営業担当者に報告」等）は**グラフの進行ではなくノードの実行成果**
// なので、この口ではなく指定チャンネルへ出す（別系統）。
//
// 旧「Task AI がスレッドへ返信した」通知は廃止（2026-08-11 本人指示「グラフ通知出し過ぎだな。
// ページ見てる間は出さなくていい」「GW上でチャットしてて返信が来た奴にいちいちとりあえず
// Discord 通知飛ばさないでほしい」）——返信は GW を開けば読めるので、鳴らす理由が無い。
// AI が会話中に本当に人間の判断を要したときは QUESTION プロトコルで①へ乗る。

/** users.json の1件のうち通知に要る部分（auth.ts の User から）。
 *  宛先の解決は recipients.ts（assignee → createdBy → ページの関係者 → スレッド発言者） */
export interface NotifyUser {
  email: string;
  displayName?: string;
  discordId?: string;
}

/** 通知対象のノード情報（2026-08-08 簡略化フォーマットの2〜3行目の材料） */
export interface NotifyTarget {
  /** ノードが属するページ（group）のタイトル。無所属や解決不能なら null */
  pageTitle: string | null;
  nodeId: string;
  nodeTitle: string;
  /** ラン経由の通知だけが持つ（発生源②）。「（ラン: X）」として subject に付く */
  runTitle?: string | null;
  /** 同じくラン経由の通知だけが持つ。リンクを #/r/<ランid>/n/<ノードid> にして
   *  「そのランのそのノード」を開かせる（2026-08-08。ページを開いた既定がテンプレート表示に
   *  なったため、これが無いとリンクを踏んでもランの進捗＝あなたの番の回答導線に着地しない） */
  runId?: string | null;
}

export interface DiscordMessage {
  content: string;
  /** これを明示しないと本文中の <@id> や @here が全部鳴ってしまう。
   *  意図したメンションだけを許可リストで通す */
  allowed_mentions: { parse?: string[]; users?: string[] };
}

/** 2行目「ページ名 - ノード名（ラン: X）」を組み立てる。pageTitle 無しならノード名だけ */
function subjectLine(t: NotifyTarget): string {
  const base = t.pageTitle ? `${t.pageTitle} - ${t.nodeTitle}` : t.nodeTitle;
  return t.runTitle ? `${base}（ラン: ${t.runTitle}）` : base;
}

/** 3行目のノードリンク。publicUrl 未設定なら null（＝通知を出さない。呼び出し側が判定する）。
 *  末尾スラッシュは除去してから UI のハッシュルート（lib/route.ts）を連結する。
 *  ラン経由の通知は `/#/r/<ランid>/n/<ノードid>`＝ランのページ、それ以外は `/#/n/<ノードid>` */
export function nodeLink(
  publicUrl: string | null | undefined,
  nodeId: string,
  runId?: string | null,
): string | null {
  if (!publicUrl) return null;
  const origin = publicUrl.replace(/\/+$/, "");
  return runId ? `${origin}/#/r/${runId}/n/${nodeId}` : `${origin}/#/n/${nodeId}`;
}

/**
 * 宛先からメンション部分を組み立てる（純粋関数）。
 * - discordId 登録済み → `<@id>` で実際に鳴らす
 * - 未登録            → 「名前さん」と**文字で書くだけ**（鳴らないが、誰宛かは分かる）
 * - 宛先が1人も解決できなかった → `@here`（本当の意味の「全員の番」だけが全体を鳴らす）
 */
export function mentionOf(recipients: NotifyUser[]): { text: string; allowed: DiscordMessage["allowed_mentions"] } {
  if (recipients.length === 0) return { text: "@here", allowed: { parse: ["everyone"] } };
  const ids: string[] = [];
  const parts = recipients.map((u) => {
    if (u.discordId) {
      ids.push(u.discordId);
      return `<@${u.discordId}>`;
    }
    return `${u.displayName ?? u.email}さん`;
  });
  return { text: parts.join(" "), allowed: ids.length > 0 ? { users: ids } : { parse: [] } };
}

/** 1〜3行を組む共通処理。link は必須（URL の無い通知は出さない方針） */
function composeContent(firstLine: string, target: NotifyTarget, link: string): string {
  return [firstLine, subjectLine(target), link].join("\n");
}

/**
 * 「あなたの番」メッセージを組み立てる（純粋関数。vitest 対象）。
 * 宛先は recipients.ts が解決済みのものを受け取る——ここは「並べて鳴らす」だけを担う。
 * publicUrl が無ければ **null を返す**（＝送らない。2026-08-11 URL 必須化）
 */
export function buildTurnMessage(
  recipients: NotifyUser[],
  target: NotifyTarget,
  publicUrl: string | null | undefined,
): DiscordMessage | null {
  const link = nodeLink(publicUrl, target.nodeId, target.runId);
  if (!link) return null;
  const { text, allowed } = mentionOf(recipients);
  return {
    content: composeContent(`${text} あなたの番です`, target, link),
    allowed_mentions: allowed,
  };
}

/** Webhook へ1通 POST する。失敗は throw（テスト送信エンドポイントが結果を返すため）。
 *  Discord 側の応答本文は使わないので wait= は付けない */
export async function sendDiscordWebhook(webhookUrl: string, message: DiscordMessage): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "GraphWrangler", ...message }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** 直近に送った本文 → 送った時刻。**まったく同じ通知**が短時間に繰り返されたときだけ間引く
 *  （2026-08-11）。「同じノードは N 分に1回」という素朴なクールダウンにしなかったのは、
 *  AIが質問 → 人間が答える → AIがまた質問、という正当な連続を黙らせてしまうため。
 *  本文が1文字でも違えば別の用件なので通す */
const recentlySent = new Map<string, number>();
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

/** 同じ本文を直近に送っていれば true（送るなら送信時刻を記録する）。
 *  ついでに古い記録を捨てる——通知は多くても数十件/日で、専用の掃除は要らない */
function isDuplicate(content: string, now: number): boolean {
  for (const [key, ts] of recentlySent) {
    if (now - ts > DUPLICATE_WINDOW_MS) recentlySent.delete(key);
  }
  const last = recentlySent.get(content);
  if (last !== undefined && now - last <= DUPLICATE_WINDOW_MS) return true;
  recentlySent.set(content, now);
  return false;
}

/** テスト用に間引きの記録を捨てる */
export function clearDuplicateGuard(): void {
  recentlySent.clear();
}

/** 通知の投げっぱなし版（リクエスト処理をブロックしない。失敗はログのみ——
 *  通知は補助機能で、本体の操作を失敗させる理由にはならない）。
 *  publicUrl 未設定は**黙って落とさず警告を出す**——設定漏れに気付けないと、
 *  「通知が来ない」の調査が settings まで辿り着かない */
export function notifyTurn(
  cfg: { discordEnabled: boolean; discordWebhookUrl: string | null; publicUrl: string | null },
  recipients: NotifyUser[],
  target: NotifyTarget,
): void {
  if (!cfg.discordEnabled || !cfg.discordWebhookUrl) return;
  const message = buildTurnMessage(recipients, target, cfg.publicUrl);
  if (!message) {
    console.warn(
      "[discord] 通知を見送りました: 設定の notify.publicUrl が未設定です（ノードURLの無い通知は出さない方針）",
    );
    return;
  }
  if (isDuplicate(message.content, Date.now())) {
    console.warn(`[discord] 同じ通知を直近に送っているため間引きました: ${message.content.split("\n")[1]}`);
    return;
  }
  void sendDiscordWebhook(cfg.discordWebhookUrl, message).catch((err) => {
    console.error(`[discord] 通知に失敗: ${String(err)}`);
  });
}
