// 内蔵チャット（グラフ整理の Workflow AI）。
// Vercel AI SDK の streamText + tool-calling を使い、AIは人間のUI操作と同じ書き込み経路
// （GraphStore/ThreadStore を直接呼ぶ）でグラフを変更する。帰属は via:"chat" /
// actor:{kind:"agent", name:"chat:<model>"} に統一する（docs/design.md 3.2）。
// このエンドポイント自体はステートレス（クライアントが毎回全履歴を送る）。会話履歴の保存は
// 別ルート（GET/PUT /api/chats/:pageId → sidecar または dataDir の chats/）が担う
// （2026-07-31 に localStorage からサーバ保存へ移行。docs/design.md 2章のストレージ図）。
import fs from "node:fs";
import { streamText, generateText, stepCountIs, convertToModelMessages, tool, type UIMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import type { SettingsStore } from "./settings.js";
import { resolveWorkspacePath } from "./files.js";
import {
  GraphStore,
  ThreadStore,
  NodeKindSchema,
  ExecutorSchema,
  ImpactSchema,
  LifecycleSchema,
  StatusSchema,
  type Actor,
  type Node,
} from "@graphwrangler/core";

const VIA = "chat";

// 設定（settings.json）→ 環境変数（GW_CHAT_PROVIDER / GW_CHAT_MODEL / 各APIキー）の順で解決
function provider(settings: SettingsStore): "anthropic" | "openai" {
  if (settings.get().chat.provider) return settings.get().chat.provider;
  return process.env.GW_CHAT_PROVIDER === "openai" ? "openai" : "anthropic";
}

function modelId(settings: SettingsStore): string {
  const configured = settings.get().chat.model;
  if (configured) return configured;
  if (process.env.GW_CHAT_MODEL) return process.env.GW_CHAT_MODEL;
  return provider(settings) === "openai" ? "gpt-5" : "claude-opus-5";
}

/** APIキー未設定なら案内文を返す（ある場合は null）。index.ts のルートが 400 に変換する */
export function chatKeyMissing(settings: SettingsStore): string | null {
  if (settings.resolveChatKey().key) return null;
  return "チャットAIが未設定です。右上の⚙（設定）からプロバイダとAPIキーを設定してください";
}

/** modelIdOverride があればそれを使う（/api/ai/complete が engine.apiModel を渡すため） */
function resolveModel(settings: SettingsStore, modelIdOverride?: string) {
  const { key } = settings.resolveChatKey();
  const mid = modelIdOverride ?? modelId(settings);
  if (provider(settings) === "openai") {
    return createOpenAI({ apiKey: key ?? undefined })(mid);
  }
  return createAnthropic({ apiKey: key ?? undefined })(mid);
}

/** ノード要約（get_state ツール用）。フルノードでなく整理判断に要る最小フィールドだけ渡す */
function summarizeNodes(graph: GraphStore) {
  return graph.state().nodes.map((n) => ({
    id: n.id,
    title: n.title,
    kind: n.kind,
    executor: n.executor,
    status: n.status,
    group: n.group,
    parents: n.parents,
  }));
}

const MEMBER_LIST_LIMIT = 30;
const SELECTED_NODE_THREAD_LIMIT = 5;
const SELECTED_NODE_THREAD_BODY_CHARS = 120;

/** impl の「有無と種類」を短く表す（doc は path があれば添える。text 本文は含めない） */
function describeImpl(impl: Node["impl"]): string {
  if (!impl) return "未設定";
  if (impl.type === "doc") return impl.path ? `doc (path: ${impl.path})` : "doc";
  return "script";
}

/** 表示中ページ（group=pageId）のメンバーノード一覧。多い場合は先頭 MEMBER_LIST_LIMIT 件
 *  + 「他N件」にする（Workflow AI に「この画面に何があるか」を把握させるための文脈、機能2） */
function pageMemberLines(graph: GraphStore, pageId: string | null): string[] {
  if (!pageId) return [];
  const members = graph.state().nodes.filter((n) => n.group === pageId);
  if (members.length === 0) return [];
  const shown = members.slice(0, MEMBER_LIST_LIMIT);
  const lines = shown.map(
    (n) => `- ${n.title || "（無題）"} (kind:${n.kind} executor:${n.executor} status:${n.status})`,
  );
  const rest = members.length - shown.length;
  if (rest > 0) lines.push(`- 他${rest}件`);
  return lines;
}

/** 全プロジェクト（kind:goal のページ）の横断一覧。「他のプロジェクトで何が動いているか」を
 *  Workflow AI が把握するための薄い文脈（2026-08-02 本人要望「プロジェクトをまたいだ全体も
 *  見れるように」）。各行はタイトル+進行状況の件数だけに絞り、ノードの中身は必要になったら
 *  get_state / state_get ツールで見に行かせる */
function projectOverviewLines(graph: GraphStore, currentPageId: string | null): string[] {
  const nodes = graph.state().nodes;
  const goals = nodes.filter((n) => n.kind === "goal" && n.group === null);
  if (goals.length === 0) return [];
  return goals.map((g) => {
    const members = nodes.filter((n) => n.group === g.id);
    const active = members.filter((n) => !["done", "dropped", "skipped"].includes(n.status)).length;
    const marker = g.id === currentPageId ? "（表示中）" : "";
    const state = g.status === "done" || g.status === "dropped" ? ` [${g.status}]` : "";
    return `- ${g.title || "（無題）"} (id: ${g.id})${state}: 未完 ${active}/${members.length} 件${marker}`;
  });
}

/** 選択中ノードのスレッド直近 SELECTED_NODE_THREAD_LIMIT 件を「kind: 本文先頭120字」形式で要約する */
function selectedNodeThreadLines(threads: ThreadStore, nodeId: string): string[] {
  const messages = threads.list(nodeId).slice(-SELECTED_NODE_THREAD_LIMIT);
  return messages.map((m) => {
    const snippet = m.body.length > SELECTED_NODE_THREAD_BODY_CHARS
      ? `${m.body.slice(0, SELECTED_NODE_THREAD_BODY_CHARS)}…`
      : m.body;
    return `- ${m.kind}: ${snippet}`;
  });
}

/** chat_cli.ts（chat.mode="cli"）でも同じ Workflow AI 人格を使うため export する。
 *  機能2（2026-07-31）: 選択ノードの詳細文脈とページのメンバー一覧を加え、AIが
 *  「今開いている画面に何があるか」を把握できるようにする */
export function systemPrompt(
  graph: GraphStore,
  threads: ThreadStore,
  pageId: string | null,
  selectedNodeId: string | null = null,
): string {
  let pageTitle = "(なし)";
  if (pageId && graph.has(pageId)) pageTitle = graph.get(pageId).title;
  else if (pageId) pageTitle = pageId;

  const memberLines = pageMemberLines(graph, pageId);

  // ユーザーが今選択しているノードを文脈として渡す（「これ分解して」の「これ」が通じるように）
  const selectedLines: string[] = [];
  if (selectedNodeId && graph.has(selectedNodeId)) {
    const sel = graph.get(selectedNodeId);
    const parentTitles = sel.parents.map((pid) => (graph.has(pid) ? graph.get(pid).title : pid));
    selectedLines.push(
      `ユーザーが選択中のノード: 「${sel.title || "（無題）"}」(id: ${sel.id})。「これ」「このタスク」はこのノードを指す。`,
      `  詳細: ${sel.detail ?? "(なし)"}`,
      `  kind: ${sel.kind} / executor: ${sel.executor} / status: ${sel.status} / lifecycle: ${sel.lifecycle} / fixed: ${sel.fixed}`,
      `  impl: ${describeImpl(sel.impl)}`,
      `  親ノード: ${parentTitles.length > 0 ? parentTitles.join(", ") : "(なし)"}`,
      `  open な判断リクエスト: ${sel.pendingRequest ? "あり" : "なし"}`,
    );
    const threadLines = selectedNodeThreadLines(threads, sel.id);
    if (threadLines.length > 0) {
      selectedLines.push("  スレッド直近の発言:", ...threadLines.map((l) => `  ${l}`));
    }
  }

  const overviewLines = projectOverviewLines(graph, pageId);

  return [
    "あなたは Workflow AI。タスクグラフ整理の相棒として、ユーザーと会話しながらノードを作成・整理する。",
    "話題は基本、表示中のページ（下記のページとノード）についての会話として扱う。" +
      "ただしユーザーが「全体」「全プロジェクト」「他のプロジェクト」「横断で」等と言ったり、" +
      "表示中ページに無い話題を出したりしたら、グラフ全体（下記のプロジェクト一覧と、" +
      "全ノード取得ツール get_state / state_get）を見て答えること。全体を見るのに確認は要らない。",
    "作業ディレクトリのソースコードやリポジトリの話はしない。",
    ...(overviewLines.length > 0
      ? ["全プロジェクト一覧（横断ビュー。中身は必要なら get_state / state_get で取得）:", ...overviewLines]
      : []),
    "ノードの impl.path やユーザーが言及したドキュメントは、読んでいいか確認を求めず、先に読んでから（Read / read_file ツール）内容を踏まえて答えること。",
    "スクリプト化を頼まれたら: 言語は **Node.js（.mjs）か Python（.py）を優先**する（ps1/bat 等のOS依存スクリプトは避ける。クロスプラットフォームで動くこと）。ファイルは**そのノードの impl.path の手順書と同じフォルダ**に、同じ番号接頭辞で置くこと（例: 00_作品概要決定/01_フォルダ作成・ツール理解.md → 00_作品概要決定/01_フォルダ作成.mjs。手順書とスクリプトは同じ知識の別素材なので同じ場所に育てる）。**引数が要る場合は impl.params に {name, example} を宣言し、command には {name} プレースホルダを使う（値は人間がパネルで入力する。宣言だけ書けばよく value は書かない）**。**スクリプトは必ず --dry-run を実装すること（何も変えず、やる予定の操作を列挙するだけで出力して終わる）——試走ボタンは常に --dry-run 付きで実行される**。書いたら（Write/Edit）ノードの impl を {type:\"script\", command:\"node 00_作品概要決定/01_フォルダ作成.mjs {target}\" のようにワークスペースルートからの相対パス、params:[{name:\"target\", example:\"...\"}]} で接続し、最後に「パネルの試走ボタンで動作確認してください」と案内すること（実行は自分ではしない）。",
    "detail（概要）は**人間向けの平易な2〜3行**に留めること。コマンドのフラグ・環境変数・パス・エッジケースの羅列など技術詳細は detail に書かず、手順書（.md）やスクリプトのコメントに置くか、スレッドへの発言として残す。detail に書くのは「何をするか」「人が気を付けること」だけ。",
    "勝手に大量のノードを作らず、分解は3〜8個の人間粒度で行うこと。",
    "ユーザーが明示した手順を勝手に変えない。削除は確認してから実行すること。",
    "fixed（ロック済み）のノードのやり方（title/impl/枝/依存など）は変更できない。変えたい場合は先にロック解除を人間に頼むこと。",
    `現在表示中のページ: ${pageTitle}`,
    ...(memberLines.length > 0 ? ["このページのノード一覧:", ...memberLines] : []),
    "新規ノードは原則そのページ（group=現在のページ）に作ること。" +
      "ユーザーが別プロジェクトの話として頼んだ場合だけ、group にそのプロジェクトの id を指定して作ってよい。",
    ...selectedLines,
    "「プラン済み」の基準は**やり方（どう進めるか）が決まっていること**。成果が決まっている必要はない（例:「作品タイトルを決める」はタイトル未定でも決め方が決まっていればプラン済み）。ユーザーにプラン済み化を勧めるかどうかもこの基準で判断する。",
    "整理の提案としてノードを作るときは lifecycle:\"draft\"（既定のまま）で作り、" +
      "作り終えたら「下書きとして N 件作りました。各ノードの「プラン済みにする」で確定できます」と案内する。" +
      "ユーザーが明示的に確定を頼んだ場合のみ lifecycle:\"committed\" で作る。",
  ].join("\n");
}

function buildTools(graph: GraphStore, threads: ThreadStore, pageId: string | null, actor: Actor) {
  return {
    get_state: tool({
      description:
        "現在のグラフ全体の要約（各ノードの id/title/kind/executor/status/group/parents のみ）を取得する",
      inputSchema: z.object({}),
      execute: async () => summarizeNodes(graph),
    }),
    add_node: tool({
      description:
        "ノードを新規作成する。group を省略すると現在表示中のページに作られる。人間粒度で、勝手に大量には作らない",
      inputSchema: z.object({
        title: z.string().min(1),
        detail: z.string().nullable().optional(),
        parents: z.array(z.string()).optional(),
        group: z.string().nullable().optional(),
        kind: NodeKindSchema.optional(),
        executor: ExecutorSchema.optional(),
        impact: ImpactSchema.optional(),
        lifecycle: LifecycleSchema.optional(),
        status: StatusSchema.optional(),
      }),
      execute: async (input) =>
        graph.addNode({ ...input, group: input.group ?? pageId ?? null }, { actor, via: VIA }),
    }),
    patch_node: tool({
      description: "既存ノードを部分更新する（id 指定必須、他は変更したいフィールドだけ渡す）",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().min(1).optional(),
        detail: z.string().nullable().optional(),
        parents: z.array(z.string()).optional(),
        group: z.string().nullable().optional(),
        kind: NodeKindSchema.optional(),
        executor: ExecutorSchema.optional(),
        impact: ImpactSchema.optional(),
        lifecycle: LifecycleSchema.optional(),
        status: StatusSchema.optional(),
      }),
      execute: async ({ id, ...patch }) => graph.patchNode(id, patch, { actor, via: VIA }),
    }),
    remove_node: tool({
      description:
        "ノードを削除する。子ノードや group メンバーを持つノードは消せない。実行前に必ずユーザーへ確認すること",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        graph.removeNode(id, { actor, via: VIA });
        return { removed: true, id };
      },
    }),
    read_file: tool({
      description:
        "ワークスペース内のドキュメントを読む（ルートからの相対パス。ノードの impl.path の手順書など）。確認を求めず必要なら先に読むこと",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path: rel }) => {
        const info = graph.workspaceInfo();
        if (!info.root) throw new Error("ワークスペースモードではないためファイルは読めません");
        const abs = resolveWorkspacePath(info.root, rel);
        if (!abs) throw new Error(`不正なパスです（ワークスペース内の相対パスのみ）: ${rel}`);
        return fs.readFileSync(abs, "utf8").slice(0, 20000);
      },
    }),
    get_thread: tool({
      description: "ノードのスレッド（会話・判断・実行履歴・成果物）を取得する",
      inputSchema: z.object({ nodeId: z.string() }),
      execute: async ({ nodeId }) => threads.list(nodeId),
    }),
    post_message: tool({
      description: "ノードのスレッドに発言を投稿する",
      inputSchema: z.object({ nodeId: z.string(), body: z.string().min(1) }),
      execute: async ({ nodeId, body }) => threads.post(nodeId, { body, author: actor, via: VIA }),
    }),
  };
}

export interface ChatRequestBody {
  messages: UIMessage[];
  pageId?: string | null;
  /** UI で選択中のノード（「これ」の解決用） */
  selectedNodeId?: string | null;
}

/** POST /api/chat のハンドラ本体。呼び出し側（index.ts）が chatKeyMissing() を先に見て 400 を返す */
export async function handleChat(
  graph: GraphStore,
  threads: ThreadStore,
  settings: SettingsStore,
  body: ChatRequestBody,
): Promise<Response> {
  const pageId = body.pageId ?? null;
  const actor: Actor = { kind: "agent", name: `chat:${modelId(settings)}` };

  const result = streamText({
    model: resolveModel(settings),
    system: systemPrompt(graph, threads, pageId, body.selectedNodeId ?? null),
    messages: await convertToModelMessages(body.messages ?? []),
    tools: buildTools(graph, threads, pageId, actor),
    stopWhen: stepCountIs(8),
  });

  return result.toUIMessageStreamResponse();
}

/**
 * POST /api/ai/complete のハンドラ本体（エンジンの engine.mode="api" 用: ツールなしの
 * 単発テキスト生成）。プロバイダ/キーはチャット設定を間借りする。モデルは
 * engine.apiModel（設定されていれば）→ チャット既定、の順（呼び出し側=index.ts が
 * chatKeyMissing() を先に見て 400 を返す）。
 */
export async function completeText(
  settings: SettingsStore,
  prompt: string,
  maxTokens?: number,
): Promise<string> {
  const overrideModelId = settings.get().engine.apiModel ?? undefined;
  const result = await generateText({
    model: resolveModel(settings, overrideModelId),
    prompt,
    ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
  });
  return result.text;
}
