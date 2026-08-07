// Discord Webhook 通知（2026-08-07 本人要望「あなたの番をディスコードでメンション通知」）。
// Bot ではなく Webhook を選んだ: チャンネル設定（連携サービス→ウェブフック）で発行した URL へ
// POST するだけで、トークン管理も常駐プロセスも要らない（gitpushlog と同じ方式）。
// メンションは本文の <@ユーザーID>（users.json の discordId）。担当者なしの「全員の番」は
// @here（2026-08-07 本人指定）。担当者ありで discordId 未登録なら鳴らさず名前を書くだけ
// （他人の番で @here を鳴らすのは誤爆のため）。
//
// 「あなたの番」の発生源はサーバに2つだけ（デスクトップ通知と同じ定義。App.tsx 参照）:
//   ① POST /nodes/:id/request … 判断リクエストが開く（pendingRequest セット）
//   ② POST /runs/:id/items/:nodeId … ランのワークアイテムが waiting へ遷移
// どちらも UI・エンジン・MCP の全経路がこの API を通るので、ここで拾えば漏れない
// （クライアント側のデスクトップ通知はタブが開いている間しか鳴らない——それを補うのが本機能）。

/** users.json の1件のうち通知に要る部分（auth.ts の User から） */
export interface NotifyUser {
  email: string;
  displayName?: string;
  discordId?: string;
}

export interface DiscordMessage {
  content: string;
  /** これを明示しないと本文中の <@id> や @here が全部鳴ってしまう。
   *  意図したメンションだけを許可リストで通す */
  allowed_mentions: { parse?: string[]; users?: string[] };
}

/**
 * 「あなたの番」メッセージを組み立てる（純粋関数。vitest 対象）。
 * - assignee あり + discordId 登録済み → その人だけをメンション
 * - assignee あり + 未登録            → メンションなしで担当名を書く
 * - assignee なし（全員の番）         → @here
 */
export function buildTurnMessage(
  assignee: string | null | undefined,
  users: NotifyUser[],
  title: string,
  extra?: string | null,
): DiscordMessage {
  const tail = extra ? `\n${extra}` : "";
  if (assignee) {
    const u = users.find((x) => x.email.toLowerCase() === assignee.toLowerCase());
    if (u?.discordId) {
      return {
        content: `<@${u.discordId}> あなたの番: ${title}${tail}`,
        allowed_mentions: { users: [u.discordId] },
      };
    }
    const name = u?.displayName ?? assignee;
    return {
      content: `${name} さんの番: ${title}${tail}`,
      allowed_mentions: { parse: [] },
    };
  }
  return {
    content: `@here あなたの番: ${title}${tail}`,
    allowed_mentions: { parse: ["everyone"] }, // @here は everyone 系の parse 許可で鳴る
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

/** 通知の投げっぱなし版（リクエスト処理をブロックしない。失敗はログのみ——
 *  通知は補助機能で、本体の操作を失敗させる理由にはならない） */
export function notifyTurn(
  cfg: { discordEnabled: boolean; discordWebhookUrl: string | null },
  users: NotifyUser[],
  notice: { assignee: string | null | undefined; title: string; extra?: string | null },
): void {
  if (!cfg.discordEnabled || !cfg.discordWebhookUrl) return;
  const message = buildTurnMessage(notice.assignee, users, notice.title, notice.extra);
  void sendDiscordWebhook(cfg.discordWebhookUrl, message).catch((err) => {
    console.error(`[discord] 通知に失敗: ${String(err)}`);
  });
}

/**
 * 「Task AI が返信し終えた」通知（2026-08-07「Discord 通知が来ない」対応）。
 * 「あなたの番」（判断リクエスト・ラン待ち）だけだと、相談中心の使い方では通知の機会が
 * ほぼ無い——AI に相談を投げて離席したら、返信が来たことを知る手段が要る。
 * メンションは担当者の discordId があるときだけ（@here は使わない。返信のたびに全員を
 * 鳴らすのは過剰で、「あなたの番」との重みの差を保つ）。
 */
export function buildAiReplyMessage(
  assignee: string | null | undefined,
  users: NotifyUser[],
  title: string,
  snippet: string,
): DiscordMessage {
  const tail = snippet ? `\n> ${snippet}` : "";
  const u = assignee ? users.find((x) => x.email.toLowerCase() === assignee.toLowerCase()) : undefined;
  if (u?.discordId) {
    return {
      content: `<@${u.discordId}> Task AI が返信: ${title}${tail}`,
      allowed_mentions: { users: [u.discordId] },
    };
  }
  return {
    content: `Task AI が返信: ${title}${tail}`,
    allowed_mentions: { parse: [] },
  };
}

/** Task AI 返信通知の投げっぱなし版。discordEnabled（全体設定）が親スイッチ。
 *  受け取るかどうかの個人設定（user_settings.ts の discordAiReplies）は呼び出し側が見る */
export function notifyAiReply(
  cfg: { discordEnabled: boolean; discordWebhookUrl: string | null },
  users: NotifyUser[],
  notice: { assignee: string | null | undefined; title: string; snippet: string },
): void {
  if (!cfg.discordEnabled || !cfg.discordWebhookUrl) return;
  const message = buildAiReplyMessage(notice.assignee, users, notice.title, notice.snippet);
  void sendDiscordWebhook(cfg.discordWebhookUrl, message).catch((err) => {
    console.error(`[discord] Task AI 返信通知に失敗: ${String(err)}`);
  });
}
