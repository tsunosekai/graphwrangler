// ワークスペースの自動 commit/push（2026-08-03 本人要望「AIによる自動プッシュ機能」）。
// AI・人間がグラフを変えると、GW が書くファイルだけを自動で commit して origin へ push する。
// ドキュメントリポ（stremix-document 等）に同居する前提なので:
//   - git add は必ずパス指定（正データファイル + .graphwrangler/）。-A は絶対に使わない
//     ——人間が編集中の他ファイルを勝手に巻き込まないため
//   - .graphwrangler/ 配下の runs/ops/settings/reads は既存の .gitignore が除外するので、
//     ディレクトリごと add してもコミット対象は threads/chats/.gitignore だけになる
//   - push 前に pull --rebase --autostash（他の人間・bot が同じブランチへ push している前提）。
//     rebase が衝突したら abort して lastError に残し、次周に持ち越す（壊すより止まる）
// 有効/無効・間隔は settings.json の git 節（UIの⚙から変更可・既定OFF）。
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT_TIMEOUT_MS = 120 * 1000; // push はネットワーク越しなので長め

export interface GitSyncConfig {
  autoPush: boolean;
  intervalSec: number;
}

export interface GitSyncStatus {
  /** ワークスペースモードで、設定が有効か */
  enabled: boolean;
  /** ワークスペースモードでない等、そもそも動けない理由（動ける場合 null） */
  unavailableReason: string | null;
  running: boolean;
  lastRunAt: string | null;
  lastPushAt: string | null;
  /** 直近の実行結果の人間向け一行（成功/エラーとも）。まだ走っていなければ null */
  lastResult: string | null;
}

export interface RunResult {
  ok: boolean;
  committed: boolean;
  pushed: boolean;
  message: string;
}

function run(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number ?? 1) : 0;
        resolve({ code: typeof code === "number" ? code : 1, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/** status --porcelain の行から「何が変わったか」の短い要約を作る（コミットメッセージ用） */
export function summarizeChanges(porcelainLines: string[]): string {
  let graph = 0;
  let threads = 0;
  let chats = 0;
  let other = 0;
  for (const line of porcelainLines) {
    const file = line.slice(3);
    if (file.endsWith(".gw.json")) graph += 1;
    else if (file.includes(".graphwrangler/threads/")) threads += 1;
    else if (file.includes(".graphwrangler/chats/")) chats += 1;
    else other += 1;
  }
  const parts: string[] = [];
  if (graph > 0) parts.push("グラフ");
  if (threads > 0) parts.push(`スレッド${threads}件`);
  if (chats > 0) parts.push("チャット履歴");
  if (other > 0) parts.push(`他${other}件`);
  return parts.join("・") || "変更なし";
}

export class GitSync {
  private root: string;
  /** git add / status の対象（root からの相対パス） */
  private paths: string[];
  private getConfig: () => GitSyncConfig;
  private log: (msg: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastRunAt: string | null = null;
  private lastPushAt: string | null = null;
  private lastResult: string | null = null;

  constructor(opts: {
    root: string;
    paths: string[];
    getConfig: () => GitSyncConfig;
    log?: (msg: string) => void;
  }) {
    this.root = opts.root;
    this.paths = opts.paths;
    this.getConfig = opts.getConfig;
    this.log = opts.log ?? ((msg) => console.log(`[gitsync] ${msg}`));
  }

  /** 定期実行を開始する。間隔は毎周 settings から読み直す（UIで変えたら次周から効く） */
  start(): void {
    if (this.timer) return;
    const tick = async () => {
      const config = this.getConfig();
      if (config.autoPush) {
        await this.runOnce();
      }
      this.timer = setTimeout(tick, Math.max(15, this.getConfig().intervalSec) * 1000);
    };
    this.timer = setTimeout(tick, 5000); // 起動直後は少し待つ（サーバの初期化を邪魔しない）
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): GitSyncStatus {
    return {
      enabled: this.getConfig().autoPush,
      unavailableReason: null,
      running: this.busy,
      lastRunAt: this.lastRunAt,
      lastPushAt: this.lastPushAt,
      lastResult: this.lastResult,
    };
  }

  /** 1回分の同期: 対象パスに変更があれば commit → 未 push コミットがあれば pull --rebase → push。
   *  設定OFFでも手動（POST /api/gitsync/run）から呼べる */
  async runOnce(): Promise<RunResult> {
    if (this.busy) return { ok: false, committed: false, pushed: false, message: "実行中です" };
    this.busy = true;
    try {
      const result = await this.doRun();
      this.lastRunAt = new Date().toISOString();
      this.lastResult = result.message;
      if (result.pushed) this.lastPushAt = this.lastRunAt;
      if (!result.ok || result.pushed) this.log(result.message);
      return result;
    } finally {
      this.busy = false;
    }
  }

  private fail(message: string): RunResult {
    return { ok: false, committed: false, pushed: false, message };
  }

  private async doRun(): Promise<RunResult> {
    if (!fs.existsSync(path.join(this.root, ".git"))) {
      return this.fail("ワークスペースが git リポジトリではありません");
    }
    const existing = this.paths.filter((p) => fs.existsSync(path.join(this.root, p)));
    if (existing.length === 0) return this.fail("同期対象のファイルがありません");

    // 1) 変更があればコミット（対象パスのみ。gitignore は git 側が尊重する）
    const st = await run(this.root, ["status", "--porcelain", "--", ...existing]);
    if (st.code !== 0) return this.fail(`git status 失敗: ${st.stderr.trim()}`);
    const dirtyLines = st.stdout.split("\n").filter((l) => l.trim().length > 0);
    let committed = false;
    if (dirtyLines.length > 0) {
      const add = await run(this.root, ["add", "--", ...existing]);
      if (add.code !== 0) return this.fail(`git add 失敗: ${add.stderr.trim()}`);
      const msg = `gw: ${summarizeChanges(dirtyLines)}（自動プッシュ）`;
      const commit = await run(this.root, ["commit", "-m", msg]);
      if (commit.code !== 0) {
        // 対象パスの変更が全て gitignore 済み等で「nothing to commit」になるのは正常系
        if (!/nothing to commit|nothing added/.test(commit.stdout + commit.stderr)) {
          return this.fail(`git commit 失敗: ${(commit.stderr || commit.stdout).trim().slice(0, 200)}`);
        }
      } else {
        committed = true;
      }
    }

    // 2) 未 push のコミットが無ければ終わり
    const upstream = await run(this.root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (upstream.code !== 0) {
      // upstream 未設定（クローン直後の空リポ等）。現在ブランチをそのまま初回 push する
      const branch = await run(this.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branch.code !== 0 || branch.stdout.trim() === "HEAD") {
        return this.fail("upstream が無く、現在のブランチも特定できません（detached HEAD?）");
      }
      const push = await run(this.root, ["push", "-u", "origin", branch.stdout.trim()]);
      if (push.code !== 0) return this.fail(`git push -u 失敗: ${push.stderr.trim().slice(0, 200)}`);
      return { ok: true, committed, pushed: true, message: `push 完了（初回 -u origin ${branch.stdout.trim()}）` };
    }
    const ahead = await run(this.root, ["rev-list", "--count", "@{u}..HEAD"]);
    if (ahead.code !== 0) return this.fail(`git rev-list 失敗: ${ahead.stderr.trim()}`);
    if (parseInt(ahead.stdout.trim(), 10) === 0) {
      return { ok: true, committed, pushed: false, message: committed ? "コミット済み（push対象なし）" : "変更なし" };
    }

    // 3) pull --rebase → push（他の人間・bot の push と共存する）
    const pull = await run(this.root, ["pull", "--rebase", "--autostash"]);
    if (pull.code !== 0) {
      await run(this.root, ["rebase", "--abort"]); // 失敗しても無視（rebase 中でなければ何もしない）
      return this.fail(`git pull --rebase 失敗（次周に再試行）: ${pull.stderr.trim().slice(0, 200)}`);
    }
    const push = await run(this.root, ["push"]);
    if (push.code !== 0) return this.fail(`git push 失敗: ${push.stderr.trim().slice(0, 200)}`);
    return { ok: true, committed, pushed: true, message: `push 完了（${ahead.stdout.trim()}コミット）` };
  }
}
