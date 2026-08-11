// graphwrangler サーバ API の薄いクライアント。エラーは {error:"..."} + 4xx/5xx を前提に、
// 拾ってトースト表示してから re-throw する（呼び出し側は catch して個別UIを止めるだけでよい）。
import type {
  ImplTrial,
  Message,
  MaterializedMessage,
  Node,
  Run,
  RunGraphNode,
  RunItemStatus,
  TraceEvent,
  WiringReference,
  WiringWarning,
} from "../types";
import { pushToast } from "./toast";
import { threadKey } from "./unread";

export class ApiError extends Error {}

/** silent: エラートーストを出さず re-throw だけする。用途は2つ:
 *  - 一括処理で失敗を集約して1回のトーストにまとめたい呼び出し側
 *  - **ポーリング**（数秒おきの取得。失敗のたびにトーストを出すと、サーバの再起動中に
 *    エラーが積み上がって画面を覆う）。呼び出し側は握り潰さず投げ直すこと——
 *    usePolling が直近の正常なデータを保って再試行する
 *  既定は従来どおりトースト表示（人が押した操作の失敗は黙らせない） */
async function request<T>(path: string, init?: RequestInit & { silent?: boolean }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    const msg = "サーバに接続できません";
    if (!init?.silent) pushToast(msg);
    throw new ApiError(msg);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    if (!init?.silent) pushToast(msg);
    throw new ApiError(msg);
  }
  return data as T;
}

export interface NodeCreateInput {
  title: string;
  detail?: string | null;
  impl?: Node["impl"];
  parents?: string[];
  group?: string | null;
  /** 左レールの整理棚（kind=folder ノードの id）。ページの見せ方の軸で実行には無関係 */
  folder?: string | null;
  /** kind=folder のみ: どの節の棚か（2026-08-08） */
  folderSection?: Node["folderSection"];
  /** 左レールでの手動並び順（昇順。null=未指定＝後ろ） */
  order?: number | null;
  kind?: Node["kind"];
  executor?: Node["executor"];
  approval?: Node["approval"];
  autonomy?: Node["autonomy"];
  lifecycle?: Node["lifecycle"];
  status?: Node["status"];
  fixed?: boolean;
  /** 担当者メール（チーム化 2026-08-04）。createdBy はサーバが刻むので入力には無い */
  assignee?: Node["assignee"];
  /** 関係者メール配列（ページでのみ意味を持つ） */
  members?: Node["members"];
  /** kind=decision のみ意味を持つ選択肢一覧（docs/design.md 3.9） */
  branches?: Node["branches"];
  parentOptions?: Node["parentOptions"];
  /** ランのコンテキストへの出力宣言（docs/design.md 3.15） */
  outputs?: Node["outputs"];
}

export type NodePatchInput = Partial<Omit<Node, "id" | "created">>;

// ---- AI設定（初回セットアップ + ⚙。実装は packages/server/src/settings.ts） ----

export interface SettingsView {
  chat: {
    /** api = プロバイダのAPIキーで直接呼ぶ / cli = claude 等のヘッドレスCLIを使う */
    mode: "api" | "cli";
    provider: "anthropic" | "openai";
    model: string | null;
    hasApiKey: boolean;
    keySource: "settings" | "env" | "none";
    cliPath: string;
    cliModel: string;
    /** CLI モードの --effort（思考の深さ）。null = CLI 既定（2026-08-07） */
    cliEffort: "low" | "medium" | "high" | "xhigh" | "max" | null;
    /** GraphWrangler AI / Task AI（CLIモード）の --allowedTools に追記するツール。
     *  既定でフルセット（Bash 等）が許可済みのため、MCP ツール等を足す用途 */
    cliExtraTools: string[];
  };
  engine: {
    /** cli = ヘッドレスCLI(claude -p 等)を起動する / api = チャット側のAPIキーで直接呼ぶ */
    mode: "cli" | "api";
    cliPath: string;
    model: string;
    /** --effort（思考の深さ）。null = CLI 既定（2026-08-07） */
    effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
    extraArgs: string[];
    /** 実行AI（CLIモード）の --allowedTools に追記するツール（既定フルセットに足す形） */
    cliExtraTools: string[];
    apiModel: string | null;
  };
  /** AI（三役共通）の作業範囲 */
  ai: {
    /** claude -p の --add-dir に渡す追加作業ディレクトリ（ワークスペースルート外の開放） */
    addDirs: string[];
  };
  /** ワークスペースの自動 commit/push（ワークスペースモードのみ意味を持つ。既定OFF） */
  git: {
    autoPush: boolean;
    intervalSec: number;
    /** 既定対象に追加で同期するワークスペース内相対パス */
    extraPaths: string[];
  };
  /** GraphWrangler 本体（アプリのクローン）の自動アップデート（2026-08-05） */
  update: {
    autoCheck: boolean;
    autoApply: boolean;
    intervalMin: number;
  };
  /** 「あなたの番」の Discord Webhook 通知（2026-08-07）。URL は書き込み専用で有無だけ返る。
   *  個別の受け取り設定はユーザーごとの UserSettings 側（設定はユーザー/全体で分離） */
  notify: {
    discordEnabled: boolean;
    hasDiscordWebhook: boolean;
    /** 通知リンクの基底URL（2026-08-08）。null = リンク無しで通知する */
    publicUrl: string | null;
  };
  /** インスタンスのブランディング（2026-08-08）。会社/個人の2インスタンスで見た目を分ける。
   *  faviconVersion はサーバ管理（アップロードで +1／既定に戻すと 0）で、patch からは書けない */
  branding: {
    siteTitle: string;
    faviconVersion: number;
  };
  setupDone: boolean;
}

/** GET/PUT /api/me/settings（ユーザーごとの設定。2026-08-07「設定はユーザーごとと全体で分けて」）。
 *  未ログイン運用では "default" 1枠に畳まれる。書き込みは即時反映（保存ボタン不要） */
export interface UserSettings {
  /** 自分の番（判断リクエスト・ラン待ち）の Discord メンション通知を受け取るか */
  discordTurnNotify: boolean;
  /** Task AI がスレッドへ返信し終えたときの Discord 通知を受け取るか */
  discordAiReplies: boolean;
}

/** GET /api/update（packages/server/src/selfupdate.ts の UpdateStatus と同形） */
export interface UpdateStatus {
  unavailableReason: string | null;
  autoCheck: boolean;
  autoApply: boolean;
  intervalMin: number;
  branch: string | null;
  current: string | null;
  currentSubject: string | null;
  behind: number;
  checking: boolean;
  applying: boolean;
  lastCheckAt: string | null;
  lastApplyAt: string | null;
  lastResult: string | null;
  /** systemd / pm2 に見られているか。false だと取り込み後の再起動は人手 */
  supervised: boolean;
  restartPending: boolean;
}

export interface SettingsPatch {
  chat?: {
    mode?: "api" | "cli";
    provider?: "anthropic" | "openai";
    model?: string | null;
    apiKey?: string | null;
    cliPath?: string;
    cliModel?: string;
    cliEffort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
    cliExtraTools?: string[];
  };
  engine?: {
    mode?: "cli" | "api";
    cliPath?: string;
    model?: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
    extraArgs?: string[];
    cliExtraTools?: string[];
    apiModel?: string | null;
  };
  ai?: { addDirs?: string[] };
  git?: { autoPush?: boolean; intervalSec?: number; extraPaths?: string[] };
  update?: { autoCheck?: boolean; autoApply?: boolean; intervalMin?: number };
  /** discordWebhookUrl は apiKey と同じ書き込み専用3値（undefined=維持 / null=削除 / string=設定） */
  notify?: { discordEnabled?: boolean; discordWebhookUrl?: string | null; publicUrl?: string | null };
  /** ファビコンは画像なので別口（uploadFavicon / resetFavicon）。ここはサイト名だけ */
  branding?: { siteTitle?: string };
  setupDone?: boolean;
}

/** 既読時刻をサーバへ送る（2026-08-02 localStorage から移行。PC で読んだノードが
 *  スマホでは全部未読になっていたため）。未読は補助機能なので失敗は握り潰す＝
 *  投げっぱなしでよく、呼び出し側は await しない */
export function postReads(marks: Record<string, string>): void {
  void request<{ reads: Record<string, string> }>("/reads", {
    method: "POST",
    body: JSON.stringify({ marks }),
  }).catch(() => {
    // 無視（次に開いたときの mark でまた進む）
  });
}

/** 自分の操作に伴う機械の記録メッセージ（状態遷移・試走結果等）で未読バッジが
 *  付かないよう、操作したノードを少し先の時刻まで既読扱いにする（2026-07-31 本人指摘
 *  「完了を自分で押した奴は青バッジ通知来なくていい」）。5秒のマージンは操作の直後に
 *  サーバ/エンジンが書く記録を吸収するため——Task AI の応答（〜10秒以降）は吸収せず
 *  ちゃんと未読になる */
function markSelfActionRead(key: string): void {
  postReads({ [key]: new Date(Date.now() + 5000).toISOString() });
}

/** ノードに対する操作系APIの後処理: 成功したら既読マークを打つ */
async function withSelfRead<T>(key: string, p: Promise<T>): Promise<T> {
  const result = await p;
  markSelfActionRead(key);
  return result;
}

/** GET /api/me の形（displayName は 2026-08-04 チーム化で追加、admin は同日のアカウント管理で追加） */
export interface Me {
  email: string | null;
  displayName: string | null;
  /** 管理者か。ユーザー管理UIの表示ゲート（サーバ側でも当然に検査される） */
  admin: boolean;
  authRequired: boolean;
}

/** GET /api/users の1件（登録ユーザーのロスター。ログイン無し運用では空配列） */
export interface TeamUser {
  email: string;
  displayName: string | null;
  admin: boolean;
  /** 無効化（Linear の Suspend 相当）。ログイン不可 + 新規の割当候補に出さない。
   *  既に assignee/members に入っている分の表示名解決は従来どおり効く */
  disabled: boolean;
  /** Discord のユーザーID（あなたの番のメンション通知用。未登録は null） */
  discordId: string | null;
}

export const api = {
  // ---- 内蔵ログイン（サーバ auth.ts。users.json にユーザーが居る運用でのみ authRequired=true） ----

  getMe: () => request<Me>("/me"),

  /** 登録ユーザーのロスター（チーム化 2026-08-04）。補助情報なので失敗はトーストせず
   *  空配列へ degrade する（旧サーバ 404 互換。人系UIが出なくなるだけ） */
  getUsers: async (): Promise<{ users: TeamUser[] }> => {
    try {
      const res = await fetch("/api/users", { headers: { "Content-Type": "application/json" } });
      if (!res.ok) return { users: [] };
      const data = (await res.json()) as { users?: Partial<TeamUser>[] };
      if (!Array.isArray(data.users)) return { users: [] };
      // admin/disabled フラグを持たない旧サーバ応答は false へ畳む（2026-08-04 アカウント管理）
      return {
        users: data.users
          .filter((u): u is Partial<TeamUser> & { email: string } => typeof u.email === "string")
          .map((u) => ({
            email: u.email,
            displayName: u.displayName ?? null,
            admin: !!u.admin,
            disabled: !!u.disabled,
            discordId: u.discordId ?? null,
          })),
      };
    } catch {
      return { users: [] };
    }
  },

  login: (email: string, password: string) =>
    request<{ email: string }>("/login", { method: "POST", body: JSON.stringify({ email, password }) }),

  logout: () => request<{ ok: boolean }>("/logout", { method: "POST", body: "{}" }),

  // ---- アカウント管理（2026-08-04。サーバ auth.ts / admin.ts） ----

  /** 自分のパスワード変更。成功時はサーバが新しいセッション Cookie を張り直す
   *  （リロード不要・ログアウトされない）。401=現パスワード違い、400=新パスワード8文字未満 */
  changePassword: (current: string, next: string) =>
    request<{ ok: boolean }>("/me/password", {
      method: "POST",
      body: JSON.stringify({ current, next }),
    }),

  /** admin: ユーザー追加。初期パスワードはこの応答で一度だけ返る（サーバに保存されない）。
   *  409=メール重複 */
  adminAddUser: (email: string, displayName?: string) =>
    request<{ email: string; password: string }>("/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, ...(displayName ? { displayName } : {}) }),
    }),

  /** admin: 表示名・admin・無効化・Discord ID の変更。400=自分自身の admin 剥奪・無効化 */
  adminPatchUser: (input: { email: string; displayName?: string; admin?: boolean; disabled?: boolean; discordId?: string | null }) =>
    request<{ ok: boolean }>("/admin/users/patch", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** admin: パスワードリセット。新パスワードはこの応答で一度だけ返る */
  adminResetPassword: (email: string) =>
    request<{ email: string; password: string }>("/admin/users/reset-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  /** Discord 通知のテスト送信（保存済み Webhook URL で1通送る。設定画面の「テスト送信」） */
  testNotify: () =>
    request<{ ok: boolean; error?: string }>("/notify/test", { method: "POST", body: "{}" }),

  // threadMeta: ノードごとの最終メッセージ時刻 / reads: ノードごとの既読時刻。
  // この2つの突き合わせが未読判定（どちらもサーバ持ち＝端末間で一致する）
  getState: (opts: { silent?: boolean } = {}) =>
    request<{
      nodes: Node[];
      threadMeta: Record<string, string>;
      reads: Record<string, string>;
      now: string;
    }>("/state", { silent: opts.silent }),

  addNode: (input: NodeCreateInput) =>
    request<Node>("/nodes", { method: "POST", body: JSON.stringify(input) }),

  patchNode: (id: string, patch: NodePatchInput) =>
    withSelfRead(id, request<Node>(`/nodes/${id}`, { method: "POST", body: JSON.stringify(patch) })),

  /** 手順書のインライン本文をワークスペース内ファイルへ書き出し、impl を path 参照に切り替える */
  implToFile: (id: string, filePath: string, opts: { overwrite?: boolean } = {}) =>
    withSelfRead(id, request<{ ok: boolean; path: string }>(`/nodes/${id}/impl/to-file`, {
      method: "POST",
      body: JSON.stringify({ path: filePath, ...(opts.overwrite ? { overwrite: true } : {}) }),
    })),

  removeNode: (id: string, opts: { force?: boolean; silent?: boolean } = {}) =>
    request<{ removed: boolean }>(`/nodes/${id}/remove`, {
      method: "POST",
      body: JSON.stringify(opts.force ? { force: true } : {}),
      silent: opts.silent,
    }),

  /** 「ノード内ノードに展開」（実行の内訳 payload.subSteps を素材に、このノードを実ノード連鎖へ
   *  置き換える）。messageId は展開元の実行成功/失敗の status メッセージ。元ノードは消えるので
   *  既読マーク（withSelfRead）はしない——消えた id への既読は意味を持たない */
  expandNode: (id: string, messageId: string) =>
    request<{ created: string[] }>(`/nodes/${id}/expand`, {
      method: "POST",
      body: JSON.stringify({ messageId }),
    }),

  // ---- スクリプト試走（試走ゲート。docs/design.md 3.5 近く。実装は packages/server/src/trial.ts） ----

  trialNode: (id: string) =>
    withSelfRead(id, request<{
      success: boolean;
      exitCode: number | null;
      output: string;
      implTrial: ImplTrial | null;
      /** 実際に実行した実コマンド（パラメータ置換後 + --dry-run。docs/design.md 3.5.1） */
      resolvedCommand: string;
    }>(`/nodes/${id}/trial`, { method: "POST", body: "{}" })),

  /** aiBusy: Task AI が応答生成中か（「考え中」表示用。GraphWrangler AI と挙動を揃える）。
   *  aiQueued: 応答中に書いた送信予約を受けて、終わり次第もう一度応答する予約があるか */
  /** runId を渡すと**そのランの会話・実行記録だけ**を返す（2026-08-08「会話や実行履歴も
   *  フォーク」）。省略/null はテンプレート（設計図）側の会話だけ */
  getThread: (id: string, runId?: string | null, opts: { silent?: boolean } = {}) =>
    request<{ messages: MaterializedMessage[]; aiBusy?: boolean; aiQueued?: boolean }>(
      runId ? `/nodes/${id}/thread?run=${encodeURIComponent(runId)}` : `/nodes/${id}/thread`,
      { silent: opts.silent },
    ),

  /** Task AI の応答を止める（2026-08-05）。予約されていた送信予約の再応答も取り消す */
  stopThreadAi: (id: string, runId?: string | null) =>
    request<{ stopped: boolean }>(`/nodes/${id}/thread-ai/cancel`, {
      method: "POST",
      body: JSON.stringify({ runId: runId ?? null }),
    }),

  postMessage: (id: string, body: string, runId?: string | null) =>
    // 自分の投稿で自分に未読が付かないようにする既読マークも、会話の単位（ラン）で打つ
    withSelfRead(threadKey(id, runId), request<Message>(`/nodes/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ kind: "say", body, runId: runId ?? null }),
    })),

  /** 「新しい会話」区切り（payload.chatBreak）。区切りも会話の単位（そのラン / テンプレート）に
   *  属するので、ランのページから押したときは runId を渡してそのランのスレッドへ打つ */
  postChatBreak: (id: string, runId?: string | null) =>
    withSelfRead(threadKey(id, runId), request<Message>(`/nodes/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        kind: "status",
        body: "―― 新しい会話 ――",
        payload: { chatBreak: true },
        runId: runId ?? null,
      }),
    })),

  answer: (id: string, requestId: string, option: string | null, note: string | null = null) =>
    withSelfRead(id, request<{ message: Message; resolved: boolean; node: Node }>(`/nodes/${id}/answer`, {
      method: "POST",
      body: JSON.stringify({ requestId, option, note }),
    })),

  // ---- 分岐ノード（kind=decision。docs/design.md 3.9） ----

  /** プロジェクト層: choice確定+skip伝搬。UIから直接叩く経路も正（human分岐の判断リクエスト経由と並立） */
  decide: (id: string, choice: string) =>
    withSelfRead(id, request<Node>(`/nodes/${id}/decide`, { method: "POST", body: JSON.stringify({ choice }) })),

  /** プロジェクト層: 分岐の選び直し（choice取り消し + このskip伝搬の復元。下流のdoneは戻らない） */
  revertDecision: (id: string) =>
    withSelfRead(id, request<Node>(`/nodes/${id}/decide/revert`, { method: "POST", body: "{}" })),

  /** ラン層: ワークアイテム(kind=decisionテンプレート)のchoice確定+skip伝搬 */
  decideRunItem: (runId: string, nodeId: string, choice: string) =>
    withSelfRead(threadKey(nodeId, runId), request<Run>(`/runs/${runId}/items/${nodeId}/decide`, {
      method: "POST",
      body: JSON.stringify({ choice }),
    })),

  // ---- トリガーノード（kind=trigger。docs/design.md 3.4/3.8/3.9） ----

  /** トリガーからランを1本作り、そのページ(group)へ置く。title はランの名前（作品名など。
   *  並列ランの区別用）。via 省略時はサーバ既定の "manual"。context はランの初期コンテキスト
   *  （docs/design.md 3.15。ラン作成フォームの入力。空欄のキーは呼び出し側が落として渡す） */
  runTrigger: async (
    nodeId: string,
    opts: { via?: string; title?: string; context?: Record<string, string> } = {},
  ) => {
    const run = await request<Run>(`/nodes/${nodeId}/run`, {
      method: "POST",
      body: JSON.stringify(opts),
    });
    // 「ラン: <ラン名>」の記録は生まれたランのスレッドに載る。自分の操作なので既読にしておく
    markSelfActionRead(threadKey(nodeId, run.id));
    return run;
  },

  // ---- ルーティーンページ: ラン（実行インスタンス。docs/design.md 3.8） ----

  listRuns: (pageId: string, opts: { silent?: boolean } = {}) =>
    request<{ runs: Run[] }>(`/pages/${pageId}/runs`, { silent: opts.silent }),

  /** 全ページのラン一覧を1リクエストで（ページ id → ラン配列。新しい順）。左レール用。
   *  ラン作成時のスナップショットはサーバ側で落とされている（2026-08-08 最適化） */
  listAllRuns: (opts: { silent?: boolean } = {}) =>
    request<{ runs: Record<string, Run[]> }>("/runs/summary", { silent: opts.silent }),

  patchRunItem: (runId: string, nodeId: string, input: { status?: RunItemStatus; note?: string | null }) =>
    // 進捗の記録はそのランのスレッドに載るので、既読もそのランのキーで打つ
    withSelfRead(threadKey(nodeId, runId), request<Run>(`/runs/${runId}/items/${nodeId}`, { method: "POST", body: JSON.stringify(input) })),

  renameRun: (runId: string, title: string) =>
    request<Run>(`/runs/${runId}/rename`, { method: "POST", body: JSON.stringify({ title }) }),

  cancelRun: (runId: string) =>
    request<Run>(`/runs/${runId}/cancel`, { method: "POST", body: "{}" }),

  getRunTrace: (runId: string, opts: { silent?: boolean } = {}) =>
    request<{ events: TraceEvent[] }>(`/runs/${runId}/trace`, { silent: opts.silent }),

  /** ランのコンテキストへ merge（docs/design.md 3.15 実行時の書き）。nodeId を渡すと
   *  「コンテキスト更新: …」の status がそのノードのスレッド（このラン）へ積まれる
   *  （human 完了ミニフォームからの書きは完了するノードを渡す）。更新後の Run が返る */
  patchRunContext: (
    runId: string,
    set: Record<string, string>,
    opts: { nodeId?: string; via?: string } = {},
  ) =>
    request<Run>(`/runs/${runId}/context`, {
      method: "POST",
      body: JSON.stringify({
        set,
        ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
        ...(opts.via ? { via: opts.via } : {}),
      }),
    }),

  /** 配線チェック（docs/design.md 3.15。ルーティーンページの参照矢印と警告バッジ）。
   *  補助表示なので失敗はトーストせず null へ degrade する（旧サーバ 404 互換。
   *  呼び出し側は「静かに描かない」——コンソール警告だけ残す） */
  getPageWiring: async (
    pageId: string,
  ): Promise<{ references: WiringReference[]; warnings: WiringWarning[] } | null> => {
    try {
      const res = await fetch(`/api/pages/${pageId}/wiring`, {
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        console.warn(`配線チェックの取得に失敗しました (HTTP ${res.status})`);
        return null;
      }
      const data = (await res.json()) as {
        references?: WiringReference[];
        warnings?: WiringWarning[];
      };
      return {
        references: Array.isArray(data.references) ? data.references : [],
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
      };
    } catch (e) {
      console.warn("配線チェックの取得に失敗しました", e);
      return null;
    }
  },

  /** そのランの時点のノード（2026-08-08）。ラン作成時に焼いたスナップショット、無ければ
   *  操作ログの再生、それも無ければ現在の中身。どれを使ったかは各ノードの source に入る */
  getRunGraph: (runId: string, opts: { silent?: boolean } = {}) =>
    request<{ runId: string; at: string; nodes: RunGraphNode[] }>(`/runs/${runId}/graph`, {
      silent: opts.silent,
    }),

  // ---- 元に戻す / やり直す（操作ログの補償追記） ----

  undo: () => request<{ undone: { id: string; op: string; ts: string } }>("/undo", {
    method: "POST",
    body: "{}",
  }),

  redo: () => request<{ redone: { id: string; op: string; ts: string } }>("/redo", {
    method: "POST",
    body: "{}",
  }),

  // ---- エンジン稼働インジケータ ----

  getEngineStatus: (opts: { silent?: boolean } = {}) =>
    request<{ alive: boolean; lastSeen: string | null }>("/engine/status", { silent: opts.silent }),

  // ---- AI設定 ----

  getSettings: () => request<SettingsView>("/settings"),

  updateSettings: (patch: SettingsPatch) =>
    request<SettingsView>("/settings", { method: "POST", body: JSON.stringify(patch) }),

  // ---- ブランディング（2026-08-08。サイト名は上の updateSettings、画像だけここ） ----

  /** ファビコンの差し替え。PNG / SVG のみ・512KB まで（判定はサーバが中身で行う）。
   *  成功すると faviconVersion が上がるので、呼び出し側は refreshBranding() で反映する */
  uploadFavicon: async (file: File): Promise<{ faviconVersion: number }> => {
    const form = new FormData();
    form.append("file", file);
    let res: Response;
    try {
      res = await fetch("/api/branding/favicon", { method: "POST", body: form });
    } catch {
      const msg = "サーバに接続できません";
      pushToast(msg, "error");
      throw new ApiError(msg);
    }
    const data = (await res.json().catch(() => null)) as {
      faviconVersion?: number;
      error?: string;
    } | null;
    if (!res.ok) {
      const msg = data?.error ?? `HTTP ${res.status}`;
      pushToast(msg, "error");
      throw new ApiError(msg);
    }
    return { faviconVersion: data?.faviconVersion ?? 0 };
  },

  /** 手置きのファビコンを消して同梱の既定へ戻す */
  resetFavicon: () =>
    request<{ faviconVersion: number }>("/branding/favicon/reset", { method: "POST", body: "{}" }),

  // ---- ユーザーごとの設定（2026-08-07「設定はユーザーごとと全体で分けて」） ----

  getMySettings: () => request<UserSettings>("/me/settings"),

  updateMySettings: (patch: Partial<UserSettings>) =>
    request<UserSettings>("/me/settings", { method: "PUT", body: JSON.stringify(patch) }),

  // ---- ワークスペース情報（手順書パスの GitHub リンク等） ----

  getWorkspaceInfo: () =>
    request<{ mode: string; root: string | null; githubBlobBase: string | null }>("/workspace"),

  // ---- 本体の自動アップデート（packages/server/src/selfupdate.ts。2026-08-05） ----
  // 更新の有無はヘッダーの表示にも使うので、取得失敗はトーストせず null へ degrade する
  // （古いサーバには /api/update が無い＝404 になるため）

  getUpdate: async (): Promise<UpdateStatus | null> => {
    try {
      const res = await fetch("/api/update", { headers: { "Content-Type": "application/json" } });
      if (!res.ok) return null;
      return (await res.json()) as UpdateStatus;
    } catch {
      return null;
    }
  },

  /** 今すぐ origin を見に行く（取り込みはしない） */
  checkUpdate: () => request<UpdateStatus>("/update/check", { method: "POST", body: "{}" }),

  /** 今すぐ取り込む。監視下（systemd/pm2）ならサーバはこの直後に再起動する */
  runUpdate: () =>
    request<{ ok: boolean; updated: boolean; message: string; status: UpdateStatus }>("/update/run", {
      method: "POST",
      body: "{}",
    }),
};
