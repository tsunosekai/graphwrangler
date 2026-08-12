// ノードスレッド（会話・判断リクエスト・Task AI）のルート（旧 index.ts から移設）
import { Hono } from "hono";
import { z } from "zod";
import { DecisionRequestSchema, GraphError, buildAiQuestionRequest } from "@graphwrangler/core";
import { loadUsers } from "../auth.js";
import { buildReportMessage, resolveChannelId, sendBotMessage } from "../discord_bot.js";
import { notifyTargetOf } from "../notify_target.js";
import { openHumanRequest } from "../open_request.js";
import { resolveRecipients } from "../recipients.js";
import {
  cancelThreadAi,
  isThreadAiFollowUpQueued,
  isThreadAiRunning,
  maybeTriggerThreadAi,
} from "../thread_ai.js";
import { meta } from "../request_meta.js";
import type { AppContext } from "../app_context.js";

export function threadRoutes(ctx: AppContext): Hono {
  // 通知（宛先の解決・Discord 送信）に要る settings / userSettings / usersFile は
  // openHumanRequest が ctx ごと受け取る（2026-08-11 に経路を1本化した）
  const { graph, threads, settings, attachmentsDir } = ctx;
  const app = new Hono();

  /**
   * ノードのスレッド。?run=<ランid> でそのランの会話・実行記録だけを返す
   * （2026-08-08 本人指定「会話や実行履歴もフォーク」）。指定なしはテンプレート（設計図）側の
   * 会話だけ——ランの記録が混ざると、どのランの話か分からなくなるため。
   * ?run=all は全部（横断で見たいとき用の逃げ道）
   */
  app.get("/api/nodes/:id/thread", (c) => {
    const id = c.req.param("id");
    const run = c.req.query("run") ?? null;
    // ラン指定のときはノードが今のグラフから消えていても読める（ランは過去の記録で、
    // テンプレートを消したあとも残る。実データで踏んだ: ページごと消えたルーティーンのラン）
    if (!run) graph.get(id);
    const messages = run === "all" ? threads.list(id) : threads.listScoped(id, run);
    // aiBusy: Task AI が応答生成中か（UI の「考え中」表示。GraphWrangler AI と挙動を揃える）
    // aiQueued: 応答中の送信予約を受けて、終わり次第もう一度応答する予約があるか（2026-08-05）
    return c.json({
      messages,
      aiBusy: isThreadAiRunning(id, run === "all" ? null : run),
      aiQueued: isThreadAiFollowUpQueued(id, run === "all" ? null : run),
    });
  });

  /** Task AI の応答を止める（2026-08-05 本人要望「AIの会話を止められる機能」）。
   *  走っていなければ stopped:false を返すだけ（呼び手は成否を気にしなくてよい） */
  app.post("/api/nodes/:id/thread-ai/cancel", async (c) => {
    const id = c.req.param("id");
    graph.get(id);
    const body = await c.req.json().catch(() => ({}) as { runId?: string | null });
    return c.json({ stopped: cancelThreadAi(id, (body as { runId?: string | null }).runId ?? null) });
  });

  const PostMessageSchema = z.object({
    kind: z.enum(["say", "status", "artifact"]).default("say"),
    body: z.string().min(1),
    payload: z.unknown().optional(),
    /** どのランの会話への投稿か（2026-08-08）。null/未指定 = テンプレート側の会話 */
    runId: z.string().nullable().default(null),
  });

  app.post("/api/nodes/:id/messages", async (c) => {
    const id = c.req.param("id");
    graph.get(id);
    const body = await c.req.json();
    const input = PostMessageSchema.parse(body);
    const m = meta(body);
    const message = threads.post(id, { ...input, author: m.actor, via: m.via });
    // AI応答も同じランの会話として返す（テンプレート側の相談とは混ぜない）
    // スレッド相談AI（機能1）: 人間の say かつ open な判断リクエストが無いノードにのみ、
    // 応答を待たず非同期でAI応答ジョブを起動する（thread_ai.ts 参照。レスポンスはブロックしない）
    maybeTriggerThreadAi({
      graph,
      threads,
      settings,
      nodeId: id,
      kind: input.kind,
      actor: m.actor,
      runId: input.runId,
      attachmentsDir, // [添付ファイル: <パス>] を Task AI が Read で読めるように

      // 「Task AI が返信した」の Discord 通知は廃止（2026-08-11 本人指示——GW でチャット中に
      // 1往復ごとに鳴っていた。返信は開けば読めるので鳴らす理由が無い）。代わりに、AI が
      // 会話中に**本当に人間の判断を要した**ときだけ QUESTION プロトコルでここへ来て、
      // 判断リクエスト＝「あなたの番」として鳴る（2026-08-11「AIが人間に本当に問い合わせを
      // したい時だけグラフ通知チャンネルに通知を出して」）。
      // 既に open なリクエストがあるノードはそもそも Task AI が起動しない
      // （shouldTriggerThreadAi）ので、ここでの重複は起きない
      onQuestion: (node, question, runId) => {
        openHumanRequest(
          ctx,
          node.id,
          buildAiQuestionRequest(node.title, question),
          { author: { kind: "agent", name: "task-ai" }, via: "chat" },
          runId,
        );
      },
    });
    return c.json(message);
  });

  /** 判断リクエストを開く（主に agent 側が使う）。pendingRequest がセットされ、ボールが人間に渡る
   *  （「あなたの番（waiting）」表示は UI が pendingRequest の有無から導出する） */
  app.post("/api/nodes/:id/request", async (c) => {
    const id = c.req.param("id");
    const node = graph.get(id);
    if (node.pendingRequest) {
      throw new GraphError(`node already has an open request: ${node.pendingRequest}`, 409);
    }
    const body = await c.req.json();
    const m = meta(body);
    const request = DecisionRequestSchema.parse(body.request);
    // ラン文脈のカード（エンジンの承認ゲート・AI質問・ラン内分岐）は runId 付きで開く——
    // カードがそのランの会話に属し、ランのページ（#/r/…）から見え・答えられるようにする
    // （2026-08-12 本人報告「通知リンクから開いたら質問に返信しても動かない」の修正）
    const runId = typeof body.runId === "string" && body.runId ? body.runId : null;
    // pendingRequest のセットと「あなたの番」の Discord 通知は open_request.ts が一手に持つ
    // （AI実行中の QUESTION・承認ゲート・失敗リカバリ・分岐が全部この経路を通る）
    const message = openHumanRequest(
      ctx,
      id,
      request,
      {
        author: m.actor.kind === "human" ? { kind: "agent" } : m.actor,
        via: m.via,
      },
      runId,
    );
    return c.json(message);
  });

  /**
   * 業務連絡の Discord 投稿（2026-08-11。MCP の discord_post から呼ばれる）。
   * **グラフ通知ではない**——手順書に「#運営一般 に報告」と書かれたノードで、AI がその
   * 実行としてチャンネルへ投げる口（discord_bot.ts の系統。軸の説明もそこ）。
   *
   * サーバ側で機械的に付けるもの: 出し元の [Graph Wrangler]（共用 Bot のため）/ 関係者の
   * メンション / ページ名 + ノード名 / **ノードURL（必須）**。AI が書くのは本文だけ。
   * これで「AI が openclaw で直接投げる」経路（URLも記録も付かない）を GW 側へ寄せられる。
   *
   * 投稿内容はスレッドにも status として残す——後から「いつ何をどこへ報告したか」を
   * ノードだけで辿れるようにするため。
   */
  const DiscordPostSchema = z.object({
    channel: z.string().min(1),
    body: z.string().min(1),
    runId: z.string().nullable().default(null),
  });

  app.post("/api/nodes/:id/discord", async (c) => {
    const id = c.req.param("id");
    const node = graph.get(id);
    const input = DiscordPostSchema.parse(await c.req.json());
    const n = settings.get().notify;
    if (!n.discordEnabled) throw new GraphError("Discord 通知が設定で無効です", 400);
    if (!n.discordBotToken || !n.discordGuildId) {
      throw new GraphError(
        "Discord の Bot トークン / サーバーID が未設定です（⚙→通知）。チャンネル指定の投稿にはこの2つが要ります",
        400,
      );
    }
    const target = notifyTargetOf(graph, node);
    const message = buildReportMessage(
      input.body,
      resolveRecipients(graph, threads, loadUsers(ctx.usersFile), node, input.runId),
      target,
      n.publicUrl,
    );
    if (!message) {
      throw new GraphError(
        "通知リンクの基底URL（⚙→通知の publicUrl）が未設定です。ノードURLの無い投稿は出しません",
        400,
      );
    }
    let posted: { id: string };
    try {
      const channelId = await resolveChannelId(n.discordBotToken, n.discordGuildId, input.channel);
      posted = await sendBotMessage(n.discordBotToken, channelId, message);
    } catch (err) {
      throw new GraphError(String(err instanceof Error ? err.message : err), 502);
    }
    threads.post(id, {
      kind: "status",
      body: `Discord ${input.channel} へ投稿:\n${input.body.trim()}`,
      payload: { discordMessageId: posted.id, channel: input.channel },
      runId: input.runId,
      author: { kind: "agent" },
      via: "discord",
    });
    return c.json({ ok: true, messageId: posted.id, content: message.content });
  });

  const AnswerSchema = z.object({
    requestId: z.string(),
    option: z.string().nullable(),
    note: z.string().nullable().default(null),
  });

  /** 判断リクエストに答える。選択肢を選んだら pendingRequest が解け、ボールが戻る */
  app.post("/api/nodes/:id/answer", async (c) => {
    const id = c.req.param("id");
    graph.get(id);
    const body = await c.req.json();
    const m = meta(body);
    const { message, resolved } = threads.answerRequest(id, AnswerSchema.parse(body), {
      author: m.actor,
      via: m.via,
    });
    if (resolved) {
      graph.patchNode(
        id,
        { pendingRequest: null, status: "pending" },
        { actor: { kind: "system" }, via: m.via },
      );
    } else {
      // ラリー（選択肢を選ばない自由文の回答。design.md 4-④）: カードは開いたままなので、
      // このままだと**誰も応答しない**（質問した実行AIはカードが open の間ずっと回答待ちで
      // 止まっており、Task AI もカードがあると起動しない）。UI は「聞き返す・相談する…」と
      // 誘っているので、Task AI に応答させて会話として成立させる（2026-08-12 修正）。
      // 決めるのは引き続き人間——AI は疑問に答えて選びやすくするだけ（thread_ai.ts の rally）
      maybeTriggerThreadAi({
        graph,
        threads,
        settings,
        nodeId: id,
        kind: message.kind,
        actor: m.actor,
        runId: message.runId ?? null,
        attachmentsDir,
        rally: true,
      });
    }
    return c.json({ message, resolved, node: graph.get(id) });
  });

  return app;
}
