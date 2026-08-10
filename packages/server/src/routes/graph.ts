// グラフ全体・ワークスペース参照・既読・undo/redo・エンジン稼働のルート（旧 index.ts から移設）
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { Hono } from "hono";
import { z } from "zod";
import { nowIso, runIdOf } from "@graphwrangler/core";
import { currentUserEmail } from "../auth.js";
import { resolveWorkspacePath } from "../files.js";
import { meta } from "../request_meta.js";
import type { AppContext } from "../app_context.js";

export function graphRoutes(ctx: AppContext): Hono {
  const { graph, threads, runs, settings, reads, selfUpdate } = ctx;
  const app = new Hono();

  const ReadsPatchSchema = z.object({ marks: z.record(z.string(), z.string()) });

  app.post("/api/reads", async (c) => {
    const { marks } = ReadsPatchSchema.parse(await c.req.json());
    reads.markRead(currentUserEmail(), marks);
    return c.json({ reads: reads.loadReads(currentUserEmail()) });
  });

  // ---- グラフ ----

  app.get("/api/state", (c) => {
    // threadMeta: 未読バッジ用にノードごとの最終メッセージ時刻を添える。reads（既読時刻）と
    // 突き合わせてクライアントが未読を判定する。どちらもサーバ持ちなので PC とスマホで一致する
    // （2026-08-02 それまで既読は localStorage で端末ごとに割れていた）。
    // スレッドファイルは小さいので毎回読んで良い規模
    // キーは「ノードid」= テンプレート（設計図）側の会話、「ノードid@ランid」= そのランの会話
    // （2026-08-08 本人指摘「テンプレートのノードにも通知が出るが、こちらに新情報は無い」）。
    // ランで起きたことでテンプレートのノードを未読にしない＝通知もフォークする
    const threadMeta: Record<string, string> = {};
    for (const n of graph.state().nodes) {
      for (const m of threads.list(n.id)) {
        // 実行履歴（kind=status: 状態遷移・ラン作成・実行成否）は未読にしない
        // （2026-08-08 本人指定。機械が書く記録で、人が読むべき新情報ではない。
        //  会話・質問・成果物＝say / decision_request / decision_answer / artifact だけ数える）
        if (m.kind === "status") continue;
        const rid = runIdOf(m);
        threadMeta[rid ? `${n.id}@${rid}` : n.id] = m.ts; // 時系列順なので最後の代入が最新
      }
    }
    return c.json({
      ...graph.state(),
      threadMeta,
      reads: reads.loadReads(currentUserEmail()),
      now: nowIso(),
    });
  });

  // ---- エクスポート（バックアップ用の一括JSON。APIキーは含まれない） ----

  app.get("/api/export", (c) => {
    const nodes = graph.state().nodes;
    const groupIds = new Set(nodes.map((n) => n.group).filter((g): g is string => g !== null));
    const threadDump: Record<string, unknown> = {};
    const runDump: Record<string, unknown> = {};
    for (const n of nodes) {
      const msgs = threads.list(n.id);
      if (msgs.length > 0) threadDump[n.id] = msgs;
      // ページ（goal またはメンバーを持つノード）だけがランを持ちうる
      if (n.kind === "goal" || groupIds.has(n.id)) {
        const list = runs.list(n.id);
        if (list.length > 0) runDump[n.id] = list;
      }
    }
    c.header("Content-Disposition", `attachment; filename="graphwrangler-export.json"`);
    return c.json({
      exportedAt: nowIso(),
      nodes,
      threads: threadDump,
      runs: runDump,
      settings: settings.publicView(),
    });
  });

  // ---- ワークスペース=1ファイル化: 動作モード + ワークスペース内ファイルの参照 ----

  /** ワークスペースの git remote が GitHub なら、手順書パスへのリンク基底
   *  `https://github.com/<org>/<repo>/blob/<branch>` を返す（違えば null）。
   *  NodePanel の impl.path 右のリンクアイコンが使う（2026-08-07 本人要望）。
   *  起動時に1回だけ解決してキャッシュ（remote/branch は運用中ほぼ変わらない） */
  let githubBlobBase: string | null | undefined; // undefined = 未解決
  function resolveGithubBlobBase(): string | null {
    if (githubBlobBase !== undefined) return githubBlobBase;
    githubBlobBase = null;
    const root = graph.workspaceInfo().root;
    if (root) {
      try {
        const remote = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
          encoding: "utf8",
          timeout: 5000,
        }).trim();
        // git@github.com:org/repo.git / https://github.com/org/repo(.git) の両形を受ける
        const m =
          remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/) ??
          remote.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
        if (m) {
          const branch =
            execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
              encoding: "utf8",
              timeout: 5000,
            }).trim() || "main";
          githubBlobBase = `https://github.com/${m[1]}/blob/${encodeURIComponent(branch)}`;
        }
      } catch {
        // git が無い・remote 未設定などは「リンクなし」でよい
      }
    }
    return githubBlobBase;
  }

  /** 現在の動作モード（workspace/datadir）を返す。GraphStore#workspaceInfo に
   *  githubBlobBase（GitHub リンクの基底 URL。無ければ null）を添える */
  app.get("/api/workspace", (c) => {
    return c.json({ ...graph.workspaceInfo(), githubBlobBase: resolveGithubBlobBase() });
  });

  /** ワークスペース内のファイルを utf8 テキストとして読む。root（正データファイルの
   *  あるディレクトリ）基準で解決し、絶対パス・".." でのルート外脱出は 400。
   *  ワークスペースモード以外・path 未指定も 400。存在しない/ディレクトリは 404
   *  （engine の impl={type:"doc",path} 解決が主な利用者。仕様書参照） */
  app.get("/api/files", (c) => {
    const info = graph.workspaceInfo();
    if (info.mode !== "workspace" || !info.root) {
      return c.json({ error: "ワークスペースモードではありません" }, 400);
    }
    const relPath = c.req.query("path");
    if (!relPath) {
      return c.json({ error: "path クエリパラメータが必要です" }, 400);
    }
    const absolute = resolveWorkspacePath(info.root, relPath);
    if (!absolute) {
      return c.json({ error: `ワークスペース外のパスは指定できません: ${relPath}` }, 400);
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return c.json({ error: `ファイルが見つかりません: ${relPath}` }, 404);
    }
    const content = fs.readFileSync(absolute, "utf8");
    return c.json({ path: relPath, content });
  });

  // ---- エンジン稼働ハートビート（UIの稼働インジケータ用。メモリ保持のみ） ----

  let engineLastSeen: string | null = null;

  app.post("/api/engine/heartbeat", (c) => {
    engineLastSeen = nowIso();
    // version = サーバ起動時のアプリ HEAD sha。エンジンは自分が見てきた値と食い違ったら
    // 自分から降りる（＝別プロセスの古いコードが動き続けるのを防ぐ。selfupdate.ts）
    return c.json({ ok: true, version: selfUpdate.version() });
  });

  app.get("/api/engine/status", (c) => {
    const alive =
      engineLastSeen !== null && Date.now() - new Date(engineLastSeen).getTime() < 20_000;
    return c.json({ alive, lastSeen: engineLastSeen });
  });

  // ---- 元に戻す / やり直す（操作ログの補償追記。core の undoLast/redoLast） ----

  app.post("/api/undo", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const undone = graph.undoLast(meta(body));
    if (!undone) return c.json({ error: "戻せる操作がありません" }, 400);
    return c.json({ undone: { id: undone.id, op: undone.op, ts: undone.ts } });
  });

  app.post("/api/redo", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const redone = graph.redoLast(meta(body));
    if (!redone) return c.json({ error: "やり直せる操作がありません" }, 400);
    return c.json({ redone: { id: redone.id, op: redone.op, ts: redone.ts } });
  });

  return app;
}
