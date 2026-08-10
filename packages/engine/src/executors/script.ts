// executor=script: node.impl={type:"script",command} を子プロセスで実行する。
// 決定的ノード（3.4）担当。shell: true でコマンド文字列をそのまま渡す。
import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

export const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000; // 5分

/** exit（プロセス本体の終了）後に残りの stdio 出力を待つ猶予。孫プロセスにパイプを
 *  握られると close はプロセス終了後も来ない（デーモンを残して正常終了するスクリプトが
 *  典型）ため、この猶予を過ぎたらストリームを打ち切り、終了コードで結果を確定する */
export const STDIO_GRACE_MS = 1000;

/**
 * 子プロセス出力のデコード。Windows では cmd.exe（内部コマンド含む）がシステム
 * コードページ（日本語環境は CP932/Shift_JIS）で出力するため、UTF-8 として読むと
 * 文字化けする（2026-07-31 実測: echo した日本語が � の列になった。chcp 65001 の
 * 前置はパイプ出力の内部コマンドに効かず解決しない）。UTF-8 で厳密デコードし、
 * 失敗したら Shift_JIS で読み直す（UTF-8 で吐くプログラムはそのまま通る）。
 */
export function decodeOutput(buf: Buffer): string {
  if (process.platform !== "win32") return buf.toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("shift_jis").decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}

/**
 * 子プロセスをプロセスツリーごと止める。child.kill() は直接の子（shell:true なら
 * シェル本体）しか止めず、実コマンドや孫プロセスが生き残る。孫に stdio パイプを
 * 握られたままだと親側の close イベントも発火しない。
 * Windows は taskkill /T /F（ツリー強制終了）、POSIX は detached 起動で分けた
 * プロセスグループへの SIGKILL（グループ kill には spawn 時の detached:true が前提）。
 */
export function killTree(child: ChildProcess): void {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export interface RunScriptOptions {
  timeoutMs?: number;
  /** 作業ディレクトリ。省略時は従来どおりリポジトリ外の作業用tmp（os.tmpdir()）。
   *  ワークスペースモードでは正データファイルのあるディレクトリ（workspace root）を渡す
   *  （ワークスペース=1ファイル化仕様: スクリプトがリポジトリ内のファイルを素で参照できる） */
  cwd?: string;
  /** 追加の環境変数（ランのコンテキスト GW_RUN_ID / GW_CONTEXT / GW_RUN_DIR / GW_PARAM_* 等。
   *  docs/design.md 3.15）。process.env に重ねて子プロセスへ渡す */
  env?: Record<string, string>;
}

/**
 * command を子プロセスで実行する。cwd は既定でリポジトリ外の作業用tmp（os.tmpdir()）に固定する
 * （このリポジトリを汚さない。CLAUDE.md 系の「一時ファイルは /tmp へ」規律と同じ発想）が、
 * opts.cwd を渡せば上書きできる（ワークスペースモードの workspace root 用）。
 * 出力はバイト列で貯めて close 時に一括デコードする（チャンク境界でマルチバイト文字が
 * 割れるのを防ぐ + 上記の Shift_JIS フォールバックのため）。
 */
export function runScript(command: string, opts: RunScriptOptions = {}): Promise<ExecResult> {
  const { timeoutMs = SCRIPT_TIMEOUT_MS, cwd = os.tmpdir(), env } = opts;
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    // close はタイムアウト resolve 後にも遅れて発火しうるため、二重 resolve を防ぐ
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const settle = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve(result);
    };

    const child = spawn(command, {
      shell: true,
      cwd,
      // POSIX ではプロセスグループを分け、killTree でグループごと止められるようにする
      ...(process.platform !== "win32" ? { detached: true } : {}),
      // env 省略時は spawn 既定（process.env 継承）のまま。指定時だけ重ねる
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });

    // close は「プロセス終了 + stdio が全部閉じる」まで発火しない。孫プロセスにパイプを
    // 握られると kill 後も close が来ないため、タイムアウトではツリーごと殺し、こちら側の
    // ストリームを打ち切って、その場で必ず resolve する（エンジンは1並列なので、ここで
    // 待ち続けるとエンジン全体が止まる）
    const timer = setTimeout(() => {
      killTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({
        success: false,
        output: decodeOutput(Buffer.concat(stdoutChunks)),
        error: `タイムアウト（${Math.round(timeoutMs / 60000)}分）`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdoutChunks.push(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderrChunks.push(d);
    });

    child.on("error", (err) => {
      settle({ success: false, output: decodeOutput(Buffer.concat(stdoutChunks)), error: String(err) });
    });

    // 終了コードから結果を確定する（close / exit+猶予 の両経路で共用）
    const finish = (code: number | null) => {
      const stdout = decodeOutput(Buffer.concat(stdoutChunks));
      const stderr = decodeOutput(Buffer.concat(stderrChunks));
      if (code !== 0) {
        settle({
          success: false,
          output: stdout,
          error: stderr.trim().slice(0, 2000) || `終了コード ${code}`,
        });
        return;
      }
      settle({ success: true, output: stdout });
    };

    // exit はプロセス本体の終了時に必ず発火する（close と違い stdio の状態に依存しない）。
    // 通常は直後に close が来て確定するが、孫プロセスにパイプを握られたまま本体だけ
    // 終了した場合は close が来ないため、猶予後にストリームを打ち切って終了コードで確定する
    child.on("exit", (code) => {
      if (settled) return;
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, STDIO_GRACE_MS);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}
