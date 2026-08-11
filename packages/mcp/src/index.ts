#!/usr/bin/env node
// GraphWrangler MCP サーバ。stdio トランスポートで待ち受け、実体は
// GraphWrangler HTTP API（既定 http://localhost:8770、env GRAPHWRANGLER_URL で変更可）への薄いプロキシ。
// 全書き込みは via:"mcp" / actor:{kind:"agent",name:"mcp"} を付けて送る。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { apiGet, apiPost, ApiError } from "./http.js";
import {
  DecisionRequestSchema,
  NodeBranchSchema,
  NodeImplSchema,
  NodePatchShape,
  NodeKindSchema,
  ExecutorSchema,
  AutonomySchema,
  LifecycleSchema,
  StatusSchema,
  RunItemStatusSchema,
  OutputParamSchema,
} from "./schemas.js";

const MCP_ACTOR = { kind: "agent" as const, name: "mcp" };
const MCP_VIA = "mcp";

/** 書き込み系リクエストの body に共通の帰属情報を付与する */
function withMeta(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, actor: MCP_ACTOR, via: MCP_VIA };
}

type NodeSummary = {
  id: unknown;
  title: unknown;
  kind: unknown;
  executor: unknown;
  status: unknown;
  approval: unknown;
  lifecycle: unknown;
  group: unknown;
  parents: unknown;
  pendingRequest: unknown;
  createdBy: unknown;
  assignee: unknown;
};

/** ノード1件から要約フィールドだけを抜き出す（detail/impl は含めない = トークン節約） */
function summarize(node: Record<string, unknown>): NodeSummary {
  return {
    id: node.id,
    title: node.title,
    kind: node.kind,
    executor: node.executor,
    status: node.status,
    approval: node.approval,
    lifecycle: node.lifecycle,
    group: node.group,
    parents: node.parents,
    pendingRequest: node.pendingRequest,
    createdBy: node.createdBy,
    assignee: node.assignee,
  };
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof ApiError ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

/** ツールハンドラを HTTP 呼び出しでラップし、ApiError を isError の CallToolResult に変換する。
 *  プロセスは落とさない。 */
function safe<Args extends unknown[], T>(fn: (...args: Args) => Promise<T>) {
  return async (...args: Args) => {
    try {
      const result = await fn(...args);
      return textResult(result);
    } catch (err) {
      return errorResult(err);
    }
  };
}

const server = new McpServer({
  name: "graphwrangler",
  version: "0.1.0",
});

// ---- 1. state_get ----

server.registerTool(
  "state_get",
  {
    description:
      "グラフ全体の要約を取得する。ノード数、ページ（kind=goalのノード、または他ノードのgroupとして参照されている=メンバーを持つノード）の一覧、" +
      "各ノードの {id,title,kind,executor,status,approval,lifecycle,group,parents,pendingRequest,createdBy,assignee} を返す。" +
      "detail/impl は含まない（トークン節約のため）。特定ノードの全フィールドが必要なら node_get を使うこと。",
    inputSchema: {},
  },
  safe(async () => {
    const state = (await apiGet("/api/state")) as { nodes: Record<string, unknown>[]; now: string };
    const nodes = state.nodes ?? [];
    const groupIds = new Set(nodes.map((n) => n.group).filter((g): g is string => typeof g === "string"));
    const pages = nodes
      .filter((n) => n.kind === "goal" || groupIds.has(n.id as string))
      .map((n) => ({ id: n.id, title: n.title, kind: n.kind }));
    return {
      now: state.now,
      nodeCount: nodes.length,
      pages,
      nodes: nodes.map(summarize),
    };
  }),
);

// ---- 2. node_get ----

server.registerTool(
  "node_get",
  {
    description: "指定した1ノードの全フィールド（detail/impl を含む）を取得する。ノードidは state_get の一覧から得る。",
    inputSchema: { nodeId: z.string().describe("取得したいノードのid") },
  },
  // GET /api/nodes/:id は GET /api/state の nodes 要素と同じ形（同じ Node）を返す。
  // 存在しないidはサーバが 404 の {error:"node not found: <id>"} を返し、http.ts が
  // ApiError にする（＝ここで見つからない判定を持たなくてよい）
  safe(async ({ nodeId }: { nodeId: string }) => apiGet(`/api/nodes/${encodeURIComponent(nodeId)}`)),
);

// ---- 3. node_add ----

server.registerTool(
  "node_add",
  {
    description:
      "新しいノードを作成する。title以外は省略可でサーバ側の既定値が使われる" +
      "（kind=task, executor=human, approval=false, lifecycle=draft, status=pending）。" +
      "group は所属ページ(ゴール)のノードid。ページ直下に作るならそのゴールノードのidを渡す（省略時はどのページにも属さない）。" +
      "parents は先行ノードid（依存/順序、DAG）。impl は実装形態: null=会話段（AIの裁量）、" +
      "{type:'doc',text}=手順書、{type:'script',command}=決定的スクリプト。" +
      "executor=human の担当者は assignee（メール）で指定する。",
    inputSchema: {
      title: z.string().min(1).describe("人間粒度の作業名"),
      detail: z.string().nullable().optional().describe("補足・文脈"),
      kind: NodeKindSchema.optional().describe(
        "goal=プロジェクトページ(ルート意図) / task=作業 / decision=分岐ノード(branchesが必要) / " +
          "trigger=起点ノード(parentsを持てない。schedule+executorでラン作成の方式を決める。作成は " +
          "trigger_run)。既定 task",
      ),
      executor: ExecutorSchema.optional().describe("誰にディスパッチするか。既定 human"),
      approval: z.boolean().optional().describe("実行前承認。true=実行の直前に人間の承認ゲートを通す（不可逆な外部副作用がある作業など）。既定 false"),
      autonomy: AutonomySchema.optional().describe(
        "AI executor の自律度。high=人間に判断を仰がず進む（失敗も自動リトライ）/ " +
          "normal=必要なときだけ QUESTION 形式で質問 / low=迷ったら質問に倒す。既定 normal",
      ),
      aiModel: z.string().nullable().optional().describe(
        "このノードのAI（実行AI・Task AI）が使うモデルの上書き（例: opus/sonnet/haiku）。null=設定の既定",
      ),
      aiEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional().describe(
        "同エフォート（思考の深さ）。null=設定の既定",
      ),
      lifecycle: LifecycleSchema.optional().describe("draft=審議中/committed=実行対象。既定 draft"),
      status: StatusSchema.optional().describe("既定 pending。unplanned=やり方未定"),
      parents: z.array(z.string()).optional().describe("先行ノードid配列。空=ルート"),
      parentOptions: z.record(z.string(), z.string()).optional().describe(
        "どの親decisionのどの枝から生えるか（親decisionId→枝id）。キーは parents に含まれる " +
          "kind=decision のノード、値はその branches の選択肢id。既定 {}",
      ),
      group: z.string().nullable().optional().describe("所属ページ(ゴール)のノードid。ページ直下に作るならそのidを渡す"),
      branches: z.array(NodeBranchSchema).nullable().optional().describe(
        "kind=decision の選択肢一覧 [{id,label,then?}]（最低2個。elseなし・単一選択）。decision 以外では null",
      ),
      schedule: z.string().nullable().optional().describe(
        "kind=trigger 用の起動方式（\"every 15m\" / \"daily 09:00\" / \"weekly mon 09:00\" 等の自由文字列）。" +
          "executor=script ならcron的なラン作成判定、executor=ai なら判定間隔として使う。既定 null",
      ),
      fixed: z.boolean().optional().describe(
        "Fixフラグ（ロック）。true=やり方が確定し、AIは impl を書き換えない。既定 false",
      ),
      impl: NodeImplSchema.optional().describe(
        "実装形態。null=会話段、{type:'doc',text}=手順書、{type:'script',command}=シェルコマンド",
      ),
      assignee: z.string().nullable().optional().describe(
        "担当者のメール。executor=human で「人間の誰がやるか」。null=未割当（全員宛）。既定 null",
      ),
      members: z.array(z.string()).optional().describe(
        "ページの関係者のメール配列。ページ（kind=goal / メンバー持ち）でのみ意味を持つ。既定 []",
      ),
      outputs: z.array(OutputParamSchema).nullable().optional().describe(
        "ランのコンテキストへの出力宣言 [{name, label?, example?}]（design.md 3.15）。" +
          "trigger ではラン作成フォームの項目 / 検知スクリプトの emit 契約になる。既定 null",
      ),
    },
  },
  safe(async (input: Record<string, unknown>) => apiPost("/api/nodes", withMeta(input))),
);

// ---- 4. node_patch ----

server.registerTool(
  "node_patch",
  {
    description:
      "既存ノードを部分更新する。patch には変えたいフィールドだけを渡す（title/detail/impl/parents/group/kind/" +
      "executor/approval/autonomy/aiModel/aiEffort/lifecycle/status/fixed/pendingRequest/assignee/members の部分集合。" +
      "assignee=担当者メール（null=未割当）、members=ページの関係者メール配列。createdBy は不変の記録なので patch 不可）。更新後のノードを返す。",
    inputSchema: {
      nodeId: z.string().describe("更新対象のノードid"),
      patch: z.object(NodePatchShape).describe("変更したいフィールドだけを含む部分オブジェクト"),
    },
  },
  safe(async ({ nodeId, patch }: { nodeId: string; patch: Record<string, unknown> }) =>
    apiPost(`/api/nodes/${encodeURIComponent(nodeId)}`, withMeta(patch)),
  ),
);

// ---- 5. node_remove ----

server.registerTool(
  "node_remove",
  {
    description:
      "ノードを削除する。既定では子ノード・メンバー持ち・Fix済みの場合は失敗する。" +
      "force=true で全部消す（メンバーは巻き添え削除、残る子は依存から切り離し。" +
      "人間の確認を取ってから使うこと）。",
    inputSchema: {
      nodeId: z.string().describe("削除するノードid"),
      force: z.boolean().optional().describe("Fix済み・メンバー持ち・子持ちでも消す"),
    },
  },
  safe(async ({ nodeId, force }: { nodeId: string; force?: boolean }) =>
    apiPost(`/api/nodes/${encodeURIComponent(nodeId)}/remove`, withMeta(force ? { force: true } : {})),
  ),
);

// ---- 6. thread_get ----

server.registerTool(
  "thread_get",
  {
    description: "指定ノードのスレッド（会話・判断リクエスト・実行ログ・成果物が時系列に並ぶ）のメッセージ一覧を取得する。",
    inputSchema: { nodeId: z.string().describe("対象ノードid") },
  },
  safe(async ({ nodeId }: { nodeId: string }) => apiGet(`/api/nodes/${encodeURIComponent(nodeId)}/thread`)),
);

// ---- 7. message_post ----

server.registerTool(
  "message_post",
  {
    description:
      "ノードのスレッドにメッセージを投稿する。kind: say=通常の発言（既定）、status=実行ログ、artifact=成果物への参照。" +
      "判断を仰ぎたい場合はこれではなく request_open を使うこと。",
    inputSchema: {
      nodeId: z.string().describe("投稿先ノードid"),
      kind: z.enum(["say", "status", "artifact"]).optional().describe("メッセージ種別。既定 say"),
      body: z.string().min(1).describe("本文"),
      payload: z.unknown().optional().describe("kind固有の追加データ（artifactの参照先など）"),
    },
  },
  safe(async ({ nodeId, ...rest }: { nodeId: string; [key: string]: unknown }) =>
    apiPost(`/api/nodes/${encodeURIComponent(nodeId)}/messages`, withMeta(rest)),
  ),
);

// ---- 8. request_open ----

server.registerTool(
  "request_open",
  {
    description:
      "人間への構造化された判断リクエストを開く。ノードの pendingRequest がセットされる（=ボールが人間に渡る。UIは「あなたの番」表示になる）。" +
      "context は3行以内・専門用語禁止でゴールの言葉での要約（文脈税）。options は2〜4個、各選択肢に" +
      "「選ぶと何が起きるか(then)」を必ず書く。impact はこの判断自体の影響、undo は戻し方（無ければnull）。" +
      "同一ノードに既に open なリクエストがある場合は失敗する。",
    inputSchema: {
      nodeId: z.string().describe("判断を仰ぐノードid"),
      request: DecisionRequestSchema.describe(
        "{context, question, options:[{id,label,then,recommended?}], impact, undo?}",
      ),
    },
  },
  safe(async ({ nodeId, request }: { nodeId: string; request: unknown }) =>
    apiPost(`/api/nodes/${encodeURIComponent(nodeId)}/request`, withMeta({ request })),
  ),
);

// ---- 9. request_answer ----

server.registerTool(
  "request_answer",
  {
    description:
      "開いている判断リクエストに回答する。option に選択肢idを渡すと決着し、ノードの pendingRequest が解けて status が pending に戻る（=エンジンが再び拾える）。" +
      "option を null にすると選択肢を選ばず自由文(note)で返す＝ラリー継続（リクエストはopenのまま）。",
    inputSchema: {
      nodeId: z.string().describe("対象ノードid"),
      requestId: z.string().describe("回答対象の decision_request メッセージid"),
      option: z.string().nullable().describe("選ぶ選択肢のid。null=選ばずラリー継続"),
      note: z.string().nullable().optional().describe("自由文の補足（ラリー時は実質必須）"),
    },
  },
  safe(async ({ nodeId, ...rest }: { nodeId: string; [key: string]: unknown }) =>
    apiPost(`/api/nodes/${encodeURIComponent(nodeId)}/answer`, withMeta(rest)),
  ),
);

// ---- 10. trigger_run ----
// トリガーノード（kind=trigger）から手動でランを1本作る。docs/design.md 3.4/3.8/3.9。
// run=ページから生成される1回分の実行インスタンス（ワークアイテムごとに進捗状態を持つ）。

server.registerTool(
  "trigger_run",
  {
    description:
      "トリガーノード（kind=trigger）から手動でランを1本作り、その group（所属ページ）へ置く。" +
      "対象ノードが kind=trigger でない、または group（所属ページ）が無い場合は失敗する。" +
      "ワークアイテムはトリガーの子孫（parentsを辿って到達可能なメンバー。lifecycleを問わず" +
      "items に入るが、実行されるのは lifecycle=committed のみ）。" +
      "context はこのランの初期コンテキスト（ランのコンテキスト。3.15）。トリガーの outputs 宣言が" +
      "ラン作成フォームの項目/emit契約に相当し、そこで挙がっているキーを渡すとよいが必須ではない" +
      "（空でもランは作れる。値は下流のノードが確定させる設計もあるため）。作成されたランを返す" +
      "（run.context に反映される）。",
    inputSchema: {
      nodeId: z.string().describe("ランを作るトリガーノードid（kind=trigger）"),
      via: z.string().min(1).optional().describe("ラン作成の理由の自由文字列（run.trigger に刻まれる）。省略時は \"mcp\""),
      context: z
        .record(z.string(), z.string())
        .optional()
        .describe("このランの初期コンテキスト（キー→値）。省略時は空。ランの進行中に run_context_set で書き足せる"),
    },
  },
  // via はここでは帰属情報ではなく「ラン作成の理由」（run.trigger の第3要素）。
  // 呼び出し側の指定が withMeta の既定 "mcp" より優先される
  safe(async ({ nodeId, via, ...rest }: { nodeId: string; via?: string; [key: string]: unknown }) =>
    apiPost(`/api/nodes/${encodeURIComponent(nodeId)}/run`, {
      ...withMeta(rest),
      ...(via !== undefined ? { via } : {}),
    }),
  ),
);

// ---- 11. run_context_set ----
// ランのコンテキスト（docs/design.md 3.15）への書き込み口。POST /api/runs/:id/context は
// merge（last-write-wins）。DAG の順序（producer が consumer の祖先）が事実上の書き順を決める。

server.registerTool(
  "run_context_set",
  {
    description:
      "ランのコンテキスト（run.context。3.15）を更新する。set の各キーを現在の run.context へ" +
      "merge する（同一ラン内は last-write-wins。テンプレートには書き戻さない＝このランだけの値）。" +
      "nodeId を渡すとそのノードのスレッドへ、省略時は run.trigger から取り出したトリガーノードへ、" +
      "runId 付きで「コンテキスト更新: k=v, …」の status メッセージが積まれる（監査用）。" +
      "script executor が stdout に出す `##gw {\"set\":{...}}` マーカー行と同じ効果を持つ、" +
      "エンジン外（MCP・人間・外部システム）からの書き込み経路。更新後のラン全体を返す。",
    inputSchema: {
      runId: z.string().describe("対象のランid"),
      set: z.record(z.string(), z.string()).describe("run.context へ merge するキー→値"),
      nodeId: z
        .string()
        .optional()
        .describe("更新をどのノードのスレッドへ記録するか。省略時は run.trigger のトリガーノードへ記録する"),
    },
  },
  safe(async ({ runId, ...rest }: { runId: string; [key: string]: unknown }) =>
    apiPost(`/api/runs/${encodeURIComponent(runId)}/context`, withMeta(rest)),
  ),
);

// ---- 12. run_list ----

type RunItemLike = { status: string };
type RunSummaryLike = {
  id: unknown;
  title: unknown;
  status: unknown;
  trigger: unknown;
  created: unknown;
  context: unknown;
  items: Record<string, RunItemLike>;
};

server.registerTool(
  "run_list",
  {
    description:
      "指定したページの過去のラン一覧を要約で取得する（新しい順）。各ランは" +
      "{id,title,status,trigger,created,context} と itemCounts（ワークアイテムの状態別件数。" +
      "pending/running/waiting/done/dropped/skipped ごとの内訳のみ）を返す。context はそのランの" +
      "run.context（3.15。Record<string,string>）。個々のワークアイテムがどのノードで今どの状態か・" +
      "resolvedParams の詳細が必要なら run_get を使うこと。",
    inputSchema: { pageId: z.string().describe("対象のページid（state_get の pages から選ぶ）") },
  },
  safe(async ({ pageId }: { pageId: string }) => {
    const result = (await apiGet(`/api/pages/${encodeURIComponent(pageId)}/runs`)) as {
      runs: RunSummaryLike[];
    };
    return {
      runs: (result.runs ?? []).map((r) => {
        const itemCounts: Record<string, number> = {};
        for (const item of Object.values(r.items ?? {})) {
          itemCounts[item.status] = (itemCounts[item.status] ?? 0) + 1;
        }
        return {
          id: r.id,
          title: r.title,
          status: r.status,
          trigger: r.trigger,
          created: r.created,
          context: r.context ?? {},
          itemCounts,
        };
      }),
    };
  }),
);

// ---- 13. run_get ----

server.registerTool(
  "run_get",
  {
    description:
      "ラン1件の全フィールドを取得する: procedure(属するページのid)・title・trigger・status(running/done/cancelled)・" +
      "items（テンプレートノードid→{status,note,choice,resolvedParams}の全件。resolvedParams は script" +
      "実行時に解決された{name:値}で未実行なら null）・context（run.context。3.15。Record<string,string>。" +
      "ラン作成時の初期値+ノードが書き足した現在値）・created。snapshot（ラン作成時点のページ構成）は" +
      "{capturedAt,nodeCount} の要約のみ返す（トークン節約のため。null=この機能より前のラン）。" +
      "runId は run_list / trigger_run から得る。",
    inputSchema: { runId: z.string().describe("取得したいランid") },
  },
  safe(async ({ runId }: { runId: string }) => {
    const run = (await apiGet(`/api/runs/${encodeURIComponent(runId)}`)) as {
      snapshot?: { capturedAt: unknown; nodes?: unknown[] } | null;
      [key: string]: unknown;
    };
    // snapshot はページ構成まるごと（ページ自身+トリガー+全メンバーの中身）で重いため素通ししない。
    // 当時の中身が要るときはサーバの GET /api/runs/:id/graph が返す
    const { snapshot, ...rest } = run;
    return {
      ...rest,
      snapshot: snapshot
        ? { capturedAt: snapshot.capturedAt, nodeCount: snapshot.nodes?.length ?? 0 }
        : null,
    };
  }),
);

// ---- 14. run_item_patch ----

server.registerTool(
  "run_item_patch",
  {
    description:
      "ラン内の1ワークアイテム（ページのメンバーノード1件について、このランでの実行状態）を更新する。" +
      "status は pending/running/waiting/done/dropped/skipped のいずれか（省略可、note のみの更新も可）。" +
      "全アイテムが done/dropped/skipped のどれかに揃うとラン全体のstatusが自動的に done になる" +
      "（cancelled のランは覆らない）。対象ノードのスレッドに状態遷移が記録される。更新後のラン全体を返す。",
    inputSchema: {
      runId: z.string().describe("対象のランid"),
      nodeId: z.string().describe("更新するワークアイテムのノードid（ページのメンバー）"),
      status: RunItemStatusSchema.optional().describe("新しい状態"),
      note: z.string().nullable().optional().describe("補足メモ"),
    },
  },
  safe(async ({ runId, nodeId, ...rest }: { runId: string; nodeId: string; [key: string]: unknown }) =>
    apiPost(`/api/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(nodeId)}`, withMeta(rest)),
  ),
);

// ---- 15. run_cancel ----

server.registerTool(
  "run_cancel",
  {
    description:
      "実行中のランを中断する（status を cancelled にする）。中断後はワークアイテムが全部揃っても" +
      "自動では done に戻らない。取り消し操作はない（undo/redo の対象外＝ラン専用の操作ログには乗らない）。",
    inputSchema: { runId: z.string().describe("中断するランid") },
  },
  safe(async ({ runId }: { runId: string }) => apiPost(`/api/runs/${encodeURIComponent(runId)}/cancel`, withMeta({}))),
);

// ---- 16. run_trace ----

server.registerTool(
  "run_trace",
  {
    description:
      "ランのトレースを再生する。ページノード本体と全ワークアイテムのノードのスレッドから、そのラン" +
      "（payload.runId が一致）に紐づくメッセージだけを集め、時系列(ts昇順)で返す。各イベントに元メッセージの" +
      "全フィールド（kind/body/author/via/ts等）+ nodeTitle が付く（run_context_set やスクリプトの" +
      "##gw マーカーによる「コンテキスト更新: k=v, …」の status メッセージもここに乗る）。" +
      "「このランで何が起きたか」を後から追うのに使う。",
    inputSchema: { runId: z.string().describe("対象のランid") },
  },
  safe(async ({ runId }: { runId: string }) => apiGet(`/api/runs/${encodeURIComponent(runId)}/trace`)),
);

// ---- 17. undo ----

server.registerTool(
  "undo",
  {
    description:
      "直前のグラフ操作（node_add/node_patch/node_remove のいずれか1件）を取り消す。操作ログの過去行は" +
      "書き換えず、逆操作を追記することで実現する（補償）。戻せる操作が無い場合はエラーになる。ノードの" +
      "スレッド（message_post等）やラン(run_*)の操作は対象外＝グラフ本体の操作ログのみが対象。",
    inputSchema: {},
  },
  safe(async () => apiPost("/api/undo", withMeta({}))),
);

// ---- 18. redo ----

server.registerTool(
  "redo",
  {
    description:
      "直前に undo した操作を1件やり直す。undo していない場合や、undo後に別の操作を行っていた場合は" +
      "やり直せる操作が無くエラーになる。",
    inputSchema: {},
  },
  safe(async () => apiPost("/api/redo", withMeta({}))),
);

const transport = new StdioServerTransport();
await server.connect(transport);
