import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BulkPanel } from "./components/BulkPanel";
import { ChatDrawer } from "./components/ChatDrawer";
import { DialogHost } from "./components/DialogHost";
import { CommandPalette } from "./components/CommandPalette";
import { GraphView } from "./components/GraphView";
import { NodePanel } from "./components/NodePanel";
import { PageList } from "./components/PageList";
import { SetupModal } from "./components/SetupModal";
import { ToastHost } from "./components/ToastHost";
import { TopBar, type RunWaitItem } from "./components/TopBar";
import { MobileNav, type MobileView } from "./components/MobileNav";
import { LoginScreen } from "./components/LoginScreen";
import { api, postReads, type Me, type SettingsView, type TeamUser } from "./lib/api";
import { refreshBranding, useBranding } from "./lib/branding";
import { TeamContext, isMyTurn, turnIsMine, useTeam, type Team } from "./lib/team";
import { cn } from "./lib/utils";
import { usePolling } from "./hooks/usePolling";
import { useIsMobile } from "./hooks/useIsMobile";
import { isRoutinePage } from "./lib/routine";
import { buildRoute, parseRoute, type RouteState } from "./lib/route";
import { pushToast } from "./lib/toast";
import type { Node, Run } from "./types";

/** localStorage の安全な読み書き（UI状態の永続化。2026-07-31 本人要望
 *  「リロードしても開閉や幅を保持」。幅とテーマ・レール開閉は各コンポーネントで保存済み） */
function loadUiState(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function saveUiState(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 無視（永続化は補助機能）
  }
}

/** sessionStorage 版。リロードは跨ぐが、タブ/アプリを開き直すと消える */
function loadTabState(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function saveTabState(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // 無視（永続化は補助機能）
  }
}

/** 内蔵ログインのゲート（2026-08-03）。サーバの users.json にユーザーが居る運用
 *  （authRequired=true）で未ログインなら、アプリ本体をマウントせずログイン画面だけ出す
 *  ——本体を出すとポーリングが 401 のトーストを連打するため、ゲートは外側で行う */
export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.getMe());
    } catch {
      // 判定に失敗したら従来どおり本体を出す（ログイン不要運用・旧サーバとの互換）
      setMe({ email: null, displayName: null, admin: false, authRequired: false });
    }
  }, []);
  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  // インスタンスのサイト名・ファビコン（2026-08-08）。取得は認証不要なのでログイン画面より前でよい
  useEffect(() => {
    void refreshBranding();
  }, []);

  if (me === null) return null; // 判定中（一瞬）
  if (me.authRequired && !me.email) return <LoginScreen onLoggedIn={() => void refreshMe()} />;
  return (
    <TeamProvider me={me}>
      <AppInner />
    </TeamProvider>
  );
}

/** ログイン情報とユーザーロスターを全域へ配る（チーム化 2026-08-04。lib/team.ts の
 *  TeamContext）。ロスターはログインゲート通過後に1回だけ取得し、失敗したら空配列
 *  = 人系UIを出さない degrade（getUsers 自体が失敗を空配列に畳む。ポーリングはしない） */
function TeamProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [users, setUsers] = useState<TeamUser[]>([]);
  // ユーザー管理ダイアログでの追加・変更を即反映するための再取得口（2026-08-04）。
  // 平常時は起動時の1回だけで、ポーリングはしない方針のまま
  const refreshUsers = useCallback(() => {
    void api.getUsers().then((r) => setUsers(r.users));
  }, []);
  useEffect(() => {
    refreshUsers();
  }, [refreshUsers]);
  const team = useMemo<Team>(
    () => ({ me, users, enabled: users.length >= 2, refreshUsers }),
    [me, users, refreshUsers],
  );
  return <TeamContext.Provider value={team}>{children}</TeamContext.Provider>;
}

function AppInner() {
  // 「あなたの番」の per-user 判定（チーム化 2026-08-04）に使う自分のメール
  const { me } = useTeam();
  // デスクトップ通知の見出しはインスタンスのサイト名（2026-08-08 ブランディング）
  const { siteTitle } = useBranding();
  const { data, refresh } = usePolling(() => api.getState(), 3000);
  // 初期 hash のルート（2026-08-08）。**ルート付きで開かれたときは localStorage の選択/ページ
  // 復元をスキップする**（hash が勝つ）——復元された旧選択とルートの選択が React Flow の
  // 初期化と同時に走ると、内部選択が合流して「2件選択」で固着する競合があった（実測）
  const [initialRoute] = useState<RouteState | null>(() => parseRoute(window.location.hash));
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    initialRoute ? null : loadUiState("gw.selectedId"),
  );
  const [pageIdRaw, setPageId] = useState<string | null>(() =>
    initialRoute ? null : loadUiState("gw.pageId"),
  );
  const [chatOpen, setChatOpen] = useState(() => loadUiState("gw.chatOpen") === "1");
  // モバイル（<768px）はヘッダー+下部タブバーを除き、一覧/グラフ/ノード/チャットの
  // どれか1つが画面を専有する（2026-08-02 本人指定）。
  // 表示中のビューは **sessionStorage** に置く（2026-08-02 本人要望「レスポンシブ画面でも
  // リロード耐性を保ってほしい」）。リロードでは見ていたビューに戻り、タブ/アプリを開き
  // 直したときは既定どおりグラフから始まる——localStorage だと後者の「開くたびグラフから」
  // （同日の本人指定）を壊すため、あえて session 側に置いている
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<MobileView>(() => {
    const saved = loadTabState("gw.mobileView") as MobileView | null;
    if (!saved || !["pages", "graph", "node", "chat"].includes(saved)) return "graph";
    // ノード詳細は選択が復元できるときだけ（空画面で復帰しないように。実効ビューを倒す
    // 下の mv とは別に、状態そのものを graph にしておく）
    if (saved === "node" && !loadUiState("gw.selectedId")) return "graph";
    return saved;
  });
  useEffect(() => saveTabState("gw.mobileView", mobileView), [mobileView]);

  useEffect(() => saveUiState("gw.selectedId", selectedId), [selectedId]);
  useEffect(() => saveUiState("gw.pageId", pageIdRaw), [pageIdRaw]);
  useEffect(() => saveUiState("gw.chatOpen", chatOpen ? "1" : "0"), [chatOpen]);

  // ---- ハッシュベース URL ルーティング（2026-08-08 本人指示。Discord 通知等のリンクから
  //      特定ページ / ノード / ラン / チャットを直接開けるようにする。lib/route.ts が正本） ----
  // 初期 hash はノード一覧のロード後でないとページ解決できないため、いったん「保留ルート」に
  // 置き、nodes が非空になった最初のタイミングで適用する（適用 effect は selectNode 定義の後方）
  const pendingRouteRef = useRef<RouteState | null>(initialRoute);
  // 保留ルートを適用し終わるまで URL への書き戻しを止める（初期 hash を localStorage 由来の
  // 状態で潰さないため）。初期 hash にルーティング情報が無ければ最初から書いてよい
  const routeReadyRef = useRef(initialRoute === null);
  // ノードエディタ標準の複数選択: 選択中の id 一覧。2件以上で一括編集パネル（BulkPanel）を出す
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  // 未読バッジ用のノードごとの最終メッセージ時刻 / 既読時刻（どちらもサーバ持ち。
  // 2026-08-02 既読を localStorage からサーバへ移した＝PC で読めばスマホでも既読）
  const threadMeta = useMemo(() => data?.threadMeta ?? {}, [data]);
  const serverReads = useMemo(() => data?.reads ?? {}, [data]);

  // 既読のローカル上書き（2026-08-05 本人指示「見たら即」。旧: 1秒待ち）。
  // NodePanel がスレッドを表示すると onViewed が呼ばれ、サーバの reads が次の
  // ポーリング（最大3秒）で追いつくのを待たずにバッジを消す。マージは新しいほう勝ち
  const [readOverrides, setReadOverrides] = useState<Record<string, string>>({});
  const reads = useMemo(() => {
    const merged = { ...serverReads };
    for (const [id, ts] of Object.entries(readOverrides)) {
      if (!merged[id] || merged[id] < ts) merged[id] = ts;
    }
    return merged;
  }, [serverReads, readOverrides]);
  // lastTs（スレッド最終メッセージ＝サーバ発行の時刻）があればそれを使う。端末の時計が
  // サーバより遅れていると、クライアント時刻の上書きでは未読が消えないため（2026-08-05）
  // key は会話の単位（"<ノードid>" or "<ノードid>@<ランid>"。lib/unread.ts の threadKey）
  const markViewed = useCallback((key: string, lastTs: string | null) => {
    setReadOverrides((prev) => ({ ...prev, [key]: lastTs ?? new Date().toISOString() }));
  }, []);

  // 旧 localStorage 既読（gw.read.<id>）を一度だけサーバへ引き継ぐ。これをやらないと
  // 移行した瞬間に「今まで読んだ全ノードが未読」になって使い物にならない
  useEffect(() => {
    if (loadUiState("gw.readsMigrated") === "1") return;
    const marks: Record<string, string> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith("gw.read.")) continue;
        const value = localStorage.getItem(key);
        if (value) marks[key.slice("gw.read.".length)] = value;
      }
    } catch {
      return; // 読めない環境では移行を諦める（サーバ側が空のまま始まるだけ）
    }
    if (Object.keys(marks).length > 0) postReads(marks);
    saveUiState("gw.readsMigrated", "1");
  }, []);

  // ページ = フォルダ（kind=goal、またはメンバーを持つノード）。zinsei desk の左レール方式。
  // kind=folder（左レールの整理棚。2026-08-05）はページではないので除く——棚はページを
  // group ではなく folder フィールドで束ねるので、メンバー判定にも引っかからない
  const folders = useMemo(() => {
    const hasMembers = new Set(nodes.map((n) => n.group).filter(Boolean) as string[]);
    return nodes.filter((n) => n.kind !== "folder" && (n.kind === "goal" || hasMembers.has(n.id)));
  }, [nodes]);
  // 整理棚そのもの（左レールだけが使う）
  const folderNodes = useMemo(() => nodes.filter((n) => n.kind === "folder"), [nodes]);

  // 表示中ページが削除された場合も先頭ページへフォールバックする（削除直後に空画面へ
  // 取り残されないように。localStorage の古い pageId も同じ経路で吸収される）
  const pageId = folders.some((f) => f.id === pageIdRaw) ? pageIdRaw : (folders[0]?.id ?? null);
  const pageNode = folders.find((f) => f.id === pageId) ?? null;
  const pageNodes = useMemo(() => nodes.filter((n) => n.group === pageId), [nodes, pageId]);

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

  // グラフ（表示中ページ）と選択ノードの食い違いガード: 選択中ノードが表示中ページの
  // メンバーでもページ自身でもなくなったら選択を落とす。ページ切替に選択が置き去りに
  // なると「グラフはこっちなのにノード詳細タブは別プロジェクトのノード」という
  // ねじれになる（2026-08-02 本人報告。localStorage 復元の組み合わせでも起きる）
  useEffect(() => {
    if (!selectedNode) return;
    if (selectedNode.id === pageId || selectedNode.group === pageId) return;
    setSelectedId(null);
  }, [selectedNode, pageId]);

  // ---- 全ページのラン一覧（PageList の左レール: ドット・ラン子行 + TopBar のラン待ち統合が使う）。
  //      **1リクエスト**でページ id → ラン配列を受け取る（2026-08-08 最適化。旧: ページごとに
  //      GET /pages/:id/runs ＝ ページ数ぶんの往復と、その回数ぶんの全ラン走査）。
  //      ルーティーンだけでなく全ページぶん来る——トリガーを外してプロジェクトへ戻った
  //      ページにも過去ランは残り、レールのラン子行に出すため ----
  const { data: railRunsData, refresh: refreshRailRuns } = usePolling(async (): Promise<Record<string, Run[]>> => {
    try {
      return (await api.listAllRuns()).runs;
    } catch {
      return {};
    }
  }, 5000);
  const railRuns = useMemo(() => railRunsData ?? {}, [railRunsData]);
  const latestRuns = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(railRuns).map(([id, list]) => [id, list[0] ?? null]),
      ) as Record<string, Run | null>,
    [railRuns],
  );

  // ---- 実行中ラン一覧（docs/design.md 3.8: トリガー起点のルーティーン。グラフ投影用）。
  //      「最新ラン」（上の latestRuns。状態不問。PageList のドット用）とは別物。
  //      同じルーティーンは並列で回せる（並行ラン: 同じテンプレートグラフ・別のラン状態）
  //      ため、現在ページの status==="running" を全部持ち、どの並行ランをグラフに投影するかを
  //      projectedRunId で選ぶ（切替UIは GraphView のツールバー。既定は最新の1本） ----
  const isCurrentPageRoutine = pageNode ? isRoutinePage(pageNode, nodes) : false;
  // 実行中だけでなく**全ラン**を持つ（2026-08-07 本人要望「過去のランが選択（表示）できない」。
  // 旧: running だけ絞っていたため、終わったランをグラフに投影して見返す手段が無かった）
  const { data: pageRunsData, refresh: refreshActiveRun } = usePolling(async (): Promise<Run[]> => {
    if (!pageId || !isCurrentPageRoutine) return [];
    try {
      const { runs } = await api.listRuns(pageId);
      // listRuns は新しい順（LedgerView と同じ前提）
      return runs;
    } catch {
      return [];
    }
    // ページが変わったら次の周期を待たず即取り直す（下のリセット effect の refresh と同趣旨）
  }, 3000, `${pageId ?? ""}:${isCurrentPageRoutine}`);
  const pageRuns = useMemo(() => pageRunsData ?? [], [pageRunsData]);
  // projectedRunId: null = 投影なし＝**テンプレート**（設計図）を見ている / それ以外 = そのラン。
  // ページを開いた既定はテンプレート（2026-08-08 本人指定。旧: 実行中のランがあれば勝手に
  // 最新1本を投影していたため、素の設計図を見るのにセレクタ操作が要った）。
  // ランはレールのラン子行かツールバーのセレクタで明示的に選ぶ
  // 開いているラン（null = テンプレートのページを見ている）。ランは**別のページ**なので、
  // 切り替えは明示操作でだけ起きる: レールのページ行＝テンプレートへ / ラン行＝そのランへ /
  // URL（#/r/<id>）＝そのランへ。ページidの変化に引きずられて勝手に消さない（2026-08-08）
  const [projectedRunId, setProjectedRunId] = useState<string | null>(null);
  // ページを切り替えたら次の3秒ポーリングを待たずにラン一覧を取り直す
  useEffect(() => {
    refreshActiveRun();
  }, [pageId, isCurrentPageRoutine, refreshActiveRun]);
  // 開いているランは全ページ横断で探す（ラン子行から別ページのランを直接開けるように）
  const openRun = useMemo<Run | null>(() => {
    if (!projectedRunId) return null;
    for (const list of Object.values(railRuns)) {
      const hit = list.find((r) => r.id === projectedRunId);
      if (hit) return hit;
    }
    return pageRuns.find((r) => r.id === projectedRunId) ?? null;
  }, [projectedRunId, railRuns, pageRuns]);
  const activeRun = openRun;

  // ---- ランのページ（2026-08-08 本人指定「ランを押すとその瞬間にグラフもノードのプロパティも
  //      すべてフォークして、それぞれ別のものとして表示される」）。
  //      中身は GET /api/runs/:id/graph（発火時スナップショット → 操作ログ復元 → 現在の順で
  //      当時を割り出す）。ラン内の進捗（items）を status に載せて、テンプレートとは別の
  //      ノード集合として扱う。ラン中に中身は変わらないので取得は開いたときだけでよい ----
  const { data: runGraph } = usePolling(
    async () => (projectedRunId ? await api.getRunGraph(projectedRunId) : null),
    60000,
    projectedRunId ?? "",
  );
  const runNodes = useMemo<Node[]>(() => {
    if (!openRun || !runGraph || runGraph.runId !== openRun.id) return [];
    return runGraph.nodes
      .filter((n) => n.id !== openRun.procedure) // ページ自身はメンバーではない
      .map((n) => {
        const item = openRun.items[n.id];
        // トリガーはランのワークアイテムを持たない＝ランが在る時点で発火済み（完了）
        const status: Node["status"] =
          item?.status === "waiting"
            ? "running" // waiting は保存値に無い派生状態。カードは pendingRequest 側で橙にする
            : (item?.status ?? (n.kind === "trigger" ? "done" : (n.status ?? "pending")));
        return { ...(n as unknown as Node), status };
      });
  }, [openRun, runGraph]);
  /** ランのページのページノード（当時のページ名で見せる）。無ければ現在のページノード */
  const runPageNode = useMemo<Node | null>(() => {
    if (!openRun || !runGraph) return null;
    const forked = runGraph.nodes.find((n) => n.id === openRun.procedure);
    return (forked as unknown as Node) ?? null;
  }, [openRun, runGraph]);
  /** ランのページを見ているか（= ラン専用の表示・編集ロックに切り替える） */
  const inRunPage = !!openRun && runNodes.length > 0;

  /** ノード詳細パネルに出すノード。ランのページではフォーク側（そのランの中身）を見せる。
   *  見つからないノード（ラン後に足されたノード等）はテンプレート側で代替する */
  const panelNode = useMemo<Node | null>(() => {
    if (!selectedId) return null;
    if (inRunPage) {
      const forked = runNodes.find((n) => n.id === selectedId) ?? (runPageNode?.id === selectedId ? runPageNode : null);
      if (forked) return forked;
    }
    return nodes.find((n) => n.id === selectedId) ?? null;
  }, [selectedId, inRunPage, runNodes, runPageNode, nodes]);

  // 実行中ランのワークアイテムで status=waiting のものを集める（あなたの番の一覧。
  // 受信箱UIは廃止済み（docs/design.md 4章②）で、今の用途はデスクトップ通知だけ）
  const runWaitItems = useMemo<RunWaitItem[]>(() => {
    if (!latestRuns) return [];
    const items: RunWaitItem[] = [];
    for (const run of Object.values(latestRuns)) {
      if (!run || run.status !== "running") continue;
      for (const [nodeId, item] of Object.entries(run.items)) {
        if (item.status !== "waiting") continue;
        const tmpl = nodes.find((n) => n.id === nodeId);
        // 他人の番（テンプレートの assignee が他人）は自分への通知対象にしない（チーム化 2026-08-04）
        if (tmpl && !turnIsMine(tmpl.assignee, me.email)) continue;
        const title = tmpl?.title || "（無題）";
        const label = item.note ? `[ラン] ${title}（${item.note}）` : `[ラン] ${title}`;
        items.push({ key: `${run.id}:${nodeId}`, nodeId, label });
      }
    }
    return items;
  }, [latestRuns, nodes, me.email]);

  // あなたの番が増えたらデスクトップ通知（タブが非表示の時だけ。gw.notify がオン + 許可済み時のみ）。
  // 他人の番（assignee が他人）は通知しない（チーム化 2026-08-04。isMyTurn が判定を一元化）
  const inboxItemsRef = useRef<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    const combined: { id: string; title: string }[] = [
      ...nodes
        .filter((n) => isMyTurn(n, me.email))
        .map((n) => ({ id: n.id, title: n.title || "（無題）" })),
      ...runWaitItems.map((item) => ({ id: item.key, title: item.label })),
    ];
    const prev = inboxItemsRef.current;
    if (prev) {
      const prevIds = new Set(prev.map((i) => i.id));
      const added = combined.filter((i) => !prevIds.has(i.id));
      if (
        added.length > 0 &&
        localStorage.getItem("gw.notify") === "1" &&
        document.visibilityState !== "visible" &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        const latest = added[added.length - 1];
        new Notification(siteTitle, { body: `あなたの番: ${latest.title}` });
      }
    }
    inboxItemsRef.current = combined;
  }, [nodes, runWaitItems, me.email, siteTitle]);

  // ---- AI設定（初回セットアップ + いつでも開ける⚙） ----
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        if (!s.setupDone) setSettingsOpen(true);
      })
      .catch(() => {
        // トースト表示済み。設定は開かないままにする
      });
  }, []);
  // ⚙ で開くときは必ずサーバから最新を取り直す（2026-08-07「Discord 通知の設定がよく
  // 元に戻る」対策）。settings は起動時に一度読むだけなので、タブを開きっぱなしのまま
  // 別の端末で設定を変えると、古い値で初期化された設定画面の「保存」が全項目を
  // 書き戻して巻き戻していた。開く直前に取り直せばこの経路は消える
  const openSettings = useCallback(() => {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        setSettingsOpen(true);
      })
      .catch(() => {
        // 取得失敗（トースト表示済み）。古い値で開くと巻き戻りの原因になるので開かない
      });
  }, []);

  const handleMutated = useCallback(() => {
    refresh();
  }, [refresh]);

  // ヘッダーのゴール捕獲欄（2026-08-01: 受信箱を置き換えた新規プロジェクトの唯一の入口。
  // docs/design.md 4章 ②）。書いた瞬間に goal ノード = 空のページを作り、そこへ移動する
  const handleCaptureGoal = useCallback(
    async (title: string) => {
      try {
        const created = await api.addNode({ title, kind: "goal" });
        refresh();
        setPageId(created.id);
        setSelectedId(created.id);
        setMobileView("graph"); // モバイル: 作ったプロジェクトのグラフへ
        pushToast(`プロジェクト「${title}」を作りました`, "info");
      } catch {
        // api() 側でエラートースト表示済み
      }
    },
    [refresh],
  );

  // ヘッダーの「元に戻す」（Ctrl+Z のショートカット処理は GraphView 側）
  const handleUndo = useCallback(async () => {
    try {
      await api.undo();
      pushToast("元に戻しました", "info");
      refresh();
    } catch {
      // api() 側でエラートースト表示済み
    }
  }, [refresh]);

  // どこから選択されても、そのノードのページへ移動する（受信箱ジャンプ用）
  const selectNode = useCallback(
    (id: string | null) => {
      // モバイル: **選択が変わったときだけ**ノード詳細ビューへ遷移する。
      // onSelect は React Flow の selection-change 経由でポーリング再描画のたびに
      // 同じ id で再発火するため、無条件に遷移すると開いているタブから数秒で
      // 勝手にノード詳細へ飛ばされる（2026-08-02 本人報告）。キャンバス上の実タップは
      // 同じ id でも GraphView の onNodeTap 経由で遷移する
      if (isMobile && id && id !== selectedId) setMobileView("node");
      setSelectedId(id);
      if (!id) return;
      const n = nodes.find((x) => x.id === id);
      if (!n) return;
      if (folders.some((f) => f.id === id)) setPageId(id);
      else if (n.group) setPageId(n.group);
    },
    [nodes, folders, isMobile, selectedId],
  );

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
    [nodes, selectNode],
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

  // モバイルの実効ビュー: 「ノード」ビューで表示できるものが無ければグラフへ倒す
  // （選択解除・削除直後に空画面へ取り残されないように）。デスクトップは null（全ペイン共存）
  const hasNodeView = selectedIds.length > 1 || selectedNode !== null;
  const mv: MobileView | null = isMobile ? (mobileView === "node" && !hasNodeView ? "graph" : mobileView) : null;

  // --- モバイルのブラウザ「戻る」統合（2026-08-02 本人報告「スマホの戻るで戻りすぎる」） ---
  // SPA なので履歴が1件も積まれず、戻る=即アプリ外に出てしまっていた。ビュー切替と
  // 設定画面を history に積み、戻るは「1つ前のビューへ」になる（履歴を遡り切ったら
  // 従来どおりページを離れる）
  const popNavRef = useRef(false);
  const firstViewPushRef = useRef(true);
  const settingsOpenRef = useRef(false);
  useEffect(() => {
    if (!isMobile) return;
    if (firstViewPushRef.current) {
      // 初期エントリに現在ビューを刻む（戻り切ったときの復元先）
      firstViewPushRef.current = false;
      window.history.replaceState({ gwView: mobileView }, "");
      return;
    }
    if (popNavRef.current) {
      popNavRef.current = false; // popstate 由来の setMobileView では積まない
      return;
    }
    window.history.pushState({ gwView: mobileView }, "");
  }, [mobileView, isMobile]);
  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
    if (!isMobile || !settingsOpen) return;
    window.history.pushState({ gwSettings: true }, "");
  }, [settingsOpen, isMobile]);
  useEffect(() => {
    if (!isMobile) return;
    const onPop = (e: PopStateEvent) => {
      if (settingsOpenRef.current) {
        setSettingsOpen(false); // 設定が開いていたら「戻る」はまず設定を閉じる
        return;
      }
      const st = e.state as { gwView?: MobileView } | null;
      popNavRef.current = true;
      setMobileView(st?.gwView ?? "graph");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [isMobile]);

  return (
    // 背景色は body が持つ（格子と一体）。ここに不透明背景を敷くと格子が隠れる
    <div className="flex h-full flex-col text-foreground">
      <TopBar
        chatOpen={mv !== null ? mv === "chat" : chatOpen}
        onToggleChat={() =>
          isMobile
            ? setMobileView((v) => (v === "chat" ? "graph" : "chat"))
            : setChatOpen((v) => !v)
        }
        onOpenSettings={openSettings}
        onUndo={handleUndo}
        onCaptureGoal={handleCaptureGoal}
      />
      {/* モバイル（mv ≠ null）はどれか1つのビューだけを表示する。
          - 一覧/ノード詳細: 非表示時はアンマウント（ノード詳細は表示中に既読化する副作用が
            あるため、隠れたまま既読が進まないように）
          - グラフ/チャット: マウントは維持して display:none（グラフはビュー切替のたびの
            再レイアウトを避け、チャットは応答ストリーミングを切らないため） */}
      <div className="flex min-h-0 flex-1">
        {(mv === null || mv === "pages") && (
          <PageList
            folders={folders}
            folderNodes={folderNodes}
            allNodes={nodes}
            onMutated={handleMutated}
            pageId={pageId}
            threadMeta={threadMeta}
            reads={reads}
            pageRuns={railRuns}
            selectedRunId={activeRun?.id ?? null}
            forceExpanded={isMobile}
            onSelectPage={(id) => {
              setProjectedRunId(null); // ページ行 = テンプレート（設計図）を開く
              setPageId(id);
              // 選択はプロジェクト自身にしておく（2026-08-02 本人指示「タップしたらグラフ画面に
              // 移りつつ、詳細はプロジェクト詳細にしておいて」）。モバイルでは画面はグラフへ
              // 移る（詳細ビューには飛ばない）が、ノードタブがプロジェクト詳細を指すので
              // 1タップでアクセスできる。デスクトップはグラフの横に詳細パネルが出る従来挙動
              setSelectedId(id);
              setMobileView("graph");
            }}
            onSelectRun={(pid, runId) => {
              // レールのラン子行 → **そのランのページ**へ移動（テンプレートとは別物として開く）
              setProjectedRunId(runId);
              setPageId(pid);
              setSelectedId(null); // ランのページはまずグラフ全体を見せる
              setMobileView("graph");
            }}
          />
        )}
        <div className={cn("contents", mv !== null && mv !== "graph" && "hidden")}>
          <GraphView
            nodes={inRunPage ? runNodes : pageNodes}
            pageNode={inRunPage ? (runPageNode ?? pageNode) : pageNode}
            runView={
              inRunPage && openRun
                ? {
                    id: openRun.id,
                    title: openRun.title,
                    status: openRun.status,
                    // 旧サーバのランファイルには context が無い（3.15 より前）ので空へ倒す
                    context: openRun.context ?? {},
                  }
                : null
            }
            onLeaveRun={() => setProjectedRunId(null)}
            selectedId={selectedId}
            threadMeta={threadMeta}
            reads={reads}
            activeRun={activeRun}
            pageRuns={pageRuns}
            onProjectRun={(runId) => {
              // ランを開く（発火直後もここを通る）。生まれたばかりのランは一覧にまだ
              // 載っていないので、次のポーリングを待たずに取り直す（2026-08-08）
              setProjectedRunId(runId);
              if (runId) {
                setSelectedId(null); // ランのページはまずグラフ全体を見せる
                refreshRailRuns();
                refreshActiveRun();
              }
            }}
            onSelect={selectNode}
            onNodeTap={() => {
              if (isMobile) setMobileView("node"); // 実タップは同じノードでも詳細へ
            }}
            onMutated={handleMutated}
            onSelectionIdsChange={setSelectedIds}
          />
        </div>
        {(mv === null || mv === "node") &&
          (selectedIds.length > 1 ? (
            <BulkPanel
              nodes={nodes.filter((n) => selectedIds.includes(n.id))}
              folders={folders}
              pageId={pageId}
              onMutated={handleMutated}
              onClose={() => {
                setSelectedIds([]);
                setSelectedId(null);
                setMobileView("graph");
              }}
            />
          ) : (
            selectedNode && (
              <NodePanel
                key={`${openRun?.id ?? "template"}:${(panelNode ?? selectedNode).id}`}
                node={panelNode ?? selectedNode}
                allNodes={inRunPage ? runNodes : nodes}
                activeRun={activeRun}
                runView={inRunPage && openRun ? { id: openRun.id, title: openRun.title } : null}
                reads={reads}
                onViewed={markViewed}
                onMutated={handleMutated}
                onClose={() => {
                  setSelectedId(null);
                  setMobileView("graph");
                }}
                onSelect={selectNode}
              />
            )
          ))}
        {(mv === null ? chatOpen : true) && (
          <div className={cn("contents", mv !== null && mv !== "chat" && "hidden")}>
            <ChatDrawer
              pageId={pageId}
              pageTitle={pageNode?.title ?? null}
              selectedNodeId={selectedId}
              onMutated={handleMutated}
              onClose={() => (isMobile ? setMobileView("graph") : setChatOpen(false))}
            />
          </div>
        )}
      </div>
      {isMobile && (
        <MobileNav
          view={mv ?? "graph"}
          nodeEnabled={hasNodeView}
          nodeLabel={selectedIds.length > 1 ? `${selectedIds.length}件選択` : (selectedNode?.title || null)}
          onChange={setMobileView}
        />
      )}
      <CommandPalette nodes={nodes} folders={folders} onSelect={selectNode} />
      {settingsOpen && settings && (
        <SetupModal
          settings={settings}
          forced={!settings.setupDone}
          onSaved={(next) => {
            setSettings(next);
            setSettingsOpen(false);
          }}
          onSkip={async () => {
            const next = await api.updateSettings({ setupDone: true }).catch(() => settings);
            setSettings(next);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <ToastHost />
      <DialogHost />
    </div>
  );
}
