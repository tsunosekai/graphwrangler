// GraphWrangler 本体（このアプリのクローン）の自動アップデート（2026-08-05 本人要望
// 「zinsei サーバーの gw と stremix の gw に分かれているので、自動アップデート機能も欲しい」）。
//
// gitsync.ts が**ワークスペース（データ）**の git を回すのに対し、こちらは**アプリのソース**の
// git を回す。やることは1本道:
//   git fetch → 遅れていれば git pull --ff-only → pnpm install → pnpm --filter ui build
//   → 自プロセスを終了（プロセス管理に再起動させる）
//
// 設計の要点:
// - **再起動は自分ではしない**。systemd / pm2 に監視されているときだけ exit(0) して
//   「落ちたら上げ直す」に乗る。監視されていない（手元で pnpm start しただけ）ときは
//   終了せず「再起動してください」と伝えるだけ——勝手にサーバを落とさないため
// - 取り込み対象は fast-forward のみ。ローカルに未コミットの変更があるときは何もしない
//   （開発機で走らせても作業中のツリーを壊さない）
// - エンジンは別プロセスなので、こちらは何も指示しない。エンジンが heartbeat の応答に
//   入っているサーバの HEAD sha の変化を見て自分で降りる（index.ts / engine 側）
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT_TIMEOUT_MS = 120 * 1000;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000; // install + build はネットワークとビルドで数分かかりうる

/** 更新を当てるための自主終了コード。**0 で終わってはいけない**——zinsei / stremix の
 *  unit はどちらも `Restart=on-failure` で、正常終了（0）だと systemd は上げ直さず
 *  サーバが落ちたままになる。非0なら on-failure でも always でも再起動される
 *  （pm2 は終了コードを問わず再起動するのでどちらでも良い）。
 *  75 = EX_TEMPFAIL（sysexits.h の「一時的な失敗。あとで再試行」）を借りている */
export const RESTART_EXIT_CODE = 75;

export interface UpdateConfig {
  /** 定期的に origin を見に行くか（見るだけなら副作用が無いので既定ON） */
  autoCheck: boolean;
  /** 遅れていたら人手を介さず取り込むか（既定OFF。取り込みは再起動を伴うため明示的に入れる） */
  autoApply: boolean;
  /** チェック間隔（分） */
  intervalMin: number;
}

export interface UpdateStatus {
  /** git リポジトリでない等、そもそも動けない理由（動ける場合 null） */
  unavailableReason: string | null;
  autoCheck: boolean;
  autoApply: boolean;
  intervalMin: number;
  branch: string | null;
  /** 起動時の HEAD sha（短縮）。エンジン側の版ずれ検知にも使う */
  current: string | null;
  currentSubject: string | null;
  /** origin 側が何コミット進んでいるか。0 = 最新 */
  behind: number;
  checking: boolean;
  applying: boolean;
  lastCheckAt: string | null;
  lastApplyAt: string | null;
  /** 直近の実行結果の人間向け一行 */
  lastResult: string | null;
  /** プロセス管理（systemd/pm2）に見られているか。false なら取り込み後の再起動は人手 */
  supervised: boolean;
  /** 取り込み済みで、再起動待ちか */
  restartPending: boolean;
}

export interface UpdateResult {
  ok: boolean;
  updated: boolean;
  message: string;
}

function run(
  cwd: string,
  cmd: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const rawCode = err ? (err as { code?: unknown }).code : 0;
      const code = typeof rawCode === "number" ? rawCode : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** プロセス管理下か。systemd は INVOCATION_ID、pm2 は pm_id を環境変数に置く */
export function detectSupervisor(): "systemd" | "pm2" | null {
  if (process.env.INVOCATION_ID) return "systemd";
  if (process.env.pm_id !== undefined) return "pm2";
  return null;
}

/** pnpm の実行ファイル候補。起動が pnpm 経由なら npm_execpath が正確（PATH に pnpm が
 *  無い systemd 環境でも動く）。それ以外は PATH の pnpm に賭ける */
function pnpmCommand(): { cmd: string; prefix: string[] } {
  const execPath = process.env.npm_execpath;
  if (execPath && /\.(c?js|mjs)$/.test(execPath) && fs.existsSync(execPath)) {
    return { cmd: process.execPath, prefix: [execPath] };
  }
  return { cmd: process.platform === "win32" ? "pnpm.cmd" : "pnpm", prefix: [] };
}

export class SelfUpdate {
  private root: string;
  private getConfig: () => UpdateConfig;
  private log: (msg: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private applying = false;
  private behind = 0;
  private branch: string | null = null;
  private current: string | null = null;
  private currentSubject: string | null = null;
  private lastCheckAt: string | null = null;
  private lastApplyAt: string | null = null;
  private lastResult: string | null = null;
  private restartPending = false;

  constructor(opts: { root: string; getConfig: () => UpdateConfig; log?: (msg: string) => void }) {
    this.root = opts.root;
    this.getConfig = opts.getConfig;
    this.log = opts.log ?? ((msg) => console.log(`[update] ${msg}`));
  }

  private unavailableReason(): string | null {
    if (!fs.existsSync(path.join(this.root, ".git"))) {
      return "アプリが git クローンではないため更新できません";
    }
    return null;
  }

  /** 起動直後に1回だけ現在の版を読む（UI表示とエンジンの版ずれ検知の基準になる） */
  async init(): Promise<void> {
    if (this.unavailableReason()) return;
    const sha = await run(this.root, "git", ["rev-parse", "--short", "HEAD"]);
    if (sha.code === 0) this.current = sha.stdout.trim();
    const subject = await run(this.root, "git", ["log", "-1", "--pretty=%s"]);
    if (subject.code === 0) this.currentSubject = subject.stdout.trim();
    const branch = await run(this.root, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch.code === 0) this.branch = branch.stdout.trim();
  }

  /** 起動時の HEAD sha。エンジンは heartbeat 応答のこの値が変わったら降りる */
  version(): string | null {
    return this.current;
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      const config = this.getConfig();
      if (config.autoCheck && !this.unavailableReason()) {
        await this.check();
        if (config.autoApply && this.behind > 0 && !this.restartPending) {
          await this.apply();
        }
      }
      const min = Math.min(Math.max(this.getConfig().intervalMin, 5), 24 * 60);
      this.timer = setTimeout(tick, min * 60 * 1000);
    };
    this.timer = setTimeout(tick, 30_000); // 起動直後は少し待つ（初期化とビルドを邪魔しない）
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): UpdateStatus {
    const config = this.getConfig();
    return {
      unavailableReason: this.unavailableReason(),
      autoCheck: config.autoCheck,
      autoApply: config.autoApply,
      intervalMin: config.intervalMin,
      branch: this.branch,
      current: this.current,
      currentSubject: this.currentSubject,
      behind: this.behind,
      checking: this.checking,
      applying: this.applying,
      lastCheckAt: this.lastCheckAt,
      lastApplyAt: this.lastApplyAt,
      lastResult: this.lastResult,
      supervised: detectSupervisor() !== null,
      restartPending: this.restartPending,
    };
  }

  /** origin を見に行って「何コミット遅れているか」を更新する（取り込みはしない） */
  async check(): Promise<UpdateStatus> {
    const reason = this.unavailableReason();
    if (reason || this.checking) return this.status();
    this.checking = true;
    try {
      const fetched = await run(this.root, "git", ["fetch", "--quiet", "origin"]);
      if (fetched.code !== 0) {
        this.lastResult = `git fetch 失敗: ${fetched.stderr.trim().slice(0, 200)}`;
        return this.status();
      }
      const behind = await run(this.root, "git", ["rev-list", "--count", "HEAD..@{u}"]);
      if (behind.code !== 0) {
        this.lastResult = `更新の確認に失敗（upstream 未設定？）: ${behind.stderr.trim().slice(0, 200)}`;
        return this.status();
      }
      this.behind = parseInt(behind.stdout.trim(), 10) || 0;
      this.lastCheckAt = new Date().toISOString();
      this.lastResult = this.behind > 0 ? `更新が ${this.behind} コミットあります` : "最新です";
    } finally {
      this.checking = false;
    }
    // 応答は checking を下ろしてから作る（返り値が「確認中」のまま固まって見えないように）
    return this.status();
  }

  /** 取り込む: pull --ff-only → pnpm install → ui build → （監視下なら）自プロセス終了。
   *  戻り値を返してから終了するので、呼び出し側はレスポンスを返しきれる */
  async apply(): Promise<UpdateResult> {
    const reason = this.unavailableReason();
    if (reason) return { ok: false, updated: false, message: reason };
    if (this.applying) return { ok: false, updated: false, message: "更新の実行中です" };
    if (this.restartPending) {
      return { ok: true, updated: true, message: "更新済みです（再起動待ち）" };
    }
    this.applying = true;
    try {
      const result = await this.doApply();
      this.lastResult = result.message;
      this.log(result.message);
      if (result.updated) {
        // 実際に取り込んだときだけ時刻を刻む（見送り・失敗は lastResult にだけ残す）
        this.lastApplyAt = new Date().toISOString();
        this.restartPending = true;
        this.scheduleRestart();
      }
      return result;
    } finally {
      this.applying = false;
    }
  }

  private async doApply(): Promise<UpdateResult> {
    // 1) 作業ツリーが汚れていたら触らない（開発機での事故防止。追跡中のファイルのみ見る）
    const dirty = await run(this.root, "git", ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.code !== 0) {
      return { ok: false, updated: false, message: `git status 失敗: ${dirty.stderr.trim().slice(0, 200)}` };
    }
    if (dirty.stdout.trim().length > 0) {
      return {
        ok: false,
        updated: false,
        message: "アプリのリポジトリに未コミットの変更があるため更新を見送りました",
      };
    }

    // 2) fast-forward で取り込む（マージコミットは作らない）
    const before = (await run(this.root, "git", ["rev-parse", "--short", "HEAD"])).stdout.trim();
    const pull = await run(this.root, "git", ["pull", "--ff-only"]);
    if (pull.code !== 0) {
      return { ok: false, updated: false, message: `git pull --ff-only 失敗: ${pull.stderr.trim().slice(0, 200)}` };
    }
    const after = (await run(this.root, "git", ["rev-parse", "--short", "HEAD"])).stdout.trim();
    if (before === after) {
      this.behind = 0;
      return { ok: true, updated: false, message: "最新です（取り込むものはありませんでした）" };
    }

    // 3) 依存とUIビルド（サーバ/エンジンは tsx 実行なのでビルド不要。UI は dist を配る）
    const { cmd, prefix } = pnpmCommand();
    const install = await run(this.root, cmd, [...prefix, "install", "--frozen-lockfile"], BUILD_TIMEOUT_MS);
    if (install.code !== 0) {
      return {
        ok: false,
        updated: false,
        message: `pnpm install 失敗（${before}→${after} は取り込み済み）: ${(install.stderr || install.stdout).trim().slice(-200)}`,
      };
    }
    const build = await run(this.root, cmd, [...prefix, "--filter", "ui", "build"], BUILD_TIMEOUT_MS);
    if (build.code !== 0) {
      return {
        ok: false,
        updated: false,
        message: `UI ビルド失敗（${before}→${after} は取り込み済み）: ${(build.stderr || build.stdout).trim().slice(-200)}`,
      };
    }

    this.behind = 0;
    const supervised = detectSupervisor();
    return {
      ok: true,
      updated: true,
      message: supervised
        ? `${before} → ${after} へ更新しました（再起動します）`
        : `${before} → ${after} へ更新しました（プロセス管理下ではないので、手動で再起動してください）`,
    };
  }

  /** 監視下（systemd/pm2）なら少し待って終了する。上げ直しはプロセス管理の仕事。
   *  監視が無ければ終了しない——サーバが落ちたまま戻らなくなるため */
  private scheduleRestart(): void {
    if (detectSupervisor() === null) return;
    setTimeout(() => {
      this.log("更新の適用のため終了します（プロセス管理が再起動します）");
      process.exit(RESTART_EXIT_CODE);
    }, 1500).unref?.();
  }
}
