// Discord Webhook 通知（2026-08-07 本人要望「あなたの番をディスコードでメンション通知」）。
// Bot ではなく Webhook を選んだ: チャンネル設定（連携サービス→ウェブフック）で発行した URL へ
// POST するだけで、トークン管理も常駐プロセスも要らない（gitpushlog と同じ方式）。
// メンションは本文の <@ユーザーID>（users.json の discordId）。担当者なしの「全員の番」は
// @here（2026-08-07 本人指定）。担当者ありで discordId 未登録なら鳴らさず名前を書くだけ
// （他人の番で @here を鳴らすのは誤爆のため）。
//
// 本文フォーマットは3行構成（2026-08-08 本人指示——本文引用が長すぎたため簡略化 + リンク化）:
//   1行目: 種別（「あなたの番です」「AIが返信」。メンションは行頭）
//   2行目: 「<ページ名> - <ノード名>」（ランがあれば末尾に（ラン: <ラン名>））
//   3行目: ノードへのリンク（notify.publicUrl 設定時のみ。UI 側の #/n/<id> ルーティングが開く）
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

/** 通知対象のノード情報（2026-08-08 簡略化フォーマットの2〜3行目の材料） */
export interface NotifyTarget {
  /** ノードが属するページ（group）のタイトル。無所属や解決不能なら null */
  pageTitle: string | null;
  nodeId: string;
  nodeTitle: string;
  /** ラン経由の通知だけが持つ（発生源②）。「（ラン: X）」として subject に付く */
  runTitle?: string | null;
  /** 同じくラン経由の通知だけが持つ。リンクに ?run= を載せて「そのランのそのノード」を開かせる
   *  （2026-08-08。ページを開いた既定がテンプレート表示になったため、これが無いとリンクを
   *  踏んでもランの進捗＝あなたの番の回答導線に着地しない） */
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

/** 3行目のノードリンク。publicUrl 未設定なら null（行ごと省略）。
 *  末尾スラッシュは除去してから `/#/n/<id>` を連結（UI 側のハッシュルーティングが開く）。
 *  ラン経由の通知は `?run=<ランid>` まで付けて、そのランの進捗ごと開かせる */
function nodeLink(
  publicUrl: string | null | undefined,
  nodeId: string,
  runId?: string | null,
): string | null {
  if (!publicUrl) return null;
  const base = `${publicUrl.replace(/\/+$/, "")}/#/n/${nodeId}`;
  return runId ? `${base}?run=${runId}` : base;
}

/** 1〜3行を組む共通処理。link が null なら3行目を出さない */
function composeContent(firstLine: string, target: NotifyTarget, publicUrl: string | null | undefined): string {
  const lines = [firstLine, subjectLine(target)];
  const link = nodeLink(publicUrl, target.nodeId, target.runId);
  if (link) lines.push(link);
  return lines.join("\n");
}

/**
 * 「あなたの番」メッセージを組み立てる（純粋関数。vitest 対象）。
 * - assignee あり + discordId 登録済み → その人だけをメンション
 * - assignee あり + 未登録            → メンションなしで担当名を書く
 * - assignee なし（全員の番）         → @here
 * 旧フォーマットの extra（質問文の引用）は廃止（2026-08-08 本人指示——長すぎるため）
 */
export function buildTurnMessage(
  assignee: string | null | undefined,
  users: NotifyUser[],
  target: NotifyTarget,
  publicUrl: string | null | undefined,
): DiscordMessage {
  if (assignee) {
    const u = users.find((x) => x.email.toLowerCase() === assignee.toLowerCase());
    if (u?.discordId) {
      return {
        content: composeContent(`<@${u.discordId}> あなたの番です`, target, publicUrl),
        allowed_mentions: { users: [u.discordId] },
      };
    }
    const name = u?.displayName ?? assignee;
    return {
      content: composeContent(`${name} さんの番です`, target, publicUrl),
      allowed_mentions: { parse: [] },
    };
  }
  return {
    content: composeContent("@here あなたの番です", target, publicUrl),
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
  cfg: { discordEnabled: boolean; discordWebhookUrl: string | null; publicUrl: string | null },
  users: NotifyUser[],
  notice: { assignee: string | null | undefined; target: NotifyTarget },
): void {
  if (!cfg.discordEnabled || !cfg.discordWebhookUrl) return;
  const message = buildTurnMessage(notice.assignee, users, notice.target, cfg.publicUrl);
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
 * 旧フォーマットの snippet（返信本文の先頭引用）は廃止（2026-08-08 本人指示——
 * 長すぎるため。本文はリンク先のノードで読む）
 */
export function buildAiReplyMessage(
  assignee: string | null | undefined,
  users: NotifyUser[],
  target: NotifyTarget,
  publicUrl: string | null | undefined,
): DiscordMessage {
  const u = assignee ? users.find((x) => x.email.toLowerCase() === assignee.toLowerCase()) : undefined;
  if (u?.discordId) {
    return {
      content: composeContent(`<@${u.discordId}> AIが返信`, target, publicUrl),
      allowed_mentions: { users: [u.discordId] },
    };
  }
  return {
    content: composeContent("AIが返信", target, publicUrl),
    allowed_mentions: { parse: [] },
  };
}

/** Task AI 返信通知の投げっぱなし版。discordEnabled（全体設定）が親スイッチ。
 *  受け取るかどうかの個人設定（user_settings.ts の discordAiReplies）は呼び出し側が見る */
export function notifyAiReply(
  cfg: { discordEnabled: boolean; discordWebhookUrl: string | null; publicUrl: string | null },
  users: NotifyUser[],
  notice: { assignee: string | null | undefined; target: NotifyTarget },
): void {
  if (!cfg.discordEnabled || !cfg.discordWebhookUrl) return;
  const message = buildAiReplyMessage(notice.assignee, users, notice.target, cfg.publicUrl);
  void sendDiscordWebhook(cfg.discordWebhookUrl, message).catch((err) => {
    console.error(`[discord] Task AI 返信通知に失敗: ${String(err)}`);
  });
}
