// 業務連絡の Discord 投稿（2026-08-11 本人要望「AIが人間とコミュニケーションする必要のある
// タスクは積極的に Discord を使ってほしい」）。
//
// **グラフ通知（discord.ts）とは別系統**。軸は「機械的か人間的か」ではなく:
//   - discord.ts     … グラフのボールが人間に渡った＝「あなたの番」。宛先はグラフ通知
//                      チャンネル固定で、答える場所は GW のノード
//   - discord_bot.ts … ノードの実行内容そのものが「誰かに連絡する」であるとき（手順書に
//                      「#運営一般 に報告」と書かれたタスク等）。これは通知ではなく
//                      **タスクの成果物**なので、宛先は手順書が決める
//
// Webhook ではなく Bot トークンにした理由（2026-08-11 本人指定「B」）: チャンネルごとに
// Webhook を発行して設定に並べるのをやめ、手順書に `#運営一般` と**名前で**書けるように
// するため。送信だけなので常駐は不要（REST を叩くだけ）。
//
// **他のアプリと共用の Bot** なので、本文の先頭に必ず [Graph Wrangler] を付ける
// （2026-08-11 本人要望「他にも同じ Bot 使っているので」）。グラフ通知チャンネル側は
// Webhook の username に "GraphWrangler" が出るため不要。
import type { DiscordMessage, NotifyTarget, NotifyUser } from "./discord.js";
import { mentionOf, nodeLink } from "./discord.js";

const API = "https://discord.com/api/v10";

/** 出し元を示す接頭辞。共用 Bot なので、どのアプリが投げたのか本文で分かるようにする */
export const SOURCE_PREFIX = "[Graph Wrangler]";

/** チャンネル一覧のキャッシュ（名前→id）。チャンネルは頻繁には増減しないので、
 *  投稿のたびに guild 全体を引き直さない。解決に失敗したときだけ引き直す */
let channelCache: { guildId: string; names: Map<string, string> } | null = null;

/** 手順書に書かれたチャンネル指定（`#運営一般` / `運営一般`）を突き合わせ用に正規化する */
function normalizeChannelName(name: string): string {
  return name.trim().replace(/^#/, "").toLowerCase();
}

async function fetchChannels(token: string, guildId: string): Promise<Map<string, string>> {
  const res = await fetch(`${API}/guilds/${encodeURIComponent(guildId)}/channels`, {
    headers: { authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Discord チャンネル一覧の取得に失敗 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const list = (await res.json()) as { id: string; name?: string }[];
  const names = new Map<string, string>();
  for (const ch of list) {
    if (ch.name) names.set(normalizeChannelName(ch.name), ch.id);
  }
  return names;
}

/**
 * チャンネル名（`#運営一般`）をチャンネルIDへ解決する。**IDを直接渡されたらそのまま通す**
 * ——手順書に数字のIDが書かれていても動くように（名前が変わったときの逃げ道でもある）。
 * キャッシュに無ければ一覧を引き直す＝新しく作られたチャンネルにも追随する。
 */
export async function resolveChannelId(
  token: string,
  guildId: string,
  channel: string,
): Promise<string> {
  const raw = channel.trim();
  if (/^\d{5,}$/.test(raw)) return raw; // 数字だけならチャンネルIDとみなす
  const name = normalizeChannelName(raw);
  if (channelCache?.guildId === guildId) {
    const hit = channelCache.names.get(name);
    if (hit) return hit;
  }
  const names = await fetchChannels(token, guildId);
  channelCache = { guildId, names };
  const id = names.get(name);
  if (!id) {
    throw new Error(
      `Discord に「${raw}」というチャンネルが見つかりません（Bot がそのサーバーに参加していて、チャンネルを見られる必要があります）`,
    );
  }
  return id;
}

/** Bot として1通 POST する。失敗は throw（呼び出し側＝AIに結果を返すため。
 *  グラフ通知の投げっぱなしと違い、こちらは**タスクの実行結果**なので成否が要る） */
export async function sendBotMessage(
  token: string,
  channelId: string,
  message: DiscordMessage,
): Promise<{ id: string }> {
  const res = await fetch(`${API}/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Discord 投稿に失敗 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as { id: string };
}

/**
 * 業務連絡の本文を組み立てる（純粋関数。vitest 対象）。
 *
 *   [Graph Wrangler] <@宛先...>
 *   <AIが書いた本文>
 *   <ページ名> - <ノード名>
 *   <ノードURL>
 *
 * ノードURLは**必須**（2026-08-11「何の話か分からないからノードURLは絶対にのせるように
 * したい」）。publicUrl が無ければ null を返す＝送らない。
 * 宛先が1人も解決できなかったときは、グラフ通知と違って **@here にしない**——ここは
 * グラフの外へ向けた連絡で、全員を鳴らす理由が無い（メンション行ごと省く）。
 */
export function buildReportMessage(
  body: string,
  recipients: NotifyUser[],
  target: NotifyTarget,
  publicUrl: string | null | undefined,
): DiscordMessage | null {
  const link = nodeLink(publicUrl, target.nodeId, target.runId);
  if (!link) return null;
  const subject = target.pageTitle ? `${target.pageTitle} - ${target.nodeTitle}` : target.nodeTitle;
  if (recipients.length === 0) {
    return {
      content: [SOURCE_PREFIX, body.trim(), subject, link].join("\n"),
      allowed_mentions: { parse: [] },
    };
  }
  const { text, allowed } = mentionOf(recipients);
  return {
    content: [`${SOURCE_PREFIX} ${text}`, body.trim(), subject, link].join("\n"),
    allowed_mentions: allowed,
  };
}

/** テスト・再解決のためにキャッシュを捨てる（設定でサーバーIDを変えたとき等） */
export function clearChannelCache(): void {
  channelCache = null;
}
