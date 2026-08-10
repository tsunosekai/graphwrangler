// ノードスレッド（会話・判断リクエスト・Task AI）のルート（旧 index.ts から移設）
import { Hono } from "hono";
import { z } from "zod";
import { DecisionRequestSchema, GraphError } from "@graphwrangler/core";
import { loadUsers } from "../auth.js";
import { notifyAiReply, notifyTurn } from "../discord.js";
import { notifyTargetOf } from "../notify_target.js";
import {
  cancelThreadAi,
  isThreadAiFollowUpQueued,
  isThreadAiRunning,
  maybeTriggerThreadAi,
} from "../thread_ai.js";
import { meta } from "../request_meta.js";
import type { AppContext } from "../app_context.js";

export function threadRoutes(ctx: AppContext): Hono {
  const { graph, threads, settings, userSettings, usersFile, attachmentsDir } = ctx;
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

      // Task AI の返信完了を Discord へ（2026-08-07「通知が来ない」対応。discord.ts 参照）。
      // 受け取るかどうかは個人設定（担当者、未割当なら default 枠）で決める。
      // 返信本文の引用（snippet）は廃止し、ページ名 + リンクの簡略フォーマットへ（2026-08-08 本人指示）
      onReply: (node) => {
        if (!userSettings.get(node.assignee ?? null).discordAiReplies) return;
        notifyAiReply(settings.get().notify, loadUsers(usersFile), {
          assignee: node.assignee,
          target: notifyTargetOf(graph, node),
        });
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
    const message = threads.openRequest(
      id,
      request,
      { author: m.actor.kind === "human" ? { kind: "agent" } : m.actor, via: m.via },
    );
    graph.patchNode(
      id,
      { pendingRequest: message.id },
      { actor: { kind: "system" }, via: m.via },
    );
    // Discord 通知（あなたの番の発生源①: ボールが人間へ渡った瞬間。discord.ts 参照）。
    // 投げっぱなし＝リクエスト処理をブロックしない。担当者が居るときはその人の
    // 個人設定（discordTurnNotify）を尊重する（2026-08-07 ユーザー別設定）。
    // 質問文の引用（extra）は廃止し、ページ名 + リンクの簡略フォーマットへ（2026-08-08 本人指示）
    if (!node.assignee || userSettings.get(node.assignee).discordTurnNotify) {
      notifyTurn(settings.get().notify, loadUsers(usersFile), {
        assignee: node.assignee,
        target: notifyTargetOf(graph, node),
      });
    }
    return c.json(message);
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
    }
    return c.json({ message, resolved, node: graph.get(id) });
  });

  return app;
}
