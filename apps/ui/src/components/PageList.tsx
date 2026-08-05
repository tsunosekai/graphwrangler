// 左レールのページ一覧。ゴール/ルーティーン（フォルダ）1つ = 1ページ（desk の左レール方式）。
// 「プロジェクト」節（トリガーを持たないページ）と「ルーティーン」節（トリガーを持つページ）に
// ビュー的に分ける（本人指定 2026-07-31）。ルーティーン化はトリガーを置く/外すだけの1操作で、
// 節をまたぐのはその副作用として自然に起きる（design.md 3.8: 「プロジェクト/ルーティーンは
// トリガーの有無の別名」）。
// タイトル下のちょぼは zinsei desk と同じ「ball（いま誰の席か）」内訳（本人指定）:
// done/dropped/skipped は暗く沈め、それ以外は担当(executor)の色で誰の手番かを見せる。
// ルーティーン行は最新ランのワークアイテム内訳（テンプレート自身は status を持たないため、
// 担当色はテンプレートノードの executor を allNodes から引く）。
// 最新ランの取得は App 側でまとめてポーリングする（受信箱のラン待ち統合と共有し、
// ページ数ぶんの N+1 取得を1箇所に集約するため。旧: このコンポーネント内で自前ポーリングしていた）。
import { useState } from "react";
import { PanelLeft, PanelLeftClose, Settings2 } from "lucide-react";
import { focusGoalCapture } from "../lib/capture";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { isRoutinePage } from "../lib/routine";
import { colorOf, displayNameOf, effectiveMembers, initialOf, sameEmail, turnIsMine, useTeam } from "../lib/team";
import { cn } from "../lib/utils";
import type { Node, Run, Status } from "../types";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Hint } from "./Hint";
import { Icon } from "./Icon";
import { StatusCircle } from "./StatusCircle";

interface Props {
  folders: Node[];
  allNodes: Node[];
  pageId: string | null;
  /** ノードid → 最終メッセージ時刻。ページ行の未読数バッジに使う（本人指定 2026-07-31:
   *  「未読は数字でプロジェクトに、あなたの番はちょぼに」） */
  threadMeta: Record<string, string>;
  /** ノードid → 既読時刻（サーバ持ち。2026-08-02 localStorage から移行＝端末間で一致） */
  reads: Record<string, string>;
  /** ページ id → 最新ラン（App 側でポーリング済み） */
  latestRuns: Record<string, Run | null>;
  /** ページ id → 実行中ラン数（並走中の世界線の数。0は非表示） */
  runningCounts: Record<string, number>;
  /** モバイル（一覧ビューが画面を専有）では畳み状態を無視して常に展開表示する
   *  （2026-08-02 モバイル4ビュー化。畳む/開くはデスクトップのレール専用の概念） */
  forceExpanded?: boolean;
  onSelectPage: (id: string) => void;
  /** 行の⚙からページ自身のノード詳細を開く（タイトル編集・関係者・削除の導線。
   *  goal ノードはグラフに描画されないため、ここが NodePanel への唯一の入口。2026-08-04） */
  onOpenPageNode: (id: string) => void;
}

const EXEC_JA: Record<Node["executor"], string> = { human: "人間", ai: "AI", script: "スクリプト" };
const STATUS_JA: Record<Status, string> = {
  unplanned: "未計画",
  pending: "待ち",
  running: "進行中",
  waiting: "回答待ち",
  done: "完了",
  dropped: "中止",
  skipped: "スキップ",
};

/** ちょぼの「席」= ball の所在。done/dropped/skipped は決着済みなので担当色でなく沈めた色にする。
 *  waiting（あなたの番）はカード右肩の橙点と同じ --attention 色で出す（人間の黄に畳むと
 *  普通の人間タスクと見分けが付かない。2026-07-31 本人指摘） */
type Seat = "attention" | "human" | "ai" | "script" | "done";
function seatOf(status: Status, executor: Node["executor"]): Seat {
  if (status === "done" || status === "dropped" || status === "skipped") return "done";
  if (status === "waiting") return "attention";
  return executor;
}
function seatColor(status: Status, executor: Node["executor"]): string {
  if (status === "done") return "var(--done)";
  if (status === "dropped" || status === "skipped") return "var(--dropped)";
  if (status === "waiting") return "var(--attention)";
  return executor === "human" ? "var(--human)" : executor === "ai" ? "var(--ai)" : "var(--script)";
}
// 目に入るべき順: あなたの番 → 人間の席 → AI → スクリプト → 完了系
const SEAT_ORDER: Seat[] = ["attention", "human", "ai", "script", "done"];
const MAX_DOTS = 16;

export function PageList({ folders, allNodes, pageId, threadMeta, reads, latestRuns, runningCounts, forceExpanded, onSelectPage, onOpenPageNode }: Props) {
  const [width, startResize] = useResizableWidth("railW", 224, 160, 400);
  // チーム化（2026-08-04）: 人フィルタとイニシャルバッジ。ロスターが2人未満なら出さない
  const { me, users, enabled: teamEnabled } = useTeam();
  // 人フィルタ: "all"（全員）/ "me"（自分。ログイン中のみ）/ "none"（帰属なし）/
  // メールアドレス。リロード跨ぎで保持
  const [personFilter, setPersonFilterRaw] = useState<string>(
    () => localStorage.getItem("gw.pageFilter") ?? "all",
  );
  const setPersonFilter = (v: string) => {
    setPersonFilterRaw(v);
    try {
      localStorage.setItem("gw.pageFilter", v);
    } catch {
      // 無視（永続化は補助機能）
    }
  };
  // 保存値の正規化: 未ログインで "me" が残っていた・ロスターから消えたメールだった、は
  // 「全員」に倒す（Select の表示と絞り込みの両方がこれを使う）。"none"（帰属なし）は有効値
  const personFilterValue =
    personFilter === "me"
      ? me.email
        ? "me"
        : "all"
      : personFilter === "all" ||
          personFilter === "none" ||
          users.some((u) => !u.disabled && sameEmail(u.email, personFilter))
        ? personFilter
        : "all";
  // ページの絞り込み述語（チーム化 2026-08-04）。判定は実効関係者
  // （手動 members ∪ 作成者 ∪ 配下ノードの担当・関係者・作成者。lib/team.ts の effectiveMembers）:
  // - 全員（またはロスター2人未満）: 絞り込みなし
  // - 人: その人が実効関係者に居るページだけ（厳格。実効関係者が空のページは出さない——
  //   当初は全滅防止で「空は常に表示」の救済を入れていたが、「担当が付いていないのに
  //   フィルタをすり抜けて出てくる」と逆の不満になった。2026-08-04 実機指摘で撤回）
  // - 帰属なし: 実効関係者が空のページだけ。救済の代替で、チーム化前の既存データに
  //   帰属を付けて回る作業や拾い漏れの発見に使う
  const byPerson = (f: Node): boolean => {
    if (!teamEnabled || personFilterValue === "all") return true;
    const eff = effectiveMembers(f, allNodes);
    if (personFilterValue === "none") return eff.length === 0;
    const email = personFilterValue === "me" ? me.email : personFilterValue;
    return !!email && eff.some((m) => sameEmail(m, email));
  };
  // アーカイブ節（done/dropped なゴール）は既定で閉じておく
  const [archiveOpen, setArchiveOpen] = useState(false);
  // レール自体の開閉（2026-07-31 本人要望）。閉じると細い縦帯だけ残す
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem("gw.railOpen") !== "0");
  const toggleRail = () =>
    setRailOpen((v) => {
      try {
        localStorage.setItem("gw.railOpen", v ? "0" : "1");
      } catch {
        // 無視
      }
      return !v;
    });

  // 未読判定は GraphView（カードの青ドット）と同じ規約: 既読時刻より新しいメッセージがあるか
  const isUnread = (id: string) => {
    const last = threadMeta[id];
    if (!last) return false;
    const read = reads[id];
    return !read || last > read;
  };

  // 作成は「ヘッダーのゴール捕獲欄」に一本化した（2026-08-01 本人指示。docs/design.md 4章 ②）。
  // ここの「＋」は無題ノードを作らず、その入力欄へフォーカスを渡すだけにする——
  // 入口が2つあると「無題のゴール」が量産されるため
  const addGoal = () => focusGoalCapture();

  // ルーティーンは対象外（常にアクティブ扱い）。goal 等の status が done|dropped のものだけ
  // アーカイブへ回す
  const activeFolders = folders.filter(
    (f) => isRoutinePage(f, allNodes) || (f.status !== "done" && f.status !== "dropped"),
  );
  const archivedFolders = folders.filter(
    (f) => !isRoutinePage(f, allNodes) && (f.status === "done" || f.status === "dropped"),
  );
  // プロジェクト（トリガー無し）/ ルーティーン（トリガー有り）のビュー的な分類（本人指定）。
  // 人フィルタ中はプロジェクト節・ルーティーン節の両方に同じ述語（上の byPerson）を適用する
  // （チーム化 2026-08-04）
  const projectFolders = activeFolders.filter((f) => !isRoutinePage(f, allNodes) && byPerson(f));
  const routineFolders = activeFolders.filter((f) => isRoutinePage(f, allNodes) && byPerson(f));

  const renderRow = (f: Node, archived: boolean) => {
    const routine = isRoutinePage(f, allNodes);
    const latestRun = latestRuns?.[f.id] ?? null;
    // ページ内（ゴール自身 + メンバー）の未読ノード数。数字バッジで行の右端に出す
    const unreadCount = [f.id, ...allNodes.filter((n) => n.group === f.id).map((n) => n.id)].filter(
      isUnread,
    ).length;

    // 質問が開いている（pendingRequest あり）ノードは status が何であれ「あなたの番」扱い
    // （NodeCard の visualStatus と同じ保険）。ただし assignee が他人なら waiting（橙）に
    // 昇格させず、素の status のまま担当の席色で描く（チーム化 2026-08-04: 他人の番は橙にしない）
    const effStatus = (n: Node): Status =>
      n.pendingRequest && turnIsMine(n.assignee, me.email) ? "waiting" : n.status;
    const memberDots = !routine
      ? allNodes
          .filter((n) => n.group === f.id)
          .slice()
          .sort((a, b) => SEAT_ORDER.indexOf(seatOf(effStatus(a), a.executor)) - SEAT_ORDER.indexOf(seatOf(effStatus(b), b.executor)))
          .map((m) => ({
            key: m.id,
            title: `${m.title || "（無題）"} — ${EXEC_JA[m.executor]}の席 / ${STATUS_JA[effStatus(m)]}`,
            color: seatColor(effStatus(m), m.executor),
          }))
      : [];

    // ランのワークアイテムはテンプレート自身の status を持たないため、担当色はテンプレートノード
    // （allNodes 内の同id）の executor を引く。テンプレートが見当たらない（削除済み等）場合は
    // script 扱いにフォールバックする
    const runDots =
      routine && latestRun
        ? Object.entries(latestRun.items)
            .map(([nodeId, item]) => {
              const tmpl = allNodes.find((n) => n.id === nodeId);
              const executor = tmpl?.executor ?? ("script" as const);
              // 他人の番（テンプレートの assignee が他人）の waiting は橙にせず、
              // pending 相当=担当の席色に落とす（チーム化 2026-08-04。effStatus と同じ原則）
              const st: Status =
                item.status === "waiting" && !turnIsMine(tmpl?.assignee ?? null, me.email)
                  ? "pending"
                  : item.status;
              return {
                key: nodeId,
                st,
                executor,
                title: `${EXEC_JA[executor]}の席 / ${STATUS_JA[item.status]}`,
              };
            })
            .sort(
              (a, b) => SEAT_ORDER.indexOf(seatOf(a.st, a.executor)) - SEAT_ORDER.indexOf(seatOf(b.st, b.executor)),
            )
            .map(({ key, st, executor, title }) => ({
              key,
              title,
              color: seatColor(st, executor),
            }))
        : [];

    const dots = routine ? runDots : memberDots;
    const shown = dots.slice(0, MAX_DOTS);
    const rest = dots.length - shown.length;

    // イニシャルバッジは実効関係者（手動 members + 配下ノードからの自動集計。2026-08-04 追修。
    // 手動だけだと配下に担当者が居てもバッジが出ず「誰のページか」が見えない）
    const effMembers = teamEnabled ? effectiveMembers(f, allNodes) : [];

    return (
      // 行の中に⚙ボタン（本物の <button>）を置くため、行自体は button でなく div[role=button]
      // にする（button の入れ子は不正HTML。2026-08-04 追修）。Enter/Space の選択も維持する
      <div
        key={f.id}
        role="button"
        tabIndex={0}
        className={cn(
          "flex w-full cursor-pointer flex-col items-stretch gap-0.5 rounded-sm px-2 py-1.5 text-left text-muted-foreground hover:bg-accent/60",
          pageId === f.id && "bg-accent text-foreground",
          archived && "opacity-70",
        )}
        onClick={() => onSelectPage(f.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelectPage(f.id);
          }
        }}
      >
        <span className="flex min-w-0 items-center gap-2">
          {routine ? (
            <span className="inline-flex size-3 flex-shrink-0 text-muted-foreground" title="ルーティーンページ">
              <Icon name="repeat" size={12} />
            </span>
          ) : (
            <StatusCircle status={f.status} size={12} />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">{f.title || "（無題）"}</span>
          {/* 関係者のイニシャルバッジ（チーム化 2026-08-04）: 実効関係者を最大3人 + “+n”。
              小さく控えめに */}
          {effMembers.length > 0 && (
            <span
              className="flex flex-shrink-0 items-center -space-x-1"
              title={`関係者: ${effMembers.map((m) => displayNameOf(m, users)).join("、")}`}
            >
              {effMembers.slice(0, 3).map((m) => (
                // 地色はユーザーの決定的カラー（colorOf）。border-background は重なり
                // （-space-x-1）の切れ目用
                <span
                  key={m}
                  className="inline-flex size-3.5 items-center justify-center rounded-full border border-background text-[8px] font-semibold leading-none text-white"
                  style={{ background: colorOf(m) }}
                >
                  {initialOf(m, users)}
                </span>
              ))}
              {effMembers.length > 3 && (
                <span className="pl-1.5 text-[9px] text-text-lo">+{effMembers.length - 3}</span>
              )}
            </span>
          )}
          {/* 実行中のラン数（並走中の世界線）。1本でも「回っている」ことが分かるように出す */}
          {routine && (runningCounts[f.id] ?? 0) > 0 && (
            <span
              className="flex-shrink-0 rounded border border-ai/40 px-1 text-[10px] leading-4 text-ai"
              title={`実行中のラン ${runningCounts[f.id]} 本`}
            >
              ▶ {runningCounts[f.id]}
            </span>
          )}
          {unreadCount > 0 && (
            <span
              className="flex-shrink-0 rounded-full bg-ai px-1.5 text-[10px] font-semibold leading-4 text-white"
              title={`未読メッセージのあるノード ${unreadCount} 件`}
            >
              {unreadCount}
            </span>
          )}
          {/* ページ自身のノード詳細（タイトル編集・関係者・削除）への導線（2026-08-04 追修）。
              goal ノードはグラフに描画されないため、この⚙が NodePanel を開く唯一の入口。
              モバイルでも押せるよう hover 表示にはしない（常時表示・控えめな色） */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5 flex-shrink-0 text-text-lo hover:text-foreground"
            title="ページの詳細を開く"
            onClick={(e) => {
              e.stopPropagation();
              onOpenPageNode(f.id);
            }}
          >
            <Settings2 className="size-3.5" />
          </Button>
        </span>
        {dots.length > 0 && (
          <span className="flex flex-wrap items-center gap-[3px] pl-5">
            {shown.map((d) => (
              <i
                key={d.key}
                className="size-[5px] flex-shrink-0 rounded-full"
                title={d.title}
                style={{ background: d.color }}
              />
            ))}
            {rest > 0 && <span className="font-mono text-xs text-text-lo">+{rest}</span>}
          </span>
        )}
      </div>
    );
  };

  if (!railOpen && !forceExpanded) {
    return (
      <div className="flex flex-shrink-0 flex-col items-center border-r border-border bg-muted py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          title="プロジェクト一覧を開く"
          onClick={toggleRail}
        >
          <PanelLeft className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div
      // overflow-x-hidden: リサイズハンドル（right:-3px）等のはみ出しが微小な横スクロールを
      // 生む不具合の抑止（2026-07-31 本人報告）
      // data-mobile-panel: モバイル（<768px）では全画面オーバーレイになる（index.css）
      data-mobile-panel="left"
      className="relative flex flex-shrink-0 flex-col gap-px overflow-y-auto overflow-x-hidden border-r border-border bg-muted p-1.5"
      style={{ width }}
    >
      <div className="resize-handle resize-handle-right" onPointerDown={(e) => startResize(e, 1)} />
      {/* プロジェクト節: トリガー無しのページ。「＋」はここに1個だけ（ルーティーン化はトリガーを
          置けば自動でルーティーン節へ移る、という体験に任せる。本人指定）。
          見出しは0件でも常に出す — 消すと「＋」の導線が無くなるコールドスタート問題があるため
          （その「＋」自体は作成せず、ヘッダーのゴール捕獲欄へ案内する） */}
      <div className="flex items-center justify-between px-2 pb-2 pt-1 text-xs font-semibold tracking-wide text-text-lo">
        <Hint
          id="page-project"
          text="トリガーを持たないページ。ゴールに向かって一度きり進める。ノードにトリガーを置くと自動でルーティーン節へ移る"
        >
          <span>プロジェクト</span>
        </Hint>
        <span className="flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            title="ゴールを追加（ヘッダーの入力欄へ）"
            onClick={addGoal}
          >
            ＋
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            title="プロジェクト一覧を閉じる"
            onClick={toggleRail}
          >
            <PanelLeftClose className="size-3.5" />
          </Button>
        </span>
      </div>
      {/* 人フィルタ（チーム化 2026-08-04）: ページを人で絞り込む。ルーティーン節にも同じ
          述語が効く。ロスターが2人未満の運用では出さない（degrade 原則） */}
      {teamEnabled && (
        <div className="px-2 pb-1.5">
          <Select value={personFilterValue} onValueChange={setPersonFilter}>
            <SelectTrigger className="h-7 w-full text-xs" title="人でページを絞り込む">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全員</SelectItem>
              {me.email && <SelectItem value="me">自分</SelectItem>}
              {/* 無効化ユーザーは選択肢から除外（2026-08-04 アカウント管理）。保存値に
                  無効化済みメールが残っていた場合は上の正規化が「全員」に倒す */}
              {users
                .filter((u) => !u.disabled && !sameEmail(u.email, me.email))
                .map((u) => (
                  <SelectItem key={u.email} value={u.email}>
                    {displayNameOf(u.email, users)}
                  </SelectItem>
                ))}
              {/* 帰属なし = 実効関係者が空のページだけ。人フィルタは厳格絞り込みなので、
                  帰属未記入の既存データはここで見つけて付けて回る（2026-08-04 追修） */}
              <SelectItem value="none">帰属なし</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {projectFolders.map((f) => renderRow(f, false))}
      {routineFolders.length > 0 && (
        <>
          <div className="flex items-center justify-between px-2 pb-2 pt-1 text-xs font-semibold tracking-wide text-text-lo">
            <Hint
              id="page-routine"
              text="トリガーを持つページ。発火のたびにラン（実行インスタンス）が生まれ、進捗はランごとに付く（台帳ビューで一覧できる）"
            >
              <span>ルーティーン</span>
            </Hint>
          </div>
          {routineFolders.map((f) => renderRow(f, false))}
        </>
      )}
      {archivedFolders.length > 0 && (
        <>
          <button
            type="button"
            className="mt-1 flex items-center gap-1.5 border-t border-border px-2 py-1.5 text-left text-xs text-text-lo hover:bg-accent/40 hover:text-muted-foreground"
            onClick={() => setArchiveOpen((v) => !v)}
          >
            <span>{archiveOpen ? "▾" : "▸"}</span>
            <span>アーカイブ {archivedFolders.length}</span>
          </button>
          {archiveOpen && (
            <div className="flex flex-col gap-px">{archivedFolders.map((f) => renderRow(f, true))}</div>
          )}
        </>
      )}
    </div>
  );
}
