// graphwrangler サーバ API の薄いクライアント。エラーは {error:"..."} + 4xx/5xx を前提に、
// 拾ってトースト表示してから re-throw する（呼び出し側は catch して個別UIを止めるだけでよい）。
import type {
  ImplTrial,
  Message,
  MaterializedMessage,
  Node,
  Run,
  RunItemStatus,
  TraceEvent,
} from "../types";
import { pushToast } from "./toast";

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    const msg = "サーバに接続できません";
    pushToast(msg);
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
    pushToast(msg);
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
    /** GraphWrangler AI / Task AI（CLIモード）の --allowedTools に追記するツール。
     *  既定でフルセット（Bash 等）が許可済みのため、MCP ツール等を足す用途 */
    cliExtraTools: string[];
  };
  engine: {
    /** cli = ヘッドレスCLI(claude -p 等)を起動する / api = チャット側のAPIキーで直接呼ぶ */
    mode: "cli" | "api";
    cliPath: string;
    model: string;
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
  setupDone: boolean;
}

export interface SettingsPatch {
  chat?: {
    mode?: "api" | "cli";
    provider?: "anthropic" | "openai";
    model?: string | null;
    apiKey?: string | null;
    cliPath?: string;
    cliModel?: string;
    cliExtraTools?: string[];
  };
  engine?: {
    mode?: "cli" | "api";
    cliPath?: string;
    model?: string;
    extraArgs?: string[];
    cliExtraTools?: string[];
    apiModel?: string | null;
  };
  ai?: { addDirs?: string[] };
  git?: { autoPush?: boolean; intervalSec?: number; extraPaths?: string[] };
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
function markSelfActionRead(nodeId: string): void {
  postReads({ [nodeId]: new Date(Date.now() + 5000).toISOString() });
}

/** ノードに対する操作系APIの後処理: 成功したら既読マークを打つ */
async function withSelfRead<T>(nodeId: string, p: Promise<T>): Promise<T> {
  const result = await p;
  markSelfActionRead(nodeId);
  return result;
}

/** GET /api/me の形（displayName は 2026-08-04 チーム化で追加） */
export interface Me {
  email: string | null;
  displayName: string | null;
  authRequired: boolean;
}

/** GET /api/users の1件（登録ユーザーのロスター。ログイン無し運用では空配列） */
export interface TeamUser {
  email: string;
  displayName: string | null;
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
      const data = (await res.json()) as { users?: TeamUser[] };
      return { users: Array.isArray(data.users) ? data.users : [] };
    } catch {
      return { users: [] };
    }
  },

  login: (email: string, password: string) =>
    request<{ email: string }>("/login", { method: "POST", body: JSON.stringify({ email, password }) }),

  logout: () => request<{ ok: boolean }>("/logout", { method: "POST", body: "{}" }),

  // threadMeta: ノードごとの最終メッセージ時刻 / reads: ノードごとの既読時刻。
  // この2つの突き合わせが未読判定（どちらもサーバ持ち＝端末間で一致する）
  getState: () =>
    request<{
      nodes: Node[];
      threadMeta: Record<string, string>;
      reads: Record<string, string>;
      now: string;
    }>("/state"),

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

  removeNode: (id: string, opts: { force?: boolean } = {}) =>
    request<{ removed: boolean }>(`/nodes/${id}/remove`, {
      method: "POST",
      body: JSON.stringify(opts.force ? { force: true } : {}),
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

  /** aiBusy: Task AI が応答生成中か（「考え中」表示用。GraphWrangler AI と挙動を揃える） */
  getThread: (id: string) =>
    request<{ messages: MaterializedMessage[]; aiBusy?: boolean }>(`/nodes/${id}/thread`),

  postMessage: (id: string, body: string) =>
    withSelfRead(id, request<Message>(`/nodes/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ kind: "say", body }),
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
    withSelfRead(nodeId, request<Run>(`/runs/${runId}/items/${nodeId}/decide`, {
      method: "POST",
      body: JSON.stringify({ choice }),
    })),

  // ---- トリガーノード（kind=trigger。docs/design.md 3.4/3.8/3.9） ----

  /** トリガーを発火し、そのページ(group)でランを1本作る。title はランの名前（作品名など。
   *  並列ランの区別用）。via 省略時はサーバ既定の "manual" */
  fireTrigger: (nodeId: string, opts: { via?: string; title?: string } = {}) =>
    withSelfRead(nodeId, request<Run>(`/nodes/${nodeId}/fire`, {
      method: "POST",
      body: JSON.stringify(opts),
    })),

  // ---- ルーティーンページ: ラン（実行インスタンス。docs/design.md 3.8） ----

  listRuns: (pageId: string) => request<{ runs: Run[] }>(`/pages/${pageId}/runs`),

  getRun: (runId: string) => request<Run>(`/runs/${runId}`),

  patchRunItem: (runId: string, nodeId: string, input: { status?: RunItemStatus; note?: string | null }) =>
    withSelfRead(nodeId, request<Run>(`/runs/${runId}/items/${nodeId}`, { method: "POST", body: JSON.stringify(input) })),

  renameRun: (runId: string, title: string) =>
    request<Run>(`/runs/${runId}/rename`, { method: "POST", body: JSON.stringify({ title }) }),

  cancelRun: (runId: string) =>
    request<Run>(`/runs/${runId}/cancel`, { method: "POST", body: "{}" }),

  getRunTrace: (runId: string) => request<{ events: TraceEvent[] }>(`/runs/${runId}/trace`),

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

  getEngineStatus: () => request<{ alive: boolean; lastSeen: string | null }>("/engine/status"),

  // ---- AI設定 ----

  getSettings: () => request<SettingsView>("/settings"),

  updateSettings: (patch: SettingsPatch) =>
    request<SettingsView>("/settings", { method: "POST", body: JSON.stringify(patch) }),

  /**
   * 内蔵チャット（GraphWrangler AI）。UIMessageStream(SSE) の生 body を返す。パースは呼び出し側
   * (ChatDrawer) が行う — この関数は「api キー未設定 400」だけをエラーとして解釈する。
   */
  chatStream: async (
    messages: unknown[],
    pageId: string | null,
    selectedNodeId?: string | null,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> => {
    let res: Response;
    try {
      res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, pageId, selectedNodeId: selectedNodeId ?? null }),
        signal,
      });
    } catch {
      throw new ApiError("サーバに接続できません");
    }
    if (!res.ok) {
      const text = await res.text();
      let msg = `HTTP ${res.status}`;
      try {
        const data = JSON.parse(text);
        if (data && typeof data.error === "string") msg = data.error;
      } catch {
        /* JSONでなければ既定メッセージのまま */
      }
      throw new ApiError(msg);
    }
    if (!res.body) throw new ApiError("ストリームを取得できません");
    return res.body;
  },
};
