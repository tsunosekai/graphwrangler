// ---- ハッシュベース URL ルーティングの同期（2026-08-08 本人指示。Discord 通知等のリンクから
//      特定ページ / ノード / ラン / チャットを直接開けるようにする。lib/route.ts が正本） ----
// lib/route.ts が純関数（parse / build）、ここが location と history の読み書き。
import { useCallback, useEffect, useRef } from "react";
import { buildRoute, parseRoute, type RouteState } from "../lib/route";
import type { Node } from "../types";

export interface UrlRoutingOptions {
  /** 初期 hash のルート（null = hash にルーティング情報が無い） */
  initialRoute: RouteState | null;
  nodes: Node[];
  pageId: string | null;
  selectedId: string | null;
  projectedRunId: string | null;
  chatOpen: boolean;
  /** ノード指定の適用口（ページ切替 + 選択をまとめて行う） */
  selectNode: (id: string | null) => void;
  setPageId: (id: string | null) => void;
  setProjectedRunId: (id: string | null) => void;
  setChatOpen: (open: boolean) => void;
}

export function useUrlRouting({
  initialRoute,
  nodes,
  pageId,
  selectedId,
  projectedRunId,
  chatOpen,
  selectNode,
  setPageId,
  setProjectedRunId,
  setChatOpen,
}: UrlRoutingOptions): void {
  // 初期 hash はノード一覧のロード後でないとページ解決できないため、いったん「保留ルート」に
  // 置き、nodes が非空になった最初のタイミングで適用する
  const pendingRouteRef = useRef<RouteState | null>(initialRoute);
  // 保留ルートを適用し終わるまで URL への書き戻しを止める（初期 hash を localStorage 由来の
  // 状態で潰さないため）。初期 hash にルーティング情報が無ければ最初から書いてよい
  const routeReadyRef = useRef(initialRoute === null);

  // --- URL ルートの適用（2026-08-08）。保留ルート（初期 hash）と hashchange の両方で使う ---
  const applyRoute = useCallback(
    (r: RouteState) => {
      if (r.nodeId && nodes.some((n) => n.id === r.nodeId)) {
        // ノード指定はページ切替 + 選択（パネルが開く）を selectNode に一任する
        selectNode(r.nodeId);
      } else if (r.pageId) {
        // ノードが見つからない・ノード指定なしのときはページだけ適用
        setPageId(r.pageId);
      }
      // ラン指定は URL を正とする（ラン指定が無ければテンプレートのページ）。リンクを踏んだのに
      // 前に見ていたランが残っていると、URL の見た目と画面が食い違う（2026-08-08）
      setProjectedRunId(r.runId);
      if (r.chat) setChatOpen(true);
    },
    [nodes, selectNode, setPageId, setProjectedRunId, setChatOpen],
  );

  // 保留ルートの適用: nodes が非空になった最初のタイミングで一度だけ。適用後は URL への
  // 書き戻し（下の effect）を解禁する
  useEffect(() => {
    const r = pendingRouteRef.current;
    if (!r || nodes.length === 0) return;
    pendingRouteRef.current = null;
    routeReadyRef.current = true;
    applyRoute(r);
  }, [nodes, applyRoute]);

  // hashchange（リンクの再クリック・手打ち編集）でも同じ適用処理を通す。この時点では
  // 通常 nodes は読み込み済みだが、万一空なら保留ルートに積んで上の effect に任せる
  useEffect(() => {
    const onHashChange = () => {
      const r = parseRoute(window.location.hash);
      if (!r) return;
      if (nodes.length === 0) {
        pendingRouteRef.current = r;
        return;
      }
      applyRoute(r);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [nodes, applyRoute]);

  // 状態 → URL: 選択状態が変わるたび hash に反映する。hashchange を発火させないため
  // replaceState を使う（pushState だと履歴も汚れる）。既存のモバイル「戻る」統合が
  // history.state（gwView 等）を使っているので、state は現在値を維持して渡す
  useEffect(() => {
    if (!routeReadyRef.current) return; // 保留ルート適用前は書かない（初期 hash を潰さない）
    const url = buildRoute({
      pageId,
      nodeId: selectedId,
      // テンプレート表示（null）は URL に載せない
      runId: projectedRunId,
      chat: chatOpen,
    });
    if (window.location.hash !== url) {
      window.history.replaceState(window.history.state, "", url);
    }
  }, [pageId, selectedId, projectedRunId, chatOpen]);
}
