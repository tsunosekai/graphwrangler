// ハッシュベースの URL ルーティング（2026-08-08 本人指示）。Discord 通知などの外部リンクから
// 特定のページ / ノード / ラン / チャットを直接開けるようにするための純関数群。DOM には触らない
// （location / history の読み書きは App.tsx 側の同期処理が行う）。
//
// スキーム:
//   #/p/<pageId>            … ページ（プロジェクト / ルーティーン = テンプレート）を開く
//   #/n/<nodeId>            … ノードを開く（属するページへ切替 + 選択でパネルが開く）
//   #/p/<pageId>/n/<nodeId> … 上の複合。build はこの複合形で出力し、parse は単独形も受ける
//   #/r/<runId>             … **ランのページ**を開く（2026-08-08 本人指定「ランは個別ページ」）。
//                             ランはテンプレートとは別物として表示する（グラフ・ノードの中身・
//                             会話・実行履歴すべてそのランのもの）
//   #/r/<runId>/n/<nodeId>  … ランのページの中のノード
//   #/chat または ?chat=1   … AI チャットドロワーを開く（ページ指定と併用可）

export interface RouteState {
  pageId: string | null;
  nodeId: string | null;
  runId: string | null;
  chat: boolean;
}

/** decodeURIComponent の安全版。壊れた %xx はそのまま返す（リンクの手打ち・改変に寛容にする） */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** "#/p/x/n/y?chat=1" を寛容にパースする。先頭 # の有無・前後スラッシュの揺れを許し、
 *  未知セグメントは無視する。ルーティング情報が何も無ければ null（= hash は関与しない）。 */
export function parseRoute(hash: string): RouteState | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const qIndex = raw.indexOf("?");
  const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const query = qIndex >= 0 ? raw.slice(qIndex + 1) : "";

  const state: RouteState = { pageId: null, nodeId: null, runId: null, chat: false };
  let found = false;

  const segments = path.split("/").filter((s) => s !== "");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "chat") {
      // #/chat 形式（ドロワーだけ開く）。#/p/<id>?chat=1 との併用は query 側で受ける
      state.chat = true;
      found = true;
      continue;
    }
    if ((seg === "p" || seg === "n" || seg === "r") && i + 1 < segments.length) {
      const value = safeDecode(segments[i + 1]);
      i++; // 値セグメントを消費
      if (seg === "p") state.pageId = value;
      else if (seg === "r") state.runId = value;
      else state.nodeId = value;
      found = true;
      continue;
    }
    // 未知セグメント（将来の拡張・タイプミス）は無視して先へ進む
  }

  // query は URLSearchParams がデコードまで面倒を見る
  const params = new URLSearchParams(query);
  if (params.get("chat") === "1") {
    state.chat = true;
    found = true;
  }

  return found ? state : null;
}

/** RouteState から hash を組み立てる。ランを開いているときは **ランのページ**
 *  （#/r/<runId>[/n/<nodeId>]）を出す——ランはテンプレートとは別のページなので、
 *  ページidは載せない（ランからページは辿れる）。ランでなければ #/p/x/n/y。
 *  全て空なら "#/"。各セグメントは encodeURIComponent（id にスラッシュ等が混ざっても壊れない） */
export function buildRoute(s: RouteState): string {
  const parts: string[] = [];
  if (s.runId) parts.push("r", encodeURIComponent(s.runId));
  else if (s.pageId) parts.push("p", encodeURIComponent(s.pageId));
  if (s.nodeId) parts.push("n", encodeURIComponent(s.nodeId));
  const query: string[] = [];
  if (s.chat) query.push("chat=1");
  return `#/${parts.join("/")}${query.length > 0 ? `?${query.join("&")}` : ""}`;
}
